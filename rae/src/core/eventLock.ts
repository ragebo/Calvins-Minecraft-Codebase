import { registerSystem } from "./registry.js";

/**
 * Fort raid, ranch raid, and train robbery each tracked their own
 * independent "active" flag in V1, with nothing stopping two from
 * running at once — e.g. starting a train robbery mid-raid. This is
 * the single shared lock all three now go through.
 *
 * Jailbreak deliberately does NOT participate: it's a continuous
 * system (anyone can attempt a lockpick anytime the jail is
 * occupied), not a scripted set-piece the way the other three are.
 */

let activeEvent: string | null = null;

/**
 * Claims the lock for `name`. Returns true if it was free — the
 * caller should go ahead and start. Returns false if another event
 * already holds it — the caller should not start; use
 * getActiveEvent() to tell the player what's blocking them.
 */
export function tryStartEvent(name: string): boolean {

    if (activeEvent !== null) return false;

    activeEvent = name;
    return true;
}

/** Releases the lock, but only if `name` is the one currently holding it. */
export function endEvent(name: string): void {
    if (activeEvent === name) {
        activeEvent = null;
    }
}

export function getActiveEvent(): string | null {
    return activeEvent;
}

registerSystem({
    name: "event-lock",
    reset() {
        // Round reset always clears the lock, regardless of which
        // event was holding it — a single source of truth rather
        // than relying on every holder to release before reset.
        activeEvent = null;
    }
});
