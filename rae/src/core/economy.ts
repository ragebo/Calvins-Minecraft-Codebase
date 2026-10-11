import { world, type Player, type ScoreboardIdentity } from "@minecraft/server";
import { error, warn } from "./log.js";

/**
 * Fixes the scattered-economy problem from V1.
 *
 * In V1 eight files called coinsObj.setScore() directly. Balancing
 * meant hunting through all of them, and no file knew what the others
 * were paying out.
 *
 * Every coin and bounty change now goes through here.
 *
 * The two scoreboards are made when they are missing (see ensureScoreboards): a payout into a world that
 * never had `/scoreboard objectives add coins dummy` typed used to be dropped without a word.
 */

type Target = Player | ScoreboardIdentity;

const OBJECTIVES = [{ id: "coins", label: "Coins" }, { id: "bounty", label: "Bounty" }] as const;

/** The objectives the game could not make, so a failure is reported once and not on every payout. */
const couldNotMake = new Set<string>();

/** What is there now. Never makes anything: reading a balance must not change the world. */
const existing = (id: string) => world.scoreboard.getObjective(id);

/** The objective to write into: the one that is there, or one made on the spot. Undefined only when the game refuses to make it. */
function forWriting(id: "coins" | "bounty") {
    return existing(id) ?? (ensureScoreboards().includes(id) ? existing(id) : undefined);
}

/**
 * Makes the coins and bounty scoreboards when they are missing, and returns the ids it made. A scoreboard is a plain dummy
 * objective, so this is exactly what typing `/scoreboard objectives add coins dummy` does. Safe to call any time; a refusal
 * from the game is reported once per objective and leaves the payout dropped, as it always was.
 */
export function ensureScoreboards(): readonly string[] {

    const made: string[] = [];

    for (const objective of OBJECTIVES) {

        if (existing(objective.id)) continue;

        try {
            world.scoreboard.addObjective(objective.id, objective.label);
            made.push(objective.id);
            couldNotMake.delete(objective.id);
        } catch (err) {
            if (!couldNotMake.has(objective.id)) {
                couldNotMake.add(objective.id);
                error("economy", `Could not make the ${objective.id} scoreboard: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    if (made.length > 0) warn("economy", `Made the missing scoreboard${made.length > 1 ? "s" : ""}: ${made.join(", ")}.`);

    return made;
}

const coins = () => existing("coins");
const bounty = () => existing("bounty");

// ---------------------------------------------------
// COINS
// ---------------------------------------------------

export function getCoins(target: Target): number {
    return coins()?.getScore(target) ?? 0;
}

export function addCoins(target: Target, amount: number): void {
    const obj = forWriting("coins");
    if (!obj) return;
    obj.setScore(target, getCoins(target) + amount);
}

export function setCoins(target: Target, amount: number): void {
    forWriting("coins")?.setScore(target, amount);
}

/** Returns the amount actually taken, which may be less than asked. */
export function takeCoins(target: Target, amount: number): number {
    const current = getCoins(target);
    const taken = Math.min(current, amount);
    if (taken > 0) setCoins(target, current - taken);
    return taken;
}

// ---------------------------------------------------
// BOUNTY
// ---------------------------------------------------

export function getBounty(target: Target): number {
    return bounty()?.getScore(target) ?? 0;
}

export function addBounty(target: Target, amount: number): void {
    const obj = forWriting("bounty");
    if (!obj) return;
    obj.setScore(target, getBounty(target) + amount);
}

export function clearBounty(target: Target): void {
    bounty()?.setScore(target, 0);
}

// ---------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------

/** Which of the two required scoreboard objectives are absent right now. Pure: no logging, no side effect. */
export function missingScoreboards(): readonly string[] {

    const missing: string[] = [];

    if (!coins()) missing.push("coins");
    if (!bounty()) missing.push("bounty");

    return missing;
}

/** Call once at startup. Reports missing objectives instead of failing quietly. */
export function verifyScoreboards(): boolean {

    ensureScoreboards();

    const missing = missingScoreboards();

    if (missing.length > 0) {
        error("economy", `Missing scoreboard objectives: ${missing.join(", ")}`);
        return false;
    }

    return true;
}
