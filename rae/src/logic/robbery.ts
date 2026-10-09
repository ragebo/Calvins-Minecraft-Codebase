import { ROBBERY as R } from "../config/balance.js";
import { OVERWORLD_Y_BOUNDS } from "../config/world.js";

/**
 * A robbery, as data: the elements a builder wired onto blocks they built (a door, a chest, a switch), what locks
 * each one, what must be done first, and what happens when it is done. Pure rules, no game imports: nothing here
 * knows what a Block or a Player is. core/robberystore.ts keeps robberies in the world, core/robberyrun.ts plays
 * them, and the builder edits them through the functions below.
 *
 * Every edit is immutable and answers `{ok, robbery}` or `{ok: false, reason}`, the way logic/route.ts's edits do,
 * and every result is validated as a whole, so a robbery that exists is always one that can be saved, loaded and
 * run: ids are unique and stable, every reference points at something, nothing loops, no block belongs to two
 * elements. `parse` never throws and runs the same validation, so a damaged save is reported, never half-loaded.
 *
 * The saved form is JSON with short keys (a world property is small and every character counts); only this file
 * knows them. A new element kind or lock method is added by extending the unions and the three mappers.
 */

export const ROBBERY_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

/** A block position: three whole numbers. */
export type Pos = readonly [x: number, y: number, z: number];

/** Two corners of a box, normalised so `min` is below `max` on every axis. Both corners are inside the box. */
export interface Box {
    readonly min: Pos;
    readonly max: Pos;
}

/**
 * Who a message or reward goes to.
 *   actor     the player who completed the element
 *   area      everyone inside the robbery's area, alive
 *   outlaws   every living outlaw
 *   law       every living law player
 *   all       everyone
 */
export type Audience = "actor" | "area" | "outlaws" | "law" | "all";
export type Channel = "chat" | "bar" | "title";

export const AUDIENCES: readonly Audience[] = ["actor", "area", "outlaws", "law", "all"];
export const CHANNELS: readonly Channel[] = ["chat", "bar", "title"];

export type ElementKind = "door" | "chest" | "switch" | "frame" | "teller";
export const ELEMENT_KINDS: readonly ElementKind[] = ["door", "chest", "switch", "frame", "teller"];

export interface PickLock {
    readonly kind: "pick";
    readonly hits: number;
    readonly tolerance: number;
    /** Misses in a row that jam it. 0 means never. */
    readonly strikes: number;
    readonly jamSeconds: number;
}

export interface KeyLock {
    readonly kind: "key";
    /** The item that opens it, e.g. "minecraft:iron_pickaxe". */
    readonly item: string;
    readonly consume: boolean;
}

export interface PayLock {
    readonly kind: "pay";
    readonly coins: number;
}

/** How a player completes an element. All of an element's locks must be passed. */
export type Lock = PickLock | KeyLock | PayLock;
export type LockKind = Lock["kind"];
export const LOCK_KINDS: readonly LockKind[] = ["pick", "key", "pay"];

interface EffectBase {
    /** Seconds after the trigger. Omitted means at once. */
    readonly delaySeconds?: number;
}

export interface SayEffect extends EffectBase {
    readonly kind: "say";
    readonly text: string;
    readonly channel: Channel;
    readonly to: Audience;
    /** A sound id played to the same audience. */
    readonly sound?: string;
}

export interface RewardEffect extends EffectBase {
    readonly kind: "reward";
    readonly coins: number;
    readonly bounty: number;
    readonly to: Audience;
}

/**
 * Decides how the robbery comes out. A "win" is a success: it runs the win effects and starts the reset countdown, and what is left
 * (doors, chests) stays workable until the site is put back, so it can sit on ANY element, not only the last. A "fail" locks what is
 * left. Whichever fires first is the only one.
 */
export interface EndEffect extends EffectBase {
    readonly kind: "end";
    readonly result: "win" | "fail";
}

/**
 * Mobs appear: `count` of them, one after another, at a block of the robbery's dimension. Guards: pillagers on the way through a
 * bank. They are tagged with the robbery's id and taken away again when the site is put back.
 */
export interface SpawnEffect extends EffectBase {
    readonly kind: "spawn";
    /** The mob's entity type, e.g. "minecraft:pillager". */
    readonly entity: string;
    readonly count: number;
    /** The block they appear at. */
    readonly at: Pos;
}

/** Something that happens: a line of text, a payout, mobs appearing, the robbery being won or failed. */
export type Effect = SayEffect | RewardEffect | SpawnEffect | EndEffect;
export type EffectKind = Effect["kind"];
export const EFFECT_KINDS: readonly EffectKind[] = ["say", "reward", "spawn", "end"];

interface ElementBase {
    /** "e1", "e2"...: stable for the life of the robbery and never reused, so links never break on a rename. */
    readonly id: string;
    readonly name: string;
    readonly locks: readonly Lock[];
    /** Elements that must be done before this one can be tried. */
    readonly req: readonly string[];
    /** Effects when this element is completed. */
    readonly onDone: readonly Effect[];
    /** Effects when a lock on this element jams. */
    readonly onFail: readonly Effect[];
}

/** An iron door, a wooden door, a trapdoor or a gate: locked means kept shut, done means opened. 1 or 2 blocks. */
export interface DoorElement extends ElementBase {
    readonly kind: "door";
    readonly cells: readonly Pos[];
}

/** A chest or barrel (or a double chest): done means its loot has been put in it. */
export interface ChestElement extends ElementBase {
    readonly kind: "chest";
    readonly cells: readonly Pos[];
    /** A loot table path such as "chests/gold_2", rolled when the chest is unlocked. */
    readonly table?: string;
    /** Items added on top of the table: [item id, amount]. */
    readonly items: readonly (readonly [string, number])[];
}

/** A button, lever, plate or any other block that is pressed: the "keypad" the rest of the robbery waits on. */
export interface SwitchElement extends ElementBase {
    readonly kind: "switch";
    readonly cells: readonly Pos[];
}

/**
 * An item frame: what is in it can be stolen. Done means the thief has been given the loot and the frame has been emptied; the
 * site being put back shows the item in it again. One block (an item frame or a glow item frame). The loot is what the thief
 * receives, set here because a script cannot read what a frame shows: the builder puts the same item in the frame to be seen.
 */
