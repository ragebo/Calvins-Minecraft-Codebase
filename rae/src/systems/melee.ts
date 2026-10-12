import { EntityDamageCause, world, system, type Player } from "@minecraft/server";
import { honored } from "../logic/melee.js";
import { onScriptEvent } from "../core/events.js";
import { warn } from "../core/log.js";
import { heldWeapon, meleeTrace, noteSet, reportOnce, setMeleeDebug, startBleed, takeSet } from "../core/melee.js";
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
