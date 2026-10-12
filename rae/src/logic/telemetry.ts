/**
 * The telemetry line: one line of JSON, written to the content log for every event worth counting (a round ending, a
 * robbery run, a shop deal). A script can write no file and call nothing outside the game, and the content log is the one
 * place a running world's output survives, so every event goes out whole and a tool outside the game does the counting
 * (tasks/plan.md has the reasoning). This file is the contract for what a line holds; core/telemetryevents.ts stamps and
 * writes the lines and decides nothing about their content.
 *
 * A line is self-contained: it names its world, its boot (one load of the scripts), its place in that boot and the build
 * that wrote it, so a log that lost its first lines, or the same log read twice, still makes sense. A reader drops a repeat
 * by world + boot + number.
 *
 * Nothing here knows the game: the limits and the tick come in as arguments (config/balance.ts holds the numbers).
 */

import { describeItem, faceOf, isService, type Trade } from "./shop.js";

/** Bump when a field changes meaning or goes away: a reader skips lines of a version it does not know. */
export const TELEMETRY_VERSION = 1;

/** The `source` core/log.ts is given, so every line starts `[telemetry] ` in the log, which is what a reader searches for. */
export const TELEMETRY_SOURCE = "telemetry";

/** What every line carries. The keys are short because a line is capped. */
export interface Stamp {
    readonly v: typeof TELEMETRY_VERSION;
    /** The world: a random id made the first time a world writes a line. Without it one report would mix the owner's worlds. */
    readonly w: string;
    /** The boot: a random id made each time the scripts load. */
    readonly b: string;
    /** This line's number within its boot, from 1. */
    readonly n: number;
    /** The game tick it was written at. It restarts at every boot, so it orders the lines of one boot only. */
    readonly t: number;
    /** The build of the add-on that wrote it (config/build.ts). */
    readonly bv: string;
}

/**
 * What each kind of event holds besides the stamp and its kind. The lines of one robbery run share `id` (the robbery) and `r`
 * (the run's number within the boot). A player is `p`, the engine's id for them and never their name; `role` is law or outlaw.
 */
export interface EventFields {
    /** Once per load, on the first tick: its stamp is the point (the world, the build, and that the way out works). */
    "boot": {};
    "round.end": {
        /** law_win, outlaw_win or aborted. */
        readonly reason: string;
        /** How long the round lasted, in ticks. */
        readonly dur: number;
        readonly kills: number;
        readonly deaths: number;
        readonly lawKills: number;
        readonly outlawKills: number;
        /** The gang's combined coins when it ended. */
        readonly coins: number;
    };
    "robbery.start": {
        readonly id: string;
        readonly r: number;
        /** A builder's test run: reports leave these out unless asked. */
        readonly test: boolean;
        /** Who started it; absent when a command block did. */
        readonly p?: string;
        readonly role?: string;
        /** Players standing in its area when it began. */
        readonly inside: number;
    };
    "robbery.element": {
        readonly id: string;
        readonly r: number;
        /** The element's id inside the robbery. */
        readonly el: string;
        /** The name its builder gave it ("Vault door"): the id says nothing to a person reading a report. */
        readonly name: string;
        /** door, chest, switch, frame or teller. */
        readonly kind: string;
        /** The kinds of lock it had: pick, key, pay or place. */
        readonly locks: readonly string[];
        /** Ticks since the run began. */
        readonly after: number;
        readonly p?: string;
    };
    "robbery.pick": {
        readonly id: string;
        readonly r: number;
        readonly el: string;
        readonly name: string;
        /** unlocked or jammed. */
        readonly result: string;
        readonly hits: number;
        readonly misses: number;
        readonly p?: string;
    };
    "robbery.payout": {
        readonly id: string;
        readonly r: number;
        /** The coins and bounty actually given, summed over the players paid. */
        readonly coins: number;
        readonly bounty: number;
        /** Who the reward was for: actor, area, outlaws, law or all. */
        readonly to: string;
        /** How many players were paid. */
        readonly players: number;
    };
    "robbery.end": {
        readonly id: string;
        readonly r: number;
        /** win, fail, stopped or round. */
        readonly result: string;
        readonly test: boolean;
        /** How long the run lasted, in ticks. */
        readonly dur: number;
        /** Elements completed, of the robbery's elements. */
        readonly done: number;
        readonly of: number;
        /** Distinct players who took part. */
        readonly people: number;
    };
    "shop.open": {
        readonly id: string;
        readonly p: string;
        readonly role?: string;
    };
    "shop.trade": {
        readonly id: string;
        /** The deal's id inside the shop. */
        readonly deal: string;
        /** buy, sell or trade. */
        readonly face: string;
        /** Coins the customer paid, and coins they were paid. */
        readonly spent: number;
        readonly got: number;
        /** Items handed over and items taken, one entry each: "minecraft:bread x4". */
        readonly give: readonly string[];
        readonly take: readonly string[];
        /** The services it did: effect, enchant, mount or teleport. */
        readonly svc: readonly string[];
        readonly p: string;
        readonly role?: string;
    };
    "shop.refuse": {
        readonly id: string;
        readonly deal: string;
        /** The reason the customer was shown. */
        readonly why: string;
        readonly p: string;
    };
    /** Written when the rate limit held lines back, with how many. */
    "telemetry.dropped": {
        readonly lines: number;
    };
}