export interface FrameElement extends ElementBase {
    readonly kind: "frame";
    readonly cells: readonly Pos[];
    /** A loot table path such as "chests/gold_2", rolled when the frame is taken from. */
    readonly table?: string;
    /** Items the thief gets on top of the table: [item id, amount]. */
    readonly items: readonly (readonly [string, number])[];
}

/**
 * A teller: an NPC or villager the builder looked at, who can be held up. Done means a player kept a gun aimed at it long enough.
 * It is not a block, so nothing is bound to the world's blocks except the one its feet are in (its "home", which keeps every
 * generic part working and which no click or protection ever sees); the entity itself carries a tag naming this element, and the
 * game finds it through a player's own view.
 */
export interface TellerElement extends ElementBase {
    readonly kind: "teller";
    /** The block its feet are in: exactly one. */
    readonly cells: readonly Pos[];
    /** How long a gun has to stay aimed at it. */
    readonly holdSeconds: number;
}

export type Element = DoorElement | ChestElement | SwitchElement | FrameElement | TellerElement;

/** The elements that hold loot: a chest has it put in, a frame has it taken. */
export type LootElement = ChestElement | FrameElement;

export const holdsLoot = (element: Element): element is LootElement => element.kind === "chest" || element.kind === "frame";

export interface Settings {
    /** Touching an element that waits on nothing (one with no requirements) starts the robbery by itself. */
    readonly autoStart: boolean;
    /** Takes the director's one slot, so it cannot run beside the fort, ranch or train. */
    readonly exclusive: boolean;
    readonly cooldownSeconds: number;
    /** 0 means no limit. */
    readonly timeLimitSeconds: number;
    /** How long after it ends the site is put back. */
    readonly resetAfterSeconds: number;
    readonly roundOnly: boolean;
    /** Players cannot break or blow up a block an element is bound to, running or not (operators can). */
    readonly protect: boolean;
    /** Fails when nobody has been inside the area for this long. 0 means never. */
    readonly failWhenEmptySeconds: number;
    /** Only outlaws can work the elements and count as being inside the area. Off: any player can. */
    readonly outlawsOnly: boolean;
}

export type HookName = "start" | "win" | "fail";
export const HOOK_NAMES: readonly HookName[] = ["start", "win", "fail"];

export interface Robbery {
    readonly version: number;
    /** A short lowercase slug, never changed: it names the world property, the tags and the structures. */
    readonly id: string;
    readonly name: string;
    /** "overworld", "nether" or "the_end". */
    readonly dimension: string;
    /** The number the next element id comes from. */
    readonly nextElement: number;
    readonly area?: Box;
    readonly settings: Settings;
    readonly hooks: { readonly start: readonly Effect[]; readonly win: readonly Effect[]; readonly fail: readonly Effect[] };
    readonly elements: readonly Element[];
}

export interface Fail { readonly ok: false; readonly reason: string }
export type Result<T> = { readonly ok: true; readonly value: T } | Fail;
export type Edit = { readonly ok: true; readonly robbery: Robbery } | Fail;
export type AddResult = { readonly ok: true; readonly robbery: Robbery; readonly element: Element } | Fail;
export type RemoveResult = { readonly ok: true; readonly robbery: Robbery; readonly removedReferences: number } | Fail;

const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (reason: string): Fail => ({ ok: false, reason });

// ---------------------------------------------------------------------------------------------------------
// Names, ids, positions
// ---------------------------------------------------------------------------------------------------------

const SLUG = /^[a-z][a-z0-9_]*$/;
const ELEMENT_ID = /^e[1-9][0-9]*$/;
const ITEM_ID = /^[a-z0-9_]+:[a-z0-9_./]+$/;
const ENTITY_ID = /^[a-z0-9_]+:[a-z0-9_.]+$/;
const TABLE_PATH = /^[a-z0-9_/]+$/;
const SOUND_ID = /^[a-zA-Z0-9_.:]+$/;
const FORMAT_CODE = /§./g;

/** A name as it is stored: no colour codes (they would make the lists unreadable), single spaces, trimmed. */
export function cleanName(raw: string): string {
    return raw.replace(FORMAT_CODE, "").replace(/\s+/g, " ").trim();
}

export function whyBadId(id: string): string | undefined {
    if (id.length < 2 || id.length > R.maxIdLength) return `an id is 2 to ${R.maxIdLength} characters`;
    if (!SLUG.test(id)) return "an id is lowercase letters, digits and underscores, starting with a letter";
    return undefined;
}

export function whyBadName(name: string): string | undefined {
    if (name.length === 0) return "a name cannot be empty";
    if (name.length > R.maxNameLength) return `a name is at most ${R.maxNameLength} characters`;
    return undefined;
}

export const posKey = (dimension: string, pos: Pos): string => `${dimension}|${pos[0]},${pos[1]},${pos[2]}`;

export const sameDimension = (id: string): string => id.replace(/^minecraft:/, "");

