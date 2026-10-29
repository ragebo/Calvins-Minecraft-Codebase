import { world, system, type Player, type Vector3 } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { JAILBREAK, JAILS } from "../config/balance.js";
import { showForm } from "../core/forms.js";
import { completeBind, hasPendingBind, type Clicked } from "../core/jailbind.js";
import { getJail, holdsPrisoners, jailAtButton } from "../core/jailstore.js";
import { registerSystem } from "../core/registry.js";
import { onScriptEvent } from "../core/events.js";
import { onTick } from "../core/tick.js";
import { addCoins, clearBounty } from "../core/economy.js";
import { error, warn } from "../core/log.js";
import { playFor } from "../core/sound.js";
import { getRecord, getJailSite, update } from "../core/state.js";
import type { JailSite } from "../config/world.js";
import { lawPlayers, prisoners } from "../core/players.js";
import type { Jail } from "../logic/jails.js";

/**
 * Flip to true while testing solo. Normally a player who's currently
 * jailed can't count toward rescuing themselves — with this on, they
 * can. Set back to false before a real game.
 */
const TESTING_MODE = false;

const PING_SOUND = "random.orb";
const SUCCESS_SOUND = "random.levelup";

let successfulHits = 0;
// Player ids, not Player handles: a handle goes invalid when its player
// disconnects, an id stays readable. Ids are resolved to whoever is
// still online when the attempt is paid out or called off.
let contributors = new Set<string>();
let failTimeoutId: number | null = null;
let sweetSpotTarget: number | null = null; // null = needs to be rolled on the next attempt
const lastClickTick = new Map<string, number>(); // player id -> tick, for the cooldown
const escortOrigin = new Map<string, Vector3>(); // player id -> jail location at the moment they were freed

