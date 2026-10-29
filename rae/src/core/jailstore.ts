import { world } from "@minecraft/server";
import { JAILS as J } from "../config/balance.js";
import { JAIL_SITES } from "../config/world.js";
import { JAIL_VERSION, jailIdFrom, parseJail, samePlace, serializeJail, type Jail, type Place } from "../logic/jails.js";
import { warn } from "./log.js";
import { prisoners } from "./players.js";
import { getJailSite } from "./state.js";
import { createRecordStore, type PlainResult, type SaveResult, type Stored } from "./recordstore.js";

/**
 * Where the jails live (logic/jails.ts is what one is; docs/decisions/0005-jails-are-records-with-buttons.md is why). One world property each
 * (`rae:jail:<id>`) on core/recordstore.ts, the store endings, shops and the start sequence's shots use, so the rules are theirs: written at once, a save that
 * does not fit is refused, an unreadable save is listed and never overwritten, one level of undo.
 *
 * What is particular here is the default. A world that has never saved a jail has the two the old config named (config/world.ts's JAIL_SITES), built at the
 * moment they are asked for, so the live config editor still moves them. The first save or delete of anything makes both real records first, and from then
 * on the config is not read for them. A world holding any saved jail, readable or not, is never offered the defaults, so a damaged save is not quietly
 * replaced by a working jail.
 *
 * The one rule the endings do not have: there is always a jail on. Prisoners have to be sent somewhere, so the last jail that is switched on cannot be
 * deleted or switched off, and if every saved jail turns out to be unreadable the capture falls back to the config's two rather than failing.
 */

/** Set the first time anything is written, so "never saved" and "all deleted" are not the same thing. Not under the records' own prefix. */
const SEEDED = "rae:jails-seeded";

const store = createRecordStore<Jail>({
    source: "jails",
    noun: "jail",
    prefix: "rae:jail:",
    maxRecords: J.maxJails,
    maxChars: J.maxChars,
    parse: parseJail,
    serialize: serializeJail,
    idOf: (jail) => jail.id
});

/** The jails the config describes, right now, in its order: jail_1, jail_2. Their ids sort the way the config lists them. */
function defaultJails(): Jail[] {
    return JAIL_SITES.map((site, index) => ({
        version: JAIL_VERSION,
        id: `jail_${index + 1}`,
        name: `Jail ${index + 1}`,
        enabled: true,
        jail: { x: site.jail.x, y: site.jail.y, z: site.jail.z },
        // A door trigger is a block. The live config editor can put a middle-of-block number in it (as the block the operator stands in), which setblock reads as the block it is in.
        ...(site.doorTrigger ? { doorTrigger: { x: Math.floor(site.doorTrigger.x), y: Math.floor(site.doorTrigger.y), z: Math.floor(site.doorTrigger.z) } } : {}),
        buttons: []
    }));
}

/** Whether the marker is set. Read once (it can only change through seed() below), because the click handler asks about every right-click in the world. */
let seededKnown: boolean | undefined;

function markedSeeded(): boolean {

    if (seededKnown !== undefined) return seededKnown;

    try {
        seededKnown = world.getDynamicProperty(SEEDED) === true;
    } catch {
        return false;
    }

    return seededKnown;
}

let defaultFor = -1;
let defaultIs = true;

/** True while nothing has ever been saved, so the config's two jails are what there is. Cached by the store's version: it is asked for every right-click in the world. */
export function jailsAreDefault(): boolean {

    if (markedSeeded()) return false;
    if (defaultFor === store.version()) return defaultIs;

    defaultIs = store.list().length === 0;
    defaultFor = store.version();

    return defaultIs;
}

