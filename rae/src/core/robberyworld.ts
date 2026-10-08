import { ItemStack, StructureSaveMode, world, type Block, type Container, type Dimension, type Vector3 } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { classOfBlockType, swingsOpen } from "../logic/blockclass.js";
import { type Pos } from "../logic/robbery.js";
import { debug, warn } from "./log.js";

/**
 * Everything a robbery does to the blocks of the world, in one place: swing a door, fill and empty a chest, ask what a
 * block is, ask whether it can be reached at all. This is the only robbery file that touches engine behavior that was
 * measured once and could differ (door `open_bit`, container contents, loot generation), so when the game disagrees
 * with an assumption there is one file to fix.
 *
 * Nothing here throws, and nothing here calls the engine from a before-event: the callers run inside `system.run` or
 * the tick loop, because a before-event callback may not change the world (measured 2026-10-06).
 *
 * A position in an unloaded chunk is not an error, it is "not now": the answer is undefined or false, and the caller
 * tries again when the chunk is back. Nothing is ever written to a block that could not be read first.
 */

const SOURCE = "robbery";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

const reported = new Set<string>();

/** A problem worth knowing about, reported once per distinct text so a tick loop cannot flood the log. */
function once(message: string): void {
    if (reported.has(message) || reported.size > 60) return;
    reported.add(message);
    warn(SOURCE, message);
}

const vector = (pos: Pos): Vector3 => ({ x: pos[0], y: pos[1], z: pos[2] });
const label = (pos: Pos): string => `${pos[0]},${pos[1]},${pos[2]}`;

// ---------------------------------------------------------------------------------------------------------
// Looking
// ---------------------------------------------------------------------------------------------------------

/** The dimension a robbery names ("overworld", "nether", "the_end"), or undefined if the game has no such one. */
export function dimensionOf(name: string): Dimension | undefined {
    try {
        return world.getDimension(name);
    } catch (err) {
        once(`there is no dimension ${name}: ${errorText(err)}`);
        return undefined;
    }
}

/** Whether the chunk holding this position is loaded. False on any failure. */
export function isLoaded(dimension: string, pos: Pos): boolean {

    const dim = dimensionOf(dimension);
    if (!dim) return false;

    try {
        return dim.isChunkLoaded(vector(pos));
    } catch {
        return false;
    }
}

/** The block at a position, or undefined when its chunk is not loaded. */
export function blockAt(dimension: string, pos: Pos): Block | undefined {

    const dim = dimensionOf(dimension);
    if (!dim) return undefined;

    try {
        return dim.getBlock(vector(pos));
    } catch {
        return undefined;
    }
}

