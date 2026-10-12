import { test } from "node:test";
import { checks, load } from "./helpers.mjs";
import { MELEE, fake, fresh, hit, dies, armed, resetMelee, debug, lines, meleeLines } from "./melee-fixtures.mjs";

// The knife's bleed (tasks/melee/plan.md, Task 3): every knife hit adds a stack that deals 1 damage at 1 second and at 2 seconds
// after the hit; what is due on a tick is dealt as ONE hit per target (separate hits within 10 ticks would be lost to the game's
// hit window), by the knife's wielder, as "override" damage so it ignores armor and that window. Whether the real game credits a
// kill to the wielder for such damage is not known yet: docs/test-cards/MELEE.md asks.

const { bleedTickActive, bleedingNow } = await load("core/melee.js");
const B = MELEE.bleed;
const mob = () => fake.makeEntity({ typeId: "minecraft:pillager" });
const amounts = (target) => target.damage.map((d) => d.amount);
const total = (target) => amounts(target).reduce((a, b) => a + b, 0);

test("the bleed is on the table: 1 damage a second for 2 seconds, up to 10 stacks", () => {
    const { check, done } = checks();
    check("1 damage per stack per tick", B.damage === 1);
    check("a second apart", B.intervalTicks === 20);
    check("two ticks of it", B.hits === 2);
    check("10 stacks at most", B.maxStacks === 10);
    done();
});

test("one knife hit: 1 damage at 1 second and 1 at 2 seconds, then it stops: 2 in all", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    hit({ attacker: knifer, target, damage: 1 });
    fake.advance(19);
    check("nothing before a second", target.damage.length === 0, JSON.stringify(amounts(target)));
    fake.advance(1);
    check("1 at a second", JSON.stringify(amounts(target)) === "[1]", JSON.stringify(amounts(target)));
    fake.advance(19);
    check("nothing in between", target.damage.length === 1);
    fake.advance(1);
    check("1 more at two seconds", JSON.stringify(amounts(target)) === "[1,1]", JSON.stringify(amounts(target)));
    fake.advance(400);
    check("and no more, ever", total(target) === 2, JSON.stringify(amounts(target)));
    done();
});

test("each bleed hit is the script's own: the wielder is the attacker, the cause ignores armor and the hit window", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    hit({ attacker: knifer, target, damage: 1 });
    fake.advance(20);
    check("the cause is override", target.damage[0]?.cause === "override", JSON.stringify(target.damage[0]));
    check("the attacker is the wielder", target.damage[0]?.damagingEntity === knifer);
    done();
});

test("three hits at once: the stacks add up (3 a second at the peak) and nothing is lost to the hit window: 6 in all", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    for (let i = 0; i < 3; i++) hit({ attacker: knifer, target, damage: 1 });
    fake.advance(20);
    check("3 at a second, in ONE hit", JSON.stringify(amounts(target)) === "[3]", JSON.stringify(amounts(target)));
    fake.advance(20);
    check("3 at two seconds, in ONE hit", JSON.stringify(amounts(target)) === "[3,3]", JSON.stringify(amounts(target)));
    fake.advance(200);
    check("6 in all", total(target) === 6, String(total(target)));
    done();
});

test("hits at different times: each stack keeps its own clock, and what falls on one tick is dealt together", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    hit({ attacker: knifer, target, damage: 1 });          // t=0: due 20 and 40
    fake.advance(10);
    hit({ attacker: knifer, target, damage: 1 });          // t=10: due 30 and 50
    hit({ attacker: knifer, target, damage: 1 });          // t=10: due 30 and 50
    fake.advance(10);
    check("t=20: the first stack", JSON.stringify(amounts(target)) === "[1]", JSON.stringify(amounts(target)));
    fake.advance(10);
    check("t=30: the other two together", JSON.stringify(amounts(target)) === "[1,2]", JSON.stringify(amounts(target)));
    fake.advance(10);
    check("t=40: the first one's second tick", JSON.stringify(amounts(target)) === "[1,2,1]", JSON.stringify(amounts(target)));
    fake.advance(10);
    check("t=50: the other two's second tick", JSON.stringify(amounts(target)) === "[1,2,1,2]", JSON.stringify(amounts(target)));
    fake.advance(200);
    check("6 in all", total(target) === 6, String(total(target)));
    done();
});

