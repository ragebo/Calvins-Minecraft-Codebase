import * as game from "@minecraft/server";
import {
    BlockPermutation, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, StructureSaveMode, system, world,
    type Block, type CustomCommandOrigin, type CustomCommandResult, type Dimension, type Player, type Vector3
} from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { onScriptEvent } from "../core/events.js";
import { error, warn } from "../core/log.js";
import { isOperator } from "../core/players.js";
import { registerSystem } from "../core/registry.js";
import { format, tell } from "../core/ui.js";
import { classOfBlockType, swingsOpen, type BlockClass } from "../logic/blockclass.js";

/**
 * A measurement, not a feature: `/scriptevent rae:robbery_probe`, and the command `/rae:robbery_probe_ctx`.
 *
 * The robbery framework wires behavior onto blocks the builder built (an iron door, a chest, a button) instead of
 * adding custom blocks. Whether that works depends on how the real game reports things nothing here has ever
 * measured: does a right-click on a chest, door, lever or button reach a script, does setting `cancel` really stop
 * the chest opening or the door swinging, can a script read and fill a chest, can it make loot from a loot table,
 * how big a structure can it save, what is a callback allowed to change. The one block interaction this codebase
 * tried before (placing the Gatling gun) turned out NOT to fire. So this records the facts first; the design
 * branches on them (docs/test-cards/ROBBERY-SPIKE.md has the decision table).
 *
 *   log on|off                  write every block interaction the game reports to the content log
 *   cancel [interact|break|explode] on|off   set `cancel` in the matching "before" event (auto-off, see ROBBERY)
 *   restricted on|off           in the interact "before" event, try a list of APIs and log which ones throw
 *   bench                       lay out a row of test blocks in front of you (operators; it overwrites that strip)
 *   report | clear              summarise what was seen / forget it
 *   door open|close lower|upper|both | door check    drive the door you are looking at (open_bit on one half or both)
 *   container                   read, fill and empty the container you are looking at
 *   loot [path]                 make loot from a loot table
 *   structure sizes|save w h d|place|verify|unloaded    what the structure API allows and keeps
 *   view                        private particles and floating text
 *   tick create|list|remove     a ticking area
 *   itemprop                    set a dynamic property on the item in your hand
 *
 * Every line is written as a content-log warning prefixed `[robbery-probe]`; the findings are the `RESULT` lines.
 * Every engine call is wrapped, so a probe that fails logs the engine's own error text instead of throwing.
 */

const LOG_SOURCE = "robbery-probe";
const log = (text: string): void => warn(LOG_SOURCE, text);
const result = (name: string, value: string): void => log(`RESULT ${name} = ${value}`);

const USAGE = "Usage: /scriptevent rae:robbery_probe log on|off | cancel [interact|break|explode] on|off | restricted on|off | bench | report | clear | door ... | container | loot [path] | structure ... | view | tick ... | itemprop";

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

/** Runs an event handler body so nothing it does can reach the game: a probe must never break a right-click. */
function guard(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        error(LOG_SOURCE, `${label} failed: ${errorText(err)}`);
    }
}

/**
 * Subscribes to one engine event, and if the engine has no such event (or refuses the subscription) writes that
 * to the log instead of throwing: a probe exists to find out what the game offers, and an exception while the
 * script loads would take the whole addon down with it.
 */
function listen<E>(name: string, signal: () => { subscribe(callback: (event: E) => void): unknown }, handler: (event: E) => void): void {
    try {
        signal().subscribe(handler);
    } catch (err) {
        warn(LOG_SOURCE, `RESULT subscribe ${name} = THREW ${errorText(err)}`);
    }
}

const at = (v: Vector3): string => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const posKey = (block: Block): string => `${block.dimension.id}|${at(block.location)}`;

function heldType(player: Player): string {
    try {
        const container = player.getComponent("minecraft:inventory")?.container;
        return container?.getItem(player.selectedSlotIndex)?.typeId ?? "hand";
    } catch {
        return "unreadable";
    }
}

function aimedBlock(player: Player): Block | undefined {
    try {
        return player.getBlockFromViewDirection({ maxDistance: R.probeAimDistance })?.block;
    } catch (err) {
        log(`aim FAILED: ${errorText(err)}`);
        return undefined;
    }
}

