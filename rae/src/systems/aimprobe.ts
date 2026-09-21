import { world, EquipmentSlot, type Entity, type Player } from "@minecraft/server";
import { AIM as A } from "../config/balance.js";
import { hideScope, showScope } from "../core/aim.js";
import { onScriptEvent } from "../core/events.js";
import { registerSystem } from "../core/registry.js";
import { onTick } from "../core/tick.js";
import { format, tell } from "../core/ui.js";

/**
 * A measurement, not a game feature: `/scriptevent rae:aim_spike`.
 *
 * The plan is to fire guns with left-click, aim with a held right-click (zoom, and a scope for the bolt rifle)
 * and reload by swapping to the off-hand, because sneak cannot be used on a horse. What scripts can see of
 * the player's input is thin (the button events know only Jump and Sneak), so this records what the game
 * actually reports before anything is built on it:
 *
 *   log on|off        write every swing, use, drop, hit, inventory change and off-hand change to the content log
 *   fov <n> | reset   set the camera's field of view (zoom), or put it back
 *   scope on | off    show or hide the scope overlay (a HUD image switched by a title text)
 *
 * With three items to hold (`/give @s bountysys:aim_probe_plain`, `_bow`, `_spyglass`: hold-to-use items that
 * differ only in their use animation), the log answers: what a left-click reports in the air, on a block and
 * on a mob, and while riding; whether holding right-click gives start and stop events; whether the bow or
 * spyglass animation zooms by itself; how an off-hand swap and a drop look to a script.
 * Everything goes to the content log as warnings (which it records), prefixed `[aim-spike]`.
 */

const LOG = "[aim-spike]";
const log = (text: string): void => console.warn(`${LOG} ${text}`);

const USAGE = "Usage: /scriptevent rae:aim_spike log on|off | fov <number> | fov reset | scope on | scope off";

let logging = false;
let stopOffhandPoll: (() => void) | undefined;
/** Players the spike has zoomed or put a scope on, so a reset can undo it. */
const touched = new Set<Player>();

const typeOf = (item: { typeId: string } | undefined): string => item?.typeId ?? "none";

function isRiding(player: Player): boolean {
    try { return player.getComponent("minecraft:riding") !== undefined; } catch { return false; }
}

const who = (player: Player): string => `${player.name} riding=${isRiding(player)} sneaking=${player.isSneaking}`;

function offhandType(player: Player): string {
    try { return typeOf(player.getComponent("minecraft:equippable")?.getEquipmentSlot(EquipmentSlot.Offhand).getItem()); } catch { return "unreadable"; }
}

const isPlayer = (entity: Entity | undefined): entity is Player => entity?.typeId === "minecraft:player";

// ---------------------------------------------------------------------------------------------------------
// Event logging (every handler is a no-op unless `log on`)
// ---------------------------------------------------------------------------------------------------------

world.afterEvents.playerSwingStart.subscribe((event) => {
    if (!logging) return;
    log(`swing source=${event.swingSource} held=${typeOf(event.heldItemStack)} ${who(event.player)}`);
});

world.afterEvents.itemUse.subscribe((event) => {
    if (!logging) return;
    log(`itemUse ${typeOf(event.itemStack)} ${who(event.source)}`);
});

// Charging items: the events that would tell a held right-click from a tap.
world.afterEvents.itemStartUse.subscribe((event) => {
    if (!logging) return;
    log(`itemStartUse ${typeOf(event.itemStack)} useDuration=${event.useDuration} ${who(event.source)}`);
});
world.afterEvents.itemStopUse.subscribe((event) => {
    if (!logging) return;
    log(`itemStopUse ${typeOf(event.itemStack)} useDuration=${event.useDuration} ${who(event.source)}`);
});
world.afterEvents.itemReleaseUse.subscribe((event) => {
    if (!logging) return;
    log(`itemReleaseUse ${typeOf(event.itemStack)} useDuration=${event.useDuration} ${who(event.source)}`);
});
world.afterEvents.itemCompleteUse.subscribe((event) => {
    if (!logging) return;
    log(`itemCompleteUse ${typeOf(event.itemStack)} useDuration=${event.useDuration} ${who(event.source)}`);
});

