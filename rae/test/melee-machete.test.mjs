import { test } from "node:test";
import { checks } from "./helpers.mjs";
import { MELEE, fake, fresh, hit, armed, resetMelee, debug, lines, meleeLines } from "./melee-fixtures.mjs";
import { load } from "./helpers.mjs";

const { finishingNow } = await load("core/melee.js");

// The machete's finishing blow (tasks/melee/plan.md, Task 4): a hit on a target whose health is 30% of its maximum or less kills it,
// whatever its armor and effects. The hurt hook writes a huge damage number (the attacker stays the wielder), and one tick later a target
// that is somehow still alive is killed outright. Whether the real game honors the huge number, and whether a hit that Resistance
// absorbs completely still sends a hurt event, are for docs/test-cards/MELEE.md.

const M = MELEE.machete;
const mob = () => fake.makeEntity({ typeId: "minecraft:pillager" });

/** Gives an entity a health component that reads whatever `state` says, and counts how often it is killed. */
function withHealth(entity, state) {
    const original = entity.getComponent.bind(entity);
    entity.getComponent = (id) => id === "minecraft:health"
        ? { get currentValue() { return state.hp; }, get effectiveMax() { return state.max; }, resetToMaxValue() {} }
        : original(id);
    entity.kills = 0;
    const realKill = entity.kill.bind(entity);
    entity.kill = () => { entity.kills++; return realKill(); };
    return entity;
}

const swing = (target, options = {}) => hit({ attacker: options.attacker ?? armed("Machete", "machete"), target, damage: 1, ...options });

test("the finishing blow is on the table: three hearts of twenty, a huge number, one tick later", () => {
    const { check, done } = checks();
    check("30% of the maximum", M.finishFraction === 0.3);
    check("a damage no armor survives", M.finishDamage >= 1000);
    check("the follow-up is one tick later", M.followUpTicks === 1);
    check("a hit that sent no hurt event does not finish by default", M.killWithoutHurtEvent === false);
    done();
});

test("a target at 6 of 20 health is finished; at 6.5 or at full health it takes the machete's 4", () => {
    const { check, done } = checks();
    fresh();

    const low = withHealth(mob(), { hp: 6, max: 20 });
    const above = withHealth(mob(), { hp: 6.5, max: 20 });
    const full = withHealth(mob(), { hp: 20, max: 20 });
    const lowDamage = swing(low).damage;
    check("6 of 20 (exactly 30%)", lowDamage === M.finishDamage, String(lowDamage));
    check("6.5 of 20", swing(above).damage === 4);
    check("20 of 20", swing(full).damage === 4);
    check("1 of 20", swing(withHealth(mob(), { hp: 1, max: 20 })).damage === M.finishDamage);
    done();
});

test("the threshold follows the target's maximum, not a fixed number", () => {
    const { check, done } = checks();
    fresh();
    check("a 40-health mob is finished at 12", swing(withHealth(mob(), { hp: 12, max: 40 })).damage === M.finishDamage);
    check("but not at 12.5", swing(withHealth(mob(), { hp: 12.5, max: 40 })).damage === 4);
    check("a 4-health mob is finished at 1.2", swing(withHealth(mob(), { hp: 1.2, max: 4 })).damage === M.finishDamage);
    check("but not at 1.3", swing(withHealth(mob(), { hp: 1.3, max: 4 })).damage === 4);
    done();
});

test("a target with no health, a dead one, or an impossible maximum is left to the machete's ordinary hit", () => {
    const { check, done } = checks();
    fresh();
    check("no health component at all", swing(mob()).damage === 4);
    check("health already gone", swing(withHealth(mob(), { hp: 0, max: 20 })).damage === 4);
    check("negative health", swing(withHealth(mob(), { hp: -3, max: 20 })).damage === 4);
    check("a maximum of nothing", swing(withHealth(mob(), { hp: 1, max: 0 })).damage === 4);
    done();
});

test("a target that survives the huge hit (Resistance) is killed a tick later; one that died is not killed twice", () => {
    const { check, done } = checks();
    fresh();

    const resistant = withHealth(mob(), { hp: 5, max: 20 });
    swing(resistant);
    check("not yet: the follow-up is a tick later", resistant.kills === 0);
    fake.advance(1);
    check("killed once by the follow-up", resistant.kills === 1, String(resistant.kills));
    fake.advance(20);
    check("and not again", resistant.kills === 1);

    const dies = withHealth(mob(), { hp: 5, max: 20 });
    swing(dies);
    dies.getComponent = () => ({ currentValue: 0, effectiveMax: 20 });          // the huge hit did it
    fake.advance(1);
    check("a target the hit killed is left alone", dies.kills === 0);

    const gone = withHealth(mob(), { hp: 5, max: 20 });
    swing(gone);
    gone.remove();                                                                  // removed by the hit (a mob's death removes it)
    let threw = false;
    try { fake.advance(1); } catch { threw = true; }
    check("a target already removed: no kill, no exception", !threw && gone.kills === 0);
    done();
});