function openBit(block: Block | undefined): boolean | undefined {
    if (!block) return undefined;
    try {
        const value = block.permutation.getAllStates()["open_bit"];
        return typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : undefined;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------------------------------------
// What has been seen: one row per (block type, held item), with the events that fired for it
// ---------------------------------------------------------------------------------------------------------

interface Outcomes { total: number; happened: number }
interface Row { readonly block: string; readonly held: string; readonly events: Set<string>; readonly normal: Outcomes; readonly cancelled: Outcomes }

const rows = new Map<string, Row>();

function rowFor(block: string, held: string): Row {
    const key = `${block}|${held}`;
    let existing = rows.get(key);
    if (!existing) {
        existing = { block, held, events: new Set(), normal: { total: 0, happened: 0 }, cancelled: { total: 0, happened: 0 } };
        rows.set(key, existing);
    }
    return existing;
}

const note = (block: string, held: string, event: string): void => { rowFor(block, held).events.add(event); };

/** Which click an event with no click of its own (container opened, button pushed) belongs to. */
const recent = new Map<string, { readonly block: string; readonly held: string; readonly tick: number }>();

function credit(block: Block, event: string): void {
    const found = recent.get(posKey(block));
    const fresh = found !== undefined && system.currentTick - found.tick <= R.probeRecentTicks;
    note(fresh ? found.block : block.typeId, fresh ? found.held : "(no click seen)", event);
}

// ---------------------------------------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------------------------------------

let logging = false;
let restricted = false;
const cancel = { interact: false, break: false, explode: false };
let cancelTimer: number | undefined;

function anyCancel(): boolean {
    return cancel.interact || cancel.break || cancel.explode;
}

function armCancelTimeout(): void {
    if (cancelTimer !== undefined) system.clearRun(cancelTimer);
    cancelTimer = undefined;
    if (!anyCancel()) return;
    cancelTimer = system.runTimeout(() => {
        cancel.interact = cancel.break = cancel.explode = false;
        cancelTimer = undefined;
        log("cancel switched itself off (safety timeout)");
    }, R.probeCancelAutoOffTicks);
}

// ---------------------------------------------------------------------------------------------------------
// Judging whether a click did what it normally does
// ---------------------------------------------------------------------------------------------------------

interface Evaluation {
    readonly pos: string;
    readonly typeId: string;
    readonly held: string;
    readonly cancelled: boolean;
    readonly openBefore: boolean | undefined;
    readonly flags: Set<string>;
    readonly dimension: Dimension;
    readonly location: Vector3;
}

const pending: Evaluation[] = [];

function flagLatest(block: Block, flag: string): void {
    const key = posKey(block);
    for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.pos === key) { pending[i]!.flags.add(flag); return; }
    }
}

/** What "it happened" means for each kind of block: it swung, it opened, it was pressed. Undefined: not judged. */
function happened(evaluation: Evaluation): boolean | undefined {

    const blockClass: BlockClass = classOfBlockType(evaluation.typeId);

    if (swingsOpen(blockClass)) {
        const now = openBit(evaluation.dimension.getBlock(evaluation.location));
        return evaluation.openBefore === undefined || now === undefined ? undefined : now !== evaluation.openBefore;
    }

    if (blockClass === "container") return evaluation.flags.has("container");
    if (blockClass === "button") return evaluation.flags.has("button");
    if (blockClass === "lever") return evaluation.flags.has("lever");

    return undefined;
}

function finish(evaluation: Evaluation): void {

    guard("evaluate", () => {
        const index = pending.indexOf(evaluation);
        if (index !== -1) pending.splice(index, 1);

        const outcome = happened(evaluation);
        if (outcome === undefined) return;

        const row = rowFor(evaluation.typeId, evaluation.held);
        const bucket = evaluation.cancelled ? row.cancelled : row.normal;
        bucket.total++;
        if (outcome) bucket.happened++;

        if (logging) log(`outcome ${evaluation.typeId} held=${evaluation.held} cancelled=${evaluation.cancelled} happened=${outcome}`);
    });
}

// ---------------------------------------------------------------------------------------------------------
// The restricted-mode battery: what may a "before" event (and a command callback) change?
// ---------------------------------------------------------------------------------------------------------

