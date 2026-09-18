import { world } from "@minecraft/server";
import { registerSystem } from "../core/registry.js";
import { onDeath } from "../core/events.js";

/**
 * V1 never had a law win condition — only the outlaws' boat escape
 * (boat.ts) ended a round. This closes that gap: once every outlaw
 * has been permanently eliminated (used both lives), law wins.
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
    // eliminated counts.
    if (outlaws.length === 0) return;
    if (!outlaws.every((player) => player.hasTag("eliminated"))) return;

    roundEnded = true;

    world.sendMessage("§9§lTHE LAW HAS WON!");
    world.sendMessage("§7Every outlaw has been captured and eliminated.");

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

registerSystem({
    name: "endgame",
    ownedTags: ["winner"],
    reset() {
        roundEnded = false;
    }
});
