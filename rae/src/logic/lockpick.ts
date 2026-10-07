/**
 * The pick lock's rules: a hidden target on a slider, hot/cold feedback on a miss, a number of hits to open it, and
 * a jam when too many misses come in a row. Lifted out of systems/jailbreak.ts so any robbery element can use it:
 * pure, with the random source and the tick passed in, and one state object per lock instead of module variables.
 *
 * What a miss sounds like is decided here (a ping whose pitch rises the closer the guess was), because that is the
 * game's only hint; which sound plays, and what happens on a jam or an unlock, is the caller's business.
 */

export interface PickParams {
    /** Correct picks needed to open the lock. */
    readonly hits: number;
    /** How close a guess must be to the hidden target to count (slider units). */
    readonly tolerance: number;
    /** Misses in a row that jam the lock. 0 means it never jams. */
    readonly strikes: number;
    /** How long a jam lasts, in ticks. */
    readonly jamTicks: number;
}

export interface PickState {
    /** The hidden target. Undefined until the first guess, and again after each hit or a jam. */
    readonly target: number | undefined;
    readonly hits: number;
    /** Misses since the last hit. */
    readonly strikes: number;
    /** The tick the lock works again, or 0. */
    readonly jammedUntil: number;
}

export const FRESH_PICK: PickState = { target: undefined, hits: 0, strikes: 0, jammedUntil: 0 };

/** The shape of the hot/cold ping and the slider's range. */
export interface PickCurve {
    /** The slider runs 0 to this. */
    readonly max: number;
    /** A miss this far away or farther is as cold as it gets. */
    readonly range: number;
    readonly floor: number;
    readonly spread: number;
}

/**
 * What a guess did.
 *   waiting   the lock is jammed: nothing happened and nothing changed
 *   miss      wrong, but the lock is still working
 *   hit       right, and more are needed
 *   unlocked  right, and that was the last one needed
 *   jam       wrong once too often: the lock is jammed for `jamTicks`
 */
export type PickOutcome = "waiting" | "miss" | "hit" | "unlocked" | "jam";

export interface PickStep {
    readonly state: PickState;
    readonly outcome: PickOutcome;
    /** How far the guess was from the target, or 0 when the lock was jammed. */
    readonly distance: number;
    /** The ping's pitch for a miss or a jam; 1 for anything else. */
    readonly pitch: number;
}

/** A target somewhere on the slider. `random` returns a number in [0, 1). */
export function rollTarget(random: () => number, max: number): number {
    return random() * max;
}

/** 0 (as cold as it gets) to 1 (right on it). */
export function proximity(distance: number, curve: PickCurve): number {
    return Math.max(0, 1 - distance / curve.range);
}

/** The pitch of the ping for a guess `distance` away: `floor` when cold, `floor + spread` when right on it. */
export function pitchFor(distance: number, curve: PickCurve): number {
    return curve.floor + proximity(distance, curve) * curve.spread;
}

/**
 * One guess. A hit re-rolls the target (the next pick is a new search) and clears the misses; a miss keeps the
 * target, so repeated pings actually mean something; too many misses in a row jam the lock, lose its progress and
 * re-roll the target, so a jam is a real cost and not just a wait.
 */
export function pickStep(state: PickState, guess: number, params: PickParams, curve: PickCurve, random: () => number, now: number): PickStep {

    if (now < state.jammedUntil) return { state, outcome: "waiting", distance: 0, pitch: 1 };

    const target = state.target ?? rollTarget(random, curve.max);
    const distance = Math.abs(guess - target);

    if (distance <= params.tolerance) {

        const hits = state.hits + 1;

        if (hits >= params.hits) {
            return { state: { target: undefined, hits, strikes: 0, jammedUntil: 0 }, outcome: "unlocked", distance, pitch: 1 };
        }

        return { state: { target: undefined, hits, strikes: 0, jammedUntil: 0 }, outcome: "hit", distance, pitch: 1 };
    }

    const strikes = state.strikes + 1;
    const pitch = pitchFor(distance, curve);

    if (params.strikes > 0 && strikes >= params.strikes) {
        return { state: { target: undefined, hits: 0, strikes: 0, jammedUntil: now + params.jamTicks }, outcome: "jam", distance, pitch };
    }

    return { state: { target, hits: state.hits, strikes, jammedUntil: 0 }, outcome: "miss", distance, pitch };
}