function whyBadPos(raw: unknown, dimension: string): string | undefined {

    if (!Array.isArray(raw) || raw.length !== 3) return "a position needs x, y and z";
    if (!raw.every((n) => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= R.maxCoordinate)) return "a position is three whole numbers";

    const y = raw[1] as number;

    if (dimension === "overworld" && (y < OVERWORLD_Y_BOUNDS.min || y > OVERWORLD_Y_BOUNDS.max)) {
        return `y=${y} is outside the overworld build limit (${OVERWORLD_Y_BOUNDS.min}..${OVERWORLD_Y_BOUNDS.max})`;
    }

    return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------

export function normalizeBox(a: Pos, b: Pos): Box {
    return {
        min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
        max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
    };
}

/** Whether a point (a player's feet, say) is inside the box: every block of the box counts whole, edges included. */
export function boxContains(box: Box, x: number, y: number, z: number): boolean {
    return x >= box.min[0] && x < box.max[0] + 1
        && y >= box.min[1] && y < box.max[1] + 1
        && z >= box.min[2] && z < box.max[2] + 1;
}

export function boxSize(box: Box): { readonly x: number; readonly y: number; readonly z: number } {
    return { x: box.max[0] - box.min[0] + 1, y: box.max[1] - box.min[1] + 1, z: box.max[2] - box.min[2] + 1 };
}

/** Points along the twelve edges of the box, about `spacing` apart, for drawing it. At most `limit` of them. */
export function edgePoints(box: Box, spacing: number, limit: number): Pos[] {

    const [x0, y0, z0] = box.min;
    const [x1, y1, z1] = [box.max[0] + 1, box.max[1] + 1, box.max[2] + 1];
    const step = Math.max(1, Math.floor(spacing));
    const points: [number, number, number][] = [];

    const along = (from: number, to: number): number[] => {
        const values: number[] = [];
        for (let v = from; v < to; v += step) values.push(v);
        values.push(to);
        return values;
    };

    for (const x of along(x0, x1)) for (const y of [y0, y1]) for (const z of [z0, z1]) points.push([x, y, z]);
    for (const y of along(y0, y1)) for (const x of [x0, x1]) for (const z of [z0, z1]) points.push([x, y, z]);
    for (const z of along(z0, z1)) for (const x of [x0, x1]) for (const y of [y0, y1]) points.push([x, y, z]);

    const unique = new Map(points.map((p) => [`${p[0]},${p[1]},${p[2]}`, p] as const));

    return [...unique.values()].slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

export function defaultSettings(): Settings {
    return {
        autoStart: true,
        exclusive: true,
        cooldownSeconds: R.defaultCooldownSeconds,
        timeLimitSeconds: R.defaultTimeLimitSeconds,
        resetAfterSeconds: R.defaultResetAfterSeconds,
        roundOnly: false,
        protect: true,
        failWhenEmptySeconds: R.defaultFailWhenEmptySeconds,
        outlawsOnly: true
    };
}

export type SettingKey = keyof Settings;

const SECOND_SETTINGS: readonly SettingKey[] = ["cooldownSeconds", "timeLimitSeconds", "resetAfterSeconds", "failWhenEmptySeconds"];
const FLAG_SETTINGS: readonly SettingKey[] = ["autoStart", "exclusive", "roundOnly", "protect", "outlawsOnly"];
export const SETTING_KEYS: readonly SettingKey[] = [...FLAG_SETTINGS, ...SECOND_SETTINGS];

/** True for the settings that are on or off; the rest are a whole number of seconds. */
export const isFlagSetting = (key: SettingKey): boolean => FLAG_SETTINGS.includes(key);

function validateSettings(raw: unknown): Result<Settings> {

    if (typeof raw !== "object" || raw === null) return bad("settings are missing");

    const source = raw as Record<string, unknown>;
    const settings: Record<string, boolean | number> = {};

    for (const key of FLAG_SETTINGS) {
        if (typeof source[key] !== "boolean") return bad(`setting ${key} must be on or off`);
        settings[key] = source[key];
    }

    for (const key of SECOND_SETTINGS) {
        const value = source[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > R.maxSettingSeconds) {
            return bad(`setting ${key} must be a whole number of seconds from 0 to ${R.maxSettingSeconds}`);
        }
        settings[key] = value;
    }

    return good(settings as unknown as Settings);
}

// ---------------------------------------------------------------------------------------------------------
// Validation of the parts. Each takes something untyped (a form's answers, a parsed save) and answers a clean value
// ---------------------------------------------------------------------------------------------------------

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === "object" && raw !== null && !Array.isArray(raw);

function intInRange(raw: unknown, min: number, max: number, what: string): Result<number> {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) return bad(`${what} must be a whole number from ${min} to ${max}`);
    return good(raw);
}

function whyBadItem(item: unknown): string | undefined {
    return typeof item === "string" && ITEM_ID.test(item) && item.length <= 64 ? undefined : "an item id looks like minecraft:iron_pickaxe";
}

export function validateLock(raw: unknown): Result<Lock> {

    if (!isRecord(raw)) return bad("a lock is missing its settings");

    if (raw["kind"] === "pick") {
        const hits = intInRange(raw["hits"], 1, R.maxPickHits, "the number of picks");
        if (!hits.ok) return hits;
        const tolerance = intInRange(raw["tolerance"], 1, Math.floor(R.pickSliderMax / 2), "the tolerance");
        if (!tolerance.ok) return tolerance;
        const strikes = intInRange(raw["strikes"], 0, R.maxPickStrikes, "the number of strikes");
        if (!strikes.ok) return strikes;
        const jam = intInRange(raw["jamSeconds"], 0, R.maxPickJamSeconds, "the jam time");
        if (!jam.ok) return jam;
        return good({ kind: "pick", hits: hits.value, tolerance: tolerance.value, strikes: strikes.value, jamSeconds: jam.value });
    }

    if (raw["kind"] === "key") {
        const problem = whyBadItem(raw["item"]);
        if (problem) return bad(problem);
        if (typeof raw["consume"] !== "boolean") return bad("a key lock must say whether the key is used up");
        return good({ kind: "key", item: raw["item"] as string, consume: raw["consume"] });
    }

    if (raw["kind"] === "pay") {
        const coins = intInRange(raw["coins"], 1, R.maxPayCoins, "the price");
        if (!coins.ok) return coins;
        return good({ kind: "pay", coins: coins.value });
    }

    return bad(`unknown lock method ${String(raw["kind"])}`);
}

/** `dimension` decides how high a spawn point may be; the whole-robbery check passes the robbery's own. */
export function validateEffect(raw: unknown, dimension = "overworld"): Result<Effect> {

    if (!isRecord(raw)) return bad("an effect is missing its settings");

    let delay: { delaySeconds: number } | Record<string, never> = {};

    if (raw["delaySeconds"] !== undefined) {
        const seconds = intInRange(raw["delaySeconds"], 0, R.maxDelaySeconds, "the delay");
        if (!seconds.ok) return seconds;
        if (seconds.value > 0) delay = { delaySeconds: seconds.value };
    }

    if (raw["kind"] === "say") {
        const text = typeof raw["text"] === "string" ? raw["text"].trim() : "";
        if (text.length === 0 || text.length > R.maxTextLength) return bad(`a message is 1 to ${R.maxTextLength} characters`);
        if (!CHANNELS.includes(raw["channel"] as Channel)) return bad("a message goes to chat, the action bar or the title");
        if (!AUDIENCES.includes(raw["to"] as Audience)) return bad("a message needs someone to go to");
        const sound = raw["sound"];
        if (sound !== undefined && (typeof sound !== "string" || !SOUND_ID.test(sound) || sound.length > 64)) return bad("a sound id looks like random.levelup");
        return good({ kind: "say", text, channel: raw["channel"] as Channel, to: raw["to"] as Audience, ...(typeof sound === "string" ? { sound } : {}), ...delay });
    }

    if (raw["kind"] === "reward") {
        const coins = intInRange(raw["coins"], 0, R.maxRewardAmount, "the coins");
        if (!coins.ok) return coins;
        const bounty = intInRange(raw["bounty"], 0, R.maxRewardAmount, "the bounty");
        if (!bounty.ok) return bounty;
        if (coins.value === 0 && bounty.value === 0) return bad("a reward needs coins or bounty");
        if (!AUDIENCES.includes(raw["to"] as Audience)) return bad("a reward needs someone to go to");
        return good({ kind: "reward", coins: coins.value, bounty: bounty.value, to: raw["to"] as Audience, ...delay });
    }

    if (raw["kind"] === "spawn") {
        const entity = raw["entity"];
        if (typeof entity !== "string" || !ENTITY_ID.test(entity) || entity.length > 64) return bad("a mob type looks like minecraft:pillager");
        const count = intInRange(raw["count"], 1, R.maxSpawnCount, "how many mobs");
        if (!count.ok) return count;
        const problem = whyBadPos(raw["at"], dimension);
        if (problem) return bad(`where the mobs appear: ${problem}`);
        const at = raw["at"] as readonly number[];
        return good({ kind: "spawn", entity, count: count.value, at: [at[0]!, at[1]!, at[2]!], ...delay });
    }

    if (raw["kind"] === "end") {
        if (raw["result"] !== "win" && raw["result"] !== "fail") return bad("the robbery ends in a win or a fail");
        return good({ kind: "end", result: raw["result"], ...delay });
    }

    return bad(`unknown effect ${String(raw["kind"])}`);
}

function validateList<T>(raw: unknown, check: (item: unknown) => Result<T>, max: number, what: string): Result<T[]> {

    if (!Array.isArray(raw)) return bad(`${what} must be a list`);
    if (raw.length > max) return bad(`${what} can hold at most ${max}`);

    const out: T[] = [];

    for (const item of raw) {
        const checked = check(item);
        if (!checked.ok) return checked;
        out.push(checked.value);
    }

    return good(out);
}

export const validateEffects = (raw: unknown, what = "effects", dimension = "overworld"): Result<Effect[]> =>
    validateList(raw, (effect) => validateEffect(effect, dimension), R.maxEffectsPerList, what);

function validateLocks(raw: unknown): Result<Lock[]> {

    const locks = validateList(raw, validateLock, R.maxLocks, "the locks");
    if (!locks.ok) return locks;

    const kinds = locks.value.map((lock) => lock.kind);
    if (new Set(kinds).size !== kinds.length) return bad("an element can have each kind of lock only once");

    return locks;
}

function validateCells(raw: unknown, dimension: string, max: number): Result<Pos[]> {

    if (!Array.isArray(raw) || raw.length === 0) return bad("an element must be bound to at least one block");
    if (raw.length > max) return bad(`this kind of element is bound to at most ${max} block${max === 1 ? "" : "s"}`);

    const cells: Pos[] = [];

    for (const cell of raw) {
        const problem = whyBadPos(cell, dimension);
        if (problem) return bad(problem);
        cells.push([cell[0], cell[1], cell[2]] as Pos);
    }

    if (new Set(cells.map((c) => c.join(","))).size !== cells.length) return bad("the same block is listed twice");

    return good(cells);
}

function validateItems(raw: unknown): Result<(readonly [string, number])[]> {

    if (!Array.isArray(raw)) return bad("the items must be a list");
    if (raw.length > R.maxItemStacks) return bad(`a chest or a frame can be given at most ${R.maxItemStacks} kinds of item`);

    const items: (readonly [string, number])[] = [];

    for (const entry of raw) {
        if (!Array.isArray(entry) || entry.length !== 2) return bad("an item is an id and an amount");
        const problem = whyBadItem(entry[0]);
        if (problem) return bad(problem);
        const amount = intInRange(entry[1], 1, 64, "the amount");
        if (!amount.ok) return amount;
        items.push([entry[0] as string, amount.value]);
    }

    return good(items);
}

function validateTable(raw: unknown): Result<string | undefined> {

    if (raw === undefined) return good(undefined);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 64 || !TABLE_PATH.test(raw)) return bad("a loot table path looks like chests/gold_2");

    return good(raw);
}

