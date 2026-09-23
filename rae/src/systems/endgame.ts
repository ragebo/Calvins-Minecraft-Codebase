import { world } from "@minecraft/server";
import { registerSystem } from "../core/registry.js";
import { onDeath, onSpawn } from "../core/events.js";
import { endRound } from "../core/round.js";
import { getRecord, update } from "../core/state.js";
import { outlaws, lawPlayers } from "../core/players.js";

/**
 * V1 never had a law win condition — only the outlaws' boat escape
 * (boat.ts) ended a round. This closes that gap: law wins once
 * every outlaw is neutralized — either permanently eliminated, or
 * currently sitting in jail. "Everyone jailed" is just as dead an
 * end as "everyone eliminated": jailbreak.ts's checkEligibility
 * requires a rescuer who is an outlaw, not currently in_jail, and
 * not eliminated — so if every outlaw is in one of those two
 * states, there is no one left who could ever attempt a rescue.
 *
 * Deliberately symmetric with boat.ts's outlaw win: tag survivors
 * "winner" and announce it, no teleport (there's no established
 * "law victory" location the way BOAT_WIN_TELEPORT exists for
 * outlaws).
 *
 * "Has this round already ended?" is core/round.ts's job now, not a private flag here: endRound()
 * only succeeds once, from ACTIVE, so a second win-condition check in the same or a later tick
 * can't double-announce.
 */

function checkLawWin(): void {

    const everyOutlaw = outlaws();

    // No outlaws at all (round not started, everyone disconnected)
    // isn't a win — only every assigned outlaw actually being
    // neutralized counts.
    if (everyOutlaw.length === 0) return;

    const allNeutralized = everyOutlaw.every((player) => {
        const record = getRecord(player);
        return record.eliminated || record.inJail;
    });

    if (!allNeutralized) return;

    // False if no round is active, or one already ended (someone else's win, or this same check
    // running again): either way, nothing left to announce.
    if (!endRound("law_win")) return;

    world.sendMessage("§9§lTHE LAW HAS WON!");
    world.sendMessage("§7Every outlaw is captured or eliminated — no one is left to break them out.");

    for (const player of lawPlayers()) {
        update(player, { winner: true });
    }
}

// Runs after jail:capture (order 100), which is the only place a player
// ever becomes "eliminated" — so this always sees the result of the
// death that might have just finished off the last outlaw. It reads
// records, not tags: jail:capture can only change the record of a dead
// player (their tags catch up when they respawn).
onDeath("endgame:law-win-check", 150, () => {
    checkLawWin();
});

// A death alone can't catch the "everyone's now in jail" case: a
// fresh capture only becomes "in jail" on respawn (jail:spawn,
// order 100), not at the moment of death itself. This runs at 150,
// after it, so the prisoner is already in jail by the time it looks.
onSpawn("endgame:law-win-check", 150, () => {
    checkLawWin();
});

registerSystem({
    name: "endgame",
    ownedTags: ["winner"],
    reset() {
        // Nothing local left to clear: whether a round has ended lives in core/round.ts now.
    }
});