function restrictedBattery(label: string, dimension: Dimension, location: Vector3, player: Player | undefined): void {

    const block = dimension.getBlock(location);
    const marker = `rae_probe_${system.currentTick}`;

    const tests: [string, () => unknown][] = [
        ["Player.sendMessage", () => { if (!player) throw new Error("no player"); player.sendMessage(""); }],
        ["world.getDynamicProperty", () => world.getDynamicProperty("rae:robbery_probe")],
        ["world.setDynamicProperty", () => world.setDynamicProperty("rae:robbery_probe", system.currentTick)],
        ["LootTableManager.getLootTable", () => world.getLootTableManager().getLootTable("chests/gold_2") !== undefined],
        ["Dimension.getBlock", () => dimension.getBlock(location)?.typeId],
        ["Dimension.spawnParticle", () => dimension.spawnParticle("minecraft:endrod", location)],
        ["Block.setPermutation (same permutation)", () => { if (!block) throw new Error("no block"); block.setPermutation(block.permutation); }],
        ["Dimension.runCommand", () => dimension.runCommand("list")],
        ["Entity.addTag", () => { if (!player) throw new Error("no player"); player.addTag(marker); player.removeTag(marker); }],
        ["Dimension.spawnEntity + remove", () => { dimension.spawnEntity("minecraft:armor_stand", location).remove(); }]
    ];

    for (const [name, fn] of tests) result(`restricted[${label}] ${name}`, attempt(fn));
}

// ---------------------------------------------------------------------------------------------------------
// Block events
// ---------------------------------------------------------------------------------------------------------

listen("beforeEvents.playerInteractWithBlock", () => world.beforeEvents.playerInteractWithBlock, (event) => {

    if (!logging && !cancel.interact && !restricted) return;

    guard("before interact", () => {
        const { block, player } = event;
        const held = event.itemStack?.typeId ?? "hand";

        // `log on` is the master switch for recording; cancel and restricted do their own job without it.
        if (logging) {
            note(block.typeId, held, "before");
            recent.set(posKey(block), { block: block.typeId, held, tick: system.currentTick });
            log(`before ${block.typeId} at ${at(block.location)} face=${event.blockFace} first=${event.isFirstEvent} held=${held} sneak=${player.isSneaking} cancel=${cancel.interact}`);

            // A held right-click repeats the event with isFirstEvent false: one outcome per click, not per repeat.
            if (event.isFirstEvent) {
                const evaluation: Evaluation = {
                    pos: posKey(block), typeId: block.typeId, held, cancelled: cancel.interact, openBefore: openBit(block),
                    flags: new Set(), dimension: block.dimension, location: block.location
                };
                pending.push(evaluation);
                system.runTimeout(() => finish(evaluation), R.probeEvaluateTicks);
            }
        }

        if (restricted) restrictedBattery("before interact", block.dimension, block.location, player);

        if (cancel.interact) event.cancel = true;
    });
});

listen("afterEvents.playerInteractWithBlock", () => world.afterEvents.playerInteractWithBlock, (event) => {

    if (!logging) return;

    guard("after interact", () => {
        const held = event.itemStack?.typeId ?? "hand";
        note(event.block.typeId, held, "after");
        log(`after ${event.block.typeId} at ${at(event.block.location)} face=${event.blockFace} first=${event.isFirstEvent} held=${held} sneak=${event.player.isSneaking}`);
    });
});

listen("afterEvents.blockContainerOpened", () => world.afterEvents.blockContainerOpened, (event) => {

    if (!logging) return;

    guard("container opened", () => {
        credit(event.block, "container");
        flagLatest(event.block, "container");
        log(`containerOpened ${event.block.typeId} at ${at(event.block.location)} by=${event.openSource.entity?.typeId ?? "none"}`);
    });
});

listen("afterEvents.blockContainerClosed", () => world.afterEvents.blockContainerClosed, (event) => {

    if (!logging) return;

    guard("container closed", () => log(`containerClosed ${event.block.typeId} at ${at(event.block.location)}`));
});

listen("afterEvents.buttonPush", () => world.afterEvents.buttonPush, (event) => {

    if (!logging) return;

    guard("button", () => {
        credit(event.block, "button");
        flagLatest(event.block, "button");
        log(`buttonPush ${event.block.typeId} at ${at(event.block.location)} source=${event.source.typeId}`);
    });
});

listen("afterEvents.leverAction", () => world.afterEvents.leverAction, (event) => {

    if (!logging) return;

    guard("lever", () => {
        credit(event.block, "lever");
        flagLatest(event.block, "lever");
        log(`leverAction ${event.block.typeId} at ${at(event.block.location)} powered=${event.isPowered} player=${event.player.name}`);
    });
});

listen("afterEvents.pressurePlatePush", () => world.afterEvents.pressurePlatePush, (event) => {

    if (!logging) return;

    guard("plate push", () => {
        credit(event.block, "plate");
        log(`pressurePlatePush ${event.block.typeId} at ${at(event.block.location)} power=${event.redstonePower} source=${event.source.typeId}`);
    });
});

listen("afterEvents.pressurePlatePop", () => world.afterEvents.pressurePlatePop, (event) => {

    if (!logging) return;

    guard("plate pop", () => log(`pressurePlatePop ${event.block.typeId} at ${at(event.block.location)}`));
});

