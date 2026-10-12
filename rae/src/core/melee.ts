import { EntityDamageCause, EquipmentSlot, type Entity, type Player } from "@minecraft/server";
import { MELEE } from "../config/balance.js";
import { addStack, dueNow, weaponForItem, type BleedStack, type MeleeWeapon } from "../logic/melee.js";
import { onDeath } from "./events.js";
import { info, warn } from "./log.js";
import { registerSystem } from "./registry.js";
import { onTick, type TickContext } from "./tick.js";

/**
 * What the melee weapons remember (systems/melee.ts listens to the game; logic/melee.ts holds the rules; the plan is tasks/melee/plan.md).
 *
 * Nothing about a weapon is remembered between hits except what a later rule needs: the number the game was told for a hit that has not
 * been reported back yet, and each target's knife bleed. WHICH weapon a player holds is never remembered: it is read from the main hand at the moment of each hit, so a
 * player who swaps mid-swing gets the item they hold.
 */

const SOURCE = "melee";

/** Off by default. A diagnostic, not round state, so a round reset leaves it as it is (the same as core/log.ts's debug switch). */
let debugOn = false;

export function setMeleeDebug(on: boolean): void {
    debugOn = on;
}

const reported = new Set<string>();

/** A failure inside an event handler or a tick is reported once per kind, never thrown into the engine and never repeated for every hit. */
export function reportOnce(kind: string, err: unknown): void {
    if (reported.has(kind)) return;
    reported.add(kind);
    warn(SOURCE, `${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
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

// ---------------------------------------------------------------------------------------------------------
// The knife's bleed
// ---------------------------------------------------------------------------------------------------------

interface Bleeding {
    readonly target: Entity;
    stacks: BleedStack<Player>[];
}

const bleeding = new Map<string, Bleeding>();
let stopTicking: (() => void) | undefined;

export function bleedingNow(): number {
    return bleeding.size;
}

/** Whether the tick handler is registered at all: it is only while someone bleeds, so an idle game pays nothing for it. */
export function bleedTickActive(): boolean {
    return stopTicking !== undefined;
}

function isDead(target: Entity): boolean {
    const health = target.getComponent("minecraft:health");
    return health !== undefined && health.currentValue <= 0;
}

/** Adds one knife hit's stack to the target. A target that is already dead or gone does not bleed. */
export function startBleed(target: Entity, wielder: Player, now: number): void {
    if (!target.isValid || isDead(target)) return;

    const existing = bleeding.get(target.id);
    if (existing) existing.stacks = addStack(existing.stacks, wielder, now, MELEE.bleed);
    else bleeding.set(target.id, { target, stacks: addStack([], wielder, now, MELEE.bleed) });

    if (!stopTicking) stopTicking = onTick("melee-bleed", stepBleeds, { everyTicks: 1 });
}

function stopBleeding(): void {
    bleeding.clear();
    endTick();
}

function endTick(): void {
    stopTicking?.();
    stopTicking = undefined;
}

/** What is due on this tick, dealt as ONE hit per target: separate hits inside the game's 10-tick hit window would be lost. */
function stepBleeds({ tick }: TickContext): void {
    for (const [id, bleed] of bleeding) {
        if (!bleed.target.isValid || isDead(bleed.target)) {
            bleeding.delete(id);
            continue;
        }

        const due = dueNow(bleed.stacks, tick, MELEE.bleed);
        if (due.amount === 0) continue;

        if (due.stacks.length === 0) bleeding.delete(id);
        else bleed.stacks = due.stacks;

        // The wielder is named so a kill can be credited to them; they may have left since the hit, and then it is just damage.
        const wielder = due.owners.find((owner) => owner.isValid);
        try {
            bleed.target.applyDamage(due.amount, wielder ? { cause: EntityDamageCause.override, damagingEntity: wielder } : { cause: EntityDamageCause.override });
            meleeTrace(`bleed: ${due.amount} to ${bleed.target.typeId} from ${due.owners.length} stack(s)`);
        } catch (err) {
            reportOnce("a bleed tick", err);
        }
    }

    if (bleeding.size === 0) endTick();
}

onDeath("melee", 5, ({ dead }) => {
    bleeding.delete(dead.id);
    if (bleeding.size === 0) endTick();
});

registerSystem({
    name: "melee",
    reset() {
        setNumbers.clear();
        stopBleeding();
    }
});
