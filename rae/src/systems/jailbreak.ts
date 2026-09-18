import { world, system, type Player, type Vector3 } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { JAILBREAK } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { onScriptEvent } from "../core/events.js";
import { onTick } from "../core/tick.js";
import { addCoins, clearBounty } from "../core/economy.js";
import {
    isJailOccupied,
    getCurrentJail,
    getCurrentDoorTrigger,
    assignJailForNewPrisoner
} from "./jail.js";

/**
 * Flip to true while testing solo. Normally a player who's currently
 * jailed can't count toward rescuing themselves — with this on, they
 * can. Set back to false before a real game.
 */
const TESTING_MODE = false;

const PING_SOUND = "random.orb";
const SUCCESS_SOUND = "random.levelup";

let successfulHits = 0;
let contributors = new Set<Player>();
let failTimeoutId: number | null = null;
let sweetSpotTarget: number | null = null; // null = needs to be rolled on the next attempt
const lastClickTick = new Map<string, number>(); // player name -> tick, for the cooldown
const escortOrigin = new Map<string, Vector3>(); // player name -> jail location at the moment they were freed

function distance(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getLawNear(point: Vector3, radius: number): Player[] {
    return world.getAllPlayers().filter((player) =>
        player.hasTag("law") &&
        !player.hasTag("eliminated") &&
        distance(player.location, point) <= radius
    );
}

/**
 * Places a redstone block at whichever jail's doorTrigger point is
 * currently active, powering whatever redstone contraption actually
 * opens that jail's door.
 */
function openJailDoor(doorTrigger: Vector3 | null): void {

    if (!doorTrigger) {
        world.sendMessage("§c[JAILBREAK ERROR] No door trigger point for the current jail.");
        return;
    }

    const dimension = world.getDimension("overworld");

    try {
        dimension.runCommand(
            `setblock ${doorTrigger.x} ${doorTrigger.y} ${doorTrigger.z} redstone_block`
        );
    } catch (error) {
        world.sendMessage(`§c[JAILBREAK ERROR] Could not open the door: ${error}`);
    }
}

function succeedBreakout(rescuers: Player[], jailLocation: Vector3, doorTrigger: Vector3 | null): void {

    world.sendMessage("§6The jailbreak succeeded!");

    openJailDoor(doorTrigger);

    for (const player of rescuers) {

        try {
            addCoins(player, JAILBREAK.rescueReward);
            player.sendMessage(`§a+${JAILBREAK.rescueReward} coins for the rescue!`);
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not reward ${player.name}: ${error}`);
        }
    }

    // Free every prisoner currently held at the jail.
    const prisoners = world.getAllPlayers().filter((player) => player.hasTag("in_jail"));

    for (const prisoner of prisoners) {

        try {

            prisoner.removeTag("in_jail");
            prisoner.addTag("escort_vulnerable");
            escortOrigin.set(prisoner.name, jailLocation);

            clearBounty(prisoner);

            prisoner.sendMessage(
                "§eYou've been freed! Get away from the jail before law catches you."
            );

        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not free ${prisoner.name}: ${error}`);
        }
    }

    successfulHits = 0;
    contributors = new Set();

    if (failTimeoutId !== null) {
        system.clearRun(failTimeoutId);
        failTimeoutId = null;
    }
}

