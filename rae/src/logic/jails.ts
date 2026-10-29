import { JAILS as J } from "../config/balance.js";

/**
 * The pure rules of a jail (core/jailstore.ts keeps them, core/jailforms.ts edits them, systems/jail.ts sends prisoners to one and systems/jailbreak.ts runs
 * the lockpick; the plan is docs/decisions/0005-jails-are-records-with-buttons.md).
 *
 * A jail is a place prisoners are sent, the block where a redstone block is placed to open its door when the jailbreak succeeds, and any number of BUTTONS:
 * blocks (a button, a lever, anything) that a player right-clicks to start the lockpick. Jails are saved in the world and made in game; a world that has never
 * saved one has the two the old config named (core/jailstore.ts).
 *
 * Nothing here knows the game. Places come in as plain values, a record that cannot be read is a reason and never an exception, and every edit returns a new
 * record and leaves the one it was given as it was.
 */

/** Bumped when a saved jail changes meaning: a reader refuses a version it does not know. */
export const JAIL_VERSION = 1;

export interface Place {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

export interface Jail {
    readonly version: number;
    /** A short lowercase id, never changed: it names the world property. */
    readonly id: string;
    readonly name: string;
    /** A jail that is off is never chosen for a new prisoner and its buttons do nothing. */
    readonly enabled: boolean;
    /** Where prisoners are put. */
    readonly jail: Place;
    /**
     * The block where a redstone block is placed to open the door when the jailbreak succeeds. A whole-number block position. A jail made on the screens has
     * none until an operator clicks one: placing a redstone block at a guessed spot could replace the cell's own floor, so without one nothing is placed.
     */
    readonly doorTrigger?: Place;
    /** The blocks a player right-clicks to start the lockpick for this jail. Whole-number block positions, each in one jail only. */
    readonly buttons: readonly Place[];
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (reason: string): Result<never> => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The place a spot is kept to two decimals: far finer than a block, and it keeps a saved jail short. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The game's own limit on how far from the middle of the world anything can be. */
const WORLD_EDGE = 30_000_000;
const HEIGHT_EDGE = 10_000;

const CONTROL = /[\u0000-\u001f\u007f]/;
const ID = /^[a-z][a-z0-9_-]{0,23}$/;

export const samePlace = (a: Place, b: Place): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** "10, 64, -3": the block a place is in (a spot in the middle of a block, 10.5, is block 10), as the whole numbers a person reading a screen needs. */
export const placeText = (place: Place): string => `${Math.floor(place.x)}, ${Math.floor(place.y)}, ${Math.floor(place.z)}`;

// ---------------------------------------------------------------------------------------------------------
// The rules a record must meet
// ---------------------------------------------------------------------------------------------------------

function whyBadPlace(label: string, place: Place, whole: boolean): string | undefined {

    if (![place.x, place.y, place.z].every((n) => typeof n === "number" && Number.isFinite(n))) return `the ${label} must be three numbers`;
    if (Math.abs(place.x) > WORLD_EDGE || Math.abs(place.z) > WORLD_EDGE || Math.abs(place.y) > HEIGHT_EDGE) return `the ${label} is outside the world`;
    if (whole && ![place.x, place.y, place.z].every(Number.isInteger)) return `the ${label} must be a block: whole numbers`;

    return undefined;
}

/** Why this jail cannot be used, in words an operator can read, or undefined when it is fine. */
export function whyNotUsable(jail: Jail): string | undefined {

    if (!ID.test(jail.id)) return "its id must be 1 to 24 characters: a lowercase letter, then lowercase letters, digits, - or _";

    const name = jail.name.trim();
    if (name.length === 0) return "a name cannot be empty";
    if (jail.name.length > J.maxName) return `a name is at most ${J.maxName} characters`;
    if (CONTROL.test(jail.name)) return "a name cannot hold a control character";

    const spot = whyBadPlace("jail spot", jail.jail, false);
    if (spot) return spot;

    if (jail.doorTrigger) {
        const door = whyBadPlace("door trigger", jail.doorTrigger, true);
        if (door) return door;
    }

    if (!Array.isArray(jail.buttons)) return "the buttons must be a list";
    if (jail.buttons.length > J.maxButtons) return `a jail has at most ${J.maxButtons} buttons`;

    for (const [index, button] of jail.buttons.entries()) {
        const problem = whyBadPlace(`button ${index + 1}`, button, true);
        if (problem) return problem;
        if (jail.doorTrigger && samePlace(button, jail.doorTrigger)) return `button ${index + 1} is the door trigger block: a block cannot be both`;
        if (jail.buttons.findIndex((other) => samePlace(other, button)) !== index) return `button ${index + 1} is listed twice`;
    }

    return undefined;
}

function checked(jail: Jail): Result<Jail> {
    const problem = whyNotUsable(jail);
    return problem ? bad(problem) : good(jail);
}

// ---------------------------------------------------------------------------------------------------------
// Making and editing one
// ---------------------------------------------------------------------------------------------------------

/** A new jail with no buttons and no door trigger yet. The jail spot is kept to two decimals. */
export function newJail(id: string, name: string, jail: Place): Result<Jail> {

    return checked({
        version: JAIL_VERSION,
        id,
        name: name.trim(),
        enabled: true,
        jail: { x: round2(jail.x), y: round2(jail.y), z: round2(jail.z) },
        buttons: []
    });
}

/** What an edit may change. `null` takes the door trigger away. The id never changes. */
export interface JailPatch {
    readonly name?: string;
    readonly enabled?: boolean;
    readonly jail?: Place;
    readonly doorTrigger?: Place | null;
    readonly buttons?: readonly Place[];
}

/** The jail with this change made, or why it cannot be (the jail itself is left as it was). */
export function edit(jail: Jail, patch: JailPatch): Result<Jail> {

    const next: { -readonly [K in keyof Jail]: Jail[K] } = { ...jail };

    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.jail !== undefined) next.jail = { x: round2(patch.jail.x), y: round2(patch.jail.y), z: round2(patch.jail.z) };
    if (patch.doorTrigger === null) delete next.doorTrigger;
    else if (patch.doorTrigger !== undefined) next.doorTrigger = { x: patch.doorTrigger.x, y: patch.doorTrigger.y, z: patch.doorTrigger.z };
    if (patch.buttons !== undefined) next.buttons = patch.buttons.map((button) => ({ x: button.x, y: button.y, z: button.z }));

