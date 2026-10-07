import { world } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { parse, posKey, sameDimension, serialize, type Pos, type Robbery } from "../logic/robbery.js";
import { warn } from "./log.js";

/**
 * Where robberies live: one world property each, `rae:robbery:def:<id>`, holding logic/robbery.ts's saved text.
 *
 * Not core/persist.ts: that engine saves state a module can rebuild and silently skips a key over its 10,000-character
 * cap, which would lose a builder's work without a word. A robbery is authored data (the one deliberate exception to
 * CLAUDE.md rule 3, with the recorded train route), so every edit is written the moment it is made, an edit that does
 * not fit is refused before anything changes, and a robbery that cannot be read is listed and never overwritten.
 *
 * Read lazily, on first use: a world property is not available while the scripts are still loading.
 *
 * Also here: the list of blocks a run has changed (an opened door, a filled chest) and not yet put back. It is saved
 * with each change, so a crash or a reload in the middle of a robbery cannot leave a site open for good: the janitor in
 * core/robberyrun.ts reads it back and cleans up. The list is by block position, not by robbery or element, so editing
 * or deleting a robbery while its site is dirty cannot orphan the cleanup.
 */

const DEFINITION_PREFIX = "rae:robbery:def:";
const DIRTY_PROPERTY = "rae:robbery:dirty";

const SOURCE = "robbery";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

// ---------------------------------------------------------------------------------------------------------
// The robberies
// ---------------------------------------------------------------------------------------------------------

/** A saved robbery that reads, or one that does not (and says why). */
export type Stored =
    | { readonly ok: true; readonly id: string; readonly robbery: Robbery }
    | { readonly ok: false; readonly id: string; readonly problem: string };

export type SaveResult = { readonly ok: true; readonly robbery: Robbery } | { readonly ok: false; readonly reason: string };
export type PlainResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const entries = new Map<string, Stored>();
let loaded = false;
let loadFailureReported = false;

/** Bumped by every change, so anything built from the robberies (the position index) knows when it is stale. */
let version = 0;

/**
 * The text each robbery had before its last change, for one level of undo: `undefined` means it did not exist.
 * Kept in memory only, so a reload forgets it. Undoing swaps, so undoing twice puts it back.
 */
const undoSlots = new Map<string, string | undefined>();

const propertyOf = (id: string): string => `${DEFINITION_PREFIX}${id}`;

function readText(id: string): string | undefined {
    try {
        const raw = world.getDynamicProperty(propertyOf(id));
        return typeof raw === "string" ? raw : undefined;
    } catch (err) {
        warn(SOURCE, `could not read ${id}: ${errorText(err)}`);
        return undefined;
    }
}

/** Reads one saved robbery into `entries`, or notes why it cannot be read. `text` undefined removes it. */
function take(id: string, text: string | undefined): void {

    if (text === undefined) {
        entries.delete(id);
        return;
    }

    const parsed = parse(text);

    if (!parsed.ok) {
        entries.set(id, { ok: false, id, problem: parsed.reason });
        warn(SOURCE, `${id} is saved but cannot be read: ${parsed.reason}`);
        return;
    }

    if (parsed.value.id !== id) {
        entries.set(id, { ok: false, id, problem: `it says it is ${parsed.value.id}, not ${id}` });
        warn(SOURCE, `${id} is saved under the wrong name (it says ${parsed.value.id})`);
        return;
    }

    entries.set(id, { ok: true, id, robbery: parsed.value });
}

function ensureLoaded(): void {

    if (loaded) return;

    let ids: string[];

    try {
        ids = world.getDynamicPropertyIds().filter((id) => id.startsWith(DEFINITION_PREFIX)).map((id) => id.slice(DEFINITION_PREFIX.length));
    } catch (err) {
        // Too early, most likely: try again next time rather than deciding there are no robberies.
        if (!loadFailureReported) warn(SOURCE, `could not list the saved robberies yet: ${errorText(err)}`);
        loadFailureReported = true;
        return;
    }

    loaded = true;

    for (const id of ids.sort()) {

        const text = readText(id);

        // It is in the list, so something is saved there. If it cannot be read it is damaged, not absent: listing it
        // keeps a later save from treating the id as free and writing over it.
        if (text === undefined) entries.set(id, { ok: false, id, problem: "its saved data could not be read" });
        else take(id, text);
    }

    version++;
}