/** A whole element from untyped parts. The cells' dimension decides the height limit. */
function validateElement(raw: unknown, dimension: string): Result<Element> {

    if (!isRecord(raw)) return bad("an element is damaged");

    const id = raw["id"];
    if (typeof id !== "string" || !ELEMENT_ID.test(id)) return bad("an element has no valid id");

    const name = typeof raw["name"] === "string" ? cleanName(raw["name"]) : "";
    const nameProblem = whyBadName(name);
    if (nameProblem) return bad(`element ${id}: ${nameProblem}`);

    const locks = validateLocks(raw["locks"]);
    if (!locks.ok) return bad(`${name}: ${locks.reason}`);

    const req = validateList(raw["req"], (item) => (typeof item === "string" && ELEMENT_ID.test(item) ? good(item) : bad("a requirement must be an element id")), R.maxElements, "the requirements");
    if (!req.ok) return bad(`${name}: ${req.reason}`);
    if (new Set(req.value).size !== req.value.length) return bad(`${name}: the same requirement is listed twice`);
    if (req.value.includes(id)) return bad(`${name}: an element cannot require itself`);

    const onDone = validateEffects(raw["onDone"], "the done effects", dimension);
    if (!onDone.ok) return bad(`${name}: ${onDone.reason}`);
    const onFail = validateEffects(raw["onFail"], "the jam effects", dimension);
    if (!onFail.ok) return bad(`${name}: ${onFail.reason}`);

    const common = { id, name, locks: locks.value, req: req.value, onDone: onDone.value, onFail: onFail.value };

    if (raw["kind"] === "door") {
        const cells = validateCells(raw["cells"], dimension, 2);
        if (!cells.ok) return bad(`${name}: ${cells.reason}`);
        return good({ ...common, kind: "door", cells: cells.value });
    }

    if (raw["kind"] === "switch") {
        const cells = validateCells(raw["cells"], dimension, R.maxCells);
        if (!cells.ok) return bad(`${name}: ${cells.reason}`);
        return good({ ...common, kind: "switch", cells: cells.value });
    }

    if (raw["kind"] === "chest" || raw["kind"] === "frame") {
        const isFrame = raw["kind"] === "frame";
        const cells = validateCells(raw["cells"], dimension, isFrame ? 1 : 2);
        if (!cells.ok) return bad(`${name}: ${cells.reason}`);
        const table = validateTable(raw["table"]);
        if (!table.ok) return bad(`${name}: ${table.reason}`);
        const items = validateItems(raw["items"] ?? []);
        if (!items.ok) return bad(`${name}: ${items.reason}`);
        const loot = { cells: cells.value, items: items.value, ...(table.value !== undefined ? { table: table.value } : {}) };
        return good(isFrame ? { ...common, kind: "frame", ...loot } : { ...common, kind: "chest", ...loot });
    }

    if (raw["kind"] === "teller") {
        const cells = validateCells(raw["cells"], dimension, 1);
        if (!cells.ok) return bad(`${name}: ${cells.reason}`);
        const hold = intInRange(raw["holdSeconds"], 1, R.maxHoldSeconds, "the hold-up time");
        if (!hold.ok) return bad(`${name}: ${hold.reason}`);
        return good({ ...common, kind: "teller", cells: cells.value, holdSeconds: hold.value });
    }

    return bad(`${name}: unknown kind ${String(raw["kind"])}`);
}

