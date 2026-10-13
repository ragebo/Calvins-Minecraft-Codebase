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
