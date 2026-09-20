/**
 * EVERY tunable number lives here. Nothing else defines one.
 *
 * This is the file you open when you want to balance the game.
 * You should never have to read system code to change a number.
 */

/** Bump whenever the shape or meaning of what this file exports changes in a way persisted data depends on. */
export const BALANCE_SCHEMA_VERSION = 1;

export const ECONOMY = {
    /** Villager robbery reward range. */
    villagerRewardMin: 15,
    villagerRewardMax: 40,
    villagerBountyGain: 25,

    /** Fraction of coins kept on death. */
    deathCoinsKept: 0.5,

    /** Coins per gold item when it enters an inventory. */
    goldIngotValue: 10,

    /** Coins required per surviving outlaw to escape by boat. */
    boatEscapePerOutlaw: 250
};

export const BOAT = {
    /** Distance from the escape boat NPC that still counts as "gathered". */
    escapeRadius: 16
};

export const JAILBREAK = {
    /** Correct slider hits needed to open the lock. */
    hitsToUnlock: 2,
    /** How forgiving the hidden sweet spot is, on a 0-100 slider. */
    sweetSpotTolerance: 10,
    /** Law inside this radius blocks progress. */
    lawBlockRadius: 4,
    /** Ticks between attempts from the same player. */
    attemptCooldownTicks: 15,
    /** Ticks of no progress before the attempt fails. */
    failTimeoutTicks: 600,
    /** Weakness applied to contributors on failure. */
    failWeaknessTicks: 600,
    failWeaknessAmplifier: 0,
    /** Coins per contributor on success. */
    rescueReward: 50,
    /** How far a freed prisoner must get from the jail to be safe. */
    escortSafeDistance: 20,
    /** Refreshed every check so the escort effects never run out mid-escort. */
    escortEffectTicks: 60
};

export const RAIDS = {
    /** Applied to every raid mob so they hit less hard. */
    mobWeaknessAmplifier: 0,
    /** Regeneration refresh for players inside an active raid. */
    playerRegenTicks: 100,
    /** Players listed by name when a raid refuses to start because nobody counted as inside; the rest are summarised. */
    failureListMaxPlayers: 8
};

export const FORT = {
    /**
     * Vanilla Health Boost only comes in fixed +4 HP steps per level,
     * so it can't hit an exact 1.5x (30 HP) on a 20 HP base.
     * Amplifier 1 (Health Boost II) = 28 HP (1.4x).
     */
    healthBoostAmplifier: 1,
    healthBoostDurationTicks: 20000000 // effectively permanent
};

export const RANCH = {
    /** Coin reward ranges per defender type, on kill. */
    pillagerRewardMin: 15,
    pillagerRewardMax: 19,
    witchRewardMin: 15,
    witchRewardMax: 17,
    golemRewardMin: 25,
    golemRewardMax: 40,

    /** Regeneration refresh for outlaws inside an active ranch raid. */
    regenTicks: 5,

    /** Base timer plus seconds per raider, rolled fresh at raid start. */
    startTimeBase: 40,
    startTimePerRaider: 10,
    /** Same shape, used to extend the timer when reinforcements arrive. */
    reinforceTimeBase: 30,
    reinforceTimePerRaider: 10,

    /** Wave 2 triggers once the timer drops to this fraction of the total. */
    wave2Threshold: 0.66,
    /** Wave 3 (final) triggers at this fraction. */
    wave3Threshold: 0.33
};

export const TRAIN = {
    /** Blocks moved per step. Lower means more structure operations. */
    stepSize: 5,
    /** Ticks between each move. */
    moveIntervalTicks: 10,
    guardCount: 3,
    /** Ticks before the train and guards are cleaned up. */
    cleanupDelayTicks: 1200,
    /** Ticks before the bridge is rebuilt. */
    bridgeRestoreDelayTicks: 1600,
    /** Coin reward range per guard kill. */
    guardRewardMin: 10,
    guardRewardMax: 19
};

export const HORSE = {
    speed: 0.2,
    /** Not currently applied anywhere — carried over from V1 as-is. */
    jump: 0.5
};

export const HARMING = {
    /** Harming level = aliveOutlaws - 1, clamped at zero. */
    levelOffset: 1
};

export const COMPASS = {
    /** What every law player's compass tracks until they switch it. */
    defaultMode: "nearest" as "nearest" | "bounty",
    /** Ticks between readout refreshes while the compass is held. */
    updateIntervalTicks: 4,
    /**
     * Ticks a chosen target stays locked before nearest / highest
     * bounty is re-decided. Only the bearing to the locked target is
     * recomputed on every refresh, which is what keeps this cheap.
     */
    retargetIntervalTicks: 20,
    /** Ticks after a mode switch before another is accepted. */
    toggleCooldownTicks: 10,
    /** Cells in the bearing bar. Odd, so there's a true center cell. */
    barCells: 21,
    /** The bar spans this many degrees either side of straight ahead. */
    barHalfWidthDegrees: 90,
    /** The marker turns green within this many degrees of dead ahead. */
    alignToleranceDegrees: 10
};

/**
 * `/scriptevent rae:probe_damage` measures how the engine treats repeated hits, on a cow it spawns and
 * removes again. It is a measurement tool, not part of the game.
 */
export const DAMAGE_PROBE = {
    /** A mob that certainly exists, is harmless and has 10 health. */
    targetType: "minecraft:cow",
    /** Damage of one probe hit. Small, so the target never dies: the ratios are what is measured. */
    unitDamage: 1,
    /** Hits in the pellet scenarios (the pump fires 8 pellets). Even, so the double tap can halve it. */
    hits: 8,
    /** Ticks between hits that are meant to fall outside any post-hit invulnerability window. */
    spacedTicks: 12,
    /** Ticks between the two shots of a double tap (the double-barrel's fire rate is 4). */
    doubleTapTicks: 4,
    /** How far in front of the player the target is put, in blocks. */
    distanceInFront: 3,
    /** Ticks after the last hit before the target's health is read. */
    settleTicks: 2,
    /** Ticks between one scenario and the next, so nothing carries over. */
    gapTicks: 30
};

export const STATE_SYNC = {
    /**
     * Ticks between checks of every player's role and status tags. A tag typed by hand
     * (`/tag @s add law`) reaches the records within this long. Whole ticks, at least 1.
     */
    reconcileIntervalTicks: 20
};

export const LOOT = {
    trainVault: "chests/gold_2",
    fortReward: "chests/gold_2"
};
