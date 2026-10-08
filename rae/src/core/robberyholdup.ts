import { type Entity, type Player } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { GUNS } from "../config/guns.js";
import { findElement, sameDimension, type TellerElement } from "../logic/robbery.js";
import { aimingWith } from "./aim.js";
import { warn } from "./log.js";
import { registerSystem } from "./registry.js";
import { touch, viewOf } from "./robberyrun.js";
import { anyBoundTellers, getRobbery } from "./robberystore.js";
import { aimedTeller } from "./robberyteller.js";
import { playFor } from "./sound.js";
import { onTick } from "./tick.js";
import { ACTION_BAR_PRIORITY, setActionBar } from "./ui.js";

/**
 * Holding up a teller. A player who keeps a gun AIMED (the right-click aim of systems/guns.ts) at a teller for its hold-up time
 * counts as touching that teller's element, through the same `touch` any block's click goes through: so it can start the robbery,
 * is refused for a law player when the robbery is outlaws only, waits for what it waits for, passes its locks, and does whatever
 * the builder set to happen when it is done (open a vault door that waits for it, pay out, spawn guards).
 *
 * One tick handler, every `holdUpEvery` ticks, and nothing at all in a world with no teller or while nobody aims. The player's own
 * view ray finds the teller; there is no line-of-sight check, so the reach is short.
 *
 * NOT measured in the real game (docs/test-cards/ROBBERY-TELLER.md): that the aim ray meets an NPC or a villager, and how the aim
 * toggle feels as a hold-up.
 */

const SOURCE = "robbery";

const GUN_ITEMS: ReadonlySet<string> = new Set(Object.values(GUNS).map((gun) => gun.itemId));

interface Hold {
    /** Ticks of aiming so far. */
    ticks: number;
    /** The last tick the teller was in the player's sights. */
    lastSeen: number;
}

/** Each (player, teller)'s progress. */
const holds = new Map<string, Hold>();
/** When each (player, teller) last counted (or was refused), so a refusal is one line and not a stream. */
const lastCount = new Map<string, number>();

function heldItemId(player: Player): string | undefined {

    try {
        return player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex)?.typeId;
    } catch {
        return undefined;
    }
}

/** Whether this player is pointing a gun: aiming one, or, when aiming is not required, holding one. */
function pointsAGun(player: Player): boolean {

    if (aimingWith(player.id) !== undefined) return true;

    return !R.holdUpNeedsAim && GUN_ITEMS.has(heldItemId(player) ?? "");
}

/** `###-------`: the font has no block glyphs, so progress is drawn in plain characters. */
function bar(done: number, of: number): string {

    const width = 10;
    const filled = Math.max(0, Math.min(width, Math.floor((done / of) * width)));

    return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
}

/** The teller turns to face whoever just pointed a gun at it. */
function faceThem(teller: Entity, player: Player): void {

    try {
        teller.teleport(teller.location, { facingLocation: player.location });
    } catch (err) {
        warn(SOURCE, `a teller could not turn to face a hold-up: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function holdUp(player: Player, now: number): void {

    const aimed = aimedTeller(player);
    if (!aimed) return;

    const { key, entity } = aimed;
    const robbery = getRobbery(key.robbery);
    const found = robbery ? findElement(robbery, key.element) : undefined;

    // A mark for an element that is gone (deleted while this entity was out of reach): a villager standing there, nothing more.
    if (!robbery || found?.kind !== "teller") return;

    const element: TellerElement = found;

    if (sameDimension(player.dimension.id) !== robbery.dimension) return;

    const holdKey = `${player.id}|${key.robbery}|${key.element}`;

    if (now - (lastCount.get(holdKey) ?? -Infinity) < R.holdUpRetryTicks) return;

    // Already held up this run: nothing more to take, and no progress bar to show for it.
    if (viewOf(key.robbery)?.elements.find((e) => e.id === key.element)?.state === "done") return;

    let hold = holds.get(holdKey);

    if (!hold || now - hold.lastSeen > R.holdUpGapTicks) {
        hold = { ticks: 0, lastSeen: now };
        holds.set(holdKey, hold);
        playFor(player, R.cues.holdUp);
        faceThem(entity, player);
    }

    hold.ticks += R.holdUpEvery;
    hold.lastSeen = now;

    const needed = element.holdSeconds * 20;

    if (hold.ticks >= needed) {
        holds.delete(holdKey);
        lastCount.set(holdKey, now);
        touch(player, { robbery: key.robbery, element: key.element, kind: "teller" });
        return;
    }

    setActionBar(player, "robbery:holdup", `§6Holding up §f${element.name} §7[${bar(hold.ticks, needed)}]`, { priority: ACTION_BAR_PRIORITY.alert, ttlTicks: R.holdUpEvery * 3 });
}

onTick("robbery:holdup", (context) => {

    // Almost always: no teller anywhere, or nobody pointing a gun.
    if (!anyBoundTellers()) {
        if (holds.size > 0) holds.clear();
        return;
    }

    const now = context.tick;

    for (const player of context.players) {

        if (!player.isValid || !pointsAGun(player)) continue;

        try {
            holdUp(player, now);
        } catch (err) {
            warn(SOURCE, `a hold-up check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // What nobody has aimed at for a while is forgotten.
    for (const [key, hold] of holds) if (now - hold.lastSeen > R.holdUpGapTicks * 4) holds.delete(key);
    for (const [key, tick] of lastCount) if (now - tick > R.holdUpRetryTicks * 4) lastCount.delete(key);
}, { everyTicks: R.holdUpEvery });

registerSystem({
    name: "robbery-holdup",
    reset() {
        holds.clear();
        lastCount.clear();
    }
});