function failBreakout(): void {

    world.sendMessage("§cThe breakout attempt was abandoned!");

    sweetSpotTarget = null;

    for (const player of contributors) {

        try {
            player.addEffect("weakness", JAILBREAK.failWeaknessTicks, {
                amplifier: JAILBREAK.failWeaknessAmplifier,
                showParticles: false
            });

            player.sendMessage("§cYou feel weakened from the failed attempt.");
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not apply weakness to ${player.name}: ${error}`);
        }
    }

    successfulHits = 0;
    contributors = new Set();
    failTimeoutId = null;
}

/**
 * Checked both before opening the menu and again when they actually
 * click Pick the Lock — their eligibility could change in the few
 * seconds the menu was open.
 */
function checkEligibility(player: Player): { eligible: boolean; message: string | null } {

    if (!player.hasTag("outlaw")) {
        return { eligible: false, message: "§cOnly outlaws can attempt this." };
    }

    if (player.hasTag("eliminated")) {
        return { eligible: false, message: null };
    }

    if (!TESTING_MODE && player.hasTag("in_jail")) {
        return { eligible: false, message: "§cYou can't pick your own lock — you need help." };
    }

    if (!isJailOccupied()) {
        return { eligible: false, message: "§7No one is currently jailed." };
    }

    return { eligible: true, message: null };
}

function showSliderChallenge(player: Player): void {

    const check = checkEligibility(player);

    if (!check.eligible) {
        if (check.message) player.sendMessage(check.message);
        return;
    }

    // Roll the hidden target once per "round" — it persists across
    // misses so repeated pings actually mean something.
    if (sweetSpotTarget === null) {
        sweetSpotTarget = Math.random() * 100;
    }

    const form = new ModalFormData()
        .title("§6Pick the Lock")
        .slider("§7Turn the pick... listen for the ping.", 0, 100, { valueStep: 1, defaultValue: 50 });

    form.show(player).then((response) => {

        if (response.canceled) return;

        resolveLockpickAttempt(player, response.formValues![0] as number);

    }).catch((error) => {
        world.sendMessage(`§c[JAILBREAK ERROR] Slider failed for ${player.name}: ${error}`);
    });
}

function resolveLockpickAttempt(player: Player, sliderValue: number): void {

    const check = checkEligibility(player);

    if (!check.eligible) {
        if (check.message) player.sendMessage(check.message);
        return;
    }

    // Per-player cooldown so one person can't brute-force it by
    // spamming submissions. Still reopens — by the time a human
    // submits again the cooldown will likely have passed anyway.
    const nowTick = system.currentTick;
    const lastTick = lastClickTick.get(player.name) ?? -Infinity;

    if (nowTick - lastTick < JAILBREAK.attemptCooldownTicks) {
        showSliderChallenge(player);
        return;
    }

    lastClickTick.set(player.name, nowTick);

    const jail = getCurrentJail();

    if (!jail) return;

    if (getLawNear(jail, JAILBREAK.lawBlockRadius).length > 0) {
        player.sendMessage("§cLaw is nearby — you can't work on the lock right now!");
        showSliderChallenge(player);
        return;
    }

    const dist = Math.abs(sliderValue - sweetSpotTarget!);

    if (dist > JAILBREAK.sweetSpotTolerance) {

        // Miss — ping pitch rises the closer they were, giving real
        // hot/cold feedback without revealing the number.
        const proximity = Math.max(0, 1 - dist / 50); // 0 (far) to 1 (very close)
        const pitch = 0.5 + proximity * 1.5; // 0.5 (low/cold) to 2.0 (high/hot)

        try {
            player.playSound(PING_SOUND, { pitch, volume: 1 });
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not play ping for ${player.name}: ${error}`);
        }

        player.sendMessage("§7...no luck. Listen closely and try again.");
        showSliderChallenge(player);
        return;
    }

    // Hit.
    try {
        player.playSound(SUCCESS_SOUND, { pitch: 1, volume: 1 });
    } catch (error) {
        world.sendMessage(`§c[JAILBREAK ERROR] Could not play success sound for ${player.name}: ${error}`);
    }

    sweetSpotTarget = null; // next attempt rolls a fresh target

    successfulHits++;
    contributors.add(player);

    player.sendMessage(`§aFound it! §7Correct picks: §e${successfulHits}/${JAILBREAK.hitsToUnlock}`);

    // Reset the failure timer on every successful hit.
    if (failTimeoutId !== null) {
        system.clearRun(failTimeoutId);
    }

    failTimeoutId = system.runTimeout(() => {
        failTimeoutId = null;
        failBreakout();
    }, JAILBREAK.failTimeoutTicks);

    if (successfulHits >= JAILBREAK.hitsToUnlock) {
        succeedBreakout([...contributors], jail, getCurrentDoorTrigger());
    } else {
        showSliderChallenge(player);
    }
}

// Run this from a command block (e.g. wired to a lever at the
// jail), set to "Execute as Initiator" so it runs as the player:
// scriptevent bounty:lockpick
onScriptEvent("bounty:lockpick", (player) => {
    if (!player) return;
    showSliderChallenge(player);
});

// scriptevent bounty:test_capture — instantly captures YOU. Skips
// needing a law player to actually catch you, so combined with
// TESTING_MODE above, you can test the entire capture → lockpick →
// escort loop completely alone.
onScriptEvent("bounty:test_capture", (player) => {

    if (!player) return;

    player.addTag("jailed");

    // Same ordering requirement as jail.ts's real capture path: roll
    // the jail site before this player counts as occupying it.
    const jailLocation = assignJailForNewPrisoner();

    player.addTag("in_jail");

    system.run(() => {
        player.teleport(jailLocation);
        player.sendMessage("§7[TEST] You've been sent to jail for testing.");
    });
});

onTick("jailbreak:escort", (ctx) => {

    for (const player of ctx.players) {

        if (!player.hasTag("escort_vulnerable")) continue;

        const origin = escortOrigin.get(player.name);

        // If we somehow lost the origin (e.g. a script reload),
        // don't trap them vulnerable forever — let them go.
        const reachedSafety = !origin || distance(player.location, origin) >= JAILBREAK.escortSafeDistance;

        if (reachedSafety) {
            player.removeTag("escort_vulnerable");
            escortOrigin.delete(player.name);
            player.sendMessage("§aYou made it to safety!");
            continue;
        }

        try {
            player.addEffect("weakness", JAILBREAK.escortEffectTicks, { amplifier: 0, showParticles: false });
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not apply weakness to ${player.name}: ${error}`);
        }

        try {
            player.addEffect("slowness", JAILBREAK.escortEffectTicks, { amplifier: 0, showParticles: false });
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not apply slowness to ${player.name}: ${error}`);
        }
    }
});

registerSystem({
    name: "jailbreak",
    ownedTags: ["escort_vulnerable"],
    reset() {
        successfulHits = 0;
        contributors = new Set();
        sweetSpotTarget = null;
        lastClickTick.clear();
        escortOrigin.clear();

        if (failTimeoutId !== null) {
            system.clearRun(failTimeoutId);
            failTimeoutId = null;
        }
    }
});
