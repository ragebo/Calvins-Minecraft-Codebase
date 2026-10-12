// Shared by the melee tests (tasks/melee): the log capture, a fresh world, and one hit as the engine delivers it.
import { fake, world, system, load } from "./helpers.mjs";

export const { MELEE } = await load("config/balance.js");
await load("systems/melee.js");
const { listSystems } = await load("core/registry.js");

export const lines = [];
const realWarn = console.warn;
console.warn = (...args) => lines.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

export const meleeLines = () => lines.filter((l) => l.startsWith("[melee]"));
export const resetMelee = () => listSystems().find((s) => s.name === "melee").reset();
export const debug = (on) => system.afterEvents.scriptEventReceive.emit({ id: "rae:melee_debug", sourceEntity: fake.makePlayer("Debugger"), message: on ? "on" : "off" });

/** A new world with the melee state cleared and its logging off. */
export function fresh() {
    fake.reset();
    resetMelee();
    debug(false);
    lines.length = 0;
}

/** One melee hit as the engine delivers it: the before event (restricted, so a forbidden call throws), then the after event. */
export function hit({ attacker, target, cause = "entityAttack", damage = 1, dealt, afterToo = true }) {
    const event = { cancel: false, damage, hurtEntity: target, damageSource: { cause, damagingEntity: attacker } };
    fake.strictBefore = true;
    try { world.beforeEvents.entityHurt.emit(event); } finally { fake.strictBefore = false; }
    if (afterToo && !event.cancel) world.afterEvents.entityHurt.emit({ damage: dealt ?? event.damage, hurtEntity: target, damageSource: event.damageSource });
    return event;
}

/** The target's death, as the engine announces it. */
export function dies(target, killer) {
    world.afterEvents.entityDie.emit({ deadEntity: target, damageSource: { cause: "entityAttack", damagingEntity: killer } });
}

export const armed = (name, weapon) => fake.makePlayer(name, { holding: MELEE.weapons[weapon].id });
export { fake, world, system };