function validateBox(raw: unknown, dimension: string): Result<Box | undefined> {

    if (raw === undefined) return good(undefined);
    if (!isRecord(raw)) return bad("the area is damaged");

    for (const corner of [raw["min"], raw["max"]]) {
        const problem = whyBadPos(corner, dimension);
        if (problem) return bad(`the area: ${problem}`);
    }

    const min = raw["min"] as Pos;
    const max = raw["max"] as Pos;
    return good(normalizeBox(min, max));
}

// ---------------------------------------------------------------------------------------------------------
// The whole robbery
// ---------------------------------------------------------------------------------------------------------

/** The first loop in the requirements, as a readable chain, or undefined when there is none. */
function findLoop(elements: readonly Element[]): string | undefined {

    const byId = new Map(elements.map((e) => [e.id, e] as const));
    const state = new Map<string, "walking" | "done">();

    const visit = (id: string, path: string[]): string | undefined => {

        if (state.get(id) === "done") return undefined;

        if (state.get(id) === "walking") {
            const start = path.indexOf(id);
            return [...path.slice(start), id].map((x) => byId.get(x)?.name ?? x).join(" -> ");
        }

        state.set(id, "walking");

        for (const next of byId.get(id)?.req ?? []) {
            const loop = visit(next, [...path, id]);
            if (loop) return loop;
        }

        state.set(id, "done");
        return undefined;
    };

    for (const element of elements) {
        const loop = visit(element.id, []);
        if (loop) return loop;
    }

    return undefined;
}

/**
 * Everything that must hold for a robbery to exist at all, checked on the whole of it: the same checks run after
 * every edit and after every load, so a robbery that is held in memory can always be saved and reloaded.
 */
export function validateRobbery(raw: unknown): Result<Robbery> {

    if (!isRecord(raw)) return bad("the saved data is not a robbery");
    if (raw["version"] !== ROBBERY_VERSION) return bad(`it was saved by a different version (${String(raw["version"])}); it has been left alone`);

    const id = raw["id"];
    if (typeof id !== "string") return bad("it has no id");
    const idProblem = whyBadId(id);
    if (idProblem) return bad(idProblem);

    const name = typeof raw["name"] === "string" ? cleanName(raw["name"]) : "";
    const nameProblem = whyBadName(name);
    if (nameProblem) return bad(nameProblem);

    const dimension = raw["dimension"];
    if (dimension !== "overworld" && dimension !== "nether" && dimension !== "the_end") return bad("its dimension is not overworld, nether or the_end");

    const nextElement = raw["nextElement"];
    if (typeof nextElement !== "number" || !Number.isInteger(nextElement) || nextElement < 1) return bad("its element counter is damaged");

    const area = validateBox(raw["area"], dimension);
    if (!area.ok) return area;

    const settings = validateSettings(raw["settings"]);
    if (!settings.ok) return settings;

    const hooks = raw["hooks"];
    if (!isRecord(hooks)) return bad("its start, win and fail effects are missing");
    const start = validateEffects(hooks["start"], "the start effects", dimension);
    if (!start.ok) return start;
    const win = validateEffects(hooks["win"], "the win effects", dimension);
    if (!win.ok) return win;
    const fail = validateEffects(hooks["fail"], "the fail effects", dimension);
    if (!fail.ok) return fail;

    const rawElements = raw["elements"];
    if (!Array.isArray(rawElements)) return bad("its elements are missing");
    if (rawElements.length > R.maxElements) return bad(`a robbery holds at most ${R.maxElements} elements`);

    const elements: Element[] = [];

    for (const rawElement of rawElements) {
        const element = validateElement(rawElement, dimension);
        if (!element.ok) return element;
        elements.push(element.value);
    }

    const ids = new Set(elements.map((e) => e.id));
    if (ids.size !== elements.length) return bad("two elements have the same id");

    const names = new Set(elements.map((e) => e.name.toLowerCase()));
    if (names.size !== elements.length) return bad("two elements have the same name");

    for (const element of elements) {
        for (const required of element.req) {
            if (!ids.has(required)) return bad(`${element.name} needs an element that does not exist (${required})`);
        }
        if (Number(element.id.slice(1)) >= nextElement) return bad(`element "${element.name}" has an id ahead of the element counter`);
    }

    const owner = new Map<string, string>();

    for (const element of elements) {
        for (const cell of element.cells) {
            const key = cell.join(",");
            const holder = owner.get(key);
            if (holder !== undefined) return bad(`the block ${key} is bound to both ${holder} and ${element.name}`);
            owner.set(key, element.name);
        }
    }

    const loop = findLoop(elements);
    if (loop) return bad(`the requirements go in a loop: ${loop}`);

    // Each effect fires at most once a run, so the sum over every list is the most mobs that can be standing at once.
    const guards = [start.value, win.value, fail.value, ...elements.flatMap((e) => [e.onDone, e.onFail])]
        .reduce((sum, list) => sum + list.reduce((inner, effect) => inner + (effect.kind === "spawn" ? effect.count : 0), 0), 0);
    if (guards > R.maxGuards) return bad(`a robbery can spawn at most ${R.maxGuards} mobs in all (this one would spawn ${guards})`);

    return good({
        version: ROBBERY_VERSION, id, name, dimension, nextElement,
        ...(area.value ? { area: area.value } : {}),
        settings: settings.value,
        hooks: { start: start.value, win: win.value, fail: fail.value },
        elements
    });
}

