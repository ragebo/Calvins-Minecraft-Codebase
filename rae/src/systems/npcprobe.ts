import { system, world, type Entity, type Player } from "@minecraft/server";
import { SHOP as S } from "../config/balance.js";
import { onScriptEvent } from "../core/events.js";
import { error, warn } from "../core/log.js";
import { isOperator, players } from "../core/players.js";
import { registerSystem } from "../core/registry.js";
import { format, tell } from "../core/ui.js";

/**
 * A measurement, not a feature: `/scriptevent rae:npc_probe`.
 *
 * The NPC shops hang on how the real game treats a vanilla `minecraft:npc`, and nobody here has measured it. This records the
 * facts first; docs/test-cards/NPC-PROBE.md is the run sheet and the shop's click routes (systems/shoptalk.ts) branch on the answers:
 *
 *   - Does a right-click on an NPC reach a script's playerInteractWithEntity, before the game opens its dialogue and after?
 *   - Does setting `cancel` in the "before" event stop the game's own dialogue screen? (Only the player at the screen can say;
 *     the probe counts how many clicks it cancelled and the card asks what was seen. An "after" event that stops firing is the
 *     engine's own answer.)
 *   - Can a script point an NPC at a dialogue scene with `dialogue change`, right after spawning it and later, and what does that
 *     scene's button report: who ran the command, as what, and who pressed it?
 *   - What does a script-spawned NPC look like (skin, the name above its head), and does it keep its mark across a relaunch?
 *
 *   log on|off              write every click on an NPC the game reports to the content log
 *   cancel on|off           set `cancel` in the "before" event for clicks on NPCs (switches itself off, see SHOP.probeCancelAutoOffTicks)
 *   spawn                   make a probe NPC in front of you: named, marked with a property and a tag, pointed at the probe scene
 *   scene                   point the nearest probe NPC at the probe scene again
 *   open                    force the probe scene open for you on the nearest probe NPC (`dialogue open`)
 *   name <text>             set the nearest probe NPC's name tag and read it back
 *   component               try the (Beta) NPC component on the nearest probe NPC
 *   report | clear          summarise what was seen and list every probe NPC / forget it
 *
 * Every line is written as a content-log warning prefixed `[npc-probe]`; the findings are the `RESULT` lines. Every engine call
 * is wrapped, so a probe that fails logs the engine's own error text instead of throwing. The scene's buttons run
 * `/scriptevent rae:npc_probe btn A` (and B), which log under `RESULT button`.
 */

const LOG_SOURCE = "npc-probe";
const log = (text: string): void => warn(LOG_SOURCE, text);
const result = (name: string, value: string): void => log(`RESULT ${name} = ${value}`);

const USAGE = "Usage: /scriptevent rae:npc_probe log on|off | cancel on|off | spawn | scene | open | name <text> | component | report | clear";

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

