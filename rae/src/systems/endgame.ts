import { registerSystem } from "../core/registry.js";
import { onDeath, onSpawn } from "../core/events.js";
import { checkRoundOver } from "../core/endings.js";

/**
 * When a round is over because of who is left, not because someone used an ending.
 *
 * V1 never had a law win condition — only the outlaws' boat escape (now the ending called boat, core/endings.ts). This closes that gap: law wins once
 * every outlaw still in play is neutralized — either permanently eliminated, or currently sitting in jail. "Everyone jailed" is just as dead an end as
 * "everyone eliminated": jailbreak.ts's checkEligibility requires a rescuer who is an outlaw, not currently in_jail, and not eliminated — so if every
 * outlaw is in one of those two states, there is no one left who could ever attempt a rescue. An outlaw who ESCAPED is not in play any more and does not
 * count against the law (core/players.ts leaves them out); when every outlaw has escaped the outlaws win instead.
 *
 * The judging is core/endings.ts's `checkRoundOver`, because an escape asks the same question; this file only says when to ask on a death or a spawn.
 * "Has this round already ended?" is core/round.ts's job: endRound() only succeeds once, from ACTIVE, so a second check in the same or a later tick can't
 * double-announce.
 */

// Runs after jail:capture (order 100), which is the only place a player
// ever becomes "eliminated" — so this always sees the result of the
// death that might have just finished off the last outlaw. It reads
// records, not tags: jail:capture can only change the record of a dead
// player (their tags catch up when they respawn).
onDeath("endgame:law-win-check", 150, () => {
    checkRoundOver();
});

// A death alone can't catch the "everyone's now in jail" case: a
// fresh capture only becomes "in jail" on respawn (jail:spawn,
// order 100), not at the moment of death itself. This runs at 150,
// after it, so the prisoner is already in jail by the time it looks.
onSpawn("endgame:law-win-check", 150, () => {
    checkRoundOver();
});

registerSystem({
    name: "endgame",
    ownedTags: ["winner"],
    reset() {
        // Nothing local left to clear: whether a round has ended lives in core/round.ts now.
    }
});
