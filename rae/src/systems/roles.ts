import { world, system, type Player, type Vector3 } from "@minecraft/server";
import { LAW_SPAWNS, OUTLAW_SPAWNS } from "../config/world.js";
import { registerSystem, resetAllSystems } from "../core/registry.js";
import { onScriptEvent } from "../core/events.js";
import { getRecord, update } from "../core/state.js";

/**
 * TEMPLATE FILE.
 *
 * Port every other system to match this shape:
 *   1. Import coordinates from config/world, numbers from config/balance.
 *   2. Register with registerSystem, declaring ownedTags and reset.
 *   3. Register triggers with onScriptEvent, never a raw subscription.
 *   4. Register loops with onTick, never a raw runInterval.
 */

export function pickRandom<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

function shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
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

export function teleportPlayersToSpawns(): void {
    for (const player of world.getAllPlayers()) {
        if (getRecord(player).role === null) continue;
        teleportToSpawn(player);
    }
}

export function startRoleSelection(): void {

    const players = shuffle([...world.getAllPlayers()]);

    if (players.length < 2) {
        world.sendMessage("§cNot enough players to start.");
        return;
    }

    // One call clears every system. No hand-maintained tag list.
    resetAllSystems();

    const lawCount = Math.max(1, Math.ceil(players.length / 4));

    players.forEach((player, index) => {
        update(player, { role: index < lawCount ? "law" : "outlaw" });
    });

    teleportPlayersToSpawns();

    for (const player of players) {
        player.onScreenDisplay.setTitle("§eRolling...");
    }

    system.runTimeout(() => {
        for (const player of players) {
            player.onScreenDisplay.setTitle(
                getRecord(player).role === "law" ? "§9LAWMAN" : "§cOUTLAW"
            );
        }
        world.sendMessage("§aRoles Assigned!");
    }, 60);
}

registerSystem({
    name: "roles",
    ownedTags: ["law", "outlaw", "native"],
    reset() {
        // Tags are cleared by the registry. Nothing else to clear.
    }
});

onScriptEvent("bounty:start_round", () => startRoleSelection());
onScriptEvent("bounty:teleport", () => teleportPlayersToSpawns());