listen("afterEvents.tripWireTrip", () => world.afterEvents.tripWireTrip, (event) => {

    if (!logging) return;

    guard("tripwire", () => {
        credit(event.block, "tripwire");
        log(`tripWireTrip ${event.block.typeId} at ${at(event.block.location)} powered=${event.isPowered} sources=${event.sources.length}`);
    });
});

listen("afterEvents.itemStartUseOn", () => world.afterEvents.itemStartUseOn, (event) => {

    if (!logging) return;

    guard("item start use on", () => {
        const held = event.itemStack?.typeId ?? "hand";
        note(event.block.typeId, held, "useOn");
        log(`itemStartUseOn ${event.block.typeId} at ${at(event.block.location)} face=${event.blockFace} held=${held}`);
    });
});

listen("afterEvents.playerPlaceBlock", () => world.afterEvents.playerPlaceBlock, (event) => {

    if (!logging) return;

    guard("place", () => {
        note(event.block.typeId, heldType(event.player), "place");
        log(`placed ${event.block.typeId} at ${at(event.block.location)} by ${event.player.name}`);
    });
});

listen("beforeEvents.playerBreakBlock", () => world.beforeEvents.playerBreakBlock, (event) => {

    if (!logging && !cancel.break) return;

    guard("before break", () => {
        if (logging) {
            note(event.block.typeId, event.itemStack?.typeId ?? "hand", "break");
            log(`before break ${event.block.typeId} at ${at(event.block.location)} cancel=${cancel.break}`);
        }
        if (cancel.break) event.cancel = true;
    });
});

listen("beforeEvents.explosion", () => world.beforeEvents.explosion, (event) => {

    if (!logging && !cancel.explode) return;

    guard("before explosion", () => {
        if (logging) log(`before explosion impacted=${event.getImpactedBlocks().length} cancel=${cancel.explode}`);
        if (cancel.explode) event.cancel = true;
    });
});

// The wand matrix: an itemUse carries no block, so it is credited to whatever the player is looking at.
listen("afterEvents.itemUse", () => world.afterEvents.itemUse, (event) => {

    if (!logging) return;

    guard("item use", () => {
        const aimed = aimedBlock(event.source);
        const type = aimed?.typeId ?? "(air)";
        note(type, event.itemStack.typeId, "itemUse");
        log(`itemUse ${event.itemStack.typeId} aimed=${type} sneak=${event.source.isSneaking}`);
    });
});

listen("afterEvents.playerSwingStart", () => world.afterEvents.playerSwingStart, (event) => {

    if (!logging) return;

    guard("swing", () => {
        const aimed = aimedBlock(event.player);
        const type = aimed?.typeId ?? "(air)";
        note(type, event.heldItemStack?.typeId ?? "hand", `swing:${event.swingSource}`);
        log(`swing source=${event.swingSource} aimed=${type} held=${event.heldItemStack?.typeId ?? "hand"}`);
    });
});

// ---------------------------------------------------------------------------------------------------------
// bench: a row of test blocks
// ---------------------------------------------------------------------------------------------------------

type States = Record<string, boolean | number | string>;
interface Step { readonly dx: number; readonly dy: number; readonly dz: number; readonly type: string; readonly states?: States }
interface Placement { readonly label: string; readonly steps: readonly Step[] }

const door = (type: string): Placement => ({
    label: type.replace("minecraft:", ""),
    steps: [
        { dx: 0, dy: 0, dz: 0, type, states: { upper_block_bit: false, "minecraft:cardinal_direction": "north", door_hinge_bit: false, open_bit: false } },
        { dx: 0, dy: 1, dz: 0, type, states: { upper_block_bit: true, "minecraft:cardinal_direction": "north", door_hinge_bit: false, open_bit: false } }
    ]
});

