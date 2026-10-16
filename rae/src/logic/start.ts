import { START as S } from "../config/balance.js";
import { OVERWORLD_Y_BOUNDS } from "../config/world.js";

/**
 * The pure rules of the start sequence (core/startsequence.ts runs it; config/balance.ts's START holds the numbers).
 *
 * A start has three things an operator authors in game, and this file is what they are:
 *
 *   - a SHOT: two marks, a start and an end, each a place and the way the camera faces, recorded by standing there. The camera
 *     appears at the start mark and eases to the end mark, which is a pan;
 *   - which shots a Start plays, picked at random and not opening with the shot that opened last time;
 *   - the START COMMANDS: an ordered list of vanilla commands run before anything else, with the edits an operator makes to it.
 *
 * Nothing here knows the game. The random source comes in as an argument, and nothing here keeps any state: every edit returns a
 * new list and leaves the one it was given as it was.
 */

/** Bump when a saved shot changes meaning: a reader refuses a version it does not know. */
export const START_VERSION = 1;

/** Where a camera is and which way it faces (degrees, as the game gives a player's rotation). */
export interface Mark {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly pitch: number;
    readonly yaw: number;
}

export interface Shot {
    readonly version: number;
    /** `s1`, `s2`...: made from the highest in use, so a deleted shot's id is not handed out again at once. */
    readonly id: string;
    /** What the operator called it; may be empty, and a screen then shows the id. */
    readonly name: string;
    readonly start: Mark;
    readonly end: Mark;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (reason: string): Result<never> => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The game's own limit on how far from the middle of the world anything can be. */
const WORLD_EDGE = 30_000_000;

/** Positions and angles are kept to two decimals: far finer than a camera shows, and it keeps a saved shot short. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------------
// A shot
// ---------------------------------------------------------------------------------------------------------

function checkMark(label: string, mark: Mark): Result<Mark> {

    const parts: [string, number][] = [["x", mark.x], ["height", mark.y], ["z", mark.z], ["pitch", mark.pitch], ["yaw", mark.yaw]];

    for (const [name, value] of parts) {
        if (typeof value !== "number" || !Number.isFinite(value)) return bad(`the ${label} ${name} is not a number`);
    }

    if (Math.abs(mark.x) > WORLD_EDGE || Math.abs(mark.z) > WORLD_EDGE) return bad(`the ${label} is beyond the edge of the world`);
    if (mark.y < OVERWORLD_Y_BOUNDS.min || mark.y > OVERWORLD_Y_BOUNDS.max) return bad(`the ${label} height ${mark.y} is outside the world (${OVERWORLD_Y_BOUNDS.min} to ${OVERWORLD_Y_BOUNDS.max})`);
    if (mark.pitch < -90 || mark.pitch > 90) return bad(`the ${label} pitch ${mark.pitch} is not between -90 and 90`);
    if (mark.yaw < -180 || mark.yaw > 180) return bad(`the ${label} yaw ${mark.yaw} is not between -180 and 180`);

    return good(mark);
}

const roundMark = (mark: Mark): Mark => ({ x: round2(mark.x), y: round2(mark.y), z: round2(mark.z), pitch: round2(mark.pitch), yaw: round2(mark.yaw) });

/** A shot from an id, a name and two marks, or the reason it cannot be one. */
export function makeShot(id: string, name: string, start: Mark, end: Mark): Result<Shot> {

    if (typeof id !== "string" || !/^[a-z0-9_]{1,16}$/.test(id)) return bad("a shot's id is 1 to 16 lower-case letters, digits or underscores");

    const clean = typeof name === "string" ? name.trim() : "";

    if (clean.length > S.maxNameChars) return bad(`a shot's name can be at most ${S.maxNameChars} characters (this one is ${clean.length})`);

    const first = checkMark("start", roundMark(start));
    if (!first.ok) return first;

    const last = checkMark("end", roundMark(end));
    if (!last.ok) return last;

    return good({ version: START_VERSION, id, name: clean, start: first.value, end: last.value });
}

export const markList = (mark: Mark): number[] => [mark.x, mark.y, mark.z, mark.pitch, mark.yaw];

export function serializeShot(shot: Shot): string {
    return JSON.stringify({ v: shot.version, id: shot.id, nm: shot.name, a: markList(shot.start), b: markList(shot.end) });
}

export function readMark(raw: unknown, label: string): Result<Mark> {

    if (!Array.isArray(raw) || raw.length !== 5 || !raw.every((n) => typeof n === "number")) return bad(`the saved ${label} is not five numbers`);

    return good({ x: raw[0] as number, y: raw[1] as number, z: raw[2] as number, pitch: raw[3] as number, yaw: raw[4] as number });
}

/** A saved shot back, or why it cannot be read. Never throws, whatever the text is. */
export function parseShot(text: string | undefined): Result<Shot> {

    if (text === undefined || text.length === 0) return bad("nothing is saved");

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return bad("the saved data is not valid JSON");
    }

