/**
 * On/off switches for purely cosmetic effects, shared between the system that acts on them
 * (systems/tumbleweed.ts) and whatever lets a player flip them (systems/menu.ts, /scriptevent). Living here,
 * not in either system, is what lets both import it: a system may not import another system.
 */

let tumbleweedsOn = false;

export function tumbleweedsEnabled(): boolean {
    return tumbleweedsOn;
}

/** Flips it and returns the new state. Existing tumbleweeds are unaffected either way: this only decides whether new ones spawn. */
export function toggleTumbleweeds(): boolean {
    tumbleweedsOn = !tumbleweedsOn;
    return tumbleweedsOn;
}
