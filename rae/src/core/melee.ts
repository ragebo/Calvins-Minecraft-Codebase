import { EquipmentSlot, type Player } from "@minecraft/server";
import { weaponForItem, type MeleeWeapon } from "../logic/melee.js";
import { info } from "./log.js";
import { registerSystem } from "./registry.js";

/**
 * What the melee weapons remember (systems/melee.ts listens to the game; logic/melee.ts holds the rules; the plan is tasks/melee/plan.md).
 *
 * Nothing about a weapon is remembered between hits except what a later rule needs: the number the game was told for a hit that has not
 * been reported back yet. WHICH weapon a player holds is never remembered: it is read from the main hand at the moment of each hit, so a
 * player who swaps mid-swing gets the item they hold.
 */

const SOURCE = "melee";

/** Off by default. A diagnostic, not round state, so a round reset leaves it as it is (the same as core/log.ts's debug switch). */
let debugOn = false;

export function setMeleeDebug(on: boolean): void {
    debugOn = on;
}

/** One line to the content log, only while `rae:melee_debug on`. */
export function meleeTrace(message: string): void {
    if (debugOn) info(SOURCE, message);
}

/** The melee weapon a player holds right now, by the item in their main hand. A read of a player who just left can throw: that is "none". */
export function heldWeapon(player: Player): MeleeWeapon | undefined {
    try {
        const item = player.getComponent("minecraft:equippable")?.getEquipmentSlot(EquipmentSlot.Mainhand)?.getItem();
        return weaponForItem(item?.typeId);
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------------------------------------
// The number a hit was set to, until the game reports what it dealt
// ---------------------------------------------------------------------------------------------------------

export interface SetNumber {
    readonly weapon: MeleeWeapon;
    readonly set: number;
    readonly tick: number;
}

const setNumbers = new Map<string, SetNumber>();

/** More than this many unreported hits means the after event is not coming for some of them: the old ones are dropped. */
const MAX_PENDING = 64;
const STALE_TICKS = 4;

export function noteSet(targetId: string, entry: SetNumber): void {
    if (setNumbers.size >= MAX_PENDING) {
        for (const [id, old] of setNumbers) if (entry.tick - old.tick > STALE_TICKS) setNumbers.delete(id);
        if (setNumbers.size >= MAX_PENDING) setNumbers.clear();
    }
    setNumbers.set(targetId, entry);
}

/** The number noted for this target, which is forgotten as it is taken. */
export function takeSet(targetId: string): SetNumber | undefined {
    const entry = setNumbers.get(targetId);
    setNumbers.delete(targetId);
    return entry;
}

registerSystem({
    name: "melee",
    reset() {
        setNumbers.clear();
    }
});
