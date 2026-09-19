import { world } from "@minecraft/server";
import { registerSystem } from "../core/registry.js";
import { onDeath, onSpawn } from "../core/events.js";

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
 */

let roundEnded = false;

function checkLawWin(): void {

    if (roundEnded) return;

    const outlaws = world.getAllPlayers().filter((player) => player.hasTag("outlaw"));

    // No outlaws at all (round not started, everyone disconnected)
    // isn't a win — only every assigned outlaw actually being
    // neutralized counts.
    if (outlaws.length === 0) return;

    const allNeutralized = outlaws.every((player) =>
        player.hasTag("eliminated") || player.hasTag("in_jail")
    );

    if (!allNeutralized) return;

    roundEnded = true;

    world.sendMessage("§9§lTHE LAW HAS WON!");
    world.sendMessage("§7Every outlaw is captured or eliminated — no one is left to break them out.");

    for (const player of world.getAllPlayers()) {
        if (player.hasTag("law") && !player.hasTag("eliminated")) {
            player.addTag("winner");
        }
    }
}

// Runs after jail:capture (order 100), which is the only place the
// "eliminated" tag ever gets set — so this always sees the result
// of the death that might have just finished off the last outlaw.
onDeath("endgame:law-win-check", 150, () => {
    checkLawWin();
});

// A death alone can't catch the "everyone's now in jail" case: a
// fresh capture only gets the in_jail tag on respawn (jail:spawn,
// order 100), not at the moment of death itself. This runs at 150,
// after it, so in_jail is already set by the time it looks.
onSpawn("endgame:law-win-check", 150, () => {
    checkLawWin();
});

registerSystem({
    name: "endgame",
    ownedTags: ["winner"],
    reset() {
        roundEnded = false;
    }
});
