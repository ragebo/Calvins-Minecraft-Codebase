import { world } from "@minecraft/server";
import { BOAT, ECONOMY, ENDINGS as E } from "../config/balance.js";
import { BOAT_NPC, BOAT_WIN_TELEPORT } from "../config/world.js";
import { ENDING_VERSION, endingIdFrom, parseEnding, serializeEnding, type Ending } from "../logic/endings.js";
import { warn } from "./log.js";
import { createRecordStore, type PlainResult, type SaveResult, type Stored } from "./recordstore.js";

/**
 * Where the endings live (logic/endings.ts is what one is; the plan is tasks/endings/plan.md). One world property each (`rae:ending:<id>`) on
 * core/recordstore.ts, the store shops and the start sequence's shots use, so the rules are theirs: written at once, a save that does not fit is
 * refused, an unreadable save is listed and never overwritten, one level of undo.
 *
 * What is particular here is the boat. A world that has never saved an ending has ONE: the boat escape, built at the moment it is asked for from the
 * old boat config (the NPC's spot, the gather radius, the price per outlaw, the win teleport), so the live config editor still moves it. The first save
 * or delete of anything makes the boat a real record first, and from then on the config is not read for it: deleting every ending leaves none, and
 * stays that way after a reload. A world holding any saved ending, readable or not, is never offered the default, so a damaged save is not quietly
 * replaced by a working boat.
 */

const BOAT_ID = "boat";

/** Set the first time anything is written, so "never saved" and "all deleted" are not the same thing. Not under the records' own prefix. */
const SEEDED = "rae:endings-seeded";

const store = createRecordStore<Ending>({
    source: "endings",
    noun: "ending",
    prefix: "rae:ending:",
    maxRecords: E.maxEndings,
    maxChars: E.maxChars,
    parse: parseEnding,
    serialize: serializeEnding,
    idOf: (ending) => ending.id
});

/** The boat as the old config describes it, right now. */
function defaultBoat(): Ending {
    return {
        version: ENDING_VERSION,
        id: BOAT_ID,
        name: "Escape boat",
        kind: "group",
        enabled: true,
        place: { x: BOAT_NPC.x, y: BOAT_NPC.y, z: BOAT_NPC.z },
        radius: BOAT.escapeRadius,
        price: ECONOMY.boatEscapePerOutlaw,
        consumeItem: true,
        winSpot: { x: BOAT_WIN_TELEPORT.x, y: BOAT_WIN_TELEPORT.y, z: BOAT_WIN_TELEPORT.z },
        texts: { ...E.texts.boat }
    };
}

function markedSeeded(): boolean {
    try {
        return world.getDynamicProperty(SEEDED) === true;
    } catch {
        return false;
    }
}

/** True while nothing has ever been saved, so the default boat is what there is. */
export function endingsAreDefault(): boolean {
    return !markedSeeded() && store.list().length === 0;
}

/** Makes the default boat a real record and remembers that the defaults are over. (Even an edit of the boat goes through this first, so its undo has the default to go back to.) */
function seed(): PlainResult {

    if (!endingsAreDefault()) return { ok: true };

    const saved = store.save(defaultBoat());
    if (!saved.ok) return saved;

    try {
        world.setDynamicProperty(SEEDED, true);
    } catch (err) {
        warn("endings", `could not note that the endings were saved: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok: true };
}

/** Every saved ending, readable or not, by id: the default boat while nothing is saved. */
export function listEndings(): readonly Stored<Ending>[] {
    return endingsAreDefault() ? [{ ok: true, id: BOAT_ID, value: defaultBoat() }] : store.list();
}

/** Every readable ending. */
export const allEndings = (): readonly Ending[] => listEndings().flatMap((stored) => (stored.ok ? [stored.value] : []));

/** The ending with this id, or undefined when there is none or it cannot be read. */
export const getEnding = (id: string): Ending | undefined => allEndings().find((ending) => ending.id === id);

/** Bumps whenever anything is saved, deleted or undone, so anything built from the endings knows when it is stale. */
export const endingsVersion = store.version;

/** Saves an ending: a new one, or an edit of one. The first save of anything makes the boat a real record. */
export function saveEnding(next: Ending): SaveResult<Ending> {

    const seeded = seed();
    if (!seeded.ok) return seeded;

    return store.save(next);
}

/** Deletes an ending (an unreadable one too). Undo brings it back until the scripts reload. */
export function removeEnding(id: string): PlainResult {

    if (endingsAreDefault() && id !== BOAT_ID) return { ok: false, reason: `there is no ending ${id}` };

    const seeded = seed();
    if (!seeded.ok) return seeded;

    return store.remove(id);
}

export const undoAvailable = store.undoAvailable;
export const undoEnding = store.undo;

/** A legal id made from a name, not one that is in use (the default boat, and a saved one that cannot be read, included). */
export const newEndingId = (name: string): string => endingIdFrom(name, new Set(listEndings().map((stored) => stored.id)));

/** Forgets everything read so far, so the next call reads the world again: the state a script reload leaves. For tests. */
export const forgetEndings = store.forget;
