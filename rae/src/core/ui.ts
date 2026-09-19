import { world, system, type Player, type TitleDisplayOptions } from "@minecraft/server";
import { registerSystem } from "./registry.js";

/**
 * One writer for what a player reads on screen: the title, the action bar and chat.
 *
 * The action bar is a single line of screen space, and more than one system wants it (the compass
 * readout now, a heads-up display next). Written directly, whoever wrote last won, so an always-on
 * line could overwrite the compass. Now every line is posted here under a source name and a
 * priority, and only the winner reaches the screen.
 *
 * Nothing in this module reports to chat. An engine call that fails throws to the caller, which
 * knows what a failure means for it.
 */

// ---------------------------------------------------
// ACTION BAR
// ---------------------------------------------------

/**
 * Who gets the line. The higher number wins, and a number between these is fine.
 *   ambient  always-on background information, such as a heads-up display
 *   tool     something the player is using right now, such as the compass
 *   alert    something the player must not miss
 */
export const ACTION_BAR_PRIORITY = { ambient: 10, tool: 50, alert: 90 } as const;

/**
 * How long a posted line stays in the running, in ticks: about how long the client keeps showing a
 * line after its last packet. A source that stops posting stops blocking the others at about the
 * time its line leaves the screen.
 */
export const DEFAULT_ACTION_BAR_TTL_TICKS = 40;

export interface ActionBarOptions {
    /** Default ACTION_BAR_PRIORITY.tool. */
    readonly priority?: number;
    /** Default DEFAULT_ACTION_BAR_TTL_TICKS. Whole ticks, at least 1. */
    readonly ttlTicks?: number;
}

interface Entry {
    readonly text: string;
    readonly priority: number;
    /** The first tick this entry no longer counts. */
    readonly expiresAtTick: number;
    /** Order of posting, so that among equal priorities the newest post wins. */
    readonly order: number;
}

// Per player, keyed by player.id (never the name), then by source.
const tables = new Map<string, Map<string, Entry>>();
let nextOrder = 0;

/** Anything that isn't a finite number falls back to the default. */
function finiteOr(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function dropExpired(table: Map<string, Entry>, now: number): void {
    for (const [source, entry] of table) {
        if (entry.expiresAtTick <= now) table.delete(source);
    }
}

/** The entry that owns the line: highest priority, and among equals the one posted last. */
function winner(table: ReadonlyMap<string, Entry>): Entry | undefined {

    let best: Entry | undefined;

    for (const entry of table.values()) {
        if (!best || entry.priority > best.priority || (entry.priority === best.priority && entry.order > best.order)) {
            best = entry;
        }
    }

    return best;
}

/**
 * Posts `text` as the line `source` wants on this player's action bar, and shows it if it wins.
 *
 * A source keeps its line up by posting it again before the ttl runs out, as the compass does every
 * few ticks; each post replaces that source's previous line and restarts its ttl. A post that loses
 * to a fresher line of higher priority is kept but sends nothing, and is shown by a later post
 * once the winner has expired or been cleared. When priorities are equal the latest post wins.
 *
 * `source` is a stable name for the caller, such as its system's name. It identifies the caller's
 * line among the others, so two callers must not share one.
 */
export function setActionBar(player: Player, source: string, text: string, options: ActionBarOptions = {}): void {

    const now = system.currentTick;

    let table = tables.get(player.id);

    if (!table) {
        table = new Map();
        tables.set(player.id, table);
    }

    dropExpired(table, now);

    const entry: Entry = {
        text,
        priority: finiteOr(options.priority, ACTION_BAR_PRIORITY.tool),
        expiresAtTick: now + Math.max(1, Math.floor(finiteOr(options.ttlTicks, DEFAULT_ACTION_BAR_TTL_TICKS))),
        order: nextOrder++
    };

    table.set(source, entry);

    // An unchanged line is sent again, on purpose. The client fades an action bar about two seconds
    // after the LAST packet it got, so a source that only sent changes would see its line vanish.
    if (winner(table) === entry) player.onScreenDisplay.setActionBar(text);
}

/**
 * Withdraws the line `source` posted. If it was the one on screen, the next best line replaces it
 * right away, or the bar is emptied when nothing else is in the running. Withdrawing a line that
 * isn't on screen, or one that was never posted, sends nothing.
 */
export function clearActionBar(player: Player, source: string): void {

    const table = tables.get(player.id);
    if (!table) return;

    dropExpired(table, system.currentTick);

    const entry = table.get(source);
    const wasShown = entry !== undefined && winner(table) === entry;

    table.delete(source);

    const next = winner(table);
    if (!next) tables.delete(player.id);

    if (wasShown) player.onScreenDisplay.setActionBar(next?.text ?? "");
}

// ---------------------------------------------------
// TITLE
// ---------------------------------------------------

export interface TitleOptions {
    readonly subtitle?: string;
    readonly fadeInTicks?: number;
    readonly stayTicks?: number;
    readonly fadeOutTicks?: number;
}

// Fallbacks for a timing a caller leaves out of an options object. Assumed to match the vanilla
// /title defaults; not checked against this game build (the typings don't say).
const TITLE_FADE_IN_TICKS = 10;
const TITLE_STAY_TICKS = 70;
const TITLE_FADE_OUT_TICKS = 20;

/**
 * Shows a title, with an optional subtitle and timings in ticks. With no options at all the
 * engine's own timings apply.
 */
export function showTitle(player: Player, title: string, options?: TitleOptions): void {

    if (!options) {
        player.onScreenDisplay.setTitle(title);
        return;
    }

    // The engine wants all three timings whenever it is given options, so fill in the missing ones.
    const display: TitleDisplayOptions = {
        fadeInDuration: options.fadeInTicks ?? TITLE_FADE_IN_TICKS,
        stayDuration: options.stayTicks ?? TITLE_STAY_TICKS,
        fadeOutDuration: options.fadeOutTicks ?? TITLE_FADE_OUT_TICKS
    };

    if (options.subtitle !== undefined) display.subtitle = options.subtitle;

    player.onScreenDisplay.setTitle(title, display);
}

/** Takes the title off the screen: the engine clears it when it is set to an empty string. */
export function clearTitle(player: Player): void {
    player.onScreenDisplay.setTitle("");
}

// ---------------------------------------------------
// CHAT
// ---------------------------------------------------

/** The colour codes chat, titles and the action bar use, by what the text means. */
export const TONE = { ok: "§a", warn: "§e", bad: "§c", info: "§7", accent: "§6", law: "§9" } as const;

export type Tone = keyof typeof TONE;

/** Starts `text` in the colour for `tone`. Nothing is added at the end, so it composes into longer lines. */
export function format(tone: Tone, text: string): string {
    return `${TONE[tone]}${text}`;
}

/** A private chat line for one player. */
export function tell(player: Player, text: string): void {
    player.sendMessage(text);
}

/** A chat line for everyone in the world. */
export function announce(text: string): void {
    world.sendMessage(text);
}

registerSystem({
    name: "ui",
    reset() {
        // A round starts with nobody holding the line.
        tables.clear();
    }
});
