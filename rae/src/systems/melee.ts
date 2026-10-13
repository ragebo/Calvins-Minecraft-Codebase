import { EntityDamageCause, EntitySwingSource, world, system, type Player } from "@minecraft/server";
import { honored } from "../logic/melee.js";
import { onScriptEvent } from "../core/events.js";
import { warn } from "../core/log.js";
import { MELEE } from "../config/balance.js";
import { axeHit, axeSwung, beginFinish, finishLanded, finishReading, heldWeapon, meleeTrace, noteSet, reportOnce, rollBatonStun, setMeleeDebug, startBleed, stun, sweepAxe, takeSet } from "../core/melee.js";
import { format, tell } from "../core/ui.js";

/**
 * The melee weapons (the plan is tasks/melee/plan.md; the numbers are MELEE in config/balance.ts).
 *
 * One listener on the game's "about to hurt" event sets the damage of a player's melee hit when the item in their hand is one of the five.
 * That event is a restricted "before" event: it may read anything and change its own `damage`, but a call that changes the world throws,
 * so this file does nothing else inside it. Whether the real game honors a number written there is not known yet
 * (docs/test-cards/MELEE.md asks): the after event compares what was dealt with what was set, and says so once if they differ.
 *
 * A hit counts as melee when a PLAYER caused it as an attack ("entityAttack"). The script's own damage (the knife's bleed) uses another
 * cause on purpose, so it is never rewritten. A gun's shot is an attack too, but it is fired from a held gun, which is not one of the five.
 */

const SOURCE = "melee";
const USAGE = "Use rae:melee_debug on or rae:melee_debug off.";

let warnedIgnored = false;
let warnedCancel = false;

function listen(label: string, subscribe: () => unknown): void {
    try {
        subscribe();
    } catch (err) {
        warn(SOURCE, `could not listen for ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

listen("the hurt event", () => world.beforeEvents.entityHurt.subscribe((event) => {
    try {
        const source = event.damageSource;
        if (source.cause !== EntityDamageCause.entityAttack) return;

        const attacker = source.damagingEntity;
        if (attacker?.typeId !== "minecraft:player") return;

        const weapon = heldWeapon(attacker as Player);
        if (!weapon) return;

        // The machete finishes a target at three hearts or less: the game is told a number nothing survives, and a follow-up kills what did.
        const reading = weapon.key === "machete" ? finishReading(event.hurtEntity) : undefined;
        if (reading) {
            event.damage = MELEE.machete.finishDamage;
            noteSet(event.hurtEntity.id, { weapon, set: event.damage, tick: system.currentTick, finish: true });
            meleeTrace(`machete: finishing blow on ${event.hurtEntity.typeId} at ${reading.health} of ${reading.max} health`);
            beginFinish(event.hurtEntity);
            return;
        }

        // The axe has a cooldown, and an attack that sweeps the others in front of it.
        if (weapon.key === "axe") {
            const verdict = axeHit(attacker as Player, event.hurtEntity, system.currentTick);
            if (verdict.cancel) {
                event.cancel = true;
                noteSet(event.hurtEntity.id, { weapon, set: 0, tick: system.currentTick, cancelled: true });
                return;
            }
            event.damage = weapon.damage;
            noteSet(event.hurtEntity.id, { weapon, set: weapon.damage, tick: system.currentTick, sweep: verdict.sweep });
            return;
        }

        event.damage = weapon.damage;
        noteSet(event.hurtEntity.id, { weapon, set: weapon.damage, tick: system.currentTick });
    } catch (err) {
        reportOnce("the hurt hook", err);
    }
}));

listen("the hurt event, after", () => world.afterEvents.entityHurt.subscribe((event) => {
    try {
        const entry = takeSet(event.hurtEntity.id);
        if (!entry) return;

        meleeTrace(`${entry.weapon.key} hit: set ${entry.set}, dealt ${event.damage}`);

        // A hit that was cancelled should never have been reported as a hurt: the game did not honor the cancel.
        if (entry.cancelled) {
            if (warnedCancel) return;
            warnedCancel = true;
            warn(SOURCE, "the game reported a hurt for a hit that was cancelled (an axe in its cooldown): it ignored the cancel, so a click in the cooldown still lands. docs/test-cards/MELEE.md says how to tell.");
            return;
        }

        // A finishing blow is set far above any health, so "dealt" is not the number set and says nothing about the game ignoring it.
        if (entry.finish) {
            finishLanded(event.hurtEntity.id);
            return;
        }

        // An axe hit that began an attack: the others in front of it take their share now that the hit has landed.
        if (entry.sweep && event.damageSource.damagingEntity?.typeId === "minecraft:player") sweepAxe(event.damageSource.damagingEntity as Player, system.currentTick);

        // A baton hit that landed may stun. (A hit that dealt nothing, because it was blocked, does not.)
        if (entry.weapon.key === "baton" && event.damage > 0 && rollBatonStun()) stun(event.hurtEntity);

        // A knife hit that landed starts a bleed. (The bleed's own damage never gets here: it is not an attack, so no number was set for it.)
        const attacker = event.damageSource.damagingEntity;
        if (entry.weapon.key === "knife" && event.damage > 0 && attacker?.typeId === "minecraft:player") {
            startBleed(event.hurtEntity, attacker as Player, system.currentTick);
        }

        if (honored(entry.set, event.damage) || warnedIgnored) return;
        warnedIgnored = true;
        warn(SOURCE, `the ${entry.weapon.key} was set to ${entry.set} but the game dealt ${event.damage}: either it ignored the hurt event's damage, or armor or an effect changed it. docs/test-cards/MELEE.md says how to tell.`);
    } catch (err) {
        reportOnce("the after-hurt check", err);
    }
}));

// A left-click swing with an axe. A tick later (so the hit that goes with it can have come first) the swing is looked at.
listen("swings", () => world.afterEvents.playerSwingStart.subscribe((event) => {
    if (event.swingSource !== EntitySwingSource.Attack || heldWeapon(event.player)?.key !== "axe") return;

    const player = event.player;
    system.runTimeout(() => axeSwung(player), MELEE.axe.swingDelayTicks);
}));

onScriptEvent("rae:melee_debug", (player, message) => {
    const argument = message.trim().toLowerCase();

    if (argument !== "on" && argument !== "off") {
        if (player) tell(player, format("warn", USAGE));
        else warn(SOURCE, USAGE);
        return;
    }

    setMeleeDebug(argument === "on");
    if (player) tell(player, format("ok", argument === "on" ? "Melee logging on: each weapon hit goes to the content log." : "Melee logging off."));
});