// ---------------------------------------------------------------------------------------------------------
// The saved form: short keys. Only this section knows them.
// ---------------------------------------------------------------------------------------------------------

const KIND_CODES: Record<ElementKind, string> = { door: "dr", chest: "ch", switch: "sw", frame: "fr", teller: "tl" };
const KIND_FROM_CODE: Record<string, ElementKind> = { dr: "door", ch: "chest", sw: "switch", fr: "frame", tl: "teller" };
const RESULT_CODES = { win: "w", fail: "f" } as const;

function storeLock(lock: Lock): Record<string, unknown> {
    if (lock.kind === "pick") return { m: "pick", h: lock.hits, t: lock.tolerance, s: lock.strikes, j: lock.jamSeconds };
    if (lock.kind === "key") return { m: "key", i: lock.item, u: lock.consume ? 1 : 0 };
    return { m: "pay", c: lock.coins };
}

function readLock(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    if (raw["m"] === "pick") return { kind: "pick", hits: raw["h"], tolerance: raw["t"], strikes: raw["s"], jamSeconds: raw["j"] };
    if (raw["m"] === "key") return { kind: "key", item: raw["i"], consume: raw["u"] === 1 };
    if (raw["m"] === "pay") return { kind: "pay", coins: raw["c"] };
    return raw;
}

function storeEffect(effect: Effect): Record<string, unknown> {

    const delay = effect.delaySeconds === undefined ? {} : { d: effect.delaySeconds };

    if (effect.kind === "say") return { a: "say", x: effect.text, c: effect.channel, to: effect.to, ...(effect.sound !== undefined ? { so: effect.sound } : {}), ...delay };
    if (effect.kind === "reward") return { a: "rew", co: effect.coins, bo: effect.bounty, to: effect.to, ...delay };
    if (effect.kind === "spawn") return { a: "spn", e: effect.entity, n: effect.count, p: [...effect.at], ...delay };
    return { a: "end", r: RESULT_CODES[effect.result], ...delay };
}

function readEffect(raw: unknown): unknown {

    if (!isRecord(raw)) return raw;

    const delay = raw["d"] === undefined ? {} : { delaySeconds: raw["d"] };

    if (raw["a"] === "say") return { kind: "say", text: raw["x"], channel: raw["c"], to: raw["to"], ...(raw["so"] !== undefined ? { sound: raw["so"] } : {}), ...delay };
    if (raw["a"] === "rew") return { kind: "reward", coins: raw["co"], bounty: raw["bo"], to: raw["to"], ...delay };
    if (raw["a"] === "spn") return { kind: "spawn", entity: raw["e"], count: raw["n"], at: raw["p"], ...delay };
    if (raw["a"] === "end") return { kind: "end", result: raw["r"] === "w" ? "win" : raw["r"] === "f" ? "fail" : raw["r"], ...delay };
    return raw;
}

const storeEffects = (effects: readonly Effect[]): unknown[] => effects.map(storeEffect);
const readEffects = (raw: unknown): unknown => (Array.isArray(raw) ? raw.map(readEffect) : raw);

function storeElement(element: Element): Record<string, unknown> {
    return {
        i: element.id, k: KIND_CODES[element.kind], nm: element.name, p: element.cells.map((c) => [...c]),
        ...(element.locks.length > 0 ? { l: element.locks.map(storeLock) } : {}),
        ...(element.req.length > 0 ? { r: [...element.req] } : {}),
        ...(element.onDone.length > 0 ? { x: storeEffects(element.onDone) } : {}),
        ...(element.onFail.length > 0 ? { y: storeEffects(element.onFail) } : {}),
        ...(holdsLoot(element) && element.table !== undefined ? { lt: element.table } : {}),
        ...(holdsLoot(element) && element.items.length > 0 ? { it: element.items.map((i) => [i[0], i[1]]) } : {}),
        ...(element.kind === "teller" ? { hs: element.holdSeconds } : {})
    };
}

function readElement(raw: unknown): unknown {

    if (!isRecord(raw)) return raw;

    const kind = typeof raw["k"] === "string" ? KIND_FROM_CODE[raw["k"]] : undefined;

    return {
        id: raw["i"], kind, name: raw["nm"], cells: raw["p"],
        locks: Array.isArray(raw["l"]) ? raw["l"].map(readLock) : [],
        req: raw["r"] ?? [],
        onDone: readEffects(raw["x"] ?? []),
        onFail: readEffects(raw["y"] ?? []),
        table: raw["lt"],
        items: raw["it"] ?? [],
        holdSeconds: raw["hs"]
    };
}

