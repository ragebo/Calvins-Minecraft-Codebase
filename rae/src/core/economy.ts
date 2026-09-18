import { world, type Player, type ScoreboardIdentity } from "@minecraft/server";

/**
 * Fixes the scattered-economy problem from V1.
 *
 * In V1 eight files called coinsObj.setScore() directly. Balancing
 * meant hunting through all of them, and no file knew what the others
 * were paying out.
 *
 * Every coin and bounty change now goes through here.
 */

type Target = Player | ScoreboardIdentity;

function coins() {
    return world.scoreboard.getObjective("coins");
}

function bounty() {
    return world.scoreboard.getObjective("bounty");
}

// ---------------------------------------------------
// COINS
// ---------------------------------------------------

export function getCoins(target: Target): number {
    return coins()?.getScore(target) ?? 0;
}

export function addCoins(target: Target, amount: number): void {
    const obj = coins();
    if (!obj) return;
    obj.setScore(target, getCoins(target) + amount);
}

export function setCoins(target: Target, amount: number): void {
    coins()?.setScore(target, amount);
}

/** Returns the amount actually taken, which may be less than asked. */
export function takeCoins(target: Target, amount: number): number {
    const current = getCoins(target);
    const taken = Math.min(current, amount);
    setCoins(target, current - taken);
    return taken;
}

// ---------------------------------------------------
// BOUNTY
// ---------------------------------------------------

export function getBounty(target: Target): number {
    return bounty()?.getScore(target) ?? 0;
}

export function addBounty(target: Target, amount: number): void {
    const obj = bounty();
    if (!obj) return;
    obj.setScore(target, getBounty(target) + amount);
}

export function clearBounty(target: Target): void {
    bounty()?.setScore(target, 0);
}

// ---------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------

/** Call once at startup. Reports missing objectives instead of failing quietly. */
export function verifyScoreboards(): boolean {

    const missing: string[] = [];

    if (!coins()) missing.push("coins");
    if (!bounty()) missing.push("bounty");

    if (missing.length > 0) {
        world.sendMessage(
            `§c[ECONOMY] Missing scoreboard objectives: ${missing.join(", ")}`
        );
        return false;
    }

    return true;
}
