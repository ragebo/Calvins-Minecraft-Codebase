import { ENDINGS as E } from "../config/balance.js";
import { START_VERSION, makeShot, markList, readMark, type Mark, type Shot } from "./start.js";

/**
 * The pure rules of the endings (core/endings.ts runs them, core/endingstore.ts keeps them; the plan is tasks/endings/plan.md).
 *
 * An ending is how an outlaw, or a gang of them, gets out. Two kinds:
 *
 *   - "group": every outlaw still in play stands at the place and the gang pays `price` coins PER MEMBER between them. It ends the round.
 *   - "solo": ONE outlaw stands at the place and pays `price` coins and/or hands over `item`. They are out of the game for good; the round goes on.
 *
 * Nothing here knows the game. Places, purses and statuses come in as plain values, a record that cannot be read is a reason and never an
 * exception, and every edit returns a new record and leaves the one it was given as it was.
 */

/** Bumped when a saved ending changes meaning: a reader refuses a version it does not know. */
export const ENDING_VERSION = 1;

export type EndingKind = "group" | "solo";

export interface Place {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** The four lines an ending says. {coins}, {player} and {count} are filled in when it is said (see fillText). */
export interface Texts {
    /** Announced to everyone when it succeeds. */
    readonly headline: string;
    /** The line under the headline. */
    readonly detail: string;
    /** Said to the gang when someone is not at the place yet. */
    readonly gather: string;
    /** Said to a player who is not an outlaw. */
    readonly outlawsOnly: string;
}

/** Who sees a cinematic: every player online, or only the ones the ending made winners (the gang; the one who escaped alone). */
export type Audience = "all" | "winners";

/** A camera pan played after an ending is announced: from where one mark is to where the other is over `seconds`. The marks are the shots' own (logic/start.ts). */
export interface Cinematic {
    readonly start: Mark;
    readonly end: Mark;
    readonly seconds: number;
    readonly audience: Audience;
}

export interface Item {
    readonly id: string;
    readonly count: number;
}

export interface Ending {
    readonly version: number;
    /** A short lowercase id, never changed: it names the world property. */
    readonly id: string;
    readonly name: string;
    readonly kind: EndingKind;
    readonly enabled: boolean;
    readonly place: Place;
    /** How near the place counts as "at" it (blocks, in three dimensions). */
    readonly radius: number;
    /** Coins: per member of the gang for a group ending, for the one outlaw for a solo one. Whole, never negative. */
    readonly price: number;
    /** A solo ending can ask for an item as well as, or instead of, coins. */
    readonly item?: Item;
    /** Whether the item is taken (true) or only has to be held. */
    readonly consumeItem: boolean;
    /** Where the winners are taken, if anywhere. */
    readonly winSpot?: Place;
    readonly texts: Texts;
    /** A pan played after the announcement; absent means no camera, no lock and no delay. */
    readonly cinematic?: Cinematic;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (reason: string): Result<never> => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Places are kept to two decimals: far finer than a block, and it keeps a saved ending short. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The game's own limit on how far from the middle of the world anything can be. */
const WORLD_EDGE = 30_000_000;
const HEIGHT_EDGE = 10_000;

const CONTROL = /[\u0000-\u001f\u007f]/;
const ID = /^[a-z][a-z0-9_-]{0,23}$/;
const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

// ---------------------------------------------------------------------------------------------------------
// The rules a record must meet
// ---------------------------------------------------------------------------------------------------------

function whyBadPlace(label: string, place: Place): string | undefined {
    const finite = [place.x, place.y, place.z].every((n) => typeof n === "number" && Number.isFinite(n));
    if (!finite) return `the ${label} must be three numbers`;
    if (Math.abs(place.x) > WORLD_EDGE || Math.abs(place.z) > WORLD_EDGE || Math.abs(place.y) > HEIGHT_EDGE) return `the ${label} is outside the world`;
    return undefined;
}

/** Why this ending cannot be used, in words an operator can read, or undefined when it is fine. */
export function whyNotUsable(ending: Ending): string | undefined {

    if (!ID.test(ending.id)) return "its id must be 1 to 24 characters: a lowercase letter, then lowercase letters, digits, - or _";
    if (ending.kind !== "group" && ending.kind !== "solo") return `an ending is either a group or a solo one, not ${String(ending.kind)}`;

    const name = ending.name.trim();
    if (name.length === 0) return "a name cannot be empty";
    if (ending.name.length > E.maxName) return `a name is at most ${E.maxName} characters`;
    if (CONTROL.test(ending.name)) return "a name cannot hold a control character";

    const placeProblem = whyBadPlace("place", ending.place);
    if (placeProblem) return placeProblem;
    if (ending.winSpot) {
        const spotProblem = whyBadPlace("win spot", ending.winSpot);
        if (spotProblem) return spotProblem;
    }

    if (typeof ending.radius !== "number" || !Number.isFinite(ending.radius) || ending.radius <= 0 || ending.radius > E.maxRadius) return `the radius must be above 0 and at most ${E.maxRadius} blocks`;
    if (!Number.isInteger(ending.price) || ending.price < 0 || ending.price > E.maxPrice) return `the price must be a whole number of coins from 0 to ${E.maxPrice}`;

    if (ending.item) {
        if (ending.kind === "group") return "a group ending is paid in coins only: an item is for a solo ending";
        if (!ITEM_ID.test(ending.item.id) || ending.item.id.length > E.maxItemId) return "the item must be an item id like minecraft:emerald";
        if (!Number.isInteger(ending.item.count) || ending.item.count < 1 || ending.item.count > E.maxItemCount) return `the item count must be a whole number from 1 to ${E.maxItemCount}`;
    }

    if (ending.kind === "solo" && ending.price === 0 && !ending.item) return "a solo ending has to ask for coins or an item, or anyone could walk out";

    if (ending.cinematic) {
        const { start, end, seconds, audience } = ending.cinematic;

        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > E.maxCinematicSeconds) return `the cinematic must last more than 0 and at most ${E.maxCinematicSeconds} seconds`;
        if (audience !== "all" && audience !== "winners") return "the cinematic is for all players or for the winners";

        const shot = makeShot("c", "", start, end);
        if (!shot.ok) return `the cinematic: ${shot.reason}`;
    }