export type EventKind = keyof EventFields;

/** What a deal did for and to the customer, in the words of a `shop.trade` line. Items are named as the shop's own screen names them. */
export interface TradeFacts {
    /** buy, sell, trade, gift or service. */
    readonly face: string;
    /** Coins the customer pays, and coins they are paid. */
    readonly spent: number;
    readonly got: number;
    /** Items handed to the customer, and items taken from them: "Iron Sword", "Arrow x6". */
    readonly give: readonly string[];
    readonly take: readonly string[];
    /** The services it does: effect, enchant, mount or teleport. */
    readonly svc: readonly string[];
}

export function tradeFacts(trade: Trade): TradeFacts {
    return {
        face: faceOf(trade),
        spent: trade.cost.coins,
        got: trade.rewards.reduce((total, reward) => total + (reward.kind === "coins" ? reward.amount : 0), 0),
        give: trade.rewards.flatMap((reward) => (reward.kind === "item" ? [describeItem(reward.item)] : [])),
        take: trade.cost.items.map(describeItem),
        svc: trade.rewards.filter(isService).map((reward) => reward.kind)
    };
}

/** A whole event as `toLine` takes it: the stamp, its kind and the fields that kind holds. */
export type TelemetryEvent<K extends EventKind = EventKind> = { [P in K]: Stamp & { readonly k: P } & EventFields[P] }[K];

/** The keys of a line that are not a kind's own: the stamp, the kind and the cut flag. A field named like one would overwrite it. */
type Reserved = keyof Stamp | "k" | "cut";

// Typed by the interface above, so a kind added to one and not to the other does not compile, and neither does a kind with a field
// named like a reserved key (its entry here could then only be `never`).
const KINDS: { readonly [K in EventKind]: [Extract<keyof EventFields[K], Reserved>] extends [never] ? true : never } = {
    "boot": true,
    "round.end": true,
    "robbery.start": true,
    "robbery.element": true,
    "robbery.pick": true,
    "robbery.payout": true,
    "robbery.end": true,
    "shop.open": true,
    "shop.trade": true,
    "shop.refuse": true,
    "telemetry.dropped": true
};

export const EVENT_KINDS = Object.keys(KINDS) as readonly EventKind[];

// ---------------------------------------------------------------------------------------------------------
// Writing a line
// ---------------------------------------------------------------------------------------------------------

/** How long a line, a text and a list may be. */
export interface LineLimits {
    /** The longest a text may be, in characters. A longer one is cut and ends in "...". */
    readonly textChars: number;
    /** The most entries a list keeps. */
    readonly listItems: number;
    /** The longest a whole line may be, in characters. */
    readonly lineChars: number;
}