function errorText(err: unknown): string {
    const name = err instanceof Error ? err.name : typeof err;
    return `${name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240);
}

function summarize(value: unknown): string {
    if (value === undefined) return "undefined";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return `array(${value.length})`;
    try { return JSON.stringify(value).slice(0, 160); } catch { return typeof value; }
}

/** Runs `fn`; the answer is "ok" (plus what it returned) or "THREW <the engine's own error text>". Never throws. */
function attempt(fn: () => unknown): string {
    try {
        const value = fn();
        return value === undefined ? "ok" : `ok (${summarize(value)})`;
    } catch (err) {
        return `THREW ${errorText(err)}`;
    }
}

/** Runs an event handler body so nothing it does can reach the game: a probe must never break a click. */
function guard(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        error(LOG_SOURCE, `${label} failed: ${errorText(err)}`);
    }
}

/** Subscribes to one engine event; if the engine has no such event (or refuses) that goes in the log instead of throwing. */
function listen<E>(name: string, signal: () => { subscribe(callback: (event: E) => void): unknown }, handler: (event: E) => void): void {
    try {
        signal().subscribe(handler);
    } catch (err) {
        warn(LOG_SOURCE, `RESULT subscribe ${name} = THREW ${errorText(err)}`);
    }
}

const at = (e: Entity): string => {
    try {
        return `${Math.floor(e.location.x)},${Math.floor(e.location.y)},${Math.floor(e.location.z)}`;
    } catch {
        return "unreadable";
    }
};

// ---------------------------------------------------------------------------------------------------------
// What has been seen
// ---------------------------------------------------------------------------------------------------------

interface Counts { before: number; after: number; cancelled: number }

const counts: Counts = { before: 0, after: 0, cancelled: 0 };
const buttons: string[] = [];
let logging = false;
let cancelling = false;
let cancelTimer: number | undefined;
let spawned = 0;

function armCancelTimeout(): void {

    if (cancelTimer !== undefined) system.clearRun(cancelTimer);
    cancelTimer = undefined;

    if (!cancelling) return;

    cancelTimer = system.runTimeout(() => {
        cancelling = false;
        cancelTimer = undefined;
        log("cancel switched itself off (safety timeout)");
    }, S.probeCancelAutoOffTicks);
}

const isNpcType = (entity: Entity): boolean => {
    try { return entity.typeId === S.npcType; } catch { return false; }
};

function heldType(player: Player): string {
    try {
        return player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex)?.typeId ?? "hand";
    } catch {
        return "unreadable";
    }
}

listen("beforeEvents.playerInteractWithEntity", () => world.beforeEvents.playerInteractWithEntity, (event) => {
    guard("the click on an NPC (before)", () => {

        if (!isNpcType(event.target)) return;

        counts.before++;

        if (logging) log(`click BEFORE: ${event.target.id} at ${at(event.target)} held=${event.itemStack?.typeId ?? "hand"} sneak=${event.player.isSneaking} cancel=${cancelling}`);

        if (cancelling) {
            event.cancel = true;
            counts.cancelled++;
        }
    });
});

listen("afterEvents.playerInteractWithEntity", () => world.afterEvents.playerInteractWithEntity, (event) => {
    guard("the click on an NPC (after)", () => {

        if (!isNpcType(event.target)) return;

        counts.after++;

        if (logging) log(`click AFTER: ${event.target.id} held=${heldType(event.player)}`);
    });
});

// ---------------------------------------------------------------------------------------------------------
// Finding the probe NPC
// ---------------------------------------------------------------------------------------------------------

function probeNpcs(): Entity[] {

    const found: Entity[] = [];

    for (const id of ["overworld", "nether", "the_end"]) {
        try {
            found.push(...world.getDimension(id).getEntities({ type: S.npcType, tags: [S.probeTag] }));
        } catch {
            // a dimension that cannot be read has none to list
        }
    }

    return found;
}

/** The probe NPC the player is looking at, else the nearest one. */
function nearestProbe(player: Player): Entity | undefined {

    try {
        const aimed = player.getEntitiesFromViewDirection({ maxDistance: S.aimReach, type: S.npcType }).find((hit) => hit.entity.hasTag(S.probeTag));
        if (aimed) return aimed.entity;
    } catch {
        // fall through to the nearest
    }

    let best: Entity | undefined;
    let bestDistance = Infinity;

    for (const npc of probeNpcs()) {
        try {
            const dx = npc.location.x - player.location.x;
            const dz = npc.location.z - player.location.z;
            const distance = dx * dx + dz * dz;
            if (distance < bestDistance) { best = npc; bestDistance = distance; }
        } catch {
            // an NPC that cannot be read is skipped
        }
    }

    return best;
}

// ---------------------------------------------------------------------------------------------------------
// The subcommands
// ---------------------------------------------------------------------------------------------------------

function spawnProbe(player: Player): void {

    spawned++;

    const here = player.location;
    const look = player.getViewDirection();
    const spot = { x: here.x + look.x * S.spawnDistance, y: here.y, z: here.z + look.z * S.spawnDistance };

    let npc: Entity;

    try {
        npc = player.dimension.spawnEntity(S.npcType, spot);
    } catch (err) {
        result("spawn", `THREW ${errorText(err)}`);
        tell(player, format("warn", "The probe NPC could not be made: see the content log."));
        return;
    }

    result("spawn", `ok id=${npc.id} at ${at(npc)}`);

    result("tag", attempt(() => npc.addTag(S.probeTag)));
    result("dynamic property", attempt(() => npc.setDynamicProperty(S.probeProperty, spawned)));
    result("nameTag set", attempt(() => { npc.nameTag = `Probe ${spawned}`; }));
    result("nameTag read back", `"${attempt(() => npc.nameTag)}"`);
    result("face the builder", attempt(() => npc.teleport(npc.location, { facingLocation: here })));
    result("dialogue change right after spawning", attempt(() => npc.runCommand(`dialogue change @s ${S.probeScene}`)));
    result("NPC component", attempt(() => npc.getComponent("minecraft:npc")));

    // The same command a moment later: if the first needed the NPC to settle, this one tells.
    system.runTimeout(() => {
        if (!npc.isValid) return;
        result("dialogue change 10 ticks after spawning", attempt(() => npc.runCommand(`dialogue change @s ${S.probeScene}`)));
    }, S.sceneRetryTicks);

    tell(player, format("ok", `Probe NPC ${spawned} is in front of you. Read the content log for the RESULT lines, then click it (see the card).`));
}

function report(player: Player | undefined): void {

    result("clicks on NPCs seen: before / after / cancelled", `${counts.before} / ${counts.after} / ${counts.cancelled}`);
    result("buttons pressed", buttons.length === 0 ? "none" : buttons.join(" | "));

    const npcs = probeNpcs();
    result("probe NPCs found", String(npcs.length));

    for (const npc of npcs) {
        result(`probe NPC ${npc.id}`, `at ${at(npc)} property=${attempt(() => npc.getDynamicProperty(S.probeProperty))} nameTag="${attempt(() => npc.nameTag)}" valid=${npc.isValid}`);
    }

    result("players carrying the scene button's tag", String(players().filter((p) => p.hasTag("rae_npc_probe_pressed")).length));

    if (player) tell(player, format("ok", `Written to the content log: ${counts.before} clicks seen before, ${counts.after} after, ${counts.cancelled} cancelled, ${npcs.length} probe NPCs.`));
}

onScriptEvent("rae:npc_probe", (player, message, origin) => {

    const [command = "", ...rest] = message.trim().split(/\s+/);
    const word = command.toLowerCase();

    // A dialogue button: the answer to "what does an NPC's button report?".
    if (word === "btn") {
        const label = rest.join(" ") || "?";
        buttons.push(label);
        const initiator = origin.initiator;
        result(`button ${label}`, `fromNpc=${origin.fromNpc} entity=${origin.entity?.typeId ?? "none"} initiator=${initiator ? `${initiator.typeId}${initiator.typeId === "minecraft:player" ? ` ${(initiator as Player).name}` : ""}` : "none"} operator=${initiator?.typeId === "minecraft:player" ? isOperator(initiator as Player) : "n/a"}`);
        return;
    }

    if (!player) {
        log("a probe command needs a player: run it as one");
        return;
    }

    if (!isOperator(player)) {
        tell(player, format("warn", "The probe is for operators."));
        return;
    }

    const arg = (rest[0] ?? "").toLowerCase();

    if (word === "log") {
        if (arg !== "on" && arg !== "off") { tell(player, format("warn", USAGE)); return; }
        logging = arg === "on";
        tell(player, format("ok", `Click logging is ${arg}.`));
        return;
    }

    if (word === "cancel") {
        if (arg !== "on" && arg !== "off") { tell(player, format("warn", USAGE)); return; }
        cancelling = arg === "on";
        armCancelTimeout();
        log(`cancel is ${arg}`);
        tell(player, format("ok", cancelling ? "Clicks on NPCs are cancelled for the next two minutes. Click one: does the game's own dialogue still open?" : "Clicks on NPCs are no longer cancelled."));
        return;
    }

    if (word === "spawn") {
        // The command that brought us here is not restricted, but a chat command's callback is: stay on the safe side and defer.
        system.run(() => guard("spawning a probe NPC", () => spawnProbe(player)));
        return;
    }

    if (word === "report") {
        report(player);
        return;
    }

    if (word === "clear") {
        counts.before = counts.after = counts.cancelled = 0;
        buttons.length = 0;
        tell(player, format("ok", "Forgotten."));
        return;
    }

    if (word === "scene" || word === "open" || word === "name" || word === "component") {

        const npc = nearestProbe(player);

        if (!npc) {
            tell(player, format("warn", "No probe NPC found: /scriptevent rae:npc_probe spawn makes one."));
            return;
        }

        if (word === "scene") result("dialogue change", attempt(() => npc.runCommand(`dialogue change @s ${S.probeScene}`)));
        else if (word === "open") result("dialogue open", attempt(() => player.runCommand(`dialogue open @e[tag=${S.probeTag},c=1] @s ${S.probeScene}`)));
        else if (word === "component") result("NPC component", attempt(() => npc.getComponent("minecraft:npc")));
        else {
            const text = rest.join(" ");
            result("nameTag set", attempt(() => { npc.nameTag = text; }));
            result("nameTag read back", `"${attempt(() => npc.nameTag)}"`);
        }

        tell(player, format("ok", "Done: see the content log."));
        return;
    }

    tell(player, format("warn", USAGE));
});

registerSystem({
    name: "npcprobe",
    reset() {
        // A measurement is not round state: nothing here is cleared by a round, but a cancel left on is switched off.
        cancelling = false;
        if (cancelTimer !== undefined) system.clearRun(cancelTimer);
        cancelTimer = undefined;
    }
});
