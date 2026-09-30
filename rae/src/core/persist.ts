import { world } from "@minecraft/server";
import { PERSIST } from "../config/balance.js";
import { onScriptEvent } from "./events.js";
import { onTick } from "./tick.js";

/**
 * Contract for state that must survive a world reload.
 *
 * Everything the game keeps in module variables is lost when the world reloads. A module that
 * needs to survive registers a Persistable; the persistence engine (built later) saves every
 * registered one to world dynamic properties and hands the data back after a reload.
 *
 * Bump `version` whenever the saved shape changes: restore() is told which version wrote the data.
 */
export interface Persistable {
    /** Stable, unique name. Also the storage key, so never rename one that has shipped. */
    readonly key: string;
    readonly version: number;
    /** Must return JSON-serialisable data. */
    save(): unknown;
    restore(data: unknown, savedVersion: number): void;
}

const registered: Persistable[] = [];

export function registerPersistable(entry: Persistable): void {

    if (registered.some((p) => p.key === entry.key)) {
        throw new Error(`Persistable "${entry.key}" is already registered`);
    }

    registered.push(entry);
}

export function listPersistables(): readonly Persistable[] {
    return registered;
}

/**
 * The engine.
 *
 * One world dynamic property per registered key, named "rae:persist:<key>", holding
 * JSON.stringify({version, data}) — never one shared blob. That isolates one Persistable's size
 * growth from another's, and lets a single oversized or corrupt key be skipped without losing
 * everyone else's data.
 *
 * A broken key must never take the others down with it: every step below (serialising, the size
 * guard, the engine write, parsing, restore()) is wrapped so one key's failure is reported and
 * skipped while the loop moves on, the same isolation round.ts already gives its subscribers.
 */

const PROPERTY_PREFIX = "rae:persist:";

function propertyName(key: string): string {
    return `${PROPERTY_PREFIX}${key}`;
}

/** The text each key was last written (or freshly read) with, so saveAll() can tell a key that
 *  hasn't changed from one that has, and skip calling into the engine for it. */
const lastWritten = new Map<string, string>();

/** Writes every registered Persistable whose save() output changed since the last write. Never
 *  throws: a key that fails to serialise, is over PERSIST.maxSavedCharsPerKey, or fails to write
 *  is reported and skipped; every other key still saves. */
export function saveAll(): void {

    for (const entry of listPersistables()) {

        let text: string;

        try {
            text = JSON.stringify({ version: entry.version, data: entry.save() });
        } catch (error) {
            console.error(`[persist] "${entry.key}" failed to save: ${error}`);
            continue;
        }

        if (text.length > PERSIST.maxSavedCharsPerKey) {
            console.error(`[persist] "${entry.key}" serialised to ${text.length} chars, over the ${PERSIST.maxSavedCharsPerKey}-char limit — skipped this save, other keys still saved.`);
            continue;
        }

        if (lastWritten.get(entry.key) === text) continue; // unchanged since the last write: nothing to do

        try {
            world.setDynamicProperty(propertyName(entry.key), text);
            lastWritten.set(entry.key, text);
        } catch (error) {
            console.error(`[persist] "${entry.key}" failed to write: ${error}`);
        }
    }
}

/** Reads each registered Persistable's own saved data back and calls entry.restore(data,
 *  savedVersion). Never throws: a key with nothing saved, corrupt JSON, or a restore() that
 *  throws is reported and skipped; every other key still restores. */
export function restoreAll(): void {

    for (const entry of listPersistables()) {

        let raw: unknown;

        try {
            raw = world.getDynamicProperty(propertyName(entry.key));
        } catch (error) {
            console.error(`[persist] "${entry.key}" failed to read: ${error}`);
            continue;
        }

        if (typeof raw !== "string") continue; // nothing saved yet, or it was cleared

        let parsed: { version?: unknown; data?: unknown };

        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            console.error(`[persist] "${entry.key}" saved data is not valid JSON, ignored: ${error}`);
            continue;
        }

        if (typeof parsed.version !== "number") {
            console.error(`[persist] "${entry.key}" saved data has no version number, ignored.`);
            continue;
        }

        try {
            entry.restore(parsed.data, parsed.version);
        } catch (error) {
            console.error(`[persist] "${entry.key}" restore() threw, ignored: ${error}`);
        }

        // What was just read already matches the world property, so an autosave right after
        // load doesn't turn around and rewrite it before anything has actually changed.
        lastWritten.set(entry.key, raw);
    }
}

// Everyone's Persistable data needs reading back once, but a world dynamic property is not
// available while the scripts are still starting, so this waits one tick rather than running
// inline at import time — the same reason state.ts's own state:adopt-at-load isn't inline either.
const stopRestoreAtLoad = onTick("persist:restore-at-load", () => {
    restoreAll();
    stopRestoreAtLoad();
}, { everyTicks: 1 });

onTick("persist:autosave", saveAll, { everyTicks: PERSIST.autosaveIntervalTicks });

/**
 * `/scriptevent rae:persist_reset`: clears every "rae:persist:*" world dynamic property. Separate
 * from rae:reset (main.ts), which resets live systems for a new round: this only clears saved
 * data, takes effect on the next load, and never touches anything currently in memory.
 */
onScriptEvent("rae:persist_reset", () => {

    let cleared = 0;

    for (const id of world.getDynamicPropertyIds()) {

        if (!id.startsWith(PROPERTY_PREFIX)) continue;

        try {
            world.setDynamicProperty(id, undefined);
            cleared++;
        } catch (error) {
            console.error(`[persist] failed to clear "${id}": ${error}`);
        }
    }

    lastWritten.clear();

    world.sendMessage(`§7Persisted data cleared (${cleared} key${cleared === 1 ? "" : "s"}). Takes effect on the next load.`);
});