const BENCH: readonly Placement[] = [
    { label: "chest", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:chest" }] },
    { label: "trapped_chest", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:trapped_chest" }] },
    { label: "barrel", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:barrel" }] },
    { label: "crafting_table", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:crafting_table" }] },
    { label: "stone", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:stone" }] },
    {
        label: "stone_button",
        steps: [
            { dx: 0, dy: 0, dz: 0, type: "minecraft:stone" },
            { dx: 0, dy: 0, dz: 1, type: "minecraft:stone_button", states: { facing_direction: 3, button_pressed_bit: false } }
        ]
    },
    {
        label: "lever",
        steps: [
            { dx: 0, dy: 0, dz: 0, type: "minecraft:stone" },
            { dx: 0, dy: 0, dz: 1, type: "minecraft:lever", states: { lever_direction: "south", open_bit: false } }
        ]
    },
    { label: "stone_pressure_plate", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:stone_pressure_plate", states: { redstone_signal: 0 } }] },
    door("minecraft:wooden_door"),
    door("minecraft:iron_door"),
    { label: "trapdoor", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:trapdoor" }] },
    { label: "iron_trapdoor", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:iron_trapdoor" }] },
    { label: "fence_gate", steps: [{ dx: 0, dy: 0, dz: 0, type: "minecraft:fence_gate" }] }
];

function placeStep(dimension: Dimension, origin: Vector3, step: Step): string {

    const target = dimension.getBlock({ x: origin.x + step.dx, y: origin.y + step.dy, z: origin.z + step.dz });
    if (!target) return "THREW no block (unloaded chunk?)";

    if (step.states) {
        const withStates = attempt(() => target.setPermutation(BlockPermutation.resolve(step.type, step.states)));
        if (withStates.startsWith("ok")) return "ok";
        const plain = attempt(() => target.setType(step.type));
        return plain.startsWith("ok") ? `ok without states (${withStates})` : plain;
    }

    return attempt(() => target.setType(step.type));
}

function buildBench(player: Player): void {

    const feet = player.location;
    const base = { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y), z: Math.floor(feet.z) + 3 };
    let failed = 0;

    BENCH.forEach((placement, index) => {
        const origin = { x: base.x + index * R.probeBenchSpacing, y: base.y, z: base.z };
        const outcomes = placement.steps.map((step) => placeStep(player.dimension, origin, step));
        const bad = outcomes.filter((o) => !o.startsWith("ok"));
        if (bad.length > 0) failed++;
        result(`bench ${placement.label} at ${at(origin)}`, outcomes.join(" / "));
    });

    const last = base.x + (BENCH.length - 1) * R.probeBenchSpacing;
    tell(player, format(failed === 0 ? "ok" : "warn", `Test bench laid out along +X from ${base.x},${base.y},${base.z} to x=${last}, in the order: ${BENCH.map((p) => p.label).join(", ")}. ${failed === 0 ? "" : `${failed} could not be placed: see the log, and place those by hand. `}Add a double chest by hand.`));
}

// ---------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------

const ratio = (o: Outcomes): string => (o.total === 0 ? "-" : `${o.happened}/${o.total}`);

function verdict(row: Row): string {
    if (row.cancelled.total === 0) return "cancel untested";
    if (row.normal.total === 0) return `cancel: ${ratio(row.cancelled)} happened (no normal baseline)`;
    return row.cancelled.happened === 0 ? "cancel EFFECTIVE" : "cancel INEFFECTIVE";
}

function report(player: Player): void {

    if (rows.size === 0) {
        tell(player, format("warn", "Nothing recorded yet: `log on`, then right-click some blocks."));
        return;
    }

    const lines = [...rows.values()]
        .sort((a, b) => a.block.localeCompare(b.block) || a.held.localeCompare(b.held))
        .map((row) => `${row.block.replace("minecraft:", "")} [${row.held.replace("minecraft:", "")}]: ${[...row.events].sort().join("+") || "-"} | normal ${ratio(row.normal)} | cancelled ${ratio(row.cancelled)} | ${verdict(row)}`);

    for (const line of lines) result("matrix", line);
    tell(player, format("ok", `${lines.length} rows (full text in the content log as RESULT matrix):`));
    for (const line of lines.slice(0, 24)) tell(player, `§7${line}`);
    if (lines.length > 24) tell(player, `§7... ${lines.length - 24} more in the log.`);
}

// ---------------------------------------------------------------------------------------------------------
// door, container, loot, structure, view, tick, itemprop
// ---------------------------------------------------------------------------------------------------------

function probeDoor(player: Player, args: readonly string[]): void {

    const block = aimedBlock(player);
    if (!block) { tell(player, format("warn", "Look at a door (within reach).")); return; }

    const states = attempt(() => block.permutation.getAllStates());
    result(`door states of ${block.typeId}`, states);

    const [verb = "check", which = "both"] = args;

    if (verb === "check") {
        tell(player, format("ok", `${block.typeId}: block states are in the log (RESULT door states).`));
        return;
    }

    const target = verb === "open";
    const lower = block.permutation.getAllStates()["upper_block_bit"] === true ? block.below() : block;
    const upper = lower?.above();

    const halves: [string, Block | undefined][] = which === "lower" ? [["lower", lower]] : which === "upper" ? [["upper", upper]] : [["lower", lower], ["upper", upper]];

    for (const [name, half] of halves) {
        if (!half) { result(`door set ${name}`, "no block"); continue; }
        result(`door set ${name} open_bit=${target}`, attempt(() => half.setPermutation(half.permutation.withState("open_bit", target))));
    }

    for (const delay of R.probeDoorSampleTicks) {
        system.runTimeout(() => {
            guard("door sample", () => result(`door +${delay}t`, `lower open=${summarize(openBit(lower))} upper open=${summarize(openBit(upper))}`));
        }, delay);
    }

    tell(player, format("ok", `Set the ${which} half(s) ${target ? "open" : "closed"}. Samples go to the log at +${R.probeDoorSampleTicks.join(", +")} ticks.`));
}

function probeContainer(player: Player): void {

    const block = aimedBlock(player);
    if (!block) { tell(player, format("warn", "Look at a chest or barrel (within reach).")); return; }

    const inventory = attempt(() => block.getComponent("minecraft:inventory"));
    result(`container component on ${block.typeId}`, inventory);

    const container = (() => { try { return block.getComponent("minecraft:inventory")?.container; } catch { return undefined; } })();
    if (!container) { tell(player, format("warn", `${block.typeId} has no readable container (see the log).`)); return; }

    result("container size", attempt(() => container.size));
    result("container emptySlotsCount before", attempt(() => container.emptySlotsCount));
    result("container setItem(0)", attempt(() => container.setItem(0, new game.ItemStack("minecraft:gold_nugget", 3))));
    result("container addItem", attempt(() => container.addItem(new game.ItemStack("minecraft:gold_ingot", 2))));
    result("container readback slot 0", attempt(() => `${container.getItem(0)?.typeId} x${container.getItem(0)?.amount}`));
    result("container emptySlotsCount after", attempt(() => container.emptySlotsCount));
    result("container clearAll", attempt(() => container.clearAll()));
    result("container emptySlotsCount cleared", attempt(() => container.emptySlotsCount));

    tell(player, format("ok", "Container probe done (the chest was filled and emptied again). See the log."));
}

function probeLoot(player: Player, path: string | undefined): void {

    const paths = path ? [path] : R.probeLootPaths;

    for (const entry of paths) {
        result(`loot table ${entry}`, attempt(() => (world.getLootTableManager().getLootTable(entry) === undefined ? "NOT FOUND" : "found")));
        const generated = attempt(() => {
            const manager = world.getLootTableManager();
            const found = manager.getLootTable(entry);
            if (!found) throw new Error("table not found");
            return (manager.generateLootFromTable(found) ?? []).map((stack) => `${stack.typeId}x${stack.amount}`).join(", ") || "(empty)";
        });
        result(`loot generate ${entry}`, generated);
    }

    tell(player, format("ok", `Loot probe done for ${paths.join(", ")}: see the log.`));
}

function probeStructure(player: Player, args: readonly string[]): void {

    const manager = world.structureManager;
    const feet = player.location;
    const from = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
    const [verb = "", a = "", b = "", c = ""] = args;

    if (verb === "sizes") {
        for (const size of R.probeStructureSizes) {
            const id = `rae:probe_s${size}`;
            const to = { x: from.x + size - 1, y: from.y + size - 1, z: from.z + size - 1 };
            const made = attempt(() => manager.createFromWorld(id, player.dimension, from, to, { saveMode: StructureSaveMode.World, includeEntities: false }));
            result(`structure ${size}x${size}x${size}`, made);
            if (made.startsWith("ok")) attempt(() => manager.delete(id));
        }
        tell(player, format("ok", "Structure size probe done: see the log for the largest cube the game accepted."));
        return;
    }

    if (verb === "save") {
        const w = Number.parseInt(a, 10), h = Number.parseInt(b, 10), d = Number.parseInt(c, 10);
        if (!(w > 0 && h > 0 && d > 0)) { tell(player, format("warn", "structure save <width> <height> <depth>")); return; }
        attempt(() => manager.delete("rae:probe_persist"));
        const made = attempt(() => manager.createFromWorld("rae:probe_persist", player.dimension, from, { x: from.x + w - 1, y: from.y + h - 1, z: from.z + d - 1 }, { saveMode: StructureSaveMode.World, includeEntities: false }));
        result(`structure save rae:probe_persist ${w}x${h}x${d}`, made);
        tell(player, format("ok", "Saved as rae:probe_persist (World mode). Quit and relaunch the game, then `structure verify`."));
        return;
    }

    if (verb === "place") {
        result("structure place rae:probe_persist", attempt(() => manager.place("rae:probe_persist", player.dimension, { x: from.x + 8, y: from.y, z: from.z })));
        tell(player, format("ok", "Placed 8 blocks east of you (it overwrites that area)."));
        return;
    }

    if (verb === "verify") {
        result("structure get rae:probe_persist", attempt(() => manager.get("rae:probe_persist")?.id));
        result("structure world ids", attempt(() => manager.getWorldStructureIds().join(", ") || "(none)"));
        tell(player, format("ok", "Verify done: see the log."));
        return;
    }

    if (verb === "unloaded") {
        const far = { x: from.x + 20000, y: from.y, z: from.z };
        result("structure from an unloaded area", attempt(() => manager.createFromWorld("rae:probe_far", player.dimension, far, { x: far.x + 4, y: far.y + 4, z: far.z + 4 }, { saveMode: StructureSaveMode.Memory, includeEntities: false })));
        attempt(() => manager.delete("rae:probe_far"));
        tell(player, format("ok", "Unloaded-area probe done: see the log."));
        return;
    }

    tell(player, format("warn", "structure sizes | save <w> <h> <d> | place | verify | unloaded"));
}

function probeView(player: Player): void {

    const feet = player.location;
    const ring = 8;

    for (let i = 0; i < ring; i++) {
        const angle = (i / ring) * Math.PI * 2;
        const spot = { x: feet.x + Math.cos(angle) * R.probeViewRadius, y: feet.y + 1, z: feet.z + Math.sin(angle) * R.probeViewRadius };
        const outcome = attempt(() => player.spawnParticle("minecraft:endrod", spot));
        if (i === 0) result("view Player.spawnParticle", outcome);
    }

    result("view TextPrimitive", attempt(() => {
        const text = new game.TextPrimitive({ x: feet.x, y: feet.y + 2.5, z: feet.z + 2 }, "robbery probe");
        text.visibleTo = [player];
        text.timeLeft = R.probeViewSeconds;
        text.depthTest = false;
        world.primitiveShapesManager.addText(text, player.dimension);
        return `maxShapes=${world.primitiveShapesManager.maxShapes}`;
    }));

    tell(player, format("ok", `A ring of particles and a floating "robbery probe" label (${R.probeViewSeconds}s) were sent to you only. Ask a second player whether they see them.`));
}

function probeTick(player: Player, args: readonly string[]): void {

    const manager = world.tickingAreaManager;
    const feet = player.location;
    const options = { dimension: player.dimension, from: { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }, to: { x: Math.floor(feet.x) + 15, y: Math.floor(feet.y) + 4, z: Math.floor(feet.z) + 15 } };
    const [verb = ""] = args;

    if (verb === "create") {
        result("ticking hasCapacity", attempt(() => manager.hasCapacity(options)));
        try {
            manager.createTickingArea("rae:probe_tick", options).then(
                () => result("ticking create rae:probe_tick", "ok (resolved)"),
                (err: unknown) => result("ticking create rae:probe_tick", `REJECTED ${errorText(err)}`)
            );
        } catch (err) {
            result("ticking create rae:probe_tick", `THREW ${errorText(err)}`);
        }
    } else if (verb === "list") {
        result("ticking areas", attempt(() => manager.getAllTickingAreas().map((area) => area.identifier).join(", ") || "(none)"));
        result("ticking chunkCount/maxChunkCount", attempt(() => `${manager.chunkCount}/${manager.maxChunkCount}`));
    } else if (verb === "remove") {
        result("ticking remove rae:probe_tick", attempt(() => manager.removeTickingArea("rae:probe_tick")));
    } else {
        tell(player, format("warn", "tick create | list | remove"));
        return;
    }

    tell(player, format("ok", "Ticking-area probe done: see the log (relaunch and `tick list` to see whether it survived)."));
}

function probeItemProperty(player: Player): void {

    const container = player.getComponent("minecraft:inventory")?.container;
    const stack = container?.getItem(player.selectedSlotIndex);

    if (!stack) { tell(player, format("warn", "Hold an item first.")); return; }

    result(`item ${stack.typeId} setDynamicProperty`, attempt(() => stack.setDynamicProperty("rae:probe", 1)));
    result(`item ${stack.typeId} getDynamicProperty`, attempt(() => stack.getDynamicProperty("rae:probe")));
    tell(player, format("ok", "Item property probe done: see the log."));
}

// ---------------------------------------------------------------------------------------------------------
// The script event
// ---------------------------------------------------------------------------------------------------------

const MUTATING = new Set(["bench", "door", "container", "structure", "tick"]);

function clearAll(): void {
    rows.clear();
    recent.clear();
    pending.length = 0;
}

function switchOff(): void {
    logging = false;
    restricted = false;
    cancel.interact = cancel.break = cancel.explode = false;
    armCancelTimeout();
}

onScriptEvent("rae:robbery_probe", (player, message) => {

    if (!player) {
        warn(LOG_SOURCE, "rae:robbery_probe has to be run by a player.");
        return;
    }

    const [command = "", ...args] = message.trim().toLowerCase().split(/\s+/);

    if (MUTATING.has(command) && !isOperator(player)) {
        tell(player, format("warn", "Operators only: this probe changes the world."));
        return;
    }

    const last = args[args.length - 1];
    const on = last === "on";
    const off = last === "off";

    if (command === "log" && (on || off)) {
        logging = on;
        tell(player, format("ok", on ? "Logging on: block interactions go to the content log." : "Logging off."));
    } else if (command === "cancel" && (on || off)) {
        const which = args.length > 1 ? args[0] : "interact";
        if (which !== "interact" && which !== "break" && which !== "explode") { tell(player, format("warn", USAGE)); return; }
        cancel[which] = on;
        armCancelTimeout();
        tell(player, format(on ? "warn" : "ok", on ? `Cancel ON for ${which}: those actions will be refused until you turn it off (it switches itself off in ${Math.round(R.probeCancelAutoOffTicks / 20)}s).` : `Cancel off for ${which}.`));
    } else if (command === "restricted" && (on || off)) {
        restricted = on;
        tell(player, format("ok", on ? "Restricted probe on: each block right-click now tries a list of APIs inside the before event and logs which throw." : "Restricted probe off."));
    } else if (command === "bench") {
        buildBench(player);
    } else if (command === "report") {
        report(player);
    } else if (command === "clear") {
        clearAll();
        tell(player, format("ok", "Recorded rows cleared."));
    } else if (command === "door") {
        probeDoor(player, args);
    } else if (command === "container") {
        probeContainer(player);
    } else if (command === "loot") {
        probeLoot(player, args[0]);
    } else if (command === "structure") {
        probeStructure(player, args);
    } else if (command === "view") {
        probeView(player);
    } else if (command === "tick") {
        probeTick(player, args);
    } else if (command === "itemprop") {
        probeItemProperty(player);
    } else {
        tell(player, format("warn", USAGE));
    }
});

// ---------------------------------------------------------------------------------------------------------
// The command-context probe: what may a custom command's callback do, and who is "the player" from an NPC?
// ---------------------------------------------------------------------------------------------------------

function describeEntity(entity: { typeId: string } | undefined): string {
    return entity ? entity.typeId : "none";
}

function runContextProbe(origin: CustomCommandOrigin): CustomCommandResult {

    const source = origin.sourceEntity;
    const player = source?.typeId === "minecraft:player" ? (source as Player) : undefined;
    const block = origin.sourceBlock;

    result("ctx origin", `sourceType=${origin.sourceType} sourceEntity=${describeEntity(origin.sourceEntity)} initiator=${describeEntity(origin.initiator)} sourceBlock=${block ? block.typeId : "none"}`);

    const dimension = (block ?? source ?? origin.initiator)?.dimension;
    const location = block?.location ?? source?.location ?? origin.initiator?.location;

    if (!dimension || !location) {
        result("ctx battery", "skipped: no dimension or location on this origin");
        return { status: CustomCommandStatus.Failure, message: "No location to test at: see the log." };
    }

    restrictedBattery("custom command", dimension, location, player ?? (origin.initiator?.typeId === "minecraft:player" ? (origin.initiator as Player) : undefined));
    return { status: CustomCommandStatus.Success, message: "Context probe ran: see the content log (RESULT ctx / restricted[custom command])." };
}

system.beforeEvents.startup.subscribe((event) => {
    try {
        event.customCommandRegistry.registerCommand(
            {
                name: "rae:robbery_probe_ctx",
                description: "Robbery probe: tries a list of world changes from inside a command and logs which are refused, plus who the origin is.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                mandatoryParameters: [{ name: "note", type: CustomCommandParamType.String }]
            },
            (origin: CustomCommandOrigin) => runContextProbe(origin)
        );
    } catch (err) {
        error(LOG_SOURCE, `registering rae:robbery_probe_ctx failed: ${errorText(err)}`);
    }
});

registerSystem({
    name: "robberyprobe",
    reset() {
        // A round reset must never leave a cancel flag on: it would stop every chest and door for everyone.
        switchOff();
        clearAll();
    }
});
