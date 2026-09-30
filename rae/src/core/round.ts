import { error } from "./log.js";
import { registerPersistable } from "./persist.js";
import { resetAllSystems } from "./registry.js";

/**
 * The round's lifecycle, with exactly one owner.
 *
 * Today roles.ts starts a round, endgame.ts and boat.ts each end one in their own way, and
 * nothing in between knows what phase the game is in. This is the shared state machine:
 *
 *   IDLE -> SETUP -> ACTIVE -> ENDING -> ENDED -> SETUP ...   (any phase can drop back to IDLE)
 *
 * SETUP is role assignment and teleporting, ACTIVE is play, ENDING is the moment winners are
 * announced (subscribers do that work), ENDED persists until the next round starts.
 */

export type Phase = "IDLE" | "SETUP" | "ACTIVE" | "ENDING" | "ENDED";
export type EndReason = "law_win" | "outlaw_win" | "aborted";

/** Bumped when the shape of what this module hands to core/persist changes. Passed through to
 *  restore() as savedVersion. */
export const ROUND_SCHEMA_VERSION = 1;

export interface PhaseChange {
    readonly from: Phase;
    readonly to: Phase;
    /** Set on the ENDING and ENDED changes of a round that finished. */
    readonly reason?: EndReason;
}

type Listener = (change: PhaseChange) => void;

const LEGAL: Readonly<Record<Phase, readonly Phase[]>> = {
    IDLE: ["SETUP"],
    SETUP: ["ACTIVE", "IDLE"],
    ACTIVE: ["ENDING", "IDLE"],
    ENDING: ["ENDED", "IDLE"],
    ENDED: ["SETUP", "IDLE"]
};

let phase: Phase = "IDLE";
let lastEndReason: EndReason | null = null;
const listeners: { readonly on: Phase | "*"; readonly fn: Listener }[] = [];

export function getPhase(): Phase {
    return phase;
}

export function isPhase(...phases: readonly Phase[]): boolean {
    return phases.includes(phase);
}

/** Why the most recent round ended, or null if none has finished since the last reset. */
export function lastEnd(): EndReason | null {
    return lastEndReason;
}

/** Runs `fn` whenever the round enters `on` (or any phase with "*"). Returns an unsubscribe function. */
export function onPhase(on: Phase | "*", fn: Listener): () => void {
    const entry = { on, fn };
    listeners.push(entry);
    return () => {
        const i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
    };
}

function transition(to: Phase, reason?: EndReason): boolean {

    if (!LEGAL[phase].includes(to)) return false;

    const change: PhaseChange = { from: phase, to, reason };
    phase = to;

    for (const listener of [...listeners]) {

        if (listener.on !== "*" && listener.on !== to) continue;

        try {
            listener.fn(change);
        } catch (err) {
            // A broken subscriber must not stop the round or the other subscribers.
            error("round", `a ${to} subscriber threw: ${err}`);
        }
    }

    return true;
}

/** IDLE or ENDED -> SETUP. False if a round is already running. */
export function startRound(): boolean {
    lastEndReason = null;
    return transition("SETUP");
}

/** SETUP -> ACTIVE: roles are assigned and play begins. */
export function beginActive(): boolean {
    return transition("ACTIVE");
}

/**
 * ACTIVE -> ENDING -> ENDED. Subscribers to ENDING announce the result; by the time
 * ENDED fires that work has run. Returns false if no round is active, so a second
 * "someone won" signal in the same tick is ignored rather than announced twice.
 */
export function endRound(reason: EndReason): boolean {

    if (!isPhase("ACTIVE")) return false;

    lastEndReason = reason;
    transition("ENDING", reason);
    transition("ENDED", reason);

    return true;
}

/** Back to IDLE from anywhere, then reset every registered system. */
export function resetRound(): void {

    if (phase !== "IDLE") {
        const change: PhaseChange = { from: phase, to: "IDLE" };
        phase = "IDLE";
        for (const listener of [...listeners]) {
            if (listener.on !== "*" && listener.on !== "IDLE") continue;
            try { listener.fn(change); } catch (err) { error("round", `an IDLE subscriber threw: ${err}`); }
        }
    }

    lastEndReason = null;
    resetAllSystems();
}

// phase is saved for future diagnostics only: restore() below never applies it back. Resuming
// straight into ACTIVE or SETUP after a reload is dangerous (no players placed, no timers
// re-armed), so a reload always leaves this module at its own default, IDLE, and only the last
// end reason comes back.
registerPersistable({
    key: "round",
    version: ROUND_SCHEMA_VERSION,
    save: () => ({ phase: getPhase(), lastEndReason: lastEnd() }),
    restore(data, savedVersion) {
        if (savedVersion !== ROUND_SCHEMA_VERSION) return;
        const parsed = data as { lastEndReason?: EndReason | null };
        if (parsed.lastEndReason !== undefined) lastEndReason = parsed.lastEndReason;
    }
});
