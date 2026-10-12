import { test } from "node:test";
import { fake, world, system, load, checks } from "./helpers.mjs";

// The melee weapons (tasks/melee/plan.md, Task 2): the one hook on the game's "about to hurt" event that sets a weapon's damage,
// and the diagnostic that says whether the game honored the number. Whether the real game honors a number written to a
// before-hurt event is NOT known yet (docs/test-cards/MELEE.md asks it), so these tests prove the code's side: it sets the
// number, leaves everything else alone, runs inside the engine's restricted before-event mode without touching a forbidden
// call, and reports clearly when the number did not take.

const { MELEE } = await load("config/balance.js");
await load("systems/melee.js");
const { listSystems } = await load("core/registry.js");

const WEAPONS = Object.entries(MELEE.weapons);
const EXPECTED = { knife: 2, machete: 4, baton: 3, axe: 6, sledgehammer: 8 };

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => lines.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });
const meleeLines = () => lines.filter((l) => l.startsWith("[melee]"));

const resetMelee = () => listSystems().find((s) => s.name === "melee").reset();
const scriptEvent = (message, source) => system.afterEvents.scriptEventReceive.emit({ id: "rae:melee_debug", sourceEntity: source, message });

function fresh() {
    fake.reset();
    resetMelee();
    scriptEvent("off", fake.makePlayer("Setup"));
    lines.length = 0;
}

/** One hit as the engine delivers it: the before event (restricted, so a forbidden call throws), then the after event. */
function hit({ attacker, target, cause = "entityAttack", damage = 1, projectile, dealt, afterToo = true }) {
    const event = { cancel: false, damage, hurtEntity: target, damageSource: { cause, damagingEntity: attacker, damagingProjectile: projectile } };
    fake.strictBefore = true;
    try { world.beforeEvents.entityHurt.emit(event); } finally { fake.strictBefore = false; }
    if (afterToo) world.afterEvents.entityHurt.emit({ damage: dealt ?? event.damage, hurtEntity: target, damageSource: event.damageSource });
    return event;
}

test("the five weapons are on the table with the owner's numbers", () => {
    const { check, done } = checks();
    check("exactly five weapons", WEAPONS.length === 5, WEAPONS.map(([k]) => k).join(","));
    for (const [key, number] of Object.entries(EXPECTED)) check(`${key} deals ${number}`, MELEE.weapons[key]?.damage === number, String(MELEE.weapons[key]?.damage));
    done();
});