world.afterEvents.entityHitEntity.subscribe((event) => {
    if (!logging || !isPlayer(event.damagingEntity)) return;
    log(`hit ${event.hitEntity.typeId} by ${who(event.damagingEntity)}`);
});

world.afterEvents.entityItemDrop.subscribe((event) => {
    if (!logging || !isPlayer(event.entity)) return;
    const items = event.items.map((item) => typeOf(item.getComponent("minecraft:item")?.itemStack)).join(", ");
    log(`itemDrop [${items}] by ${who(event.entity)}`);
});

world.afterEvents.playerInventoryItemChange.subscribe((event) => {
    if (!logging) return;
    log(`inventory slot=${event.slot} ${typeOf(event.beforeItemStack)} -> ${typeOf(event.itemStack)} ${who(event.player)}`);
});

// ---------------------------------------------------------------------------------------------------------
// The off-hand slot has no event of its own that is known to fire on a swap, so it is read
// ---------------------------------------------------------------------------------------------------------

function startOffhandPoll(): void {
    stopOffhandPoll?.();
    const last = new Map<string, string>();
    stopOffhandPoll = onTick("aimprobe:offhand", ({ players }) => {
        for (const player of players) {
            const now = offhandType(player);
            const before = last.get(player.id);
            if (before !== undefined && before !== now) {
                const main = typeOf(player.getComponent("minecraft:equippable")?.getEquipmentSlot(EquipmentSlot.Mainhand).getItem());
                log(`offhand ${before} -> ${now} (main hand ${main}) ${who(player)}`);
            }
            last.set(player.id, now);
        }
    }, { everyTicks: A.offhandPollTicks });
}

function setLogging(on: boolean): void {
    logging = on;
    if (on) startOffhandPoll();
    else { stopOffhandPoll?.(); stopOffhandPoll = undefined; }
}

// ---------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------

function setFov(player: Player, argument: string): void {

    const reset = argument === "reset";
    const fov = Number.parseFloat(argument);

    if (!reset && !(fov >= A.fovMin && fov <= A.fovMax)) {
        tell(player, format("warn", `Give a field of view between ${A.fovMin} and ${A.fovMax} (the engine refuses anything else), or reset: /scriptevent rae:aim_spike fov 40`));
        return;
    }

    try {
        if (reset) player.camera.setFov();
        else player.camera.setFov({ fov, easeOptions: { easeTime: A.fovEaseSeconds } });
    } catch (error) {
        log(`fov ${argument} FAILED: ${error}`);
        tell(player, format("warn", `The camera refused: ${error}`));
        return;
    }

    touched.add(player);
    log(`fov ${argument} ok`);
    tell(player, format("ok", reset ? "Field of view put back." : `Field of view ${fov}.`));
}

function setScope(player: Player, on: boolean): void {
    if (on) {
        showScope(player);
        touched.add(player);
    } else {
        hideScope(player);
    }
    log(`scope ${on ? "on" : "off"}`);
    tell(player, format("ok", on ? "Scope title sent: the overlay should be showing." : "Scope title cleared."));
}

onScriptEvent("rae:aim_spike", (player, message) => {

    if (!player) {
        console.warn(`${LOG} rae:aim_spike has to be run by a player.`);
        return;
    }

    const [command = "", argument = ""] = message.trim().toLowerCase().split(/\s+/);

    if (command === "log" && (argument === "on" || argument === "off")) {
        setLogging(argument === "on");
        tell(player, format("ok", argument === "on" ? "Logging on: swings, uses, drops, hits and off-hand changes go to the content log." : "Logging off."));
    } else if (command === "fov") {
        setFov(player, argument);
    } else if (command === "scope" && (argument === "on" || argument === "off")) {
        setScope(player, argument === "on");
    } else {
        tell(player, format("warn", USAGE));
    }
});

registerSystem({
    name: "aimprobe",
    reset() {
        setLogging(false);
        for (const player of touched) {
            if (!player.isValid) continue;
            try { player.camera.setFov(); } catch { /* nothing to undo */ }
            hideScope(player);
        }
        touched.clear();
    }
});
