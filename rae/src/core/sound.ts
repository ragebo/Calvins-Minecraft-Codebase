import { system, type Dimension, type Player, type Vector3 } from "@minecraft/server";
import { error } from "./log.js";

/**
 * The one place `Player.playSound`/`Dimension.playSound` gets called (CLAUDE.md rule 5's "one writer
 * per channel"), replacing scattered direct calls across `systems/`.
 *
 * Two shapes, not one, because they mean different things: `playFor` is private (`Player.playSound`)
 * — only that player hears it, for a menu click or any other personal feedback — while `playAt` is
 * positional (`Dimension.playSound`) — everyone near the location hears it, for gunfire or anything
 * else that should carry to bystanders. Collapsing them would either make gunfire inaudible to
 * bystanders or make private UI clicks public; callers pick deliberately, this module doesn't guess.
 *
 * `playSequence` generalizes guns.ts's old `playCue`/`playCues`: a list of cues, some delayed, each
 * re-checking (once its delay elapses) that the player is still valid and — if the caller passed one
 * — that `shouldPlay()` still holds. That closure is how a caller expresses "is the player still
 * holding/using the thing this sequence belongs to" (a gun, in guns.ts's case) without this file
 * needing to know what a gun, or anything else, is: core/sound.ts stays completely domain-agnostic.
 *
 * A bad cue (an id the engine doesn't recognise, or an out-of-range pitch/volume — Dimension.playSound
 * throws below pitch 0.01 or a negative volume) is caught so it can never break whatever triggered it,
 * and is reported once per id via core/log.ts's error(), not a fresh world.sendMessage.
 */

export interface SoundCue {
    /** Vanilla (or custom) sound event id. */
    readonly id: string;
    /** 1 is normal and higher carries farther. Omit for the engine's own default. Never below 0. */
    readonly volume?: number;
    /** 1 is the sound's natural pitch. Omit for the engine's own default. The engine rejects anything under 0.01. */
    readonly pitch?: number;
    /** Ticks after the call. Omit to play immediately. Only meaningful inside playSequence — playFor/playAt always play at once. */
    readonly delayTicks?: number;
}

export interface PlaySequenceOptions {
    /**
     * Re-checked right before each DELAYED cue plays (never the immediate ones, which land in the same
     * tick as the call, already known good) — a false silences that cue. Each later cue's delay still
     * runs its own check independently, so shouldPlay flipping back to true mid-sequence lets a later
     * cue play again.
     */
    readonly shouldPlay?: () => boolean;
    /** Positional (Dimension.playSound, playAt) instead of the default private (Player.playSound, playFor). */
    readonly positional?: boolean;
}

function soundOptions(cue: SoundCue): { volume?: number; pitch?: number } {
    return { volume: cue.volume, pitch: cue.pitch };
}

const reportedBadCueIds = new Set<string>();

/**
 * A bad cue would otherwise repeat its failure on every call, so each id is reported once, ever — a
 * standing dev/ops memory rather than round state, the same idea core/log.ts's own debug flag follows
 * (and exactly what guns.ts's own version of this set used to do before this module existed).
 */
function reportBadCue(cue: SoundCue, err: unknown): void {
    if (reportedBadCueIds.has(cue.id)) return;
    reportedBadCueIds.add(cue.id);
    error("sound", `${cue.id}: ${err}`);
}

/** Private: only `player` hears it. For a menu click, a dry-fire click, or any other cue meant for one person alone. */
export function playFor(player: Player, cue: SoundCue): void {
    try {
        player.playSound(cue.id, soundOptions(cue));
    } catch (err) {
        reportBadCue(cue, err);
    }
}

/** Positional: everyone near `at` (default `player`'s own location) hears it. For gunfire and anything else that should carry to bystanders. */
export function playAt(player: Player, cue: SoundCue, at?: Vector3): void {
    try {
        player.dimension.playSound(cue.id, at ?? player.location, soundOptions(cue));
    } catch (err) {
        reportBadCue(cue, err);
    }
}

/**
 * Positional with no player at all: everyone near `at` in `dimension` hears it. For a sound that belongs to a place
 * (a vault door swinging open) and not to someone, so it can be played when nobody in particular caused it.
 */
export function playAtPoint(dimension: Dimension, cue: SoundCue, at: Vector3): void {
    try {
        dimension.playSound(cue.id, at, soundOptions(cue));
    } catch (err) {
        reportBadCue(cue, err);
    }
}

/**
 * Plays every cue in order: immediate ones (no delayTicks) right away, delayed ones scheduled with
 * system.runTimeout. See PlaySequenceOptions for what shouldPlay/positional do. Defaults to playFor
 * (private) when `positional` is omitted.
 */
export function playSequence(player: Player, cues: readonly SoundCue[], options?: PlaySequenceOptions): void {

    const play = options?.positional ? playAt : playFor;

    for (const cue of cues) {

        if (!cue.delayTicks) {
            play(player, cue);
            continue;
        }

        system.runTimeout(() => {
            if (!player.isValid) return;
            if (options?.shouldPlay && !options.shouldPlay()) return;
            play(player, cue);
        }, cue.delayTicks);
    }
}
