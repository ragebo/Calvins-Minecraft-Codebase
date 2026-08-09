import { world, system } from "@minecraft/server";

// CHANGE THESE TO YOUR BOAT AREA
const BOAT_NPC = {
    x: 10,
    y: 65,
    z: 154
};

const ESCAPE_RADIUS = 16;

export function attemptOutlawEscape(player) {

    // Only outlaws can activate the boat
    if (!player.hasTag("outlaw")) {
        player.sendMessage("§cOnly outlaws can use the escape boat.");
        return;
    }

    const coinsObj = world.scoreboard.getObjective("coins");

    if (!coinsObj) {
        player.sendMessage("§cError: coins scoreboard missing.");
        return;
    }

    //---------------------------------------------------
    // GET ALL ALIVE OUTLAWS
    //---------------------------------------------------

    const aliveOutlaws = world.getAllPlayers().filter(player =>
    player.hasTag("outlaw") &&
    !player.hasTag("eliminated")
);

const nearbyOutlaws = aliveOutlaws.filter(isNearBoatNPC);

if (nearbyOutlaws.length !== aliveOutlaws.length) {

    world.sendMessage(
        `§cAll surviving outlaws must gather at the escape boat!`
    );

    return;
}

    //---------------------------------------------------
    // CALCULATE REQUIRED MONEY
    //---------------------------------------------------

    const requiredCoins =
        (250 * aliveOutlaws.length);

    //---------------------------------------------------
    // CALCULATE COMBINED OUTLAW MONEY
    //---------------------------------------------------

    let totalCoins = 0;

    for (const outlaw of aliveOutlaws) {
        totalCoins += coinsObj.getScore(outlaw) ?? 0;
    }

    if (totalCoins < requiredCoins) {

        world.sendMessage(
            `§cThe gang needs §e${requiredCoins} coins§c to escape.`
        );

        world.sendMessage(
            `§7Combined money: §e${totalCoins}`
        );

        return;
    }

    //---------------------------------------------------
    // TAKE THE MONEY FROM THE GANG
    //---------------------------------------------------

    let remainingCost = requiredCoins;

    for (const outlaw of aliveOutlaws) {

        if (remainingCost <= 0) break;

        const outlawCoins =
            coinsObj.getScore(outlaw) ?? 0;

        const amountToTake =
            Math.min(outlawCoins, remainingCost);

        coinsObj.setScore(
            outlaw,
            outlawCoins - amountToTake
        );

        remainingCost -= amountToTake;
    }

    //---------------------------------------------------
    // OUTLAWS WIN
    //---------------------------------------------------

    world.sendMessage(
        "§6§lTHE OUTLAWS HAVE ESCAPED!"
    );

    world.sendMessage(
        `§eThe gang pooled ${requiredCoins} coins and escaped by boat!`
    );

    // Add your actual game-ending commands here
    for (const outlaw of aliveOutlaws) {
        outlaw.addTag("winner");
        world.getDimension("overworld").runCommand("tp @a[tag=winner] 369.17 63.06 -370.01")
    }
}


//---------------------------------------------------
// CHECK IF PLAYER IS IN BOAT AREA
//---------------------------------------------------

function isNearBoatNPC(player) {

    const dx = player.location.x - BOAT_NPC.x;
    const dy = player.location.y - BOAT_NPC.y;
    const dz = player.location.z - BOAT_NPC.z;

    return (dx * dx + dy * dy + dz * dz) <= ESCAPE_RADIUS * ESCAPE_RADIUS;
}


system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:escape") return;

    const player = event.sourceEntity;

    if (!player || player.typeId !== "minecraft:player") return;

    attemptOutlawEscape(player);

});