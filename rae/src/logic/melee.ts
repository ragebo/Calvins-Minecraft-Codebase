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

/** Whether the game dealt the number a hit was set to. A hair of tolerance, because the engine keeps health in floats. */
export function honored(set: number, dealt: number): boolean {
    return Math.abs(set - dealt) < 0.001;
}