test("a hit with each weapon deals exactly its number, on a mob and on a player", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const victim = fake.makePlayer("Victim");
    for (const [key, weapon] of WEAPONS) {
        const attacker = fake.makePlayer(`Wielder-${key}`, { holding: weapon.id });
        const onMob = hit({ attacker, target: mob, damage: 1 });
        const onPlayer = hit({ attacker, target: victim, damage: 1 });
        check(`${key} on a mob`, onMob.damage === EXPECTED[key], String(onMob.damage));
        check(`${key} on a player`, onPlayer.damage === EXPECTED[key], String(onPlayer.damage));
        check(`${key} leaves the hit standing`, onMob.cancel === false && onPlayer.cancel === false);
    }
    check("the restricted before-event mode never threw (the handler would have reported it)", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("a hit with anything else is left exactly as it was", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const other = (holding) => hit({ attacker: fake.makePlayer(`P-${holding ?? "fist"}`, { holding }), target: mob, damage: 5 }).damage;

    check("a fist", other(undefined) === 5);
    check("a revolver", other("bountysys:revolver") === 5);
    check("a vanilla sword", other("minecraft:iron_sword") === 5);
    check("a vanilla axe", other("minecraft:diamond_axe") === 5);

    const knifeHolder = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });
    check("a non-player attacker", hit({ attacker: fake.makeEntity({ typeId: "minecraft:zombie" }), target: mob, damage: 5 }).damage === 5);
    check("nobody attacking (fall, fire, a command)", hit({ attacker: undefined, target: mob, damage: 5, cause: "fall" }).damage === 5);
    check("an arrow from a knife holder", hit({ attacker: knifeHolder, target: mob, damage: 5, cause: "projectile", projectile: fake.makeEntity({ typeId: "minecraft:arrow" }) }).damage === 5);
    check("the script's own override damage (the bleed) from a knife holder", hit({ attacker: knifeHolder, target: mob, damage: 5, cause: "override" }).damage === 5);
    check("nothing was reported", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("the weapon is read from the main hand at the moment of the hit, never remembered", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const player = fake.makePlayer("Swapper", { holding: MELEE.weapons.knife.id });

    check("holding the knife", hit({ attacker: player, target: mob, damage: 1 }).damage === 2);
    player.holding = MELEE.weapons.machete.id;
    check("swapped to the machete mid-fight", hit({ attacker: player, target: mob, damage: 1 }).damage === 4);
    player.holding = "minecraft:stick";
    check("swapped to a stick", hit({ attacker: player, target: mob, damage: 1 }).damage === 1);
    player.holding = undefined;
    check("swapped to an empty hand", hit({ attacker: player, target: mob, damage: 1 }).damage === 1);
    player.holding = MELEE.weapons.sledgehammer.id;
    check("and back to a weapon", hit({ attacker: player, target: mob, damage: 1 }).damage === 8);
    done();
});

test("with rae:melee_debug on the pipeline is logged; off, nothing is", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const op = fake.makePlayer("Op");
    const knifer = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });

    hit({ attacker: knifer, target: mob, damage: 1 });
    check("off by default: a melee hit logs nothing", meleeLines().length === 0, meleeLines().join(" | "));

    scriptEvent("on", op);
    lines.length = 0;
    hit({ attacker: knifer, target: mob, damage: 1 });
    const log = meleeLines().join("\n");
    check("on: the weapon is named", log.includes("knife"), log);
    check("on: the number it set is logged", /set 2\b/.test(log), log);
    check("on: the number the game dealt is logged", /dealt 2\b/.test(log), log);

    lines.length = 0;
    hit({ attacker: fake.makePlayer("Fist"), target: mob, damage: 1 });
    check("on: a hit with nothing special is not logged (no noise)", meleeLines().length === 0, meleeLines().join(" | "));

    scriptEvent("off", op);
    lines.length = 0;
    hit({ attacker: knifer, target: mob, damage: 1 });
    check("off again: silent", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("rae:melee_debug with something else says how to use it and changes nothing", () => {
    const { check, done } = checks();
    fresh();
    const op = fake.makePlayer("Op");
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const knifer = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });
    const traced = () => { lines.length = 0; hit({ attacker: knifer, target: mob, damage: 1 }); return meleeLines().length > 0; };

    scriptEvent("maybe", op);
    check("the player is told the usage", op.messages.some((m) => m.includes("on") && m.includes("off")), JSON.stringify(op.messages));
    check("off stays off", !traced());

    scriptEvent("on", op);
    scriptEvent("maybe", op);
    check("on stays on", traced());
    done();
});

test("when the game dealt a different number than was set, ONE warning says so, once per script load", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const machete = fake.makePlayer("Machete", { holding: MELEE.weapons.machete.id });

    hit({ attacker: machete, target: mob, damage: 1, dealt: 4 });
    check("a honored number is silent", meleeLines().length === 0, meleeLines().join(" | "));

    hit({ attacker: machete, target: mob, damage: 1, dealt: 1 });
    check("an ignored number warns once", meleeLines().length === 1, meleeLines().join(" | "));
    check("the warning names the weapon and both numbers", /machete/.test(meleeLines()[0]) && /4/.test(meleeLines()[0]) && /1/.test(meleeLines()[0]), meleeLines()[0]);

    hit({ attacker: machete, target: mob, damage: 1, dealt: 1 });
    hit({ attacker: machete, target: mob, damage: 1, dealt: 2 });
    check("never again", meleeLines().length === 1, meleeLines().join(" | "));
    done();
});

test("an after-hurt event the hook did not set a number for is ignored", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    hit({ attacker: fake.makePlayer("Fist"), target: mob, damage: 3, dealt: 99 });
    check("a fist hit whose damage differs from anything is not a warning", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("a round reset clears the per-target records", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const knife = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });

    hit({ attacker: knife, target: mob, damage: 1, afterToo: false });       // a number was set, the after event has not come yet
    resetMelee();
    world.afterEvents.entityHurt.emit({ damage: 7, hurtEntity: mob, damageSource: { cause: "entityAttack", damagingEntity: knife } });
    check("a record from before the reset is gone, so the late after event compares with nothing", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("a hit whose target or attacker became invalid never breaks the hook", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const knife = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });
    mob.remove();
    let threw = false;
    try { hit({ attacker: knife, target: mob, damage: 1 }); } catch { threw = true; }
    check("no exception reaches the engine", !threw);
    done();
});