const FLAG_CODES: Record<string, SettingKey> = { as: "autoStart", ex: "exclusive", rd: "roundOnly", pr: "protect", wo: "outlawsOnly" };
const SECOND_CODES: Record<string, SettingKey> = { cd: "cooldownSeconds", tl: "timeLimitSeconds", ra: "resetAfterSeconds", fe: "failWhenEmptySeconds" };

function storeSettings(settings: Settings): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [code, key] of Object.entries(FLAG_CODES)) out[code] = settings[key] ? 1 : 0;
    for (const [code, key] of Object.entries(SECOND_CODES)) out[code] = settings[key];
    return out;
}

function readSettings(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    const out: Record<string, unknown> = {};
    for (const [code, key] of Object.entries(FLAG_CODES)) out[key] = raw[code] === 1;
    for (const [code, key] of Object.entries(SECOND_CODES)) out[key] = raw[code];
    return out;
}

/** The text a robbery is saved as. */
export function serialize(robbery: Robbery): string {
    return JSON.stringify({
        v: robbery.version, id: robbery.id, nm: robbery.name, d: robbery.dimension, n: robbery.nextElement,
        ...(robbery.area ? { a: [...robbery.area.min, ...robbery.area.max] } : {}),
        s: storeSettings(robbery.settings),
        h: { st: storeEffects(robbery.hooks.start), w: storeEffects(robbery.hooks.win), f: storeEffects(robbery.hooks.fail) },
        e: robbery.elements.map(storeElement)
    });
}

/** A saved robbery, or the reason it cannot be one. Never throws. */
export function parse(text: string | undefined): Result<Robbery> {

    if (text === undefined || text.length === 0) return bad("nothing is saved");

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return bad("the saved data is not valid JSON");
    }

    if (!isRecord(raw)) return bad("the saved data is not a robbery");

    const a = raw["a"];
    const area = Array.isArray(a) && a.length === 6 ? { min: [a[0], a[1], a[2]], max: [a[3], a[4], a[5]] } : a === undefined ? undefined : "damaged";
    const hooks = isRecord(raw["h"]) ? raw["h"] : {};

    return validateRobbery({
        version: raw["v"], id: raw["id"], name: raw["nm"], dimension: raw["d"], nextElement: raw["n"],
        area,
        settings: readSettings(raw["s"]),
        hooks: { start: readEffects(hooks["st"] ?? []), win: readEffects(hooks["w"] ?? []), fail: readEffects(hooks["f"] ?? []) },
        elements: Array.isArray(raw["e"]) ? raw["e"].map(readElement) : raw["e"]
    });
}

// ---------------------------------------------------------------------------------------------------------
// Looking things up
// ---------------------------------------------------------------------------------------------------------

export const findElement = (robbery: Robbery, id: string): Element | undefined => robbery.elements.find((e) => e.id === id);

/** The element bound to a block, if any. */
export function elementAt(robbery: Robbery, pos: Pos): Element | undefined {
    return robbery.elements.find((e) => e.cells.some((c) => c[0] === pos[0] && c[1] === pos[1] && c[2] === pos[2]));
}

/** Elements nothing has to be done before: where a robbery can be started from. */
export const rootElements = (robbery: Robbery): readonly Element[] => robbery.elements.filter((e) => e.req.length === 0);

/** Elements that wait on this one. */
export const dependentsOf = (robbery: Robbery, id: string): readonly Element[] => robbery.elements.filter((e) => e.req.includes(id));

const KIND_LABELS: Record<ElementKind, string> = { door: "Door", chest: "Chest", switch: "Switch", frame: "Frame", teller: "Teller" };
export const kindLabel = (kind: ElementKind): string => KIND_LABELS[kind];

/** An item id as a player would say it: "minecraft:iron_pickaxe" becomes "iron pickaxe". */
export function itemLabel(typeId: string): string {
    const colon = typeId.indexOf(":");
    return (colon === -1 ? typeId : typeId.slice(colon + 1)).replace(/_/g, " ");
}