function distance(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Everyone connected right now. The one place this file asks the engine for the player list. */
function getOnlinePlayers(): Player[] {
    return world.getAllPlayers();
}

/**
 * The jail that holds prisoners, as it is NOW: the site kept in core/state is a copy taken at the capture, so if an operator has moved the jail or changed its
 * door since, the saved jail (found by the id the site carries) is what counts. A site with no id, or whose jail is gone, is used as it was taken.
 */
function activeSite(): JailSite | null {

    const site = getJailSite();

    if (!site) return null;

    const current = site.id !== undefined ? getJail(site.id) : undefined;

    if (!current) return site;

    return { id: current.id, jail: current.jail, ...(current.doorTrigger ? { doorTrigger: current.doorTrigger } : {}) };
}

function getLawNear(point: Vector3, radius: number): Player[] {
    return lawPlayers().filter((player) => distance(player.location, point) <= radius);
}

/**
 * Places a redstone block at whichever jail's doorTrigger point is
 * currently active, powering whatever redstone contraption actually
 * opens that jail's door.
 */
function openJailDoor(doorTrigger: Vector3 | undefined): void {

    // A jail with no door trigger frees its prisoners and opens nothing (its door is worked some other way): not an error.
    if (!doorTrigger) return;

    const dimension = world.getDimension("overworld");

    try {
        dimension.runCommand(
            `setblock ${doorTrigger.x} ${doorTrigger.y} ${doorTrigger.z} redstone_block`
        );
    } catch (err) {
        error("jailbreak", `Could not open the door: ${err}`);
    }
}

function succeedBreakout(rescuerIds: readonly string[], jailLocation: Vector3, doorTrigger: Vector3 | undefined): void {

    world.sendMessage("§6The jailbreak succeeded!");

    openJailDoor(doorTrigger);

    // One snapshot of who is online serves both lookups below. A rescuer
    // who disconnected since their pick has no live handle to pay any
    // more, so they are simply not in it and get skipped.
    const online = getOnlinePlayers();

    for (const player of online.filter((p) => rescuerIds.includes(p.id))) {

        try {
            addCoins(player, JAILBREAK.rescueReward);
            player.sendMessage(`§a+${JAILBREAK.rescueReward} coins for the rescue!`);
        } catch (err) {
            error("jailbreak", `Could not reward ${player.name}: ${err}`);
        }
    }

    // Free every prisoner currently held at the jail.
    const held = online.filter((player) => getRecord(player).inJail);

    for (const prisoner of held) {

        try {

            update(prisoner, { inJail: false, escortVulnerable: true });
            escortOrigin.set(prisoner.id, jailLocation);

            clearBounty(prisoner);

            prisoner.sendMessage(
                "§eYou've been freed! Get away from the jail before law catches you."
            );

        } catch (err) {
            error("jailbreak", `Could not free ${prisoner.name}: ${err}`);
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

    // Only contributors still online: anyone who disconnected since their
    // pick has no live handle to weaken.
    for (const player of getOnlinePlayers().filter((p) => contributors.has(p.id))) {

        try {
            player.addEffect("weakness", JAILBREAK.failWeaknessTicks, {
                amplifier: JAILBREAK.failWeaknessAmplifier,
                showParticles: false
            });

            player.sendMessage("§cYou feel weakened from the failed attempt.");
        } catch (err) {
            error("jailbreak", `Could not apply weakness to ${player.name}: ${err}`);
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

    const record = getRecord(player);

    if (record.role !== "outlaw") {
        return { eligible: false, message: "§cOnly outlaws can attempt this." };
    }

    if (record.eliminated) {
        return { eligible: false, message: null };
    }

    if (!TESTING_MODE && record.inJail) {
        return { eligible: false, message: "§cYou can't pick your own lock — you need help." };
    }

    if (prisoners().length === 0) {
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

    // Through showForm, which waits and tries again when the game says the player is busy (a form opened straight from a right-click, with food or a bow in hand, hits that).
    void showForm(player, form).then((response) => {

        if (!response || response.canceled || !response.formValues) return;

        resolveLockpickAttempt(player, response.formValues[0] as number);

    }).catch((err) => {
        error("jailbreak", `Slider failed for ${player.name}: ${err}`);
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
    const lastTick = lastClickTick.get(player.id) ?? -Infinity;

    if (nowTick - lastTick < JAILBREAK.attemptCooldownTicks) {
        showSliderChallenge(player);
        return;
    }

    lastClickTick.set(player.id, nowTick);

    const site = activeSite();

    if (!site) return;

    const jail = site.jail;

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

        playFor(player, { id: PING_SOUND, pitch, volume: 1 });

        player.sendMessage("§7...no luck. Listen closely and try again.");
        showSliderChallenge(player);
        return;
    }

    // Hit.
    playFor(player, { id: SUCCESS_SOUND, pitch: 1, volume: 1 });

    sweetSpotTarget = null; // next attempt rolls a fresh target

    successfulHits++;
    contributors.add(player.id);

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
        succeedBreakout([...contributors], jail, site.doorTrigger);
    } else {
        showSliderChallenge(player);
    }
}

// Run this from a command block (e.g. wired to a lever at the
// jail), set to "Execute as Initiator" so it runs as the player:
// scriptevent bounty:lockpick
// It works on whichever jail is holding prisoners. A jail's own buttons (below) are the in-game way: no command block needed.
onScriptEvent("bounty:lockpick", (player) => {
    if (!player) return;
    showSliderChallenge(player);
});

// ---------------------------------------------------------------------------------------------------------
// A jail's buttons: any block an operator has bound to a jail (core/jailforms.ts), right-clicked
// ---------------------------------------------------------------------------------------------------------

const lastPress = new Map<string, number>(); // player id -> tick, so one click reported twice opens one form

/**
 * A player pressed one of this jail's buttons. Prisoners are held in one jail at a time (the one the last capture chose), so a button of any other jail says
 * so instead of starting a pick for a lock nobody is behind.
 */
function pressJailButton(player: Player, jail: Jail): void {

    const check = checkEligibility(player);

    if (!check.eligible) {
        if (check.message) player.sendMessage(check.message);
        return;
    }

    if (!holdsPrisoners(jail.id)) {
        player.sendMessage(`§7No one is held in ${jail.name}.`);
        return;
    }

    showSliderChallenge(player);
}

try {
    world.beforeEvents.playerInteractWithBlock.subscribe((event) => {

        try {
            const player = event.player;
            const block = event.block;

            // An operator who has just pressed "bind a block" on a jail's screen: this click is the answer, whatever the block is.
            if (hasPendingBind(player)) {
                event.cancel = true;

                if (!event.isFirstEvent) return;

                const where = block.location;
                const clicked: Clicked = { dimensionId: block.dimension.id, x: where.x, y: where.y, z: where.z, typeId: block.typeId };

                system.run(() => {
                    try {
                        completeBind(player, clicked);
                    } catch (err) {
                        error("jailbreak", `Could not finish binding a block: ${err instanceof Error ? err.message : String(err)}`);
                    }
                });
                return;
            }

            const at = block.location;
            const jail = jailAtButton(block.dimension.id, at.x, at.y, at.z);

            if (!jail) return;

            // A jail that is switched off has no use for its buttons, unless it still holds prisoners (it was on when they were put there): then the click is left to the game.
            if (!jail.enabled && !holdsPrisoners(jail.id)) return;

            // The button only starts the pick: it does not also press, and a held click repeats the event every tick, so only the first counts.
            event.cancel = true;

            if (!event.isFirstEvent) return;

            const now = system.currentTick;

            if (now - (lastPress.get(player.id) ?? -Infinity) < JAILS.pressGapTicks) return;

            lastPress.set(player.id, now);

            system.run(() => {
                try {
                    if (player.isValid) pressJailButton(player, jail);
                } catch (err) {
                    error("jailbreak", `A jail button failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
        } catch (err) {
            error("jailbreak", `Could not read a click on a block: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
} catch (err) {
    warn("jailbreak", `Could not listen for jail buttons: ${err instanceof Error ? err.message : String(err)}`);
}

// (scriptevent bounty:test_capture, which jails you instantly so the whole
// capture → lockpick → escort loop can be tested alone with TESTING_MODE
// above, lives in jail.ts with the rest of the capture path.)

onTick("jailbreak:escort", (ctx) => {

    for (const player of ctx.players) {

        if (!getRecord(player).escortVulnerable) continue;

        const origin = escortOrigin.get(player.id);

        // If we somehow lost the origin (e.g. a script reload),
        // don't trap them vulnerable forever — let them go.
        const reachedSafety = !origin || distance(player.location, origin) >= JAILBREAK.escortSafeDistance;

        if (reachedSafety) {
            update(player, { escortVulnerable: false });
            escortOrigin.delete(player.id);
            player.sendMessage("§aYou made it to safety!");
            continue;
        }

        try {
            player.addEffect("weakness", JAILBREAK.escortEffectTicks, { amplifier: 0, showParticles: false });
        } catch (err) {
            error("jailbreak", `Could not apply weakness to ${player.name}: ${err}`);
        }

        try {
            player.addEffect("slowness", JAILBREAK.escortEffectTicks, { amplifier: 0, showParticles: false });
        } catch (err) {
            error("jailbreak", `Could not apply slowness to ${player.name}: ${err}`);
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
        lastPress.clear();
        escortOrigin.clear();

        if (failTimeoutId !== null) {
            system.clearRun(failTimeoutId);
            failTimeoutId = null;
        }
    }
});