/** Every saved robbery, readable or not, by id. */
export function listStored(): readonly Stored[] {
    ensureLoaded();
    return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function getStored(id: string): Stored | undefined {
    ensureLoaded();
    return entries.get(id);
}

/** The robbery with this id, or undefined when there is none or it cannot be read. */
export function getRobbery(id: string): Robbery | undefined {
    const stored = getStored(id);
    return stored?.ok ? stored.robbery : undefined;
}

/** Every readable robbery. */
export function allRobberies(): readonly Robbery[] {
    return listStored().flatMap((stored) => (stored.ok ? [stored.robbery] : []));
}

/** Bumps whenever anything is saved, deleted or undone. */
export function storeVersion(): number {
    ensureLoaded();
    return version;
}

/**
 * Saves a robbery: a new one, or an edit of an existing one. Nothing is changed unless every check passes: the id
 * must not belong to an unreadable save, there must be room, it must fit in one property, it must read back exactly,
 * and the game must accept the write.
 */
export function saveRobbery(next: Robbery): SaveResult {

    ensureLoaded();

    const existing = entries.get(next.id);

    if (existing && !existing.ok) {
        return { ok: false, reason: `${next.id} is saved but cannot be read (${existing.problem}). Delete it first, and undo brings it back.` };
    }

    if (!existing && entries.size >= R.maxRobberies) {
        return { ok: false, reason: `there is room for ${R.maxRobberies} robberies and they are all in use` };
    }

    const text = serialize(next);

    if (text.length > R.maxSavedChars) {
        return { ok: false, reason: `that robbery would take ${text.length} characters and a save holds ${R.maxSavedChars}. Nothing was changed.` };
    }

    const readBack = parse(text);

    if (!readBack.ok) return { ok: false, reason: `it would not read back (${readBack.reason}). Nothing was changed.` };

    const before = readText(next.id);

    // An edit that changes nothing must not use up the undo.
    if (before === text) return { ok: true, robbery: readBack.value };

    try {
        world.setDynamicProperty(propertyOf(next.id), text);
    } catch (err) {
        return { ok: false, reason: `the game refused the save: ${errorText(err)}` };
    }

    undoSlots.set(next.id, before);
    entries.set(next.id, { ok: true, id: next.id, robbery: readBack.value });
    version++;

    return { ok: true, robbery: readBack.value };
}

/** Removes a robbery, readable or not. Undo brings it back. */
export function deleteRobbery(id: string): PlainResult {

    ensureLoaded();

    if (!entries.has(id)) return { ok: false, reason: `there is no robbery ${id}` };

    const before = readText(id);

    try {
        world.setDynamicProperty(propertyOf(id), undefined);
    } catch (err) {
        return { ok: false, reason: `the game refused the delete: ${errorText(err)}` };
    }

    undoSlots.set(id, before);
    entries.delete(id);
    version++;

    return { ok: true };
}

/** What `undoLast` can do for a robbery right now. */
export function undoAvailable(id: string): boolean {
    return undoSlots.has(id);
}

/** Puts a robbery back as it was before its last save or delete. Doing it again redoes. */
export function undoLast(id: string): PlainResult {

    ensureLoaded();

    if (!undoSlots.has(id)) return { ok: false, reason: `there is nothing to undo for ${id}` };

    const target = undoSlots.get(id);
    const current = readText(id);

    try {
        world.setDynamicProperty(propertyOf(id), target);
    } catch (err) {
        return { ok: false, reason: `the game refused the undo: ${errorText(err)}` };
    }

    undoSlots.set(id, current);
    take(id, target);
    version++;

    return { ok: true };
}

/** The saved text of a robbery exactly as stored, for a backup in the log. */
export function rawText(id: string): string | undefined {
    ensureLoaded();
    return entries.has(id) ? readText(id) : undefined;
}

/**
 * Forgets everything read so far, so the next call reads the world again: the state a script reload leaves. The
 * saved data is untouched, and so is the undo, which this file cannot tell a reload from. For tests.
 */
export function forgetLoaded(): void {
    entries.clear();
    dirty.clear();
    loaded = false;
    dirtyLoaded = false;
    index = undefined;
    version++;
}

// ---------------------------------------------------------------------------------------------------------
// Which block belongs to which element
// ---------------------------------------------------------------------------------------------------------

/** An element, found by the block it is bound to. */
export interface Bound {
    readonly robbery: string;
    readonly element: string;
}

let index: { readonly forVersion: number; readonly byPosition: ReadonlyMap<string, Bound> } | undefined;

function positions(): ReadonlyMap<string, Bound> {

    ensureLoaded();

    if (index && index.forVersion === version) return index.byPosition;

    const byPosition = new Map<string, Bound>();

    for (const stored of entries.values()) {
        if (!stored.ok) continue;
        for (const element of stored.robbery.elements) {
            for (const cell of element.cells) byPosition.set(posKey(stored.robbery.dimension, cell), { robbery: stored.id, element: element.id });
        }
    }

    index = { forVersion: version, byPosition };

    return byPosition;
}

/**
 * The element bound to a block, if any. The hot path: a right-click on any block in the world lands here, so it is one
 * map lookup, and nothing at all when no robbery has bound a block.
 */
export function boundAt(dimensionId: string, x: number, y: number, z: number): Bound | undefined {

    const byPosition = positions();

    if (byPosition.size === 0) return undefined;

    return byPosition.get(posKey(sameDimension(dimensionId), [x, y, z]));
}

/** Whether any robbery has bound a block at all. */
export function anyBoundBlocks(): boolean {
    return positions().size > 0;
}

// ---------------------------------------------------------------------------------------------------------
// Blocks a run has changed and not yet put back
// ---------------------------------------------------------------------------------------------------------

/** What putting a block back means: shut the door, or empty the chest. */
export type CleanAction = "close" | "empty";

export interface Dirty {
    /** The robbery that changed it. While that robbery is running or waiting for its reset, the janitor leaves it alone. */
    readonly robbery: string;
    readonly dimension: string;
    readonly pos: Pos;
    readonly action: CleanAction;
}

const ACTION_CODES: Record<CleanAction, string> = { close: "c", empty: "e" };
const ACTION_FROM_CODE: Record<string, CleanAction> = { c: "close", e: "empty" };

const dirty = new Map<string, Dirty>();
let dirtyLoaded = false;

const dirtyKey = (entry: Dirty): string => `${entry.robbery}|${entry.dimension}|${entry.pos[0]},${entry.pos[1]},${entry.pos[2]}|${ACTION_CODES[entry.action]}`;

function readDirtyKey(key: unknown): Dirty | undefined {

    if (typeof key !== "string") return undefined;

    const [robbery, dimension, place, code] = key.split("|");
    const action = code === undefined ? undefined : ACTION_FROM_CODE[code];
    const coordinates = (place ?? "").split(",").map(Number);

    if (!robbery || !dimension || !action || coordinates.length !== 3 || !coordinates.every(Number.isInteger)) return undefined;

    return { robbery, dimension, pos: [coordinates[0]!, coordinates[1]!, coordinates[2]!], action };
}

function ensureDirty(): void {

    if (dirtyLoaded) return;

    let raw: unknown;

    try {
        raw = world.getDynamicProperty(DIRTY_PROPERTY);
    } catch {
        return; // too early: try again next time
    }

    dirtyLoaded = true;

    if (typeof raw !== "string") return;

    try {
        const parsed: unknown = JSON.parse(raw);

        for (const key of Array.isArray(parsed) ? parsed : []) {
            const entry = readDirtyKey(key);
            if (entry) dirty.set(dirtyKey(entry), entry);
            else warn(SOURCE, `ignored a damaged site-cleanup note: ${String(key).slice(0, 60)}`);
        }
    } catch {
        warn(SOURCE, "the saved site-cleanup list is not valid and was ignored");
    }
}

function persistDirty(): boolean {

    try {
        world.setDynamicProperty(DIRTY_PROPERTY, dirty.size === 0 ? undefined : JSON.stringify([...dirty.keys()]));
        return true;
    } catch (err) {
        warn(SOURCE, `could not save the site-cleanup list: ${errorText(err)}`);
        return false;
    }
}

/**
 * Notes that a block is about to be changed, saving the note at once (so a crash cannot lose it). False when the note
 * could not be kept: the caller goes on anyway, because it also remembers what it changed for a normal reset.
 */
export function markDirty(entry: Dirty): boolean {

    ensureDirty();

    const key = dirtyKey(entry);

    if (dirty.has(key)) return true;

    if (dirty.size >= R.maxDirtyEntries) {
        warn(SOURCE, `the site-cleanup list is full (${R.maxDirtyEntries}); ${key} will not survive a reload`);
        return false;
    }

    dirty.set(key, entry);

    return persistDirty();
}

/** The block has been put back. */
export function clearDirty(entry: Dirty): void {

    ensureDirty();

    if (dirty.delete(dirtyKey(entry))) persistDirty();
}

export function dirtyEntries(): readonly Dirty[] {
    ensureDirty();
    return [...dirty.values()];
}

export function dirtyCount(): number {
    ensureDirty();
    return dirty.size;
}

/** Whether a changed block of this robbery is still waiting to be put back. */
export function robberyIsDirty(robbery: string): boolean {
    ensureDirty();
    for (const entry of dirty.values()) if (entry.robbery === robbery) return true;
    return false;
}

/** Whether a block position, whoever changed it, is still waiting to be put back. */
export function isDirtyAt(dimension: string, pos: Pos): boolean {
    ensureDirty();
    for (const entry of dirty.values()) {
        if (entry.dimension === dimension && entry.pos[0] === pos[0] && entry.pos[1] === pos[1] && entry.pos[2] === pos[2]) return true;
    }
    return false;
}
