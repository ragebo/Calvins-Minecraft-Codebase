import { world, type Player } from "@minecraft/server";
import { BOAT_NPC, BOAT_WIN_TELEPORT } from "../config/world.js";
import { ECONOMY, BOAT } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { onScriptEvent } from "../core/events.js";
import { getCoins, takeCoins } from "../core/economy.js";
import { endRound, isPhase } from "../core/round.js";
import { getRecord, update } from "../core/state.js";
import { aliveOutlaws } from "../core/players.js";

function isNearBoatNPC(player: Player): boolean {

    const dx = player.location.x - BOAT_NPC.x;
    const dy = player.location.y - BOAT_NPC.y;
    const dz = player.location.z - BOAT_NPC.z;

    return (dx * dx + dy * dy + dz * dz) <= BOAT.escapeRadius * BOAT.escapeRadius;
}

export function attemptOutlawEscape(player: Player): void {

    if (getRecord(player).role !== "outlaw") {
        player.sendMessage("§cOnly outlaws can use the escape boat.");
        return;
    }

    // Closes a real edge case: without this, an eliminated outlaw calling this after law has
    // already won leaves aliveOutlaws() empty, and the "must gather" and "must pay" checks below
    // both pass vacuously on zero survivors, announcing an escape with nobody in it.
    if (!isPhase("ACTIVE")) {
        player.sendMessage("§cNo round is running.");
        return;
    }

    const survivors = aliveOutlaws();

    const nearbyOutlaws = survivors.filter(isNearBoatNPC);

    if (nearbyOutlaws.length !== survivors.length) {
        world.sendMessage("§cAll surviving outlaws must gather at the escape boat!");
        return;
    }

    const requiredCoins = ECONOMY.boatEscapePerOutlaw * survivors.length;

    let totalCoins = 0;

    for (const outlaw of survivors) {
        totalCoins += getCoins(outlaw);
    }

    if (totalCoins < requiredCoins) {
        world.sendMessage(`§cThe gang needs §e${requiredCoins} coins§c to escape.`);
        world.sendMessage(`§7Combined money: §e${totalCoins}`);
        return;
    }

    let remainingCost = requiredCoins;

    for (const outlaw of survivors) {

        if (remainingCost <= 0) break;

        remainingCost -= takeCoins(outlaw, remainingCost);
    }

    // The isPhase check above already confirmed the round is active moments ago, and nothing
    // between then and here can change it (synchronous script execution) — this is really only
    // ever false on a genuine same-tick race with a law win, and it's checked anyway rather than
    // assumed.
    if (!endRound("outlaw_win")) return;

    world.sendMessage("§6§lTHE OUTLAWS HAVE ESCAPED!");
    world.sendMessage(`§eThe gang pooled ${requiredCoins} coins and escaped by boat!`);

    for (const outlaw of survivors) {
        update(outlaw, { winner: true });
    }

    world.getDimension("overworld").runCommand(
        `tp @a[tag=winner] ${BOAT_WIN_TELEPORT.x} ${BOAT_WIN_TELEPORT.y} ${BOAT_WIN_TELEPORT.z}`
    );
}

// scriptevent bounty:escape
onScriptEvent("bounty:escape", (player) => {
    if (!player) return;
    attemptOutlawEscape(player);
});

registerSystem({
    name: "boat",
    ownedTags: ["winner"],
    reset() {
        // Tags are cleared by the registry. Nothing else to clear.
    }
});
