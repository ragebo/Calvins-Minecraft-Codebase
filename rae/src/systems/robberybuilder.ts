import {
    CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, EquipmentSlot, system, world,
    type CustomCommandOrigin, type CustomCommandResult, type ItemStack, type Player, type Vector3
} from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { debug, error, info, warn } from "../core/log.js";
import { isOperator } from "../core/players.js";
import { registerSystem } from "../core/registry.js";
import { applyEdit, createRobbery, giveWand, select, selectedId, selectedRobbery, wandOnAir, wandOnBlock, type WandAction } from "../core/robberyedit.js";
import { hasMenuOpen, openAddElement, openElementMenu, openMainMenu, openNewRobbery, openPickRobbery } from "../core/robberyforms.js";
import { activateElement, cooldownLeftSeconds, resetSiteNow, startRobbery, stopRobbery, viewOf, whyCannotActivate, whyCannotStart, whyCannotStop, clock } from "../core/robberyrun.js";
import { boundAt, deleteRobbery, getRobbery, getStored, listStored, rawText, undoLast } from "../core/robberystore.js";
import { onTick } from "../core/tick.js";
import { ACTION_BAR_PRIORITY, format, setActionBar, tell } from "../core/ui.js";
import { describeElement, describeRobbery, parseSettingValue } from "../logic/robberymeta.js";
import { SETTING_KEYS, edgePoints, itemLabel, sameDimension, setArea, setSettings, whyNotRunnable, type Pos, type SettingKey } from "../logic/robbery.js";

/**
 * Building a robbery in the game: the wand, the commands, and the builder view. Operators only, all of it.
 *
 * The wand is a plain item with no behavior of its own. Using it on a block, or on nothing, is turned into a screen by
 * core/robberyedit.ts (what does this click mean?) and core/robberyforms.ts (the screen). The commands are the guaranteed
 * way to do the same, and the only way for something with no player: a command block or an NPC button can start, stop,
 * reset and activate a robbery by id, which is how an old command-block build hands a part of itself to this system.
 *
 * Both a before-event and a custom command's callback run in RESTRICTED execution (measured 2026-10-06): they may read, send a
 * chat line and write a dynamic property, and nothing that changes the world. So each command checks everything it can at once
 * (and answers honestly: an unknown robbery, a cooldown, an element that waits on another is a Failure the player sees), then
 * defers the part that changes the world to the next tick and tells the player how it went.
 */

const SOURCE = "robbery";

const ok = (message: string): CustomCommandResult => ({ status: CustomCommandStatus.Success, message });
const failure = (message: string): CustomCommandResult => ({ status: CustomCommandStatus.Failure, message });

const SETTING_ENUM = "rae:robbery_setting";

// ---------------------------------------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------------------------------------

/** The player behind a command: whoever typed it, or, from an NPC's button, the player who pressed it. */
function playerOf(origin: CustomCommandOrigin): Player | undefined {

    const source = origin.sourceEntity;
    if (source?.typeId === "minecraft:player") return source as Player;

    const initiator = origin.initiator;

    return initiator?.typeId === "minecraft:player" ? (initiator as Player) : undefined;
}

/** How a deferred command reports back: to the player who ran it, or to the log when there is none (a command block). */
function later(origin: CustomCommandOrigin, text: string): void {

    const player = playerOf(origin);

    if (player?.isValid) tell(player, text);
    else info(SOURCE, text.replace(/§./g, ""));
}

const holdsWand = (player: Player, item: ItemStack | undefined): boolean => item?.typeId === R.wandItemId && isOperator(player);

// ---------------------------------------------------------------------------------------------------------
// The wand
// ---------------------------------------------------------------------------------------------------------

/**
 * The last tick each builder's wand click was handled, on a block or on nothing. One click can be reported several ways (the
 * block event, the swing, the item use), so anything that arrives within R.wandClickGapTicks of a click already handled is
 * that same click and is ignored.
 */
const lastWandClick = new Map<string, number>();

const sameClick = (player: Player): boolean => system.currentTick - (lastWandClick.get(player.id) ?? -Infinity) <= R.wandClickGapTicks;

/** The type of the block the wand points at within reach, or undefined when it points at nothing (or the game cannot say). */
function blockInReach(player: Player): string | undefined {

    try {
        return player.getBlockFromViewDirection({ maxDistance: R.wandReach })?.block.typeId;
    } catch {
        return undefined;
    }
}

