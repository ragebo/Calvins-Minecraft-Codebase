import { world } from "@minecraft/server";
import { ECONOMY } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { addCoins } from "../core/economy.js";

/**
 * Ratios match vanilla gold conversion (9 nuggets = 1 ingot, 9
 * ingots = 1 block), so ECONOMY.goldIngotValue alone keeps
 * everything in proportion.
 */
const GOLD_VALUES: Record<string, number> = {
    "minecraft:gold_nugget": Math.max(1, Math.round(ECONOMY.goldIngotValue / 9)),
    "minecraft:gold_ingot": ECONOMY.goldIngotValue,
    "minecraft:gold_block": ECONOMY.goldIngotValue * 9
};

// This event only fires for the items listed in includeItems —
// filtered by the engine itself — so nothing runs at all unless
// gold actually enters a player's inventory.
world.afterEvents.playerInventoryItemChange.subscribe((event) => {

    const itemId = event.itemStack?.typeId;

    // A gold item LEAVING a slot also fires this event with
    // itemStack undefined — skip that case.
    if (!itemId) return;

    const value = GOLD_VALUES[itemId];
    if (!value) return;

    const player = event.player;

    try {

        const coinValue = value * event.itemStack!.amount;

        // Clear the gold out of the slot it just landed in.
        const inventory = player.getComponent("minecraft:inventory");
        inventory!.container!.setItem(event.slot, undefined);

        addCoins(player, coinValue);

        player.sendMessage(`§6+${coinValue} coins`);

    } catch (error) {
        world.sendMessage(`§c[GOLD ERROR] Could not convert gold for ${player.name}: ${error}`);
    }

}, {
    includeItems: Object.keys(GOLD_VALUES)
});

registerSystem({
    name: "gold",
    reset() {
        // No internal state, no owned tags.
    }
});