    for (const [which, text] of Object.entries(ending.texts)) {
        if (typeof text !== "string") return `the ${which} text must be text`;
        if (text.length > E.maxText) return `a text is at most ${E.maxText} characters (the ${which} one is ${text.length})`;
        if (CONTROL.test(text)) return `a text cannot hold a control character (the ${which} one does)`;
    }

    return undefined;
}

function checked(ending: Ending): Result<Ending> {
    const problem = whyNotUsable(ending);
    return problem ? bad(problem) : good(ending);
}

// ---------------------------------------------------------------------------------------------------------
// Making and editing one
// ---------------------------------------------------------------------------------------------------------

const defaultTexts = (kind: EndingKind): Texts => ({ ...E.texts[kind] });

/** A new ending of this kind, with the defaults of its kind: the radius from the config, free for a group, the default price for a solo one. */
export function newEnding(kind: string, id: string, name: string, place: Place): Result<Ending> {

    if (kind !== "group" && kind !== "solo") return bad(`an ending is either a group or a solo one, not ${kind}`);

    return checked({
        version: ENDING_VERSION,
        id,
        name: name.trim(),
        kind,
        enabled: true,
        place: { x: round2(place.x), y: round2(place.y), z: round2(place.z) },
        radius: E.defaultRadius,
        price: kind === "solo" ? E.defaultSoloPrice : 0,
        consumeItem: true,
        texts: defaultTexts(kind)
    });
}

/** What an edit may change. `null` takes an item or a win spot away. The id and the kind never change. */
export interface EndingPatch {
    readonly name?: string;
    readonly enabled?: boolean;
    readonly place?: Place;
    readonly radius?: number;
    readonly price?: number;
    readonly item?: Item | null;
    readonly consumeItem?: boolean;
    readonly winSpot?: Place | null;
    readonly texts?: Partial<Texts>;
    /** `null` takes the cinematic away. */
    readonly cinematic?: Cinematic | null;
}

/** The ending's cinematic as the camera shot the start sequence plays (its id is the ending's), or undefined when it has none. */
export function cinematicShot(ending: Ending): Shot | undefined {
    return ending.cinematic ? { version: START_VERSION, id: ending.id, name: ending.name, start: ending.cinematic.start, end: ending.cinematic.end } : undefined;
}

/** The ending with this change made, or why it cannot be (the ending itself is left as it was). */
export function edit(ending: Ending, patch: EndingPatch): Result<Ending> {

    const next: { -readonly [K in keyof Ending]: Ending[K] } = { ...ending };

    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.place !== undefined) next.place = { x: round2(patch.place.x), y: round2(patch.place.y), z: round2(patch.place.z) };
    if (patch.radius !== undefined) next.radius = patch.radius;
    if (patch.price !== undefined) next.price = patch.price;
    if (patch.item === null) delete next.item;
    else if (patch.item !== undefined) next.item = { id: patch.item.id, count: patch.item.count };
    if (patch.consumeItem !== undefined) next.consumeItem = patch.consumeItem;
    if (patch.winSpot === null) delete next.winSpot;
    else if (patch.winSpot !== undefined) next.winSpot = { x: round2(patch.winSpot.x), y: round2(patch.winSpot.y), z: round2(patch.winSpot.z) };
    if (patch.texts !== undefined) next.texts = { ...ending.texts, ...patch.texts };
    if (patch.cinematic === null) delete next.cinematic;
    else if (patch.cinematic !== undefined) {
        // The shots' own rounding of the marks; a mark that cannot be a shot's is left as given, for the check below to refuse with its reason.
        const shot = makeShot("c", "", patch.cinematic.start, patch.cinematic.end);
        next.cinematic = {
            start: shot.ok ? shot.value.start : patch.cinematic.start,
            end: shot.ok ? shot.value.end : patch.cinematic.end,
            seconds: round2(patch.cinematic.seconds),
            audience: patch.cinematic.audience
        };
    }

