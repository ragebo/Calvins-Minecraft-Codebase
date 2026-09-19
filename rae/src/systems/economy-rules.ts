import { world, type Player, type ScoreboardIdentity } from "@minecraft/server";
import { ECONOMY } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { onDeath } from "../core/events.js";
import { getCoins, setCoins, addCoins, addBounty } from "../core/economy.js";
import { getRecord, recordOf } from "../core/state.js";

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
 * A player's name for a chat line. A dead player's entity handle may already be
 * invalid, and Player.name can throw on one; the scoreboard identity outlives the
 * entity, so its display name is what we use then.
 */
function nameOf(player: Player, identity: ScoreboardIdentity): string {
    return player.isValid ? player.name : identity.displayName;
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

    // Whether they're law comes from their record: the dead player's entity
    // handle may already be invalid, and hasTag() on one throws.
    if (currentCoins <= 0 && recordOf(dead)?.role !== "law") {

        // The inventory can only be reached through a live handle, so a dead
        // player whose handle is gone drops nothing (and nothing is announced).
        if (dead.isValid) {
            dropInventory(dead);
            world.sendMessage(`§c${dead.name} had no money and dropped their inventory!`);
        }

    } else if (currentCoins > 0) {

        const remainingCoins = Math.floor(currentCoins * ECONOMY.deathCoinsKept);
        setCoins(deadIdentity, remainingCoins);

        world.sendMessage(`§c${nameOf(dead, deadIdentity)} died and lost half their money!`);
    }
    // A law player with no money takes no death penalty at all.
});

onDeath("economy:villager-robbery", 100, (ctx) => {

    if (!ctx.killer) return;
    if (ctx.dead.typeId !== "minecraft:villager_v2") return;
    if (!ctx.dead.hasTag("homestead")) return;
    if (getRecord(ctx.killer).role !== "outlaw") return;

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