    return checked(next);
}

/** The jail with one more button, or why it cannot have it. */
export function addButton(jail: Jail, button: Place): Result<Jail> {
    return edit(jail, { buttons: [...jail.buttons, button] });
}

/** The jail without its button number `index` (from 0), or why it cannot be. */
export function removeButton(jail: Jail, index: number): Result<Jail> {

    if (!Number.isInteger(index) || index < 0 || index >= jail.buttons.length) return bad(`this jail has no button ${index + 1}`);

    return edit(jail, { buttons: jail.buttons.filter((_, at) => at !== index) });
}

/** "Jail Two" -> "jail_two": a legal id made from a name, numbered (_2, _3...) when it is taken. */
export function jailIdFrom(name: string, taken: ReadonlySet<string>): string {

    const slug = name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^[0-9_]+/, "")
        .slice(0, 24)
        .replace(/_+$/, "");

    const base = slug.length > 0 ? slug : "jail";

    if (!taken.has(base)) return base;

    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = `${base.slice(0, 24 - suffix.length).replace(/_+$/, "")}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Saving and reading one
// ---------------------------------------------------------------------------------------------------------

const triple = (place: Place): [number, number, number] => [place.x, place.y, place.z];

export function serializeJail(jail: Jail): string {
    return JSON.stringify({
        v: jail.version,
        id: jail.id,
        nm: jail.name,
        on: jail.enabled,
        j: triple(jail.jail),
        ...(jail.doorTrigger ? { d: triple(jail.doorTrigger) } : {}),
        b: jail.buttons.map(triple)
    });
}

function readPlace(raw: unknown, label: string): Result<Place> {
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((n) => typeof n === "number")) return bad(`the saved ${label} is not three numbers`);
    return good({ x: raw[0] as number, y: raw[1] as number, z: raw[2] as number });
}

/** A saved jail back, or why it cannot be read. Never throws, whatever the text is. */
export function parseJail(text: string | undefined): Result<Jail> {

    if (text === undefined || text.length === 0) return bad("nothing is saved");

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return bad("the saved data is not valid JSON");
    }

    if (!isRecord(raw)) return bad("the saved data is not a jail");
    if (raw["v"] !== JAIL_VERSION) return bad(`it was saved by a different version (${String(raw["v"])}), and this one reads ${JAIL_VERSION}`);
    if (typeof raw["id"] !== "string") return bad("the saved jail has no id");
    if (typeof raw["nm"] !== "string") return bad("the saved jail has no name");

    const spot = readPlace(raw["j"], "jail spot");
    if (!spot.ok) return spot;

    let doorTrigger: Place | undefined;
    if (raw["d"] !== undefined) {
        const door = readPlace(raw["d"], "door trigger");
        if (!door.ok) return door;
        doorTrigger = door.value;
    }

    const list = raw["b"];
    if (!Array.isArray(list)) return bad("the saved buttons are not a list");

    const buttons: Place[] = [];

    for (const [index, entry] of list.entries()) {
        const button = readPlace(entry, `button ${index + 1}`);
        if (!button.ok) return button;
        buttons.push(button.value);
    }

    return checked({
        version: JAIL_VERSION,
        id: raw["id"],
        name: raw["nm"],
        enabled: raw["on"] !== false,
        jail: { x: round2(spot.value.x), y: round2(spot.value.y), z: round2(spot.value.z) },
        ...(doorTrigger ? { doorTrigger } : {}),
        buttons
    });
}