test("a mob that was handed a melee weapon (by a command) is not rewritten: only players wield them", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const zombie = fake.makeEntity({ typeId: "minecraft:zombie" });
    zombie.getComponent = (id) => id === "minecraft:equippable"
        ? { getEquipmentSlot: () => ({ getItem: () => ({ typeId: MELEE.weapons.sledgehammer.id }) }) }
        : undefined;

    check("a zombie with a sledgehammer deals what the game says", hit({ attacker: zombie, target: mob, damage: 3 }).damage === 3);
    done();
});

test("an attacker the engine can no longer read leaves the hit as it was, silently", () => {
    const { check, done } = checks();
    fresh();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const gone = fake.makePlayer("Gone", { holding: MELEE.weapons.knife.id });
    gone.remove();

    let threw = false;
    let event;
    try { event = hit({ attacker: gone, target: mob, damage: 5 }); } catch { threw = true; }
    check("no exception reaches the engine", !threw);
    check("the hit is untouched", event?.damage === 5, String(event?.damage));
    check("and it is not worth a report", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("a failure inside the hook is reported once and never thrown at the engine", () => {
    const { check, done } = checks();
    fresh();
    const broken = () => ({ cancel: false, damage: 1, hurtEntity: fake.makeEntity({}), get damageSource() { throw new Error("the engine refused"); } });

    let threw = false;
    try {
        world.beforeEvents.entityHurt.emit(broken());
        world.beforeEvents.entityHurt.emit(broken());
    } catch { threw = true; }

    check("no exception reaches the engine", !threw);
    check("exactly one report for two failures", meleeLines().length === 1, meleeLines().join(" | "));
    check("it says which hook and why", /the hurt hook/.test(meleeLines()[0] ?? "") && /the engine refused/.test(meleeLines()[0] ?? ""), meleeLines()[0]);
    done();
});

test("a reset forgets a number whose after event never came", () => {
    const { check, done } = checks();
    fresh();
    scriptEvent("on", fake.makePlayer("Op"));
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    const knife = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });
    const late = () => world.afterEvents.entityHurt.emit({ damage: 2, hurtEntity: mob, damageSource: { cause: "entityAttack", damagingEntity: knife } });

    hit({ attacker: knife, target: mob, damage: 1, afterToo: false });
    lines.length = 0;
    late();
    check("without a reset, the late after event finds the number it was set to", meleeLines().some((l) => /set 2/.test(l)), meleeLines().join(" | "));

    hit({ attacker: knife, target: mob, damage: 1, afterToo: false });
    resetMelee();
    lines.length = 0;
    late();
    check("after a reset it finds nothing", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("unreported numbers cannot pile up: past 64 the stale ones go, and the fresh ones stay", () => {
    const { check, done } = checks();
    fresh();
    scriptEvent("on", fake.makePlayer("Op"));
    const knife = fake.makePlayer("Knifer", { holding: MELEE.weapons.knife.id });
    const mobs = Array.from({ length: 66 }, () => fake.makeEntity({ typeId: "minecraft:pillager" }));
    const reported = (mob) => { lines.length = 0; world.afterEvents.entityHurt.emit({ damage: 2, hurtEntity: mob, damageSource: { cause: "entityAttack", damagingEntity: knife } }); return meleeLines().length > 0; };

    for (const mob of mobs.slice(0, 63)) hit({ attacker: knife, target: mob, damage: 1, afterToo: false });
    fake.advance(10);
    hit({ attacker: knife, target: mobs[63], damage: 1, afterToo: false });      // the 64th, fresh
    hit({ attacker: knife, target: mobs[64], damage: 1, afterToo: false });      // the 65th: the table is full, so the stale 63 go

    check("an old number is gone", !reported(mobs[0]));
    check("the fresh one beside it stayed", reported(mobs[63]));
    check("the newest is there", reported(mobs[64]));

    // And when everything is fresh and the table is full, it starts over rather than growing.
    resetMelee();
    for (const mob of mobs) hit({ attacker: knife, target: mob, damage: 1, afterToo: false });
    check("a full table of fresh numbers starts over: the first is gone", !reported(mobs[0]));
    check("and the last one is kept", reported(mobs[65]));
    done();
});
