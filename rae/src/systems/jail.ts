import { world, system, type Player, type ScoreboardIdentity, type Vector3 } from "@minecraft/server";
import { JAIL_SITES, type JailSite } from "../config/world.js";
import { registerSystem } from "../core/registry.js";
import { onDeath } from "../core/events.js";
import { addCoins, getBounty, clearBounty } from "../core/economy.js";

/**
 * Tracks which jail site is currently in use and captures outlaws
 * caught by law. A prisoner's first capture sends them to jail; a
 * second capture eliminates them permanently.
 */

let activeJailEntry: JailSite | null = null;

/** Is anyone currently physically detained right now? */
export function isJailOccupied(): boolean {
    return world.getAllPlayers().some((player) => player.hasTag("in_jail"));
}

/**
 * Call this ONLY when a NEW prisoner is captured. Rolls a fresh
 * jail entry if the jail is currently empty; otherwise reuses
 * whatever jail is already active, so multiple prisoners always
 * share the same one.
 */
export function assignJailForNewPrisoner(): Vector3 {
    if (!isJailOccupied() || !activeJailEntry) {
        activeJailEntry = JAIL_SITES[Math.floor(Math.random() * JAIL_SITES.length)];
    }

    return activeJailEntry.jail;
}

/** Read-only lookup of wherever the jail currently is. Never rolls a new one. */
export function getCurrentJail() {
    return activeJailEntry ? activeJailEntry.jail : null;
}

/** The door-trigger point that matches whichever jail is currently active. */
export function getCurrentDoorTrigger() {
    return activeJailEntry ? activeJailEntry.doorTrigger : null;
}

onDeath("jail:capture", 100, (ctx) => {

    if (ctx.dead.typeId !== "minecraft:player") return;
    if (!ctx.killer) return;

    const dead = ctx.dead as Player;

    // dead.hasTag() throws InvalidEntityError if the entity's handle
    // is already gone by the time this runs — if we can't read the
    // outlaw tag at all there's nothing safe to capture.
    if (!dead.isValid) return;
    if (!dead.hasTag("outlaw") || !ctx.killer.hasTag("law")) return;

    const deadIdentity: ScoreboardIdentity | undefined = dead.scoreboardIdentity;

    if (!deadIdentity) {
        ctx.killer.sendMessage("§c[DEBUG] Could not get dead outlaw's scoreboard identity.");
        return;
    }

    const bounty = getBounty(deadIdentity);

    if (bounty > 0) {
        addCoins(ctx.killer, bounty);
        clearBounty(deadIdentity);

        world.sendMessage(
            `§6${ctx.killer.name} collected a bounty of §e${bounty}§6 coins from ${dead.name}!`
        );
    }

    if (!dead.hasTag("jailed")) {
        dead.addTag("send_to_jail");

        world.sendMessage(`§6${dead.name} was captured by the law and sent to jail!`);

        return;
    }

    dead.addTag("eliminated");

    world.sendMessage(`§4${dead.name} has been permanently eliminated!`);
});

world.afterEvents.playerSpawn.subscribe((event) => {

    const player = event.player;

    if (player.hasTag("send_to_jail")) {

        player.removeTag("send_to_jail");
        player.addTag("jailed");

        // Must run before this player gets the in_jail tag — otherwise
        // isJailOccupied() always sees them as already occupying it,
        // and assignJailForNewPrisoner() can never roll a fresh site
        // once the jail has actually emptied out.
        const jailLocation = assignJailForNewPrisoner();

        player.addTag("in_jail");

        system.run(() => {
            player.teleport(jailLocation);
            player.sendMessage("§cYou have been captured! This is your second and final life.");
        });

        return;
    }

    if (player.hasTag("eliminated")) {
        system.run(() => {
            player.runCommand("gamemode spectator @s");
            player.sendMessage("§4You have been permanently eliminated.");
        });
    }
});

registerSystem({
    name: "jail",
    ownedTags: ["jailed", "in_jail", "send_to_jail", "eliminated"],
    reset() {
        activeJailEntry = null;
    }
});