/** Makes the defaults real records and remembers that the defaults are over. (Even the first edit goes through this, so undo has the default to go back to.) */
function seed(): PlainResult {

    if (!jailsAreDefault()) return { ok: true };

    const made: string[] = [];

    for (const jail of defaultJails()) {
        const saved = store.save(jail);

        if (!saved.ok) {
            // Half a seed would leave one jail where there were two, and no way back to the defaults: take back what was made, and the undo that leaves.
            for (const id of made) {
                store.remove(id);
                store.forgetUndo(id);
            }

            return saved;
        }

        made.push(jail.id);
    }

    // The seed is not an edit anybody made: "undo my last change" on a jail that was never touched would otherwise delete it. (The edit that comes next sets its own undo.)
    for (const id of made) store.forgetUndo(id);

    try {
        world.setDynamicProperty(SEEDED, true);
        seededKnown = true;
    } catch (err) {
        warn("jails", `could not note that the jails were saved: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok: true };
}

/** Every saved jail, readable or not, by id: the config's two while nothing is saved. */
export function listJails(): readonly Stored<Jail>[] {
    return jailsAreDefault() ? defaultJails().map((value) => ({ ok: true as const, id: value.id, value })) : store.list();
}

/** Every readable jail. */
export const allJails = (): readonly Jail[] => listJails().flatMap((stored) => (stored.ok ? [stored.value] : []));

/** The jail with this id, or undefined when there is none or it cannot be read. */
export const getJail = (id: string): Jail | undefined => allJails().find((jail) => jail.id === id);

/**
 * The jails a new prisoner can be sent to: the ones that are on. If there are none (every saved jail is unreadable), the config's two, so a capture
 * never fails for want of a jail.
 */
export function usableJails(): readonly Jail[] {

    const on = allJails().filter((jail) => jail.enabled);

    if (on.length > 0) return on;

    warn("jails", "no jail is on and readable, so the config's jails are used: open the Jails screen and fix or delete the damaged ones");

    return defaultJails();
}

/** Bumps whenever anything is saved, deleted or undone, so anything built from the jails knows when it is stale. */
export const jailsVersion = store.version;

/** Whether this jail is the one that holds prisoners right now (the active jail is kept in core/state by id, or by spot for a site that carries no id). */
export function holdsPrisoners(id: string): boolean {

    const site = getJailSite();

    if (!site || prisoners().length === 0) return false;
    if (site.id !== undefined) return site.id === id;

    const jail = getJail(id);

    return jail !== undefined && samePlace(site.jail, jail.jail);
}

const placeText = (place: Place): string => `${Math.round(place.x)}, ${Math.round(place.y)}, ${Math.round(place.z)}`;

/** Why this jail's blocks cannot be what they are, given the other jails, or undefined when they can. A block is one jail's button, and never another's door. */
function whyBlocksClash(next: Jail): string | undefined {

    for (const other of allJails()) {

        if (other.id === next.id) continue;

        for (const button of next.buttons) {
            if (other.buttons.some((there) => samePlace(there, button))) return `the block at ${placeText(button)} is already a button of ${other.name}`;
            if (other.doorTrigger && samePlace(other.doorTrigger, button)) return `the block at ${placeText(button)} is the door trigger of ${other.name}`;
        }

        const door = next.doorTrigger;
        if (door && other.buttons.some((there) => samePlace(there, door))) return `the door trigger at ${placeText(door)} is a button of ${other.name}`;
    }

    return undefined;
}

/** Saves a jail: a new one, or an edit of one. The first save of anything makes the config's two real records. */
export function saveJail(next: Jail): SaveResult<Jail> {

    const clash = whyBlocksClash(next);
    if (clash) return { ok: false, reason: clash };

    if (!next.enabled && getJail(next.id)?.enabled && !allJails().some((jail) => jail.enabled && jail.id !== next.id)) {
        return { ok: false, reason: "at least one jail has to stay on, or captured players would have nowhere to go" };
    }

    const seeded = seed();
    if (!seeded.ok) return seeded;

    return store.save(next);
}

/** Deletes a jail (an unreadable one too). Undo brings it back until the scripts reload. */
export function removeJail(id: string): PlainResult {

    if (jailsAreDefault() && !defaultJails().some((jail) => jail.id === id)) return { ok: false, reason: `there is no jail ${id}` };

    // Only a jail that is on counts against the rule: a damaged or switched-off one can always be deleted (a world whose every jail is damaged could never be cleaned up otherwise).
    if (getJail(id)?.enabled && !allJails().some((jail) => jail.enabled && jail.id !== id)) {
        return { ok: false, reason: "at least one jail has to stay on, or captured players would have nowhere to go" };
    }

    if (holdsPrisoners(id)) return { ok: false, reason: "prisoners are held there now: free them, or reset the game, first" };

    const seeded = seed();
    if (!seeded.ok) return seeded;

    return store.remove(id);
}

export const undoAvailable = store.undoAvailable;

/** Undoes the last change to this jail, unless that would leave no jail on or put back a block another jail has used since (the rules that hold on every path). */
export function undoJail(id: string): PlainResult {

    const result = store.undo(id);

    if (!result.ok) return result;

    // Undo puts back raw text, so what a save would have refused has to be checked here: no jail on, or a block another jail has used since.
    const back = getJail(id);
    const clash = back ? whyBlocksClash(back) : undefined;

    if (!allJails().some((jail) => jail.enabled) || clash) {
        store.undo(id);
        return { ok: false, reason: clash ? `undoing that would clash: ${clash}` : "undoing that would leave no jail on, and captured players would have nowhere to go" };
    }

    return result;
}

/** A legal id made from a name, not one that is in use (the config's two, and a saved one that cannot be read, included). */
export const newJailId = (name: string): string => jailIdFrom(name, new Set(listJails().map((stored) => stored.id)));

// ---------------------------------------------------------------------------------------------------------
// Finding the jail a clicked block belongs to
// ---------------------------------------------------------------------------------------------------------

let index = new Map<string, Jail>();
let indexVersion = -1;

const keyOf = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * The jail that has this block as a button, or undefined. Asked for every right-click on any block in the world, so with no button anywhere it is a flag
 * and a map lookup: the index is rebuilt only when a jail has been saved, deleted or undone. Jails are in the overworld.
 */
export function jailAtButton(dimensionId: string, x: number, y: number, z: number): Jail | undefined {

    if (jailsAreDefault()) return undefined;
    if (dimensionId !== "overworld" && dimensionId !== "minecraft:overworld") return undefined;

    if (indexVersion !== store.version()) {
        index = new Map();

        // Every jail's buttons, on or off: a jail that was switched off while it holds prisoners still has to work until they are free (systems/jailbreak.ts decides).
        for (const jail of allJails()) {
            for (const button of jail.buttons) index.set(keyOf(button.x, button.y, button.z), jail);
        }

        indexVersion = store.version();
    }

    return index.get(keyOf(x, y, z));
}

/** Whether a block is the door trigger or a button of any jail (a robbery must not bind the same block). */
export function jailUses(x: number, y: number, z: number): Jail | undefined {
    return allJails().find((jail) => (jail.doorTrigger?.x === x && jail.doorTrigger.y === y && jail.doorTrigger.z === z) || jail.buttons.some((button) => button.x === x && button.y === y && button.z === z));
}

/** Forgets everything read so far, so the next call reads the world again: the state a script reload leaves. For tests. */
export function forgetJails(): void {
    store.forget();
    seededKnown = undefined;
    defaultFor = -1;
    index = new Map();
    indexVersion = -1;
}