    if (!isRecord(raw)) return bad("the saved data is not a shot");
    if (raw["v"] !== START_VERSION) return bad(`it was saved by a different version (${String(raw["v"])}), and this one reads ${START_VERSION}`);
    if (typeof raw["id"] !== "string") return bad("the saved shot has no id");

    const first = readMark(raw["a"], "start");
    if (!first.ok) return first;

    const last = readMark(raw["b"], "end");
    if (!last.ok) return last;

    return makeShot(raw["id"], typeof raw["nm"] === "string" ? raw["nm"] : "", first.value, last.value);
}

/** The next shot id: one past the highest `s<number>` in use. Ids of any other shape are ignored. */
export function nextShotId(ids: readonly string[]): string {

    let highest = 0;

    for (const id of ids) {
        const found = /^s(\d+)$/.exec(id);
        if (found) highest = Math.max(highest, Number(found[1]));
    }

    return `s${highest + 1}`;
}

// ---------------------------------------------------------------------------------------------------------
// Picking shots
// ---------------------------------------------------------------------------------------------------------

/**
 * `count` different shots from the pool, in a random order, never more than the pool holds. When the pool has another shot, the
 * first one is not `previousFirstId`: opening with the same shot twice running would feel like the same intro.
 */
export function pickShots(pool: readonly Shot[], count: number, previousFirstId: string | undefined, random: () => number): Shot[] {

    const wanted = Number.isFinite(count) ? Math.min(Math.floor(count), pool.length) : 0;

    if (wanted <= 0) return [];

    const order = [...pool];

    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
    }

    if (order.length > 1 && order[0]!.id === previousFirstId) [order[0], order[1]] = [order[1]!, order[0]!];

    return order.slice(0, wanted);
}

/** How long each of `count` shots lasts when the whole intro takes `total` seconds. 0 when there is nothing to share. */
export function secondsPerShot(total: number, count: number): number {

    if (!Number.isFinite(total) || !Number.isFinite(count) || total <= 0 || count <= 0) return 0;

    return total / count;
}

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

/** A command as it will be run: spaces and one leading slash taken off. Refused when it is empty, over the cap or on more than one line. */
export function cleanCommand(text: string): Result<string> {

    if (typeof text !== "string") return bad("a command is text");
    if (/[\r\n]/.test(text)) return bad("a command has to be on one line");

    let line = text.trim();

    if (line.startsWith("/")) line = line.slice(1).trim();

    if (line.length === 0) return bad("type a command");
    if (line.length > S.maxCommandChars) return bad(`a command can be at most ${S.maxCommandChars} characters (this one is ${line.length})`);

    return good(line);
}

export function addCommand(list: readonly string[], text: string): Result<readonly string[]> {

    const line = cleanCommand(text);
    if (!line.ok) return line;

    if (list.length >= S.maxCommands) return bad(`the list is full: it holds at most ${S.maxCommands} commands`);

    return good([...list, line.value]);
}

const hasIndex = (list: readonly string[], index: number): boolean => Number.isInteger(index) && index >= 0 && index < list.length;

export function editCommand(list: readonly string[], index: number, text: string): Result<readonly string[]> {

    if (!hasIndex(list, index)) return bad(`there is no command number ${index + 1}`);

    const line = cleanCommand(text);
    if (!line.ok) return line;

    return good(list.map((existing, i) => (i === index ? line.value : existing)));
}

export function removeCommand(list: readonly string[], index: number): Result<readonly string[]> {

    if (!hasIndex(list, index)) return bad(`there is no command number ${index + 1}`);

    return good(list.filter((_, i) => i !== index));
}

export const serializeCommands = (list: readonly string[]): string => JSON.stringify(list);

/** A saved list back, or why it cannot be read. An empty list is a real list: "run nothing" is something an operator can choose. */
export function parseCommands(text: string | undefined): Result<readonly string[]> {

    if (text === undefined || text.length === 0) return bad("nothing is saved");

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return bad("the saved data is not valid JSON");
    }

    if (!Array.isArray(raw)) return bad("the saved data is not a list of commands");
    if (raw.length > S.maxCommands) return bad(`it holds ${raw.length} commands and the most is ${S.maxCommands}`);

    const list: string[] = [];

    for (let i = 0; i < raw.length; i++) {

        if (typeof raw[i] !== "string") return bad(`command ${i + 1} is not text`);

        const line = cleanCommand(raw[i] as string);
        if (!line.ok) return bad(`command ${i + 1}: ${line.reason}`);

        list.push(line.value);
    }

    return good(list);
}
