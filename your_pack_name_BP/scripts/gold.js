import { world } from "@minecraft/server";

//====================================
// GOLD → COINS SETTINGS
//====================================

// How many coins each gold item is worth. Ratios match vanilla
// gold conversion (9 nuggets = 1 ingot, 9 ingots = 1 block), so
// changing GOLD_INGOT_VALUE alone keeps everything in proportion.
const GOLD_INGOT_VALUE = 10;

const GOLD_VALUES = {
    "minecraft:gold_nugget": Math.max(1, Math.round(GOLD_INGOT_VALUE / 9)),
    "minecraft:gold_ingot": GOLD_INGOT_VALUE,
    "minecraft:gold_block": GOLD_INGOT_VALUE * 9
};

//====================================
// CONVERT ON PICKUP
//====================================

// This event only fires for the items listed in includeItems —
// filtered by the engine itself, not our code — so nothing runs
// at all unless gold actually enters a player's inventory.
world.afterEvents.playerInventoryItemChange.subscribe((event) => {

    const itemId = event.itemStack?.typeId;

    // Filter already limits us to gold items, but a gold item
    // LEAVING a slot also fires this event with itemStack
    // undefined — skip that case.
    if (!itemId) return;

    const value = GOLD_VALUES[itemId];
    if (!value) return;

    const player = event.player;
    const coinsObj = world.scoreboard.getObjective("coins");

    if (!coinsObj) return;

    try {

        const coinValue = value * event.itemStack.amount;

        // Clear the gold out of the slot it just landed in.
        const inventory = player.getComponent("minecraft:inventory");
        inventory.container.setItem(event.slot, undefined);

        coinsObj.setScore(
            player,
            (coinsObj.getScore(player) ?? 0) + coinValue
        );

        player.sendMessage(`§6+${coinValue} coins §7(gold converted automatically)`);

    } catch (error) {

        world.sendMessage(`§c[GOLD ERROR] Could not convert gold for ${player.name}: ${error}`);

    }

}, {
    includeItems: Object.keys(GOLD_VALUES)
});
