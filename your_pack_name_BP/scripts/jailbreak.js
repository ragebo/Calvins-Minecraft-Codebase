import { world, system } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { isJailOccupied, getCurrentJail, getCurrentDoorTrigger, assignJailForNewPrisoner } from "./jail.js";

//====================================
// TESTING
//====================================

// Flip to true while testing solo. Normally a player who's
// currently jailed can't count toward rescuing themselves — with
// this on, they can. That means you can test the ENTIRE loop
// alone: get captured, then run scriptevent bounty:lockpick as
// yourself. Set back to false before a real game.
const TESTING_MODE = false;

//====================================
// LOCKPICK SETTINGS
//====================================

// Distance from the jail that still counts as "law showed up and
// blocked this click" — checked at the moment of each click, not
// on a timer, so this never runs unless someone actually clicks.
const LOCKPICK_RADIUS = 4;

// How many correct sweet-spot hits are needed to unlock.
const HITS_TO_UNLOCK = 2;

// The slider goes 0-100. A hidden target rolls somewhere in that
// range; landing within TOLERANCE of it counts as a hit. The
// SAME target persists across misses, so repeated pings actually
// help you narrow in on it — it only re-rolls after a hit.
const SWEET_SPOT_TOLERANCE = 10;

// Vanilla sound IDs — real in-game assets, no custom sounds
// needed. random.orb is the classic XP-pickup ping, used here as
// the "how close are you" feedback; its pitch is what actually
// carries the hot/cold information.
const PING_SOUND = "random.orb";
const SUCCESS_SOUND = "random.levelup";

// Minimum real time between attempts counting FROM THE SAME
// PLAYER, so one person can't just brute-force the slider by
// spamming submissions. Doesn't block other players from
// attempting in the meantime.
const CLICK_COOLDOWN_TICKS = 15; 

// If no attempt lands anywhere for this long, the whole thing
// fails. This is a real-time countdown that RESETS on every hit
// — not a polling loop, so it costs nothing while idle.
const FAIL_TIMEOUT_TICKS = 600; // 30 seconds

const FAIL_WEAKNESS_DURATION = 600; // 30 seconds
const FAIL_WEAKNESS_AMPLIFIER = 0;

const RESCUE_REWARD_COINS = 50; // flat bonus per unique contributor at success

//====================================
// DOOR
//====================================

//====================================
// ESCORT SETTINGS
//====================================

// How far a freed prisoner needs to get from the jail they were
// held at before they're considered safe. No longer tied to
// OUTLAW_SPAWNS — just distance from wherever they escaped.
const ESCORT_SAFE_DISTANCE = 20;

// Refreshed every check so effects never actually run out
// mid-escort — same pattern as your saturation/health boost.
const ESCORT_EFFECT_DURATION = 60;

//====================================
// STATE
//====================================

let successfulHits = 0;
let contributors = new Set();
let failTimeoutId = null;
let sweetSpotTarget = null; // null = needs to be rolled on the next attempt
const lastClickTick = new Map(); // player name -> tick, for the cooldown
const escortOrigin = new Map(); // player name -> jail location at the moment they were freed

//====================================
// HELPERS
//====================================

function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getLawNear(point, radius) {
    return world.getAllPlayers().filter(player =>
        player.hasTag("law") &&
        !player.hasTag("eliminated") &&
        distance(player.location, point) <= radius
    );
}

