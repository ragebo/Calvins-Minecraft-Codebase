import { world } from "@minecraft/server";

/**
 * Fixes the reset bug from V1.
 *
 * In V1, round reset was a hand-written list of removeTag calls in
 * roles.ts. Every new system had to remember to add itself. One sync
 * dropped the jail reset and nobody noticed.
 *
 * Now a system registers itself. Round reset calls every registered
 * system. Adding a system cannot break the reset.
 */

export interface GameSystem {
    /** Used in debug output. */
    readonly name: string;
    /** Clear all state this system owns. Called at round start. */
    reset(): void;
    /** Tags this system owns. Cleared from every player at round start. */
    readonly ownedTags?: readonly string[];
}

const systems: GameSystem[] = [];

export function registerSystem(system: GameSystem): void {
    systems.push(system);
}

export function resetAllSystems(): void {

    // Clear every tag any system claims ownership of.
    const allTags = new Set<string>();

    for (const system of systems) {
        for (const tag of system.ownedTags ?? []) {
            allTags.add(tag);
        }
    }

    for (const player of world.getAllPlayers()) {
        for (const tag of allTags) {
            player.removeTag(tag);
        }
    }

    // Then let each system clear its own internal state.
    for (const system of systems) {
        try {
            system.reset();
        } catch (error) {
            world.sendMessage(`§c[RESET ERROR] ${system.name}: ${error}`);
        }
    }
}

export function listSystems(): readonly GameSystem[] {
    return systems;
}