    return checked(next);
}

/** "Escape Boat" -> "escape_boat": a legal id made from a name, numbered (_2, _3...) when it is taken. */
export function endingIdFrom(name: string, taken: ReadonlySet<string>): string {

    const slug = name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^[0-9_]+/, "")
        .slice(0, 24)
        .replace(/_+$/, "");

    const base = slug.length > 0 ? slug : "ending";

    if (!taken.has(base)) return base;

    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = `${base.slice(0, 24 - suffix.length).replace(/_+$/, "")}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** A text with {coins}, {player} and {count} filled in. Anything else in braces, or a value that was not given, stays as typed. */
export function fillText(text: string, values: { readonly coins?: number; readonly player?: string; readonly count?: number }): string {
    return text.replace(/\{(coins|player|count)\}/g, (whole, key: "coins" | "player" | "count") => {
        const value = values[key];
        return value === undefined ? whole : String(value);
    });
}

// ---------------------------------------------------------------------------------------------------------
// Saving and reading one
// ---------------------------------------------------------------------------------------------------------

export function serializeEnding(ending: Ending): string {
    return JSON.stringify({
        v: ending.version,
        id: ending.id,
        nm: ending.name,
        k: ending.kind,
        on: ending.enabled,
        p: ending.place,
        r: ending.radius,
        c: ending.price,
        ...(ending.item ? { i: { id: ending.item.id, n: ending.item.count } } : {}),
        ic: ending.consumeItem,
        ...(ending.winSpot ? { w: ending.winSpot } : {}),
        t: [ending.texts.headline, ending.texts.detail, ending.texts.gather, ending.texts.outlawsOnly],
        ...(ending.cinematic ? { cn: { a: markList(ending.cinematic.start), b: markList(ending.cinematic.end), s: ending.cinematic.seconds, au: ending.cinematic.audience } } : {})
    });
}

function readPlace(raw: unknown, label: string): Result<Place> {
    if (!isRecord(raw)) return bad(`the ${label} is missing`);
    const { x, y, z } = raw;
    if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return bad(`the ${label} is not three numbers`);
    return good({ x: round2(x), y: round2(y), z: round2(z) });
}

/** A saved ending back, or why it cannot be read. Never throws, whatever the text is. */
export function parseEnding(text: string | undefined): Result<Ending> {

    if (text === undefined || text.length === 0) return bad("nothing is saved");

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return bad("the saved data is not valid JSON");
    }

    if (!isRecord(raw)) return bad("the saved data is not an ending");
    if (raw["v"] !== ENDING_VERSION) return bad(`it was saved by a different version (${String(raw["v"])}), and this one reads ${ENDING_VERSION}`);
    if (typeof raw["id"] !== "string") return bad("the saved ending has no id");
    if (raw["k"] !== "group" && raw["k"] !== "solo") return bad("the saved ending is neither a group nor a solo one");
    if (typeof raw["nm"] !== "string") return bad("the saved ending has no name");

    const place = readPlace(raw["p"], "place");
    if (!place.ok) return place;

    let winSpot: Place | undefined;
    if (raw["w"] !== undefined) {
        const spot = readPlace(raw["w"], "win spot");
        if (!spot.ok) return spot;
        winSpot = spot.value;
    }

    if (typeof raw["r"] !== "number") return bad("the saved radius is not a number");
    if (typeof raw["c"] !== "number") return bad("the saved price is not a number");

    let item: Item | undefined;
    if (raw["i"] !== undefined) {
        const found = raw["i"];
        if (!isRecord(found) || typeof found["id"] !== "string" || typeof found["n"] !== "number") return bad("the saved item is not an id and a count");
        item = { id: found["id"], count: found["n"] };
    }

    const lines = raw["t"];
    if (!Array.isArray(lines) || lines.length !== 4 || lines.some((line) => typeof line !== "string")) return bad("the saved texts are not four lines of text");

    let cinematic: Cinematic | undefined;
    if (raw["cn"] !== undefined) {
        const found = raw["cn"];
        if (!isRecord(found) || typeof found["s"] !== "number" || (found["au"] !== "all" && found["au"] !== "winners")) return bad("the saved cinematic is not a start, an end, a length and an audience");

        const start = readMark(found["a"], "cinematic start");
        if (!start.ok) return start;

        const end = readMark(found["b"], "cinematic end");
        if (!end.ok) return end;

        cinematic = { start: start.value, end: end.value, seconds: found["s"], audience: found["au"] };
    }

    return checked({
        version: ENDING_VERSION,
        id: raw["id"],
        name: raw["nm"],
        kind: raw["k"],
        enabled: raw["on"] !== false,
        place: place.value,
        radius: raw["r"],
        price: raw["c"],
        ...(item ? { item } : {}),
        consumeItem: raw["ic"] !== false,
        ...(winSpot ? { winSpot } : {}),
        texts: { headline: lines[0] as string, detail: lines[1] as string, gather: lines[2] as string, outlawsOnly: lines[3] as string },
        ...(cinematic ? { cinematic } : {})
    });
}

// ---------------------------------------------------------------------------------------------------------
// Has the ending been met?
// ---------------------------------------------------------------------------------------------------------

/** Whether `at` is within `radius` of `place`, in three dimensions, the edge included. */
export function within(place: Place, at: Place, radius: number): boolean {
    const dx = at.x - place.x;
    const dy = at.y - place.y;
    const dz = at.z - place.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/** One outlaw in play, as a group ending sees them. */
export interface Member {
    readonly id: string;
    readonly coins: number;
    readonly at: Place;
}

export type GroupVerdict =
    | { readonly ok: true; readonly owed: number; readonly charges: readonly { readonly id: string; readonly take: number }[] }
    | { readonly ok: false; readonly why: "nobody" }
    | { readonly ok: false; readonly why: "gather"; readonly missing: readonly string[] }
    | { readonly ok: false; readonly why: "poor"; readonly need: number; readonly have: number };

/**
 * Whether this gang can use this ending: every member in play within the radius (checked before the money, as the boat always has), and
 * the pooled coins at least `price` x members. The cost is taken from the members in the order given, each giving what they have until it is paid.
 */
export function groupVerdict(ending: Ending, members: readonly Member[]): GroupVerdict {

    if (members.length === 0) return { ok: false, why: "nobody" };

    const missing = members.filter((member) => !within(ending.place, member.at, ending.radius)).map((member) => member.id);
    if (missing.length > 0) return { ok: false, why: "gather", missing };

    const owed = ending.price * members.length;
    const have = members.reduce((sum, member) => sum + Math.max(0, member.coins), 0);
    if (have < owed) return { ok: false, why: "poor", need: owed, have };

    const charges: { id: string; take: number }[] = [];
    let remaining = owed;

    for (const member of members) {
        const take = Math.min(Math.max(0, member.coins), remaining);
        if (take > 0) charges.push({ id: member.id, take });
        remaining -= take;
    }

    return { ok: true, owed, charges };
}

/** The one outlaw trying a solo ending. */
export interface Lone {
    readonly coins: number;
    readonly at: Place;
    /** How many of the ending's item they hold. */
    readonly itemCount: number;
}

export type SoloVerdict =
    | { readonly ok: true; readonly takeCoins: number; readonly takeItem: number }
    | { readonly ok: false; readonly why: "far" }
    | { readonly ok: false; readonly why: "poor"; readonly need: number; readonly have: number }
    | { readonly ok: false; readonly why: "item"; readonly need: number; readonly have: number };

/** Whether this outlaw can use this solo ending: at the place, with the coins, with the item; and what is taken if so. */
export function soloVerdict(ending: Ending, lone: Lone): SoloVerdict {

    if (!within(ending.place, lone.at, ending.radius)) return { ok: false, why: "far" };

    const coins = Math.max(0, lone.coins);
    if (coins < ending.price) return { ok: false, why: "poor", need: ending.price, have: coins };

    if (ending.item && lone.itemCount < ending.item.count) return { ok: false, why: "item", need: ending.item.count, have: lone.itemCount };

    return { ok: true, takeCoins: ending.price, takeItem: ending.item && ending.consumeItem ? ending.item.count : 0 };
}

// ---------------------------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------------------------

/** One assigned outlaw's standing, for the tally and the round verdict. */
export interface Standing {
    readonly escaped: boolean;
    readonly eliminated: boolean;
    readonly inJail: boolean;
}

/** An outlaw who escaped counts as escaped whatever else is true of them. */
export function tally(outlaws: readonly Standing[]): { escaped: number; captured: number; free: number; total: number } {

    let escaped = 0;
    let captured = 0;

    for (const outlaw of outlaws) {
        if (outlaw.escaped) escaped++;
        else if (outlaw.eliminated || outlaw.inJail) captured++;
    }

    return { escaped, captured, free: outlaws.length - escaped - captured, total: outlaws.length };
}

/**
 * Where the round stands, from every assigned outlaw's standing. With no outlaws it is still running. When every outlaw has escaped the outlaws
 * win. The law wins when the outlaws still in play, the ones who did not escape, are all jailed or eliminated, whoever escaped before.
 */
export function roundVerdict(outlaws: readonly Standing[]): "running" | "law_win" | "outlaw_win" {

    if (outlaws.length === 0) return "running";

    const inPlay = outlaws.filter((outlaw) => !outlaw.escaped);

    if (inPlay.length === 0) return "outlaw_win";

    return inPlay.every((outlaw) => outlaw.eliminated || outlaw.inJail) ? "law_win" : "running";
}
