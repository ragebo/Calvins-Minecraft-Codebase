import { system, world, type Player, type Vector3 } from "@minecraft/server";
import { LAW_SPAWNS, OUTLAW_SPAWNS } from "../config/world.js";
import { players } from "./players.js";
import { resetAllSystems } from "./registry.js";
import { getRecord, update, type Role } from "./state.js";
import { announce, showTitle } from "./ui.js";

/**
 * The game's own actions: starting a round with roles, and sending people to their spawns.
 *
 * They used to live in systems/roles.ts, reachable only through its script events. The in-game menu
 * (systems/menu.ts) needs them too, and a system may not import another system, so they live here and
 * both call them. The rules are unchanged: a round resets every system, assigns the roles, sends each
 * player with a role to a random spawn for it, and announces the roles a moment later.
 */

/** What the person starting a round can decide for each player. */
export type Choice = "law" | "outlaw" | "sit_out";

export interface ChosenStart {
    readonly ok: boolean;
    /** Why nothing started (when `ok` is false). */
    readonly refusal?: string;
    /** Things worth knowing that did not stop the round (an empty side). */
    readonly warnings: readonly string[];
}

/** Ticks between "Rolling..." and the role titles. */
const REVEAL_DELAY_TICKS = 60;

export function pickRandom<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)]!;
}

function shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j]!, array[i]!];
    }
    return array;
}

export function spawnListFor(player: Player): Vector3[] {
    return getRecord(player).role === "law" ? LAW_SPAWNS : OUTLAW_SPAWNS;
}

export function teleportToSpawn(player: Player): void {
    try {
        player.teleport(pickRandom(spawnListFor(player)));
    } catch (error) {
        world.sendMessage(`§c[ROLES] Could not teleport ${player.name}: ${error}`);
    }
}

/** The reset the menu offers and `/scriptevent rae:reset` runs: every system back to its starting state. */
export function resetGame(): void {
    resetAllSystems();
    announce("§7All systems reset.");
}

/** Sends everyone who has a role to a random spawn for it. */
export function sendEveryoneToSpawns(): void {
    for (const player of players()) {
        // The list is a snapshot from earlier this tick: someone who just left is still in it, and their handle throws.
        if (!player.isValid) continue;
        if (getRecord(player).role === null) continue;
        teleportToSpawn(player);
    }
}

/**
 * The shared part of every start: a clean slate, the roles, the spawns, then the reveal. `roles` maps each
 * player to a role, or to null for someone who sits this round out (they get nothing and go nowhere).
 */
function begin(roles: ReadonlyMap<Player, Role | null>): void {

    // One call clears every system. No hand-maintained tag list.
    resetAllSystems();

    const playing: Player[] = [];

    for (const [player, role] of roles) {
        if (role === null) continue;
        update(player, { role });
        playing.push(player);
    }

    sendEveryoneToSpawns();

    for (const player of playing) {
        showTitle(player, "§eRolling...");
    }

    system.runTimeout(() => {
        for (const player of playing) {
            if (!player.isValid) continue;
            showTitle(player, getRecord(player).role === "law" ? "§9LAWMAN" : "§cOUTLAW");
        }
        announce("§aRoles Assigned!");
    }, REVEAL_DELAY_TICKS);
}

/** The round everyone has always got: shuffled roles, a quarter of the players (at least one) are law. False when there are too few players. */
export function startRandomRound(): boolean {

    const everyone = shuffle([...players()]);

    if (everyone.length < 2) {
        announce("§cNot enough players to start.");
        return false;
    }

    const lawCount = Math.max(1, Math.ceil(everyone.length / 4));
    const roles = new Map<Player, Role | null>();

    everyone.forEach((player, index) => roles.set(player, index < lawCount ? "law" : "outlaw"));
    begin(roles);

    return true;
}

/**
 * A round with the roles someone picked. Refuses when nobody is playing; an empty side (no law, or no outlaw) is
 * allowed, because testing alone is a real use, and comes back as a warning.
 */
export function startChosenRound(choices: ReadonlyMap<Player, Choice>): ChosenStart {

    const roles = new Map<Player, Role | null>();

    // Someone may have left while the choices were being made.
    for (const [player, choice] of choices) {
        if (!player.isValid) continue;
        roles.set(player, choice === "sit_out" ? null : choice);
    }

    const chosen = [...roles.values()].filter((role): role is Role => role !== null);

    if (chosen.length === 0) {
        return { ok: false, refusal: "Nobody is playing: pick Law or Outlaw for at least one player.", warnings: [] };
    }

    const warnings: string[] = [];
    if (!chosen.includes("law")) warnings.push("Nobody is law.");
    if (!chosen.includes("outlaw")) warnings.push("Nobody is an outlaw.");

    begin(roles);

    return { ok: true, warnings };
}
