import type { Player } from "@minecraft/server";
import { error } from "./log.js";

/**
 * Putting a player in spectator for the rest of a round, and giving them their game mode back (lifted out of systems/jail.ts, where an elimination
 * used it, so an escaped outlaw can use it too: the plan is tasks/endings/plan.md).
 *
 * The game mode a player had is remembered in a property on the player, so it outlives a script reload and a world reload, and is given back by the
 * next round's reset or the player's next spawn.
 */

/** Remembers what game mode a spectating player was in, so a new round can give it back. */
const BEFORE_SPECTATOR = "rae:gamemode_before_spectator";

/** The game mode a `/gamemode` command knows, from what the engine reports ("Survival" becomes "survival"). */
function modeNow(player: Player): string {
    try {
        return String(player.getGameMode()).toLowerCase();
    } catch {
        return "survival";
    }
}

/** Whether the round put this player in spectator and has not yet given them their game mode back. */
export function wasPutInSpectator(player: Player): boolean {
    return player.getDynamicProperty(BEFORE_SPECTATOR) !== undefined;
}

export function enterSpectator(player: Player): void {

    if (!player.isValid) return;

    const before = modeNow(player);

    // Already a spectator (eliminated twice, or sent here by hand): keep what was remembered the first time.
    if (before !== "spectator" && player.getDynamicProperty(BEFORE_SPECTATOR) === undefined) player.setDynamicProperty(BEFORE_SPECTATOR, before);

    player.runCommand("gamemode spectator @s");
}

/** Gives a spectating player their game mode back. Nothing happens to a player who was never put in spectator by the round. */
export function leaveSpectator(player: Player): void {

    if (!player.isValid) return;

    const before = player.getDynamicProperty(BEFORE_SPECTATOR);

    if (typeof before !== "string") return;

    try {
        player.runCommand(`gamemode ${before === "spectator" ? "survival" : before} @s`);
    } catch (err) {
        // What was remembered is kept, so the next reset or spawn tries again instead of leaving them a spectator with no memory of why.
        error("jail", `could not give a player their game mode back: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    player.setDynamicProperty(BEFORE_SPECTATOR, undefined);
}