/** The stamp's keys in the order they are written. They are never cut or dropped: a reader places a line by them. */
const STAMP_KEYS: readonly string[] = ["v", "k", "w", "b", "n", "t", "bv"];

function cutText(text: string, max: number): string {

    if (text.length <= max) return text;
    if (max <= 3) return text.slice(0, max);

    return `${text.slice(0, max - 3)}...`;
}

/** A text or a list brought within the limits, and whether anything was lost doing it. Any other value is left as it is. */
function shorten(value: unknown, limits: LineLimits): { readonly value: unknown; readonly cut: boolean } {

    if (typeof value === "string") {
        const text = cutText(value, limits.textChars);
        return { value: text, cut: text !== value };
    }

    if (Array.isArray(value)) {
        const items = value.slice(0, limits.listItems).map((item) => (typeof item === "string" ? cutText(item, limits.textChars) : item));
        return { value: items, cut: items.length < value.length || items.some((item, i) => item !== value[i]) };
    }

    return { value, cut: false };
}

/**
 * The event as one line of compact JSON: the stamp first, then its fields as given, nothing for a field left undefined.
 * Texts and lists are cut to the limits; a line still over `lineChars` then loses whole fields, the biggest first, until it
 * fits. Anything lost sets `cut: 1`. It is always valid JSON, and it is never shortened by chopping the text itself.
 */
export function toLine(event: TelemetryEvent, limits: LineLimits): string {

    const given = event as unknown as Readonly<Record<string, unknown>>;
    const line: Record<string, unknown> = {};
    let cut = false;

    for (const key of STAMP_KEYS) line[key] = given[key];

    for (const [key, value] of Object.entries(given)) {

        if (STAMP_KEYS.includes(key) || value === undefined) continue;

        const short = shorten(value, limits);

        line[key] = short.value;
        if (short.cut) cut = true;
    }

    const render = (): string => JSON.stringify(cut ? { ...line, cut: 1 } : line);
    let text = render();

    // Still too long: whole fields go, the biggest first, so a line keeps its many small facts over one big one.
    while (text.length > limits.lineChars) {

        const biggest = Object.keys(line)
            .filter((key) => !STAMP_KEYS.includes(key))
            .sort((a, b) => JSON.stringify(line[b]).length - JSON.stringify(line[a]).length)[0];

        if (biggest === undefined) break;     // only the stamp is left: it cannot be made smaller

        delete line[biggest];
        cut = true;
        text = render();
    }

    return text;
}

// ---------------------------------------------------------------------------------------------------------
// The rate limit
// ---------------------------------------------------------------------------------------------------------

/** Where a rate limiter stands: the window it is counting in, the lines let through in it and the lines refused in it. */
export interface LimiterState {
    /** The tick the current window opened at, or undefined before the first line. */
    readonly since: number | undefined;
    readonly used: number;
    readonly refused: number;
}

export const FRESH_LIMITER: LimiterState = { since: undefined, used: 0, refused: 0 };

export interface LimiterStep {
    readonly state: LimiterState;
    /** Whether this line may be written. */
    readonly allowed: boolean;
    /** How many lines the window that has just closed refused. Told once, to the first line of the next window; 0 otherwise. */
    readonly dropped: number;
}

/**
 * One line asking to be written at `tick`: up to `max` per window of `windowTicks`, the rest refused and counted. A window
 * opens at the first line after the last one ran out, or when the clock went backwards (a reload, or a test, restarts it).
 * The state is the caller's to keep; nothing here remembers anything.
 */
export function limitStep(state: LimiterState, tick: number, max: number, windowTicks: number): LimiterStep {

    const opens = state.since === undefined || tick < state.since || tick - state.since >= windowTicks;
    const dropped = opens ? state.refused : 0;
    const window: LimiterState = opens ? { since: tick, used: 0, refused: 0 } : state;

    if (window.used < max) return { state: { ...window, used: window.used + 1 }, allowed: true, dropped };

    return { state: { ...window, refused: window.refused + 1 }, allowed: false, dropped };
}