test("a bleed on a player works the same, and it can kill", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const victim = fake.makePlayer("Victim");

    hit({ attacker: knifer, target: victim, damage: 1 });
    fake.advance(40);
    check("1 then 1 on a player", JSON.stringify(amounts(victim)) === "[1,1]", JSON.stringify(amounts(victim)));
    check("the wielder is named", victim.damage.every((d) => d.damagingEntity === knifer));
    done();
});

test("a stack cap of 10: an eleventh hit at the same moment adds nothing, and a later one refreshes the oldest", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    for (let i = 0; i < 11; i++) hit({ attacker: knifer, target, damage: 1 });
    fake.advance(20);
    check("10 a second at the peak, not 11", JSON.stringify(amounts(target)) === "[10]", JSON.stringify(amounts(target)));
    fake.advance(20);
    check("10 again", JSON.stringify(amounts(target)) === "[10,10]", JSON.stringify(amounts(target)));

    const other = mob();
    for (let i = 0; i < 10; i++) hit({ attacker: knifer, target: other, damage: 1 });
    fake.advance(10);
    hit({ attacker: knifer, target: other, damage: 1 });                       // full: the oldest is refreshed
    fake.advance(10);
    check("the refreshed stack's turn has not come: 9 at the first moment", JSON.stringify(amounts(other)) === "[9]", JSON.stringify(amounts(other)));
    fake.advance(10);
    check("then 1 from the refreshed stack", JSON.stringify(amounts(other)) === "[9,1]", JSON.stringify(amounts(other)));
    fake.advance(200);
    check("never more than 10 stacks of 2 in all", total(other) === 20, String(total(other)));
    done();
});

test("it ends when the target dies, leaves, or the round resets", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");

    const killed = mob();
    hit({ attacker: knifer, target: killed, damage: 1 });
    fake.advance(10);
    dies(killed, knifer);
    check("its death ends the bleed at once", bleedingNow() === 0, String(bleedingNow()));
    check("and the tick with it", !bleedTickActive());
    fake.advance(100);
    check("a target that died is not hurt again", killed.damage.length === 0, JSON.stringify(amounts(killed)));

    const removed = mob();
    hit({ attacker: knifer, target: removed, damage: 1 });
    fake.advance(10);
    removed.remove();
    fake.advance(1);
    check("a target removed from the world is let go on the next tick", bleedingNow() === 0, String(bleedingNow()));
    fake.advance(100);
    check("a target removed from the world is left alone", removed.damage.length === 0);

    const leaver = fake.makePlayer("Leaver");
    hit({ attacker: knifer, target: leaver, damage: 1 });
    fake.advance(10);
    leaver.remove();
    fake.advance(1);
    check("a player who left is let go on the next tick", bleedingNow() === 0, String(bleedingNow()));
    fake.advance(100);
    check("a player who left is left alone", leaver.damage.length === 0);

    const reset = mob();
    hit({ attacker: knifer, target: reset, damage: 1 });
    fake.advance(10);
    resetMelee();
    check("a round reset ends every bleed at once", bleedingNow() === 0, String(bleedingNow()));
    fake.advance(100);
    check("and none is hurt afterwards", reset.damage.length === 0, JSON.stringify(amounts(reset)));
    done();
});

test("a target that dies by another cause while bleeding is let go on the next tick", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();
    let health = 10;
    target.getComponent = (id) => id === "minecraft:health" ? { get currentValue() { return health; }, effectiveMax: 20 } : undefined;

    hit({ attacker: knifer, target, damage: 1 });
    check("bleeding while alive", bleedingNow() === 1);
    health = 0;
    fake.advance(1);
    check("let go once its health is gone, even with no death event", bleedingNow() === 0);
    fake.advance(100);
    check("and never hurt again", target.damage.length === 0);
    done();
});

test("a bleed tick the engine refuses is reported once, and does not stop anyone else's bleed", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const broken = mob();
    const healthy = mob();
    broken.applyDamage = () => { throw new Error("the engine refused"); };

    hit({ attacker: knifer, target: broken, damage: 1 });
    hit({ attacker: knifer, target: healthy, damage: 1 });
    fake.advance(40);

    check("one report for two refused ticks", meleeLines().length === 1, meleeLines().join(" | "));
    check("it says what failed and why", /a bleed tick/.test(meleeLines()[0] ?? "") && /the engine refused/.test(meleeLines()[0] ?? ""), meleeLines()[0]);
    check("the other target still bled, both ticks", JSON.stringify(amounts(healthy)) === "[1,1]", JSON.stringify(amounts(healthy)));
    done();
});