function uniqueName(robbery: Robbery, base: string): string {

    const taken = new Set(robbery.elements.map((e) => e.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;

    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------------------

function checked(candidate: Robbery): Edit {
    const result = validateRobbery(candidate);
    return result.ok ? { ok: true, robbery: result.value } : result;
}

export function newRobbery(id: string, name: string, dimension: string): Edit {

    const clean = cleanName(name);
    const problem = whyBadId(id) ?? whyBadName(clean);
    if (problem) return bad(problem);

    return checked({
        version: ROBBERY_VERSION, id, name: clean, dimension, nextElement: 1,
        settings: defaultSettings(), hooks: { start: [], win: [], fail: [] }, elements: []
    });
}

export function renameRobbery(robbery: Robbery, name: string): Edit {
    return checked({ ...robbery, name: cleanName(name) });
}

export function setSettings(robbery: Robbery, patch: Partial<Settings>): Edit {
    return checked({ ...robbery, settings: { ...robbery.settings, ...patch } });
}

export function setArea(robbery: Robbery, a: Pos, b: Pos): Edit {
    return checked({ ...robbery, area: normalizeBox(a, b) });
}

export function clearArea(robbery: Robbery): Edit {
    const { area: _removed, ...rest } = robbery;
    return checked(rest);
}

export function setHook(robbery: Robbery, hook: HookName, effects: readonly Effect[]): Edit {
    return checked({ ...robbery, hooks: { ...robbery.hooks, [hook]: effects } });
}

/** What a new element is made from. Anything left out is empty. */
export interface NewElement {
    readonly kind: ElementKind;
    readonly name?: string;
    readonly cells: readonly Pos[];
    readonly table?: string;
    readonly items?: readonly (readonly [string, number])[];
    readonly locks?: readonly Lock[];
    readonly req?: readonly string[];
    readonly onDone?: readonly Effect[];
    readonly onFail?: readonly Effect[];
    /** A teller's hold-up time in seconds; the default is R.defaultHoldSeconds. */
    readonly holdSeconds?: number;
}

export function addElement(robbery: Robbery, spec: NewElement): AddResult {

    if (robbery.elements.length >= R.maxElements) return bad(`a robbery holds at most ${R.maxElements} elements`);

    const id = `e${robbery.nextElement}`;
    const wanted = spec.name === undefined ? "" : cleanName(spec.name);

    // A name the builder typed is theirs: refuse a clash and say so. Only a default name is numbered to stay unique.
    if (wanted.length > 0 && robbery.elements.some((e) => e.name.toLowerCase() === wanted.toLowerCase())) {
        return bad(`there is already an element called ${wanted}`);
    }

    const name = wanted.length > 0 ? wanted : uniqueName(robbery, `${kindLabel(spec.kind)} ${robbery.nextElement}`);

    const element = validateElement({
        id, kind: spec.kind, name, cells: spec.cells, locks: spec.locks ?? [], req: spec.req ?? [],
        onDone: spec.onDone ?? [], onFail: spec.onFail ?? [], table: spec.table, items: spec.items ?? [],
        holdSeconds: spec.holdSeconds ?? R.defaultHoldSeconds
    }, robbery.dimension);

    if (!element.ok) return element;

    const result = checked({ ...robbery, nextElement: robbery.nextElement + 1, elements: [...robbery.elements, element.value] });

    return result.ok ? { ok: true, robbery: result.robbery, element: element.value } : result;
}

/** What may be changed on an element. `table: null` clears the loot table. */
export interface ElementPatch {
    readonly name?: string;
    readonly cells?: readonly Pos[];
    readonly table?: string | null;
    readonly items?: readonly (readonly [string, number])[];
    readonly locks?: readonly Lock[];
    readonly req?: readonly string[];
    readonly onDone?: readonly Effect[];
    readonly onFail?: readonly Effect[];
    readonly holdSeconds?: number;
}

export function updateElement(robbery: Robbery, id: string, patch: ElementPatch): Edit {

    const current = findElement(robbery, id);
    if (!current) return bad(`there is no element ${id}`);

    if (!holdsLoot(current) && (patch.table !== undefined || patch.items !== undefined)) return bad("only a chest or an item frame has loot");
    if (current.kind !== "teller" && patch.holdSeconds !== undefined) return bad("only a teller has a hold-up time");

    const others = robbery.elements.filter((e) => e.id !== id);
    const wantedName = patch.name === undefined ? current.name : cleanName(patch.name);

    if (others.some((e) => e.name.toLowerCase() === wantedName.toLowerCase())) return bad(`there is already an element called ${wantedName}`);

    const merged: Record<string, unknown> = {
        ...current,
        name: wantedName,
        ...(patch.cells !== undefined ? { cells: patch.cells } : {}),
        ...(patch.items !== undefined ? { items: patch.items } : {}),
        ...(patch.locks !== undefined ? { locks: patch.locks } : {}),
        ...(patch.req !== undefined ? { req: patch.req } : {}),
        ...(patch.onDone !== undefined ? { onDone: patch.onDone } : {}),
        ...(patch.onFail !== undefined ? { onFail: patch.onFail } : {}),
        ...(patch.holdSeconds !== undefined ? { holdSeconds: patch.holdSeconds } : {})
    };

    if (patch.table === null) delete merged["table"];
    else if (patch.table !== undefined) merged["table"] = patch.table;

    const element = validateElement(merged, robbery.dimension);
    if (!element.ok) return element;

    return checked({ ...robbery, elements: robbery.elements.map((e) => (e.id === id ? element.value : e)) });
}

/** Removes an element and every requirement that pointed at it. */
export function removeElement(robbery: Robbery, id: string): RemoveResult {

    if (!findElement(robbery, id)) return bad(`there is no element ${id}`);

    let removedReferences = 0;

    const elements = robbery.elements
        .filter((e) => e.id !== id)
        .map((e) => {
            if (!e.req.includes(id)) return e;
            removedReferences++;
            return { ...e, req: e.req.filter((r) => r !== id) };
        });

    const result = checked({ ...robbery, elements });

    return result.ok ? { ok: true, robbery: result.robbery, removedReferences } : result;
}

// ---------------------------------------------------------------------------------------------------------
// Can it run?
// ---------------------------------------------------------------------------------------------------------

function usesAudience(effects: readonly Effect[], audience: Audience): boolean {
    return effects.some((effect) => (effect.kind === "say" || effect.kind === "reward") && effect.to === audience);
}

/**
 * Why a robbery cannot be started yet: an empty list means it can. Edits keep a robbery valid, but valid is not
 * the same as finished: this is the builder's checklist.
 */
export function whyNotRunnable(robbery: Robbery): string[] {

    const problems: string[] = [];

    if (robbery.elements.length === 0) problems.push("it has no elements yet");

    const everyList = [robbery.hooks.start, robbery.hooks.win, robbery.hooks.fail, ...robbery.elements.flatMap((e) => [e.onDone, e.onFail])];

    if (!everyList.some((list) => list.some((effect) => effect.kind === "end" && effect.result === "win"))) {
        problems.push("nothing makes it a success: add a \"Win or fail the robbery\" effect set to won, on any element (the vault door, say) or in the start hook");
    }

    if (!robbery.area && everyList.some((list) => usesAudience(list, "area"))) problems.push("an effect goes to the area but the area is not set");
    if (!robbery.area && robbery.settings.failWhenEmptySeconds > 0) problems.push("it fails when the area is empty, but the area is not set");

    for (const element of robbery.elements) {
        if (element.kind === "chest" && element.table === undefined && element.items.length === 0 && element.locks.length === 0 && element.req.length === 0) {
            problems.push(`"${element.name}": a chest with no loot, lock or requirement does nothing`);
        }

        // A teller that nothing waits on and that does nothing when it is held up is a villager standing in a bank.
        if (element.kind === "teller" && element.onDone.length === 0 && !robbery.elements.some((other) => other.req.includes(element.id))) {
            problems.push(`"${element.name}": a teller with nothing set to happen when it is held up, and nothing waiting for it, does nothing`);
        }

        // A frame hands out its loot when it is taken from: with none, and nothing set to happen when it is done, taking from it does nothing.
        if (element.kind === "frame" && element.table === undefined && element.items.length === 0 && element.onDone.length === 0) {
            problems.push(`"${element.name}": an item frame with no loot and nothing set to happen when it is done does nothing`);
        }
    }

    return problems;
}
