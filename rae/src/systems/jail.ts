import { world, system, type Player, type ScoreboardIdentity, type Vector3 } from "@minecraft/server";
import { JAIL_SITES } from "../config/world.js";
import { registerSystem } from "../core/registry.js";
import { onDeath, onScriptEvent, onSpawn } from "../core/events.js";
import { addCoins, getBounty, clearBounty } from "../core/economy.js";
import { error } from "../core/log.js";
import { getRecord, recordOf, getJailSite, setJailSite, syncTags, update, updateById } from "../core/state.js";
import { players, prisoners } from "../core/players.js";

/**
 * Chooses which jail site prisoners are sent to and captures outlaws
 * caught by law. A prisoner's first capture sends them to jail; a
 * second capture eliminates them permanently.
 *
 * The site in use is kept in core/state (getJailSite), not here, so the
 * jailbreak can find the jail's door without importing this file.
 */

/** Is anyone currently physically detained right now? */
function isJailOccupied(): boolean {
    return prisoners().length > 0;
}

/**
 * Call this ONLY when a NEW prisoner is captured. Rolls a fresh
 * jail entry if the jail is currently empty; otherwise reuses
 * whatever jail is already active, so multiple prisoners always
 * share the same one.
 */
export function assignJailForNewPrisoner(): Vector3 {

    let site = getJailSite();

    if (!isJailOccupied() || !site) {
        site = JAIL_SITES[Math.floor(Math.random() * JAIL_SITES.length)];
        setJailSite(site);
    }

    return site.jail;
}

/**
 * A player's name for a chat line. A dead player's entity handle may already be
 * invalid, and Player.name can throw on one; the scoreboard identity outlives the
 * entity, so its display name is what we use then.
 */
function nameOf(player: Player, identity: ScoreboardIdentity): string {
    return player.isValid ? player.name : identity.displayName;
}

/** Remembers what game mode an eliminated player was in, so a new round can give it back (a world property, so it outlives a reload). */
const BEFORE_SPECTATOR = "rae:gamemode_before_spectator";

/** The game mode a `/gamemode` command knows, from what the engine reports ("Survival" becomes "survival"). */
function modeNow(player: Player): string {
    try {
        return String(player.getGameMode()).toLowerCase();
    } catch {
        return "survival";
    }
}

function enterSpectator(player: Player): void {

    if (!player.isValid) return;

    const before = modeNow(player);

    // Already a spectator (eliminated twice, or sent here by hand): keep what was remembered the first time.
    if (before !== "spectator" && player.getDynamicProperty(BEFORE_SPECTATOR) === undefined) player.setDynamicProperty(BEFORE_SPECTATOR, before);

    player.runCommand("gamemode spectator @s");
}

/** Gives an eliminated player their game mode back. Nothing happens to a player who was never put in spectator by the round. */
function leaveSpectator(player: Player): void {

    if (!player.isValid) return;

    const before = player.getDynamicProperty(BEFORE_SPECTATOR);

    if (typeof before !== "string") return;

    try {
        player.runCommand(`gamemode ${before === "spectator" ? "survival" : before} @s`);
    } catch (err) {
        // What was remembered is kept, so the next reset or spawn tries again instead of leaving them a spectator with no memory of why.
        error("jail", `could not give a player their game mode back: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    player.setDynamicProperty(BEFORE_SPECTATOR, undefined);
}

onDeath("jail:capture", 100, (ctx) => {

    if (ctx.dead.typeId !== "minecraft:player") return;
    if (!ctx.killer) return;

    const dead = ctx.dead as Player;

    // The dead player's entity handle may already be invalid, so nothing here
    // calls anything on it except `id`, `isValid` and `scoreboardIdentity`, which
    // stay readable. Who they are comes from their record, and what happens to
    // them is written to it; their tags catch up when they next spawn
    // (state:adopt, then jail:spawn below).
    const record = recordOf(dead);

    if (record?.role !== "outlaw" || getRecord(ctx.killer).role !== "law") return;

    const deadIdentity: ScoreboardIdentity | undefined = dead.scoreboardIdentity;

    if (!deadIdentity) {
        error("jail", "Could not get a dead outlaw's scoreboard identity.");
        return;
    }

    const deadName = nameOf(dead, deadIdentity);
    const bounty = getBounty(deadIdentity);

    if (bounty > 0) {
        addCoins(ctx.killer, bounty);
        clearBounty(deadIdentity);

        world.sendMessage(
            `§6${ctx.killer.name} collected a bounty of §e${bounty}§6 coins from ${deadName}!`
        );
    }

    if (record.captures < 1) {
        updateById(dead.id, { pendingJail: true });

        world.sendMessage(`§6${deadName} was captured by the law and sent to jail!`);

        return;
    }

    updateById(dead.id, { eliminated: true });

    world.sendMessage(`§4${deadName} has been permanently eliminated!`);
});

// Order 100: decides where a captured or eliminated player goes, and marks them
// placed so the generic respawn (order 200, main.ts) leaves them alone.
onSpawn("jail:spawn", 100, (ctx) => {

    const player = ctx.player;

    // What happened to this player while they were dead (captured, eliminated) is
    // in their record but not yet on their tags: write it out now that the handle
    // is valid again, then decide from the record.
    syncTags(player);

    const record = getRecord(player);

    if (record.pendingJail) {

        update(player, { pendingJail: false, captures: Math.max(record.captures, 1) });

        // Must run before this player is marked in jail — otherwise
        // isJailOccupied() always sees them as already occupying it,
        // and assignJailForNewPrisoner() can never roll a fresh site
        // once the jail has actually emptied out.
        const jailLocation = assignJailForNewPrisoner();

        update(player, { inJail: true });

        system.run(() => {
            player.teleport(jailLocation);
            player.sendMessage("§cYou have been captured! This is your second and final life.");
        });

        ctx.placed = true;
        return;
    }

    if (record.eliminated) {
        system.run(() => {
            enterSpectator(player);
            player.sendMessage("§4You have been permanently eliminated.");
        });

        ctx.placed = true;
        return;
    }

    // Eliminated in an earlier round and offline when it was reset: the reset could not reach them, so they are let out now.
    if (player.getDynamicProperty(BEFORE_SPECTATOR) !== undefined) system.run(() => leaveSpectator(player));
});

// scriptevent bounty:test_capture — instantly captures YOU. Skips
// needing a law player to actually catch you, so combined with
// TESTING_MODE in jailbreak.ts, you can test the entire capture →
// lockpick → escort loop completely alone.
onScriptEvent("bounty:test_capture", (player) => {

    if (!player) return;

    update(player, { captures: Math.max(getRecord(player).captures, 1) });

    // Same ordering requirement as the real capture path above: roll
    // the jail site before this player counts as occupying it.
    const jailLocation = assignJailForNewPrisoner();

    update(player, { inJail: true });

    system.run(() => {
        player.teleport(jailLocation);
        player.sendMessage("§7[TEST] You've been sent to jail for testing.");
    });
});

registerSystem({
    name: "jail",
    ownedTags: ["jailed", "in_jail", "send_to_jail", "eliminated"],
    reset() {
        setJailSite(null);

        // A new round: nobody stays a spectator because of the last one.
        for (const player of players()) leaveSpectator(player);
    }
});