/** The type id of the block at a position ("minecraft:iron_door"), or undefined when it cannot be read. */
export function typeAt(dimension: string, pos: Pos): string | undefined {

    const block = blockAt(dimension, pos);
    if (!block) return undefined;

    try {
        return block.typeId;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------------------------------------

/** What a door element reads as: every bound block open, every one shut, a mixture, or unreadable right now. */
export type DoorState = "open" | "closed" | "mixed" | "unknown";

function openBitOf(block: Block): boolean | undefined {

    try {
        const value = block.permutation.getAllStates()["open_bit"];
        return typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The other half of a door: the block above a lower half, below an upper half. Setting one half alone leaves the two
 * out of step (measured), so a door is always swung as a pair. Undefined for anything that is not a two-high door.
 */
function partnerOf(dimension: string, pos: Pos, block: Block): Pos | undefined {

    if (classOfBlockType(block.typeId) !== "door") return undefined;

    try {
        const upper = block.permutation.getAllStates()["upper_block_bit"];
        if (typeof upper !== "boolean") return undefined;

        const other: Pos = [pos[0], pos[1] + (upper ? -1 : 1), pos[2]];
        const next = blockAt(dimension, other);

        return next && classOfBlockType(next.typeId) === "door" ? other : undefined;
    } catch {
        return undefined;
    }
}

/** The cells to swing: the ones given, plus the missing half of any door among them. */
function withPartners(dimension: string, cells: readonly Pos[]): Pos[] {

    const wanted = new Map<string, Pos>(cells.map((cell) => [label(cell), cell] as const));

    for (const cell of cells) {
        const block = blockAt(dimension, cell);
        const partner = block ? partnerOf(dimension, cell, block) : undefined;
        if (partner && !wanted.has(label(partner))) wanted.set(label(partner), partner);
    }

    return [...wanted.values()];
}

/**
 * The blocks to bind for a click on `pos`: for a door, both halves; for anything else, just the block. The builder
 * uses this so a door is never bound by one half only.
 */
export function cellsToBind(dimension: string, pos: Pos): Pos[] {

    const block = blockAt(dimension, pos);
    if (!block) return [pos];

    const partner = partnerOf(dimension, pos, block);

    if (!partner) return [pos];

    // Lower half first, so the saved order is the same whichever half was clicked.
    return pos[1] <= partner[1] ? [pos, partner] : [partner, pos];
}

export function readDoor(dimension: string, cells: readonly Pos[]): DoorState {

    let open = 0;
    let closed = 0;

    for (const cell of cells) {

        const block = blockAt(dimension, cell);
        if (!block) return "unknown";

        const bit = openBitOf(block);
        if (bit === undefined) return "unknown";

        if (bit) open++;
        else closed++;
    }

    if (open > 0 && closed > 0) return "mixed";
    if (open > 0) return "open";
    if (closed > 0) return "closed";

    return "unknown";
}

/**
 * Swings the door open or shut. True when every block (and the other half of any door) now has the wanted state; false
 * when some could not be reached, so the caller knows to try again. A block that is not something that swings is
 * reported once and counts as not done.
 */
export function setDoor(dimension: string, cells: readonly Pos[], open: boolean): boolean {

    let everyBlock = true;

    for (const cell of withPartners(dimension, cells)) {

        const block = blockAt(dimension, cell);

        if (!block) {
            everyBlock = false;
            continue;
        }

        try {

            if (!swingsOpen(classOfBlockType(block.typeId)) || openBitOf(block) === undefined) {
                once(`${block.typeId} at ${label(cell)} does not open and close, so the robbery cannot swing it`);
                everyBlock = false;
                continue;
            }

            if (openBitOf(block) === open) continue;

            block.setPermutation(block.permutation.withState("open_bit", open));

        } catch (err) {
            once(`could not swing the door at ${label(cell)}: ${errorText(err)}`);
            everyBlock = false;
        }
    }

    return everyBlock;
}

// ---------------------------------------------------------------------------------------------------------
// Chests
// ---------------------------------------------------------------------------------------------------------

function containerAt(dimension: string, pos: Pos): { readonly container: Container | undefined; readonly reachable: boolean } {

    const block = blockAt(dimension, pos);
    if (!block) return { container: undefined, reachable: false };

    try {
        return { container: block.getComponent("minecraft:inventory")?.container, reachable: true };
    } catch (err) {
        once(`could not open the container at ${label(pos)}: ${errorText(err)}`);
        return { container: undefined, reachable: true };
    }
}

export interface FillResult {
    /** At least one stack went in. */
    readonly ok: boolean;
    /** How many stacks went into the chest. */
    readonly stacks: number;
    /** Something went wrong (a missing table, a chest too full), for the log; the fill still did what it could. */
    readonly problem?: string;
}

/** The stacks a chest element hands out: what its loot table rolls, then its fixed items. */
function stacksFor(table: string | undefined, items: readonly (readonly [string, number])[], problems: string[]): ItemStack[] {

    const stacks: ItemStack[] = [];

    if (table !== undefined) {

        try {
            const loot = world.getLootTableManager().getLootTable(table);

            if (!loot) {
                problems.push(`there is no loot table ${table}`);
            } else {
                stacks.push(...(world.getLootTableManager().generateLootFromTable(loot) ?? []));
            }
        } catch (err) {
            problems.push(`loot table ${table} failed: ${errorText(err)}`);
        }
    }

    for (const [id, amount] of items) {

        try {
            stacks.push(new ItemStack(id, amount));
        } catch (err) {
            problems.push(`item ${id} is not valid: ${errorText(err)}`);
        }
    }

    return stacks;
}

/**
 * Puts a chest element's loot in: the table's roll, then the fixed items. They go in through the first block that has
 * an inventory (a double chest reads as one container from either half, or as two halves, and the rest are tried for
 * anything that did not fit). Never throws; `problem` says what went wrong.
 */
export function fillChest(dimension: string, cells: readonly Pos[], table: string | undefined, items: readonly (readonly [string, number])[]): FillResult {

    const problems: string[] = [];
    const containers: Container[] = [];

    for (const cell of cells) {
        const found = containerAt(dimension, cell);
        if (found.container && !containers.includes(found.container)) containers.push(found.container);
        if (!found.reachable) return { ok: false, stacks: 0, problem: `the chest at ${label(cell)} is not loaded` };
    }

    if (containers.length === 0) return { ok: false, stacks: 0, problem: `there is no container at ${cells.map(label).join(" / ")}` };

    let stacks = 0;
    let lost = 0;

    for (const stack of stacksFor(table, items, problems)) {

        let rest: ItemStack | undefined = stack;

        for (const container of containers) {

            try {
                rest = container.addItem(rest);
            } catch (err) {
                problems.push(`could not add ${stack.typeId}: ${errorText(err)}`);
                break;
            }

            if (rest === undefined) break;
        }

        // A stack that only partly fitted still put something in; what is left over is what was lost.
        if (rest === undefined || rest.amount < stack.amount) stacks++;
        if (rest !== undefined) lost += rest.amount;
    }

    if (lost > 0) problems.push(`the chest was full: ${lost} item${lost === 1 ? "" : "s"} did not fit`);

    const problem = problems.length > 0 ? problems.join("; ") : undefined;

    if (problem) once(`filling ${cells.map(label).join(" / ")}: ${problem}`);

    return { ok: stacks > 0, stacks, ...(problem !== undefined ? { problem } : {}) };
}

/**
 * The chest right beside this one (north, south, east or west, same type): most likely the other half of a double chest.
 * Undefined when there is none, or more than one (then it cannot be told which).
 */
export function neighbourChest(dimension: string, pos: Pos): Pos | undefined {

    const type = typeAt(dimension, pos);
    if (type === undefined) return undefined;

    const found: Pos[] = [];

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const next: Pos = [pos[0] + dx, pos[1], pos[2] + dz];
        if (typeAt(dimension, next) === type) found.push(next);
    }

    return found.length === 1 ? found[0] : undefined;
}

/** Whether the game has a loot table at this path (this pack's and the game's own are both visible). Undefined if it cannot be asked. */
export function lootTableExists(path: string): boolean | undefined {

    try {
        return world.getLootTableManager().getLootTable(path) !== undefined;
    } catch {
        return undefined;
    }
}

/**
 * Takes everything out of a chest element's blocks. True when every block is now empty or is no longer a container;
 * false when one could not be reached (try again later). Whatever was in the chest is removed, the builder's own items
 * too: a bound chest holds only what the robbery puts in it.
 */
export function emptyChest(dimension: string, cells: readonly Pos[]): boolean {

    let everyBlock = true;

    for (const cell of cells) {

        const found = containerAt(dimension, cell);

        if (!found.reachable) {
            everyBlock = false;
            continue;
        }

        if (!found.container) continue;

        try {
            found.container.clearAll();
        } catch (err) {
            once(`could not empty the chest at ${label(cell)}: ${errorText(err)}`);
            everyBlock = false;
        }
    }

    return everyBlock;
}

/** Whether a chest element's blocks hold nothing right now. Unreadable counts as not empty. */
export function chestIsEmpty(dimension: string, cells: readonly Pos[]): boolean {

    for (const cell of cells) {

        const found = containerAt(dimension, cell);

        if (!found.reachable) return false;
        if (!found.container) continue;

        try {
            if (found.container.emptySlotsCount !== found.container.size) return false;
        } catch {
            return false;
        }
    }

    return true;
}

/** The stacks a chest or frame element hands out: what its loot table rolls, then its fixed items. `problems` says what could not be made. */
export function lootStacks(table: string | undefined, items: readonly (readonly [string, number])[]): { readonly stacks: ItemStack[]; readonly problems: string[] } {

    const problems: string[] = [];
    const stacks = stacksFor(table, items, problems);

    return { stacks, problems };
}

/** Drops stacks on the ground at a point. Answers how many were dropped; never throws. */
export function dropItems(dimension: string, at: Vector3, stacks: readonly ItemStack[]): number {

    const dim = dimensionOf(dimension);
    if (!dim) return 0;

    let dropped = 0;

    for (const stack of stacks) {
        try {
            dim.spawnItem(stack, at);
            dropped++;
        } catch (err) {
            once(`could not drop ${stack.typeId}: ${errorText(err)}`);
        }
    }

    return dropped;
}

// ---------------------------------------------------------------------------------------------------------
// Item frames
// ---------------------------------------------------------------------------------------------------------

/**
 * An item frame is a BLOCK in Bedrock, with a block entity that holds the item it shows, and the scripting API has nothing for
 * it: a script can neither read that item nor set it. The one thing that can put an item back in a frame is a structure, so a
 * bound frame is saved as a one-block structure and put back from that.
 *
 * Measured in the real game: a World-mode structure with a `rae:` id survives leaving the world, and one made over an unloaded
 * area saves air without complaint (so the chunk is checked first). Measured 2026-10-08 (the owner, BP 0.2.1): a frame put back
 * with the structure placed OVER the frame standing there held its item (it could be taken) but showed nothing. NOT measured: what
 * a punch on a frame does; docs/test-cards/ROBBERY-FRAME.md measures that.
 */

const coordinate = (n: number): string => (n < 0 ? `m${-n}` : String(n));

/**
 * The name a frame's saved copy has: by robbery and position, never by element, so putting a site back needs nothing but the
 * note the janitor already keeps (an element may be edited or deleted while its site is dirty). A minus sign becomes an m.
 */
export const frameStructureId = (robbery: string, pos: Pos): string =>
    `${R.frameStructurePrefix}${robbery}_${coordinate(pos[0])}_${coordinate(pos[1])}_${coordinate(pos[2])}`;

/** Whether the block at this position is an item frame (or a glow item frame). */
export function isFrameAt(dimension: string, pos: Pos): boolean {

    const type = typeAt(dimension, pos);

    return type !== undefined && classOfBlockType(type) === "frame";
}

export interface CaptureResult {
    readonly ok: boolean;
    /** Why it could not be saved, in words for the builder. */
    readonly problem?: string;
}

/** Saves the frame as it is now, with the item it shows, replacing any earlier copy. */
export function captureFrame(dimension: string, robbery: string, pos: Pos): CaptureResult {

    const dim = dimensionOf(dimension);
    if (!dim) return { ok: false, problem: `there is no dimension ${dimension}` };

    // A structure made over an unloaded area is air, and the game says nothing: check first. (These two are read by the builder, so the position is spelt out.)
    if (!isLoaded(dimension, pos)) return { ok: false, problem: `${pos.join(", ")} is not loaded right now` };
    if (!isFrameAt(dimension, pos)) return { ok: false, problem: `there is no item frame at ${pos.join(", ")}` };

    const id = frameStructureId(robbery, pos);

    try {
        const manager = world.structureManager;

        // An id must be new to be made, so a copy that is already there goes first.
        if (manager.get(id) !== undefined) manager.delete(id);

        manager.createFromWorld(id, dim, vector(pos), vector(pos), { saveMode: StructureSaveMode.World, includeEntities: false });

        return { ok: true };
    } catch (err) {
        once(`could not save the frame at ${label(pos)}: ${errorText(err)}`);
        return { ok: false, problem: errorText(err) };
    }
}

/** Whether a saved copy of this frame exists. Undefined when the game cannot be asked. */
export function frameIsCaptured(robbery: string, pos: Pos): boolean | undefined {

    try {
        return world.structureManager.get(frameStructureId(robbery, pos)) !== undefined;
    } catch {
        return undefined;
    }
}

/**
 * Empties a frame: the block is replaced by air and then by the same frame again, which has no item. True when that was done or
 * there was no frame there to empty; false when it could not be reached (try again later).
 */
export function emptyFrame(dimension: string, pos: Pos): boolean {

    const block = blockAt(dimension, pos);
    if (!block) return false;

    try {
        if (classOfBlockType(block.typeId) !== "frame") return true;

        const permutation = block.permutation;

        block.setType("minecraft:air");
        block.setPermutation(permutation);

        return true;
    } catch (err) {
        once(`could not empty the frame at ${label(pos)}: ${errorText(err)}`);
        return false;
    }
}

/**
 * The result of putting a frame back. "missing": there is no saved copy and never will be, so there is nothing to wait for.
 * "unreachable": its chunk is not loaded or the game refused, so try again later.
 */
export type Restored = "restored" | "missing" | "unreachable";

/**
 * Puts the frame back from its saved copy, with the item it showed.
 *
 * A frame already standing there is cleared first. Placed over it, the saved copy put its item in the frame (the owner could take
 * it) and nobody could see it: the likely reason is that a structure loaded into a block identical to the one it replaces changes
 * the frame's data in place and the players' screens are never told. Every other way a frame gets into the world is a NEW block, and
 * that is announced, so the spot is made air and the frame placed again; it is the same two steps `emptyFrame` takes the other way.
 * The saved copy is looked for first, so a frame that cannot be put back is never cleared; and if the placement fails after the
 * clearing, the answer is "unreachable" and the next try finds air and places it.
 */
export function restoreFrame(dimension: string, robbery: string, pos: Pos): Restored {

    const dim = dimensionOf(dimension);
    if (!dim || !isLoaded(dimension, pos)) return "unreachable";

    const id = frameStructureId(robbery, pos);

    try {
        const manager = world.structureManager;

        if (manager.get(id) === undefined) return "missing";

        const standing = blockAt(dimension, pos);
        const clear = standing !== undefined && classOfBlockType(standing.typeId) === "frame";

        if (clear) standing.setType("minecraft:air");

        manager.place(id, dim, vector(pos), { includeEntities: false });

        debug(SOURCE, `the frame at ${label(pos)} was put back${clear ? " after clearing the frame standing there" : " on an empty spot"}`);

        return "restored";
    } catch (err) {
        once(`could not put the frame at ${label(pos)} back: ${errorText(err)}`);
        return "unreachable";
    }
}

/**
 * Takes away the dropped items named in `only` that are lying within `reach` blocks of `at`: what a punch popped out of a frame.
 * Only items named are touched, so nothing else lying on the floor near a frame is ever removed. Answers how many went.
 */
export function removeItemsNear(dimension: string, at: Vector3, reach: number, only: ReadonlySet<string>): number {

    const dim = dimensionOf(dimension);
    if (!dim || only.size === 0) return 0;

    let removed = 0;

    try {
        for (const entity of dim.getEntities({ type: "minecraft:item", location: at, maxDistance: reach })) {

            if (!only.has(entity.id)) continue;

            const where = entity.location;
            if (Math.hypot(where.x - at.x, where.y - at.y, where.z - at.z) > reach) continue;

            try {
                entity.remove();
                removed++;
            } catch (err) {
                once(`could not remove a dropped item: ${errorText(err)}`);
            }
        }
    } catch (err) {
        once(`could not look for dropped items: ${errorText(err)}`);
    }

    return removed;
}
