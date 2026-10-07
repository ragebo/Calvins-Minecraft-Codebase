import { world } from "@minecraft/server";
import { warn } from "./log.js";

/**
 * A place for things a builder authors in game (a shop, later a quest): one world property each, `<prefix><id>`, holding the
 * saved text a logic/ module writes and reads.
 *
 * Not core/persist.ts: that engine saves state a module can rebuild and silently skips a key over its 10,000-character cap,
 * which would lose a builder's work without a word. An authored record is data (a deliberate exception to CLAUDE.md rule 3),
 * so every edit is written the moment it is made, an edit that does not fit is refused before anything changes, and a record
 * that cannot be read is listed and never overwritten. core/robberystore.ts has the same contract, written before this was
 * made general; it could move onto this one.
 *
 * Read lazily, on first use: a world property is not available while the scripts are still loading.
 *
 * One level of undo is kept in memory, per id, so a reload forgets it. Undoing swaps, so undoing twice puts it back.
 */

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface RecordStoreOptions<T> {
    /** What the content log calls this store. */
    readonly source: string;
    /** What one record is called in a message: "shop". */
    readonly noun: string;
    /** The world property of a record is this prefix plus its id. */
    readonly prefix: string;
    readonly maxRecords: number;
    /** A saved record longer than this many characters is refused up front. */
    readonly maxChars: number;
    readonly parse: (text: string | undefined) => ParseResult<T>;
    readonly serialize: (value: T) => string;
    readonly idOf: (value: T) => string;
}

/** A saved record that reads, or one that does not (and says why). */
export type Stored<T> =
    | { readonly ok: true; readonly id: string; readonly value: T }
    | { readonly ok: false; readonly id: string; readonly problem: string };

export type SaveResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
export type PlainResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface RecordStore<T> {
    /** Every saved record, readable or not, by id. */
    list(): readonly Stored<T>[];
    get(id: string): Stored<T> | undefined;
    /** The record with this id, or undefined when there is none or it cannot be read. */
    value(id: string): T | undefined;
    /** Every readable record. */
    all(): readonly T[];
    /** Bumps whenever anything is saved, deleted or undone, so anything built from the records knows when it is stale. */
    version(): number;
    save(next: T): SaveResult<T>;
    remove(id: string): PlainResult;
    undoAvailable(id: string): boolean;
    undo(id: string): PlainResult;
    /** The saved text exactly as stored, for a backup in the log. */
    rawText(id: string): string | undefined;
    /** Forgets everything read so far, so the next call reads the world again: the state a script reload leaves. For tests. */
    forget(): void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export function createRecordStore<T>(options: RecordStoreOptions<T>): RecordStore<T> {

    const { source, noun, prefix } = options;

    const entries = new Map<string, Stored<T>>();
    const undoSlots = new Map<string, string | undefined>();
    let loaded = false;
    let loadFailureReported = false;
    let version = 0;

    const propertyOf = (id: string): string => `${prefix}${id}`;

    function readText(id: string): string | undefined {
        try {
            const raw = world.getDynamicProperty(propertyOf(id));
            return typeof raw === "string" ? raw : undefined;
        } catch (err) {
            warn(source, `could not read ${id}: ${errorText(err)}`);
            return undefined;
        }
    }

    /** Reads one saved record into `entries`, or notes why it cannot be read. `text` undefined removes it. */
    function take(id: string, text: string | undefined): void {

        if (text === undefined) {
            entries.delete(id);
            return;
        }

        const parsed = options.parse(text);

        if (!parsed.ok) {
            entries.set(id, { ok: false, id, problem: parsed.reason });
            warn(source, `${id} is saved but cannot be read: ${parsed.reason}`);
            return;
        }

        if (options.idOf(parsed.value) !== id) {
            entries.set(id, { ok: false, id, problem: `it says it is ${options.idOf(parsed.value)}, not ${id}` });
            warn(source, `${id} is saved under the wrong name (it says ${options.idOf(parsed.value)})`);
            return;
        }

        entries.set(id, { ok: true, id, value: parsed.value });
    }

    function ensureLoaded(): void {

        if (loaded) return;

        let ids: string[];

        try {
            ids = world.getDynamicPropertyIds().filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
        } catch (err) {
            // Too early, most likely: try again next time rather than deciding there are none.
            if (!loadFailureReported) warn(source, `could not list the saved ${noun}s yet: ${errorText(err)}`);
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

    function list(): readonly Stored<T>[] {
        ensureLoaded();
        return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    // Plain functions, never `this`: a caller may take one out of the object (core/shopstore.ts re-exports them).
    return {

        list,

        get(id) {
            ensureLoaded();
            return entries.get(id);
        },

        value(id) {
            ensureLoaded();
            const stored = entries.get(id);
            return stored?.ok ? stored.value : undefined;
        },

        all() {
            return list().flatMap((stored) => (stored.ok ? [stored.value] : []));
        },

        version() {
            ensureLoaded();
            return version;
        },

        /**
         * Saves a record: a new one, or an edit of an existing one. Nothing is changed unless every check passes: the id must
         * not belong to an unreadable save, there must be room, it must fit in one property, it must read back exactly, and
         * the game must accept the write.
         */
        save(next) {

            ensureLoaded();

            const id = options.idOf(next);
            const existing = entries.get(id);

            if (existing && !existing.ok) {
                return { ok: false, reason: `${id} is saved but cannot be read (${existing.problem}). Delete it first, and undo brings it back.` };
            }

            if (!existing && entries.size >= options.maxRecords) {
                return { ok: false, reason: `there is room for ${options.maxRecords} ${noun}s and they are all in use` };
            }

            const text = options.serialize(next);

            if (text.length > options.maxChars) {
                return { ok: false, reason: `that ${noun} would take ${text.length} characters and a save holds ${options.maxChars}. Nothing was changed.` };
            }

            const readBack = options.parse(text);

            if (!readBack.ok) return { ok: false, reason: `it would not read back (${readBack.reason}). Nothing was changed.` };

            const before = readText(id);

            // An edit that changes nothing must not use up the undo.
            if (before === text) return { ok: true, value: readBack.value };

            try {
                world.setDynamicProperty(propertyOf(id), text);
            } catch (err) {
                return { ok: false, reason: `the game refused the save: ${errorText(err)}` };
            }

            undoSlots.set(id, before);
            entries.set(id, { ok: true, id, value: readBack.value });
            version++;

            return { ok: true, value: readBack.value };
        },

        /** Removes a record, readable or not. Undo brings it back. */
        remove(id) {

            ensureLoaded();

            if (!entries.has(id)) return { ok: false, reason: `there is no ${noun} ${id}` };

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
        },

        undoAvailable(id) {
            return undoSlots.has(id);
        },

        /** Puts a record back as it was before its last save or delete. Doing it again redoes. */
        undo(id) {

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
        },

        rawText(id) {
            ensureLoaded();
            return entries.has(id) ? readText(id) : undefined;
        },

        forget() {
            entries.clear();
            loaded = false;
            version++;
        }
    };
}