test("the bleed is still dealt when the wielder has gone, just without a name on it", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    hit({ attacker: knifer, target, damage: 1 });
    knifer.remove();
    fake.advance(20);
    check("the damage still lands", amounts(target).length === 1);
    check("without an attacker", target.damage[0]?.damagingEntity === undefined);
    check("and still as override", target.damage[0]?.cause === "override");
    done();
});

test("only a knife hit bleeds: other weapons, fists and the bleed's own damage never add a stack", () => {
    const { check, done } = checks();
    fresh();
    const target = mob();
    const knifer = armed("Knifer", "knife");

    for (const weapon of ["machete", "baton", "axe", "sledgehammer"]) hit({ attacker: armed(`P-${weapon}`, weapon), target, damage: 1 });
    hit({ attacker: fake.makePlayer("Fist"), target, damage: 1 });
    hit({ attacker: fake.makePlayer("Gun", { holding: "bountysys:revolver" }), target, damage: 1 });
    hit({ attacker: knifer, target, damage: 1, cause: "override" });                      // the bleed's own tick coming back as a hurt event
    hit({ attacker: knifer, target, damage: 1, cause: "projectile" });
    fake.advance(100);
    check("nothing bled", target.damage.length === 0, JSON.stringify(amounts(target)));
    done();
});

test("a knife hit that dealt nothing, or that killed the target, starts no bleed", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");

    const blocked = mob();
    hit({ attacker: knifer, target: blocked, damage: 1, dealt: 0 });
    check("a hit that dealt nothing starts nothing", bleedingNow() === 0);
    fake.advance(100);
    check("and nothing is dealt", blocked.damage.length === 0);

    const grazed = mob();
    hit({ attacker: knifer, target: grazed, damage: 1, dealt: 0.5 });
    check("a hit that dealt a little (armor took the rest) still bleeds", bleedingNow() === 1);
    fake.advance(100);
    resetMelee();

    const dead = mob();
    dead.getComponent = (id) => id === "minecraft:health" ? { currentValue: 0, effectiveMax: 20 } : undefined;
    hit({ attacker: knifer, target: dead, damage: 1 });
    check("a target the hit killed starts nothing", bleedingNow() === 0);
    fake.advance(100);
    check("and nothing is dealt to it", dead.damage.length === 0);

    const gone = mob();
    gone.remove();
    let threw = false;
    lines.length = 0;
    try { hit({ attacker: knifer, target: gone, damage: 1 }); } catch { threw = true; }
    check("a target already removed starts nothing", bleedingNow() === 0);
    fake.advance(100);
    check("no exception, no bleed, and no report either", !threw && gone.damage.length === 0 && meleeLines().length === 0, meleeLines().join(" | "));
    done();
});

test("nothing is ticking while no one bleeds, and the tick stops again when the last bleed ends", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    check("idle at the start", !bleedTickActive() && bleedingNow() === 0);
    hit({ attacker: knifer, target, damage: 1 });
    check("ticking with one bleeding", bleedTickActive() && bleedingNow() === 1);
    fake.advance(40);
    check("idle again once it has run its course", !bleedTickActive() && bleedingNow() === 0);

    hit({ attacker: knifer, target, damage: 1 });
    resetMelee();
    check("idle after a reset", !bleedTickActive() && bleedingNow() === 0);
    done();
});

test("with rae:melee_debug on, each bleed hit is logged with its size", () => {
    const { check, done } = checks();
    fresh();
    const knifer = armed("Knifer", "knife");
    const target = mob();

    hit({ attacker: knifer, target, damage: 1 });
    fake.advance(40);
    check("off: silent", meleeLines().length === 0, meleeLines().join(" | "));

    debug(true);
    lines.length = 0;
    const other = mob();
    hit({ attacker: knifer, target: other, damage: 1 });
    hit({ attacker: knifer, target: other, damage: 1 });
    fake.advance(20);
    check("on: the bleed is logged with its size and its stacks", meleeLines().some((l) => /bleed: 2 to minecraft:pillager from 2 stack/.test(l)), meleeLines().join(" | "));
    done();
});
