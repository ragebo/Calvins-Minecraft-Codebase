import { MELEE } from "../config/balance.js";

/**
 * The pure rules of the melee weapons (core/melee.ts holds the state, systems/melee.ts listens to the game; the numbers are
 * MELEE in config/balance.ts, the plan is tasks/melee/plan.md). Nothing here knows the game.
 */

export type MeleeKey = keyof typeof MELEE.weapons;

export interface MeleeWeapon {
    readonly key: MeleeKey;
    readonly name: string;
    readonly damage: number;
}

/** Which melee weapon an item is, or undefined for anything else (a fist, a gun, a vanilla sword). */
export function weaponForItem(itemId: string | undefined): MeleeWeapon | undefined {
    for (const [key, weapon] of Object.entries(MELEE.weapons)) {
        if (weapon.id === itemId) return { key: key as MeleeKey, name: weapon.name, damage: weapon.damage };
    }
    return undefined;
}

/** Whether a target with this much health, of this much at most, is within the machete's finishing range. A dead target (no health left) is not. */
export function isFinishable(health: number, max: number, fraction: number): boolean {
    return health > 0 && health <= max * fraction + 1e-9;
}

/** Whether a baton hit stuns, given a random number in [0, 1): the same roll for the same dice, with the dice passed in so a test can rig them. */
export function rollStun(random: number, chance: number): boolean {
    return random < chance;
}

/**
 * Whether something is in the cone in front of someone: `to` is the way from them to it and `facing` the way they look, both on the flat
 * (x and z). Within `halfAngleDegrees` either side counts, exactly on the edge included. With no direction to measure (it is on top of
 * them, or they look straight up or down) it counts, so a swing straight down still hits what is around the feet.
 */
export function inCone(toX: number, toZ: number, facingX: number, facingZ: number, halfAngleDegrees: number): boolean {
    const toLength = Math.hypot(toX, toZ);
    const facingLength = Math.hypot(facingX, facingZ);
    if (toLength < 1e-6 || facingLength < 1e-6) return true;

    const cosine = (toX * facingX + toZ * facingZ) / (toLength * facingLength);
    return cosine >= Math.cos((halfAngleDegrees * Math.PI) / 180) - 1e-9;
}

export type CooldownStatus = "ready" | "same" | "cooling";

/**
 * Where an attack with a cooldown stands at `now`: "ready" when there is no attack or its cooldown (until the tick `until`) is over, "same"
 * when the last attack began within `sameAttackTicks` ago (so this is the same click), "cooling" otherwise.
 */
export function cooldownStatus(until: number | undefined, attackTick: number, now: number, sameAttackTicks: number): CooldownStatus {
    if (until === undefined || now >= until) return "ready";
    return now - attackTick <= sameAttackTicks ? "same" : "cooling";
}

/** Ticks as seconds to a tenth, rounded up so a cooldown never reads as over before it is: 10 ticks is "0.5", 11 is "0.6". */
export function formatSeconds(ticks: number): string {
    return (Math.ceil(Math.max(0, ticks) / 2) / 10).toFixed(1);
}

/** Whether the game dealt the number a hit was set to. A hair of tolerance, because the engine keeps health in floats. */
export function honored(set: number, dealt: number): boolean {
    return Math.abs(set - dealt) < 0.001;
}

// ---------------------------------------------------------------------------------------------------------
// The knife's bleed
// ---------------------------------------------------------------------------------------------------------

export interface BleedRules {
    readonly damage: number;
    readonly intervalTicks: number;
    readonly hits: number;
    readonly maxStacks: number;
}

/** One knife hit's bleed on one target: when its next tick is due, how many are left, and whose hit it was. */
export interface BleedStack<Owner> {
    readonly owner: Owner;
    readonly due: number;
    readonly left: number;
}

/** A new hit's stack added to a target's. A target already at the cap loses its oldest stack to the new one, so a long fight keeps it bleeding. */
export function addStack<Owner>(stacks: readonly BleedStack<Owner>[], owner: Owner, now: number, rules: BleedRules): BleedStack<Owner>[] {
    const room = Math.floor(rules.maxStacks) - 1;
    const kept = stacks.length > room ? stacks.slice(stacks.length - room) : stacks;
    return [...kept, { owner, due: now + rules.intervalTicks, left: rules.hits }];
}

/** What the stacks owe at `now`: one total for the whole target (so it can be dealt as ONE hit), who it is owed by, and the stacks that remain. */
export function dueNow<Owner>(stacks: readonly BleedStack<Owner>[], now: number, rules: BleedRules): { amount: number; owners: Owner[]; stacks: BleedStack<Owner>[] } {
    const owners: Owner[] = [];
    const remaining: BleedStack<Owner>[] = [];
    let amount = 0;

    for (const stack of stacks) {
        if (stack.due > now) {
            remaining.push(stack);
            continue;
        }
        amount += rules.damage;
        owners.push(stack.owner);
        if (stack.left > 1) remaining.push({ owner: stack.owner, due: stack.due + Math.max(1, rules.intervalTicks), left: stack.left - 1 });
    }

    return { amount, owners, stacks: remaining };
}
