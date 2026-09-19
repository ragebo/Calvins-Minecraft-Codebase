import { world, system, EquipmentSlot, type Player } from "@minecraft/server";
import { COMPASS } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { getBounty } from "../core/economy.js";
import { relativeBearing, bearingBar } from "../core/bearing.js";

/**
 * Replaces the vanilla locator bar for law. Hold the compass and the
 * action bar shows a bearing strip pointing at either the nearest free
 * outlaw or the one with the highest bounty. Sneak + use switches
 * between the two — same combo as reloading a gun, so it works on
 * controller too.
 *
 * The work is split in two to keep it cheap. WHO to point at is only
 * decided about once a second and then locked in; the bearing to that
 * locked target — the part that has to follow the camera — is all
 * that gets recomputed on every refresh.
 */

const COMPASS_ITEM_ID = "bountysys:law_compass";

type CompassMode = typeof COMPASS.defaultMode;

const MODES: Record<CompassMode, { hud: string; chat: string }> = {
    nearest: { hud: "NEAREST", chat: "nearest outlaw" },
    bounty: { hud: "TOP BOUNTY", chat: "outlaw with the highest bounty" }
};

/** Who a tracker is currently pointing at, and when that was decided. */
interface Lock {
    readonly player: Player;
    readonly name: string;
    /** Only looked up in bounty mode; 0 otherwise. */
    readonly bounty: number;
    readonly pickedAtTick: number;
}

// Per player, keyed by player id (same as guns.ts). Modes are in memory
// rather than on the item itself: item dynamic properties are refused
// on stackable items, which every custom item here counts as.
const modeByPlayer = new Map<string, CompassMode>();
const lastSwitchTick = new Map<string, number>();
const locks = new Map<string, Lock>();

function getMode(player: Player): CompassMode {
    return modeByPlayer.get(player.id) ?? COMPASS.defaultMode;
}

function isHoldingCompass(player: Player): boolean {
    const equippable = player.getComponent("minecraft:equippable");
    return equippable?.getEquipmentSlot(EquipmentSlot.Mainhand)?.getItem()?.typeId === COMPASS_ITEM_ID;
}

interface Candidate {
    readonly player: Player;
    readonly distance: number;
    readonly bounty: number;
}

function isBetter(candidate: Candidate, current: Candidate, mode: CompassMode): boolean {
    // Equal bounties (including everyone at 0) fall back to nearest.
    if (mode === "bounty" && candidate.bounty !== current.bounty) {
        return candidate.bounty > current.bounty;
    }
    return candidate.distance < current.distance;
}

/**
 * Free outlaws only — eliminated ones are spectators and jailed ones
 * are already accounted for. Querying through the tracker's own
 * dimension leaves out outlaws elsewhere, where a bearing means
 * nothing. Bounties are only looked up when they decide the pick.
 */
function pickTarget(tracker: Player, mode: CompassMode): Candidate | undefined {

    const origin = tracker.location;
    let best: Candidate | undefined;

    for (const outlaw of tracker.dimension.getPlayers({ tags: ["outlaw"], excludeTags: ["eliminated", "in_jail"] })) {

        const there = outlaw.location;

        const candidate: Candidate = {
            player: outlaw,
            distance: Math.hypot(there.x - origin.x, there.y - origin.y, there.z - origin.z),
            bounty: mode === "bounty" ? getBounty(outlaw) : 0
        };

        if (!best || isBetter(candidate, best, mode)) best = candidate;
    }

    return best;
}

/**
 * The tracker's current target: the locked one while it's fresh and
 * still in the world, otherwise a newly decided one. A target who is
 * jailed or eliminated inside the lock window is still pointed at
 * until the next re-decision, at most retargetIntervalTicks later.
 */
function getLock(tracker: Player, mode: CompassMode): Lock | undefined {

    const now = system.currentTick;
    const existing = locks.get(tracker.id);

    if (existing && existing.player.isValid && now - existing.pickedAtTick < COMPASS.retargetIntervalTicks) {
        return existing;
    }

    const picked = pickTarget(tracker, mode);

    if (!picked) {
        locks.delete(tracker.id);
        return undefined;
    }

    const lock: Lock = {
        player: picked.player,
        name: picked.player.name,
        bounty: picked.bounty,
        pickedAtTick: now
    };

    locks.set(tracker.id, lock);
    return lock;
}

function renderReadout(tracker: Player, mode: CompassMode): string {

    const label = `§9${MODES[mode].hud}`;
    const lock = getLock(tracker, mode);

    if (!lock) return `${label}  §7No outlaws to track`;

    const from = tracker.location;
    const to = lock.player.location;

    const bar = bearingBar(
        relativeBearing(tracker.getViewDirection(), from, to),
        {
            cells: COMPASS.barCells,
            halfWidthDegrees: COMPASS.barHalfWidthDegrees,
            alignToleranceDegrees: COMPASS.alignToleranceDegrees
        }
    );

    const distance = Math.round(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));

    const bountyText = mode === "bounty"
        ? `  ${lock.bounty > 0 ? `§6${lock.bounty} coins` : "§7no bounty"}`
        : "";

    return `${label}  ${bar}  §f${lock.name}  §7${distance}m${bountyText}`;
}

// Its own interval rather than onTick: the shared loop only runs once
// a second, far too coarse for a marker that has to follow the
// player's camera. Same reasoning as train.ts.
let lastErrorTick = -Infinity;

system.runInterval(() => {

    for (const player of world.getPlayers({ tags: ["law"], excludeTags: ["eliminated"] })) {

        try {

            if (!isHoldingCompass(player)) continue;

            player.onScreenDisplay.setActionBar(renderReadout(player, getMode(player)));

        } catch (error) {
            // Runs several times a second — throttle so a persistent
            // failure can't flood chat.
            if (system.currentTick - lastErrorTick > 200) {
                lastErrorTick = system.currentTick;
                world.sendMessage(`§c[COMPASS ERROR] ${player.name}: ${error}`);
            }
        }
    }

}, COMPASS.updateIntervalTicks);

world.afterEvents.itemUse.subscribe((event) => {

    if (event.itemStack.typeId !== COMPASS_ITEM_ID) return;

    const player = event.source;

    if (!player.hasTag("law")) {
        player.sendMessage("§cOnly law can use the compass.");
        return;
    }

    const current = getMode(player);

    if (!player.isSneaking) {
        player.sendMessage(`§9Compass: tracking the §f${MODES[current].chat}§9. §7Sneak + use to switch.`);
        return;
    }

    // Guards against one press being delivered as two use events, which
    // would switch and immediately switch back.
    const now = system.currentTick;
    if (now - (lastSwitchTick.get(player.id) ?? -Infinity) < COMPASS.toggleCooldownTicks) return;
    lastSwitchTick.set(player.id, now);

    const next: CompassMode = current === "nearest" ? "bounty" : "nearest";
    modeByPlayer.set(player.id, next);

    // The old lock was chosen under the other mode's rules.
    locks.delete(player.id);

    player.playSound("random.click", { volume: 0.5 });
    player.sendMessage(`§9Compass now tracking the §f${MODES[next].chat}§9.`);
});

registerSystem({
    name: "compass",
    reset() {
        modeByPlayer.clear();
        lastSwitchTick.clear();
        locks.clear();
    }
});