// Places a redstone block at whichever jail's doorTrigger point
// is currently active (from jail.js), powering whatever redstone
// contraption actually opens that jail's door.
function openJailDoor(doorTrigger) {

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

//====================================
// SUCCESS / FAILURE
//====================================

function succeedBreakout(rescuers, jailLocation, doorTrigger) {

    world.sendMessage("§6The jailbreak succeeded!");

    openJailDoor(doorTrigger);

    const coinsObj = world.scoreboard.getObjective("coins");
    const bountyObj = world.scoreboard.getObjective("bounty");

    for (const player of rescuers) {

        try {

            if (coinsObj) {
                coinsObj.setScore(
                    player,
                    (coinsObj.getScore(player) ?? 0) + RESCUE_REWARD_COINS
                );
            }

            player.sendMessage(`§a+${RESCUE_REWARD_COINS} coins for the rescue!`);

        } catch (error) {

            world.sendMessage(`§c[JAILBREAK ERROR] Could not reward ${player.name}: ${error}`);

        }
    }

    // Free every prisoner currently held at the jail.
    const prisoners = world.getAllPlayers().filter(player => player.hasTag("in_jail"));

    for (const prisoner of prisoners) {

        try {

            prisoner.removeTag("in_jail");
            prisoner.addTag("escort_vulnerable");
            escortOrigin.set(prisoner.name, jailLocation);

            if (bountyObj) bountyObj.setScore(prisoner, 0);

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

function failBreakout() {

    world.sendMessage("§cThe breakout attempt was abandoned!");

    sweetSpotTarget = null;

    for (const player of contributors) {

        try {

            player.addEffect("weakness", FAIL_WEAKNESS_DURATION, {
                amplifier: FAIL_WEAKNESS_AMPLIFIER,
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

//====================================
// LOCKPICK — triggered by scriptevent, not a timer
//====================================

// Run this from a command block (e.g. wired to a lever at the
// jail), set to "Execute as Initiator" so it runs as the player:
// scriptevent bounty:lockpick
system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:lockpick") return;

    const player = event.sourceEntity;

    if (!player || player.typeId !== "minecraft:player") return;

    showSliderChallenge(player);

});

// Checked both before opening the menu (no point showing it if
// they can't act) and again when they actually click Pick the
// Lock (their eligibility could change in the few seconds the
// menu was open — someone else could free the prisoner first).
function checkEligibility(player) {

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

function showSliderChallenge(player) {

    const check = checkEligibility(player);

    if (!check.eligible) {
        if (check.message) player.sendMessage(check.message);
        return;
    }

    // Roll the hidden target once per "round" — it persists
    // across misses so repeated pings actually mean something.
    if (sweetSpotTarget === null) {
        sweetSpotTarget = Math.random() * 100;
    }

    const form = new ModalFormData()
        .title("§6Pick the Lock")
        .slider("§7Turn the pick... listen for the ping.", 0, 100, { valueStep: 1, defaultValue: 50 });

    form.show(player).then((response) => {

        if (response.canceled) return;

        resolveLockpickAttempt(player, response.formValues[0]);

    }).catch((error) => {

        world.sendMessage(`§c[JAILBREAK ERROR] Slider failed for ${player.name}: ${error}`);

    });
}

function resolveLockpickAttempt(player, sliderValue) {

    const check = checkEligibility(player);

    if (!check.eligible) {
        // Not eligible anymore (freed already, eliminated, etc.) —
        // nothing to reopen.
        if (check.message) player.sendMessage(check.message);
        return;
    }

    // Per-player cooldown so one person can't brute-force it by
    // spamming submissions. Still reopens — by the time a human
    // submits again the cooldown will likely have passed anyway.
    const nowTick = system.currentTick;
    const lastTick = lastClickTick.get(player.name) ?? -Infinity;

    if (nowTick - lastTick < CLICK_COOLDOWN_TICKS) {
        showSliderChallenge(player);
        return;
    }

    lastClickTick.set(player.name, nowTick);

    const jail = getCurrentJail();

    if (!jail) return;

    if (getLawNear(jail, LOCKPICK_RADIUS).length > 0) {
        player.sendMessage("§cLaw is nearby — you can't work on the lock right now!");
        showSliderChallenge(player);
        return;
    }

    const dist = Math.abs(sliderValue - sweetSpotTarget);

    if (dist > SWEET_SPOT_TOLERANCE) {

        // Miss — ping pitch rises the closer they were, giving
        // real hot/cold feedback without revealing the number.
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

    player.sendMessage(`§aFound it! §7Correct picks: §e${successfulHits}/${HITS_TO_UNLOCK}`);

    // Reset the failure timer on every successful hit.
    if (failTimeoutId !== null) {
        system.clearRun(failTimeoutId);
    }

    failTimeoutId = system.runTimeout(() => {
        failTimeoutId = null;
        failBreakout();
    }, FAIL_TIMEOUT_TICKS);

    if (successfulHits >= HITS_TO_UNLOCK) {
        succeedBreakout([...contributors], jail, getCurrentDoorTrigger());
    } else {
        showSliderChallenge(player);
    }
}

//====================================
// ESCORT VULNERABILITY
//====================================

system.runInterval(() => {

    for (const player of world.getAllPlayers()) {

        if (!player.hasTag("escort_vulnerable")) continue;

        const origin = escortOrigin.get(player.name);

        // If we somehow lost the origin (e.g. a script reload),
        // don't trap them vulnerable forever — let them go.
        const reachedSafety = !origin || distance(player.location, origin) >= ESCORT_SAFE_DISTANCE;

        if (reachedSafety) {

            player.removeTag("escort_vulnerable");
            escortOrigin.delete(player.name);
            player.sendMessage("§aYou made it to safety!");
            continue;
        }

        try {
            player.addEffect("weakness", ESCORT_EFFECT_DURATION, { amplifier: 0, showParticles: false });
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not apply weakness to ${player.name}: ${error}`);
        }

        try {
            player.addEffect("slowness", ESCORT_EFFECT_DURATION, { amplifier: 0, showParticles: false });
        } catch (error) {
            world.sendMessage(`§c[JAILBREAK ERROR] Could not apply slowness to ${player.name}: ${error}`);
        }
    }

}, 20);

//====================================
// TESTING COMMANDS
//====================================

// scriptevent bounty:test_capture — instantly captures YOU
// (must be run as the player, e.g. from a command block set to
// "Execute as Initiator"). Skips needing a law player to actually
// catch you, so combined with TESTING_MODE above, you can test
// the entire capture → lockpick → escort loop completely alone.
system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:test_capture") return;

    const player = event.sourceEntity;

    if (!player || player.typeId !== "minecraft:player") return;

    player.addTag("jailed");
    player.addTag("in_jail");

    const jailLocation = assignJailForNewPrisoner();

    system.run(() => {
        player.teleport(jailLocation);
        player.sendMessage("§7[TEST] You've been sent to jail for testing.");
    });
});

//====================================
// RESET (called at round start)
//====================================

export function resetJailbreak() {
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