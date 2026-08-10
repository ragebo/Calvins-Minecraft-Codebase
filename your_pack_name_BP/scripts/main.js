import { world, system } from "@minecraft/server";
import { attemptOutlawEscape } from "./boat.js";
import { startRanchRaid } from "./ranchraid.js";
import "./ranchraid.js";
import { startRoleSelection, LAW_SPAWNS, OUTLAW_SPAWNS, pickRandomSpawn } from "./roles.js";
import "./horse.js";
import "./gold.js";
import "./harming.js";
import { startTrainRobbery } from "./train.js";
import "./train.js";

const JAIL_X = -254;
const JAIL_Y = 64;
const JAIL_Z = 235;

//---------------------------------------------------
// DROP INVENTORY (used when a player dies broke)
//---------------------------------------------------

function dropInventory(player) {

    try {

        const dimension = player.dimension;
        const location = player.location;
        const inventory = player.getComponent("minecraft:inventory");
        const container = inventory.container;

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

world.afterEvents.entityDie.subscribe((event) => {
    const dead = event.deadEntity;
    const killer = event.damageSource.damagingEntity;

    const bountyObj = world.scoreboard.getObjective("bounty");
    const coinsObj = world.scoreboard.getObjective("coins");

    //---------------------------------------------------
    // OUTLAW LOSES HALF THEIR MONEY ON DEATH
    // Runs for ANY cause of death — fall, drown, mob, poison,
    // not just PvP kills. Must stay above the killer check below.
    //---------------------------------------------------

    if (coinsObj && dead.typeId === "minecraft:player") {
        const deadIdentity = dead.scoreboardIdentity;

        if (deadIdentity) {
            const currentCoins = coinsObj.getScore(deadIdentity) ?? 0;

            if (currentCoins <= 0) {

                dropInventory(dead);

                world.sendMessage(
                    `§c${dead.name} had no money and dropped their inventory!`
                );

            } else {

                const remainingCoins = Math.floor(currentCoins / 2);

                coinsObj.setScore(deadIdentity, remainingCoins);

                world.sendMessage(
                    `§c${dead.name} died and lost half their money!`
                );
            }
        }
    }

    //---------------------------------------------------
    // Everything past this point needs a player killer.
    //---------------------------------------------------

    if (!killer || killer.typeId !== "minecraft:player") return;

    if (!bountyObj || !coinsObj) return;

    //---------------------------------------------------
    // OUTLAW KILLS HOMESTEAD VILLAGER
    //---------------------------------------------------

    if (
        dead.typeId === "minecraft:villager_v2" &&
        dead.hasTag("homestead") &&
        killer.hasTag("outlaw")
    ) {
        const reward = Math.floor(Math.random() * 26) + 15;

        // Pass the living player entity directly
        const currentCoins = coinsObj.getScore(killer) ?? 0;
        const currentBounty = bountyObj.getScore(killer) ?? 0;

        coinsObj.setScore(killer, currentCoins + reward);
        bountyObj.setScore(killer, currentBounty + 25);

        killer.sendMessage(
            `§6You robbed a homestead! §a+${reward} coins`
        );

        killer.sendMessage(
            "§cYour bounty increased by 25!"
        );

        return;
    }

    //---------------------------------------------------
    // LAW KILLS OUTLAW
    //---------------------------------------------------

    if (
        dead.typeId === "minecraft:player" &&
        dead.hasTag("outlaw") &&
        killer.hasTag("law")
    ) {
        const deadIdentity = dead.scoreboardIdentity;

        if (!deadIdentity) {
            killer.sendMessage(
                "§c[DEBUG] Could not get dead outlaw's scoreboard identity."
            );
            return;
        }

        //---------------------------------------------------
        // PAY BOUNTY
        //---------------------------------------------------

        const bounty = bountyObj.getScore(deadIdentity) ?? 0;

        if (bounty > 0) {
            const currentCoins = coinsObj.getScore(killer) ?? 0;

            coinsObj.setScore(
                killer,
                currentCoins + bounty
            );

            bountyObj.setScore(
                deadIdentity,
                0
            );

            world.sendMessage(
                `§6${killer.name} collected a bounty of §e${bounty}§6 coins from ${dead.name}!`
            );
        }

        //---------------------------------------------------
        // FIRST LIFE - SEND TO JAIL
        //---------------------------------------------------

        if (!dead.hasTag("jailed")) {
            dead.addTag("send_to_jail");

            world.sendMessage(
                `§6${dead.name} was captured by the law and sent to jail!`
            );

            return;
        }

        //---------------------------------------------------
        // SECOND LIFE - ELIMINATE
        //---------------------------------------------------

        dead.addTag("eliminated");

        world.sendMessage(
            `§4${dead.name} has been permanently eliminated!`
        );

        return;


    }

    if (
        dead.hasTag("ranch_defender") &&
        killer?.typeId === "minecraft:player"
    ) {
        let reward = 0;

        switch (dead.typeId) {

            case "minecraft:pillager":
                reward = Math.floor(Math.random() * 5) + 15;
                break;

            case "minecraft:witch":
                reward = Math.floor(Math.random() * 3) + 15;
                break;

            case "minecraft:iron_golem":
                reward = Math.floor(Math.random() * 16) + 25;
                break;

        }
        coinsObj.setScore(
            killer,
            (coinsObj.getScore(killer) ?? 0) + reward
        );

        killer.sendMessage(
            `§a+$${reward}`
        );
    }


});


world.afterEvents.playerSpawn.subscribe((event) => {

    const player = event.player;

    // Give effectively infinite saturation
    player.addEffect("saturation", 20000000, {
        amplifier: 255,
        showParticles: false
    });

    // Send first-life outlaw to jail
    if (player.hasTag("send_to_jail")) {
        player.removeTag("send_to_jail");
        player.addTag("jailed");

        system.run(() => {
            player.teleport({
                x: JAIL_X,
                y: JAIL_Y,
                z: JAIL_Z
            });

            player.sendMessage(
                "§cYou have been captured! This is your second and final life."
            );
        });

        return;
    }

    // Handle permanent elimination
    if (player.hasTag("eliminated")) {
        system.run(() => {
            // Replace this with your preferred spectator/dead-player system
            player.runCommand("gamemode spectator @s");

            player.sendMessage(
                "§4You have been permanently eliminated."
            );
        });

        return;
    }

    // Random respawn point for everyone else currently in a role.
    // This never runs for the two cases above, so it can't
    // interfere with the jail teleport or elimination.
    if (player.hasTag("law") || player.hasTag("outlaw")) {

        try {

            const spawnList = player.hasTag("law") ? LAW_SPAWNS : OUTLAW_SPAWNS;

            system.run(() => {
                player.teleport(pickRandomSpawn(spawnList));
            });

        } catch (error) {

            world.sendMessage(`§c[SPAWN ERROR] Could not respawn ${player.name}: ${error}`);

        }
    }
});


//Handles Water Poision

system.runInterval(() => {

    for (const player of world.getAllPlayers()) {

        if (player.isInWater) {

            // 40 ticks = 2 seconds, amplifier 0, particles hidden —
            // same values as the old command, just without going
            // through the command parser every time.
            player.addEffect("poison", 40, {
                amplifier: 0,
                showParticles: false
            });

        }

    }

}, 20);