test("a hit that sent no hurt event is not finished, unless the owner turns that fallback on", () => {
    const { check, done } = checks();
    fresh();

    const quiet = withHealth(mob(), { hp: 5, max: 20 });
    swing(quiet, { afterToo: false });
    fake.advance(5);
    check("by default a hit the game did not report as a hurt is not followed up", quiet.kills === 0);

    M.killWithoutHurtEvent = true;
    try {
        const absorbed = withHealth(mob(), { hp: 5, max: 20 });
        swing(absorbed, { afterToo: false });
        fake.advance(1);
        check("with the fallback on it is", absorbed.kills === 1, String(absorbed.kills));
    } finally { M.killWithoutHurtEvent = false; }
    done();
});

test("a creative or spectator player is not finished; a survival or adventure player is", () => {
    const { check, done } = checks();
    fresh();
    const player = (mode) => {
        const p = withHealth(fake.makePlayer(`P-${mode}`), { hp: 2, max: 20 });
        p.getGameMode = () => mode;
        return p;
    };

    for (const mode of ["Creative", "creative", "Spectator", "spectator"]) {
        const target = player(mode);
        check(`${mode}: the ordinary hit`, swing(target).damage === 4);
        fake.advance(2);
        check(`${mode}: not killed`, target.kills === 0);
    }
    for (const mode of ["Survival", "Adventure"]) {
        const target = player(mode);
        check(`${mode}: finished`, swing(target).damage === M.finishDamage);
        fake.advance(1);
        check(`${mode}: killed by the follow-up if it lived`, target.kills === 1);
    }
    done();
});

test("only the machete finishes: any other weapon, a fist or a gun, however low the target", () => {
    const { check, done } = checks();
    fresh();
    for (const weapon of ["knife", "baton", "axe", "sledgehammer"]) {
        const target = withHealth(mob(), { hp: 1, max: 20 });
        const event = swing(target, { attacker: armed(`P-${weapon}`, weapon) });
        check(`${weapon}: its own number`, event.damage === MELEE.weapons[weapon].damage, String(event.damage));
        fake.advance(5);
        check(`${weapon}: no kill`, target.kills === 0);
    }
    const fist = withHealth(mob(), { hp: 1, max: 20 });
    check("a fist", swing(fist, { attacker: fake.makePlayer("Fist") }).damage === 1);
    fake.advance(5);
    check("a fist: no kill", fist.kills === 0);
    done();
});

test("a round reset cancels a follow-up that was waiting, and nothing is kept once a follow-up has run", () => {
    const { check, done } = checks();
    fresh();
    const target = withHealth(mob(), { hp: 5, max: 20 });
    swing(target);
    check("one blow waiting", finishingNow() === 1);
    resetMelee();
    check("none after the reset", finishingNow() === 0);
    fake.advance(5);
    check("nothing is killed after the reset", target.kills === 0);

    const other = withHealth(mob(), { hp: 5, max: 20 });
    swing(other);
    fake.advance(1);
    check("a follow-up that ran leaves nothing behind", finishingNow() === 0, String(finishingNow()));
    done();
});

test("a target whose health the engine will not read is left to the machete's ordinary hit", () => {
    const { check, done } = checks();
    fresh();
    const target = mob();
    target.getComponent = () => { throw new Error("InvalidEntityError"); };
    let event;
    let threw = false;
    try { event = swing(target); } catch { threw = true; }
    check("no exception", !threw);
    check("the ordinary 4", event?.damage === 4, String(event?.damage));
    fake.advance(5);
    check("no follow-up is waiting", finishingNow() === 0);
    done();
});

test("a player whose game mode the engine will not say is treated as in survival", () => {
    const { check, done } = checks();
    fresh();
    const player = withHealth(fake.makePlayer("Mystery"), { hp: 2, max: 20 });
    check("finished", swing(player).damage === M.finishDamage);
    done();
});

test("the finishing blow is not mistaken for a number the game ignored", () => {
    const { check, done } = checks();
    fresh();
    const target = withHealth(mob(), { hp: 5, max: 20 });
    swing(target, { dealt: 5 });                                  // the game dealt what health there was, not the huge number
    check("no warning", meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("with rae:melee_debug on, the log says whether the hit or the follow-up finished it", () => {
    const { check, done } = checks();
    fresh();
    debug(true);

    const byHit = withHealth(mob(), { hp: 5, max: 20 });
    lines.length = 0;
    swing(byHit);
    byHit.getComponent = () => ({ currentValue: 0, effectiveMax: 20 });
    fake.advance(1);
    check("the blow is logged with the target's health", meleeLines().some((l) => /finishing blow/.test(l) && /5 of 20/.test(l)), meleeLines().join(" | "));
    check("and it is said that the hit itself did it, so no kill was needed", meleeLines().some((l) => /the hit itself killed it/.test(l)), meleeLines().join(" | "));

    const byKill = withHealth(mob(), { hp: 5, max: 20 });
    lines.length = 0;
    swing(byKill);
    fake.advance(1);
    check("the follow-up did it", meleeLines().some((l) => /kill\(\)/.test(l)), meleeLines().join(" | "));
    done();
});

test("a kill the engine refuses is reported once and never thrown", () => {
    const { check, done } = checks();
    fresh();
    const target = withHealth(mob(), { hp: 5, max: 20 });
    target.kill = () => { throw new Error("the engine refused"); };
    let threw = false;
    swing(target);
    try { fake.advance(1); } catch { threw = true; }
    check("no exception", !threw);
    check("one report, naming the cause", meleeLines().length === 1 && /the engine refused/.test(meleeLines()[0]), meleeLines().join(" | "));
    done();
});
