import { world, type Player } from "@minecraft/server";
import { ECONOMY } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { onDeath } from "../core/events.js";
import { getCoins, setCoins, addCoins, addBounty } from "../core/economy.js";

function dropInventory(player: Player): void {

    try {

        const dimension = player.dimension;
        const location = player.location;
        const inventory = player.getComponent("minecraft:inventory");
        const container = inventory!.container!;

        for (let i = 0; i < container.size; i++) {

            const itemStack = container.getItem(i);

            if (!itemStack) continue;

            dimension.spawnItem(itemStack, location);
            container.setItem(i, undefined);
        }

    } catch (error) {
        world.sendMessage(`§c[DEATH ERROR] Could not drop inventory for ${player.name}: ${error}`);
    }
}

/**
 * Runs for ANY cause of death — fall, drown, mob, poison, not just
 * PvP kills.
 */
onDeath("economy:death-penalty", 50, (ctx) => {

    if (ctx.dead.typeId !== "minecraft:player") return;

    const dead = ctx.dead as Player;
    const deadIdentity = dead.scoreboardIdentity;

    if (!deadIdentity) return;

    const currentCoins = getCoins(deadIdentity);

    // dead.hasTag() throws InvalidEntityError if the entity's handle
    // is already gone by the time this runs — treat that as "can't
    // tell if they're law," which just means the broke-and-drops
    // branch doesn't fire for them (same as the law exemption below).
    if (currentCoins <= 0 && dead.isValid && !dead.hasTag("law")) {

        dropInventory(dead);
        world.sendMessage(`§c${dead.name} had no money and dropped their inventory!`);

    } else if (currentCoins > 0) {

        const remainingCoins = Math.floor(currentCoins * ECONOMY.deathCoinsKept);
        setCoins(deadIdentity, remainingCoins);

        world.sendMessage(`§c${dead.name} died and lost half their money!`);
    }
    // A law player with no money takes no death penalty at all.
});

onDeath("economy:villager-robbery", 100, (ctx) => {

    if (!ctx.killer) return;
    if (ctx.dead.typeId !== "minecraft:villager_v2") return;
    if (!ctx.dead.hasTag("homestead")) return;
    if (!ctx.killer.hasTag("outlaw")) return;

    const reward =
        Math.floor(Math.random() * (ECONOMY.villagerRewardMax - ECONOMY.villagerRewardMin + 1)) +
        ECONOMY.villagerRewardMin;

    addCoins(ctx.killer, reward);
    addBounty(ctx.killer, ECONOMY.villagerBountyGain);

    ctx.killer.sendMessage(`§6You robbed a homestead! §a+${reward} coins`);
    ctx.killer.sendMessage(`§cYour bounty increased by ${ECONOMY.villagerBountyGain}!`);
});

registerSystem({
    name: "economy-rules",
    reset() {
        // No internal state, no owned tags.
    }
});