/** Does what a wand click means: says something, or opens a screen. */
function perform(player: Player, action: WandAction): void {

    if (action.kind === "say") tell(player, format("info", action.text));
    else if (action.kind === "menu") void openMainMenu(player);
    else if (action.kind === "new") void openNewRobbery(player);
    else if (action.kind === "pick") void openPickRobbery(player);
    else if (action.kind === "element") void openElementMenu(player, action.robbery, action.element);
    else void openAddElement(player, action.robbery, action.pos, action.blockType);
}

function guarded(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        error(SOURCE, `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

try {
    world.beforeEvents.playerInteractWithBlock.subscribe((event) => {

        guarded("a wand click on a block", () => {

            if (!holdsWand(event.player, event.itemStack)) return;

            // The wand never places a block, opens a chest or presses a button, whatever it is pointed at.
            event.cancel = true;

            if (!event.isFirstEvent) return;

            const player = event.player;
            const block = event.block;
            const dimension = block.dimension.id;
            const pos: Pos = [block.location.x, block.location.y, block.location.z];
            const type = block.typeId;

            lastWandClick.set(player.id, system.currentTick);

            // Off unless /scriptevent rae:log_debug on: what the game reported, for when a click does not do what it should.
            debug(SOURCE, `wand click on ${type} at ${pos.join(",")} face=${event.blockFace} sneak=${player.isSneaking}`);

            // Everything after this changes saved data or opens a form: not allowed in here.
            system.run(() => guarded("a wand click on a block", () => perform(player, wandOnBlock(player, dimension, pos, type))));
        });
    });
} catch (err) {
    warn(SOURCE, `could not listen for wand clicks on blocks: ${err instanceof Error ? err.message : String(err)}`);
}

try {
    // The wand is for pointing, not for mining: a builder in creative mode would otherwise knock out whatever they click.
    world.beforeEvents.playerBreakBlock.subscribe((event) => {
        guarded("breaking a block with the wand", () => {
            if (holdsWand(event.player, event.itemStack)) event.cancel = true;
        });
    });
} catch (err) {
    warn(SOURCE, `could not listen for the wand breaking blocks: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * A click on nothing. What the game sends for one is not the same for every kind: a LEFT-click in the air is a swing with the
 * source Attack, which the guns already rely on; a RIGHT-click in the air has only been seen as a swing (Interact) or an item
 * use when the game counts it as one, and the spike never recorded a clean sample. So the wand listens for all of them.
 *
 * What it must NOT do is take a click on a block for one on nothing. The game reports a swing (and sometimes an item use) with
 * about half of all block clicks, and never with an iron door, and not at a fixed moment after the block event: the first
 * playtest opened the main menu on top of the element screen for exactly those clicks. A time window cannot catch them all, so
 * the question asked is where the wand points: a block within reach means the click was on it, and the block event has it.
 */
function clickOnNothing(player: Player, how: string): void {

    const block = blockInReach(player);

    if (block !== undefined) {
        debug(SOURCE, `wand ${how} ignored: it points at ${block}, so it is a click on a block`);
        return;
    }

    // The same click reported twice (a swing and an item use): the first one opened the menu.
    if (sameClick(player)) return;

    lastWandClick.set(player.id, system.currentTick);

    debug(SOURCE, `wand click on nothing: ${how}`);

    // Already opening one (an impatient second click): nothing to add, and no reason to tell them off.
    if (hasMenuOpen(player)) return;

    perform(player, wandOnAir(player));
}

/** The swings that can be a click with the wand: a right-click (Interact, Use) or a left-click (Attack). Mining a block is not one. */
const CLICK_SWINGS: readonly string[] = ["Interact", "Use", "Attack"];

try {
    world.afterEvents.playerSwingStart.subscribe((event) => {

        guarded("a wand swing", () => {

            if (!holdsWand(event.player, event.heldItemStack)) return;

            if (!CLICK_SWINGS.includes(event.swingSource)) {
                debug(SOURCE, `wand swing ignored: ${event.swingSource}`);
                return;
            }

            clickOnNothing(event.player, `swing ${event.swingSource}`);
        });
    });
} catch (err) {
    warn(SOURCE, `could not listen for wand swings: ${err instanceof Error ? err.message : String(err)}`);
}

try {
    // The game's own "this item was used": for a right-click with nothing to click on it is the likeliest to fire.
    world.afterEvents.itemUse.subscribe((event) => {

        guarded("a wand item use", () => {

            if (!holdsWand(event.source, event.itemStack)) return;

            clickOnNothing(event.source, "item use");
        });
    });
} catch (err) {
    warn(SOURCE, `could not listen for wand item uses: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------------------------------------
// The builder view: what is bound, where the area is, and what the wand points at
// ---------------------------------------------------------------------------------------------------------

/** Builders who asked to see their robbery marked in the world. */
const viewers = new Set<string>();
let particlesBroken = false;

/** Just over the top of a block. A marker at a block's centre is inside it, and a chest, a door or a button hides what is inside. */
const markerAbove = (pos: Pos): Vector3 => ({ x: pos[0] + 0.5, y: pos[1] + 1.3, z: pos[2] + 0.5 });
const gap = (a: Vector3, b: Vector3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function wandInHand(player: Player): boolean {
    try {
        return player.getComponent("minecraft:equippable")?.getEquipmentSlot(EquipmentSlot.Mainhand).getItem()?.typeId === R.wandItemId;
    } catch {
        return false;
    }
}

function drawMarkers(player: Player, points: readonly Vector3[]): void {

    if (particlesBroken) return;

    try {
        for (const point of points) player.spawnParticle(R.viewParticle, point);
    } catch (err) {
        // A particle id the game does not know would throw on every redraw: say so once and stop drawing.
        particlesBroken = true;
        warn(SOURCE, `the builder view could not draw ${R.viewParticle}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function aimLine(player: Player): string | undefined {

    const hit = player.getBlockFromViewDirection({ maxDistance: R.wandReach });
    if (!hit) return undefined;

    const block = hit.block;
    const bound = boundAt(block.dimension.id, block.location.x, block.location.y, block.location.z);

    if (!bound) return `§7${itemLabel(block.typeId)} §8- right-click it with the wand to bind it`;

    const robbery = getRobbery(bound.robbery);
    const element = robbery?.elements.find((e) => e.id === bound.element);
    if (!robbery || !element) return undefined;

    const state = viewOf(robbery.id)?.elements.find((e) => e.id === element.id)?.state;

    return `§6${element.name} §7(${element.kind}${state ? `, ${state}` : ""}) §8${robbery.name}`;
}

function showView(player: Player): void {

    const robbery = selectedRobbery(player);
    if (!robbery || robbery.dimension !== sameDimension(player.dimension.id)) return;

    const here = player.location;
    const points: Vector3[] = [];

    for (const element of robbery.elements) {
        for (const cell of element.cells) {

            // Over the block, not in it. A block with another block of the same element straight above it (a door's lower half)
            // leaves the marking to the one above, so a door is marked once, over its top.
            if (element.cells.some((other) => other[0] === cell[0] && other[1] === cell[1] + 1 && other[2] === cell[2])) continue;

            const point = markerAbove(cell);
            if (gap(here, point) <= R.viewRange) points.push(point);
        }
    }

    if (robbery.area) {
        for (const edge of edgePoints(robbery.area, R.viewEdgeSpacing, R.viewMaxPoints)) {
            const point = { x: edge[0], y: edge[1], z: edge[2] };
            if (gap(here, point) <= R.viewRange) points.push(point);
        }
    }

    drawMarkers(player, points.slice(0, R.viewMaxPoints));

    if (!wandInHand(player)) return;

    const line = aimLine(player);
    if (line) setActionBar(player, "robbery:view", line, { priority: ACTION_BAR_PRIORITY.tool, ttlTicks: R.viewEvery * 2 });
}

onTick("robbery:view", (context) => {

    // Nobody looking at their robbery: nothing to do, which is almost always.
    if (viewers.size === 0) return;

    for (const id of [...viewers]) {

        const player = context.players.find((candidate) => candidate.id === id);

        if (!player || !player.isValid || !isOperator(player)) {
            viewers.delete(id);
            continue;
        }

        guarded("the builder view", () => showView(player));
    }
}, { everyTicks: R.viewEvery });

// ---------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------

/** The robbery a command means: the one named, or, with none named, the one the builder selected. */
function target(origin: CustomCommandOrigin, named?: string): { readonly id: string } | { readonly problem: string } {

    if (named !== undefined && named.length > 0) return { id: named.toLowerCase() };

    const player = playerOf(origin);
    const chosen = player ? selectedRobbery(player) : undefined;

    if (chosen) return { id: chosen.id };

    return { problem: player ? "select a robbery first: /rae:robbery_select <id>" : "name the robbery: this was not run by a player" };
}

function describeList(): string {

    const stored = listStored();

    if (stored.length === 0) return "No robberies yet. Make one with /rae:robbery_new <id> <name>, then take the wand with /rae:robbery_wand.";

    return stored.map((entry) => {

        if (!entry.ok) return `§c${entry.id}: cannot be read (${entry.problem})`;

        const robbery = entry.robbery;
        const view = viewOf(entry.id);
        const problems = whyNotRunnable(robbery);
        const wait = cooldownLeftSeconds(entry.id);

        const state = view ? (view.phase === "running" ? "§arunning" : "§eending") : problems.length > 0 ? `§enot ready (${problems.length} thing${problems.length === 1 ? "" : "s"} missing)` : wait > 0 ? `§7closed for ${clock(wait)}` : "§7ready";

        return `§f${entry.id}§7: ${robbery.name}, ${robbery.elements.length} element${robbery.elements.length === 1 ? "" : "s"}, ${state}`;
    }).join("\n");
}

function describeInfo(id: string): string {

    const robbery = getRobbery(id);
    if (!robbery) return `there is no robbery ${id}`;

    const lines = [...describeRobbery(robbery, whyNotRunnable(robbery))];

    for (const element of robbery.elements) lines.push("", ...describeElement(robbery, element));

    return lines.join("\n");
}

interface Parameter { readonly name: string; readonly type: CustomCommandParamType }

interface CommandSpec {
    readonly name: string;
    readonly description: string;
    readonly mandatory?: readonly Parameter[];
    readonly optional?: readonly Parameter[];
    readonly run: (origin: CustomCommandOrigin, ...args: any[]) => CustomCommandResult;
}

const STRING = CustomCommandParamType.String;
const BOOLEAN = CustomCommandParamType.Boolean;

const COMMANDS: readonly CommandSpec[] = [
    {
        name: "rae:robbery_list",
        description: "Lists every robbery and whether it is ready.",
        run: () => ok(describeList())
    },
    {
        name: "rae:robbery_info",
        description: "Shows a robbery's settings and elements. Add true to write its saved text to the content log as a backup.",
        mandatory: [{ name: "robbery", type: STRING }],
        optional: [{ name: "raw", type: BOOLEAN }],
        run: (origin, id: string, raw?: boolean) => {
            const wanted = target(origin, id);
            if ("problem" in wanted) return failure(wanted.problem);

            if (raw === true) {
                const text = rawText(wanted.id);
                if (text === undefined) return failure(`there is no robbery ${wanted.id}`);
                info(SOURCE, `${wanted.id} saved as: ${text}`);
                return ok(`Written to the content log (${text.length} characters).`);
            }

            return getRobbery(wanted.id) ? ok(describeInfo(wanted.id)) : failure(`there is no robbery ${wanted.id}`);
        }
    },
    {
        name: "rae:robbery_new",
        description: "Makes a new robbery in the dimension you stand in, and selects it.",
        mandatory: [{ name: "id", type: STRING }, { name: "name", type: STRING }],
        run: (origin, id: string, name: string) => {
            const player = playerOf(origin);
            if (!player) return failure("a new robbery takes the dimension of the player who makes it: run this as a player");

            const made = createRobbery(player, id, name);

            return made.ok ? ok(`Made ${made.robbery.name} (${made.robbery.id}) and selected it. Take the wand with /rae:robbery_wand.`) : failure(made.reason);
        }
    },
    {
        name: "rae:robbery_select",
        description: "Chooses the robbery you are building.",
        mandatory: [{ name: "robbery", type: STRING }],
        run: (origin, id: string) => {
            const player = playerOf(origin);
            if (!player) return failure("this is for a player building a robbery");

            const robbery = getRobbery(id.toLowerCase());
            if (!robbery) return failure(`there is no robbery ${id}`);

            select(player, robbery.id);

            return ok(`Now building ${robbery.name}.`);
        }
    },
    {
        name: "rae:robbery_delete",
        description: "Deletes a robbery for good (until the world is reloaded, undo brings it back). Needs true to be sure.",
        mandatory: [{ name: "robbery", type: STRING }, { name: "confirm", type: BOOLEAN }],
        run: (origin, id: string, confirm: boolean) => {
            if (confirm !== true) return failure("add true at the end to really delete it");

            const key = id.toLowerCase();
            if (!getStored(key)) return failure(`there is no robbery ${id}`);

            const gone = deleteRobbery(key);
            if (!gone.ok) return failure(gone.reason);

            // What it changed in the world is still noted, so the site is put back by the janitor within a second.
            const player = playerOf(origin);
            if (player && selectedId(player) === key) select(player, undefined);

            return ok(`Deleted ${key}. Its doors are shut and chests emptied within a second. /rae:robbery_undo ${key} brings it back.`);
        }
    },
    {
        name: "rae:robbery_start",
        description: "Starts a robbery by hand. Add true for a test run: anyone can take part and there is no cooldown.",
        mandatory: [{ name: "robbery", type: STRING }],
        optional: [{ name: "test", type: BOOLEAN }],
        run: (origin, id: string, test?: boolean) => {
            const wanted = target(origin, id);
            if ("problem" in wanted) return failure(wanted.problem);

            const why = whyCannotStart(wanted.id, { test: test === true });
            if (why) return failure(`${wanted.id}: ${why}`);

            const player = playerOf(origin);

            system.run(() => {
                const result = startRobbery(wanted.id, { by: player, test: test === true });
                if (!result.ok) later(origin, format("warn", `${wanted.id} did not start: ${result.reason}.`));
            });

            return ok(`Starting ${wanted.id}${test === true ? " as a test run" : ""}.`);
        }
    },
    {
        name: "rae:robbery_stop",
        description: "Stops a robbery that is under way. No win or fail effects; its site is put back at once.",
        mandatory: [{ name: "robbery", type: STRING }],
        run: (origin, id: string) => {
            const wanted = target(origin, id);
            if ("problem" in wanted) return failure(wanted.problem);

            const why = whyCannotStop(wanted.id);
            if (why) return failure(`${wanted.id}: ${why}`);

            system.run(() => { stopRobbery(wanted.id); });

            return ok(`Stopping ${wanted.id}.`);
        }
    },
    {
        name: "rae:robbery_reset",
        description: "Puts a robbery's site back now (doors shut, chests emptied), ending it if it is under way, and clears its cooldown.",
        mandatory: [{ name: "robbery", type: STRING }],
        run: (origin, id: string) => {
            const wanted = target(origin, id);
            if ("problem" in wanted) return failure(wanted.problem);
            if (!getStored(wanted.id)) return failure(`there is no robbery ${wanted.id}`);

            system.run(() => {
                const result = resetSiteNow(wanted.id);
                later(origin, format("ok", `${wanted.id}: put back ${result.cleaned} block${result.cleaned === 1 ? "" : "s"}${result.left > 0 ? `; ${result.left} more wait for their chunk to load` : ""}.`));
            });

            return ok(`Putting ${wanted.id} back.`);
        }
    },
    {
        name: "rae:robbery_activate",
        description: "Completes one element of a robbery from outside (a command block, an NPC button). Locks are skipped; what it waits for is not.",
        mandatory: [{ name: "robbery", type: STRING }, { name: "element", type: STRING }],
        run: (origin, id: string, element: string) => {
            const key = id.toLowerCase();
            const why = whyCannotActivate(key, element);
            if (why) return failure(`${key}: ${why}`);

            const player = playerOf(origin);

            system.run(() => {
                const result = activateElement(key, element, player);
                if (!result.ok) later(origin, format("warn", `${key}: ${result.reason}.`));
            });

            return ok(`Activating ${element} in ${key}.`);
        }
    },
    {
        name: "rae:robbery_wand",
        description: "Gives you the builder's wand: right-click a door, chest or button to bind it; left-click the air, or sneak and right-click, for the menu.",
        run: (origin) => {
            const player = playerOf(origin);
            if (!player) return failure("the wand goes to a player: run this as a player");

            system.run(() => {
                tell(player, giveWand(player) ? format("ok", "You have the wand. Right-click a block to bind it; left-click the air, or sneak and right-click, for the menu.") : format("info", "You already have the wand."));
            });

            return ok("Giving you the wand.");
        }
    },
    {
        name: "rae:robbery_edit",
        description: "Opens the builder's menu (the same as left-clicking the air with the wand).",
        run: (origin) => {
            const player = playerOf(origin);
            if (!player) return failure("the menu opens for a player: run this as a player");

            system.run(() => { void openMainMenu(player); });

            return ok("Opening the menu. Close the chat to see it.");
        }
    },
    {
        name: "rae:robbery_view",
        description: "Marks the robbery you are building in the world (its blocks and its area), and shows what the wand points at.",
        optional: [{ name: "on", type: BOOLEAN }],
        run: (origin, on?: boolean) => {
            const player = playerOf(origin);
            if (!player) return failure("the view is drawn for a player: run this as a player");

            const want = on ?? !viewers.has(player.id);

            if (want) viewers.add(player.id);
            else viewers.delete(player.id);

            return ok(want ? "The builder view is on." : "The builder view is off.");
        }
    },
    {
        name: "rae:robbery_undo",
        description: "Undoes the last change to a robbery (or the deletion of one). Doing it again redoes.",
        optional: [{ name: "robbery", type: STRING }],
        run: (origin, id?: string) => {
            const wanted = target(origin, id);
            if ("problem" in wanted) return failure(wanted.problem);

            const result = undoLast(wanted.id);

            return result.ok ? ok(`Undone for ${wanted.id}. Run it again to put it back.`) : failure(result.reason);
        }
    },
    {
        name: "rae:robbery_area",
        description: "Sets the area of the robbery you are building from two corners (~ ~ ~ works).",
        mandatory: [{ name: "from", type: CustomCommandParamType.Location }, { name: "to", type: CustomCommandParamType.Location }],
        run: (origin, from: Vector3, to: Vector3) => {
            const wanted = target(origin);
            if ("problem" in wanted) return failure(wanted.problem);

            const corner = (v: Vector3): Pos => [Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)];
            const outcome = applyEdit(wanted.id, (robbery) => setArea(robbery, corner(from), corner(to)));

            return outcome.ok ? ok(`The area of ${outcome.robbery.name} is set.`) : failure(outcome.reason);
        }
    },
    {
        name: "rae:robbery_set",
        description: "Changes a setting of the robbery you are building: on or off for a switch, whole seconds for a time.",
        mandatory: [{ name: SETTING_ENUM, type: CustomCommandParamType.Enum }, { name: "value", type: STRING }],
        run: (origin, key: SettingKey, value: string) => {
            const wanted = target(origin);
            if ("problem" in wanted) return failure(wanted.problem);

            const parsed = parseSettingValue(key, value);
            if (!parsed.ok) return failure(parsed.reason);

            const outcome = applyEdit(wanted.id, (robbery) => setSettings(robbery, { [key]: parsed.value }));

            return outcome.ok ? ok(`${key} is now ${String(parsed.value)} for ${outcome.robbery.name}.`) : failure(outcome.reason);
        }
    }
];

// A registration mistake (a bare name, an enum used before it exists) throws and, uncaught, would take every command after it
// down too: that is exactly how the rae:config_* commands once all failed at once. So each is tried on its own. Only the log
// hears of a failure, because this runs while the scripts are still starting.
system.beforeEvents.startup.subscribe((event) => {

    const registry = event.customCommandRegistry;

    const attempt = (what: string, fn: () => void): void => {
        try {
            fn();
        } catch (err) {
            warn(SOURCE, `registering ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    attempt(SETTING_ENUM, () => registry.registerEnum(SETTING_ENUM, [...SETTING_KEYS]));

    for (const spec of COMMANDS) {
        attempt(spec.name, () => registry.registerCommand(
            {
                name: spec.name,
                description: spec.description,
                permissionLevel: CommandPermissionLevel.GameDirectors,
                ...(spec.mandatory ? { mandatoryParameters: spec.mandatory.map((p) => ({ name: p.name, type: p.type })) } : {}),
                ...(spec.optional ? { optionalParameters: spec.optional.map((p) => ({ name: p.name, type: p.type })) } : {})
            },
            spec.run
        ));
    }
});

registerSystem({
    name: "robberybuilder",
    reset() {
        lastWandClick.clear();
        viewers.clear();
    }
});
