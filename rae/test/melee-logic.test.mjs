import { test } from "node:test";
import { load, checks } from "./helpers.mjs";

// The pure rules of the melee weapons (logic/melee.ts).

const { MELEE } = await load("config/balance.js");
const { weaponForItem, honored } = await load("logic/melee.js");

test("an item is a melee weapon only by its exact id, and it brings its name and number", () => {
    const { check, done } = checks();

    for (const [key, weapon] of Object.entries(MELEE.weapons)) {
        const found = weaponForItem(weapon.id);
        check(`${key}: found by its id`, found?.key === key && found.name === weapon.name && found.damage === weapon.damage, JSON.stringify(found));
    }

    check("nothing", weaponForItem(undefined) === undefined);
    check("an empty id", weaponForItem("") === undefined);
    check("a vanilla sword", weaponForItem("minecraft:iron_sword") === undefined);
    check("a gun", weaponForItem("bountysys:revolver") === undefined);
    check("an id that only contains a weapon's", weaponForItem("bountysys:knife_sharp") === undefined && weaponForItem("x:bountysys:knife") === undefined);
    check("a different case", weaponForItem("bountysys:KNIFE") === undefined);
    done();
});

test("a number is honored when the game dealt it, give or take a float's rounding, in either direction", () => {
    const { check, done } = checks();
    check("equal", honored(4, 4));
    check("a float's rounding above", honored(4, 4.0004));
    check("a float's rounding below", honored(4, 3.9996));
    check("a whole point less", !honored(4, 3));
    check("a whole point more (the check is two-sided)", !honored(4, 5));
    check("half a point more", !honored(4, 4.5));
    check("a hundredth less", !honored(4, 3.99));
    check("nothing dealt", !honored(4, 0));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The knife's bleed
// ---------------------------------------------------------------------------------------------------------

const { addStack, dueNow, isFinishable } = await load("logic/melee.js");

test("a target is finishable at 30% of its maximum or less, with a float's rounding forgiven, and never when dead", () => {
    const { check, done } = checks();
    check("exactly 30%", isFinishable(6, 20, 0.3));
    check("below it", isFinishable(1, 20, 0.3));
    check("a hair above it", !isFinishable(6.0001, 20, 0.3));
    check("above it", !isFinishable(6.5, 20, 0.3));
    check("at full health", !isFinishable(20, 20, 0.3));
    check("0.9 of 3 is 30% although 0.3 * 3 is 0.8999999999999999 in a float", isFinishable(0.9, 3, 0.3));
    check("no health left is dead, not finishable", !isFinishable(0, 20, 0.3));
    check("negative health", !isFinishable(-2, 20, 0.3));
    check("a maximum of nothing", !isFinishable(1, 0, 0.3));
    check("a maximum that is not a number", !isFinishable(1, NaN, 0.3));
    check("another fraction", isFinishable(10, 20, 0.5) && !isFinishable(10.1, 20, 0.5));
    done();
});
const RULES = { damage: 1, intervalTicks: 20, hits: 2, maxStacks: 3 };

test("a new hit adds a stack that is first due one interval later, with all its ticks to come", () => {
    const { check, done } = checks();
    const stacks = addStack([], "ada", 100, RULES);
    check("one stack", stacks.length === 1);
    check("due an interval later", stacks[0].due === 120, String(stacks[0].due));
    check("both ticks to come", stacks[0].left === 2);
    check("it remembers whose hit it was", stacks[0].owner === "ada");

    const more = addStack(stacks, "bo", 110, RULES);
    check("another stack beside it, the first untouched", more.length === 2 && more[0] === stacks[0] && more[1].due === 130 && more[1].owner === "bo");
    check("the list it was given is left as it was", stacks.length === 1);
    done();
});

test("at the cap a new hit replaces the oldest stack; a cap lowered meanwhile trims the oldest ones", () => {
    const { check, done } = checks();
    let stacks = [];
    for (const [i, who] of ["a", "b", "c"].entries()) stacks = addStack(stacks, who, i, RULES);
    check("three fit", stacks.map((s) => s.owner).join() === "a,b,c");

    stacks = addStack(stacks, "d", 10, RULES);
    check("a fourth pushes out the oldest", stacks.map((s) => s.owner).join() === "b,c,d", stacks.map((s) => s.owner).join());

    const lowered = addStack(stacks, "e", 11, { ...RULES, maxStacks: 2 });
    check("a lower cap keeps only the newest ones that fit", lowered.map((s) => s.owner).join() === "d,e", lowered.map((s) => s.owner).join());

    check("a cap of 0 or less still lets the newest hit bleed", addStack(stacks, "f", 12, { ...RULES, maxStacks: 0 }).map((s) => s.owner).join() === "f");
    check("a cap that is not a whole number is rounded down", addStack(stacks, "g", 13, { ...RULES, maxStacks: 2.9 }).length === 2);
    done();
});

test("what is due is one total for the target, and a stack steps along until its ticks run out", () => {
    const { check, done } = checks();
    const stacks = [{ owner: "b", due: 20, left: 1 }, { owner: "a", due: 20, left: 2 }, { owner: "c", due: 30, left: 2 }];

    const none = dueNow(stacks, 19, RULES);
    check("nothing before the due tick", none.amount === 0 && none.owners.length === 0 && none.stacks.length === 3);

    const first = dueNow(stacks, 20, RULES);
    check("two stacks are due on tick 20: 2 damage in one total", first.amount === 2, String(first.amount));
    check("owed by b and a", first.owners.join() === "b,a");
    check("b had one tick left and is gone; a steps on a whole interval from its own due tick", first.stacks.length === 2 && first.stacks[0].owner === "a" && first.stacks[0].due === 40 && first.stacks[0].left === 1, JSON.stringify(first.stacks));
    check("c is untouched", first.stacks[1] === stacks[2]);
    check("the list it was given is left as it was", stacks[1].left === 2 && stacks.length === 3);

    const second = dueNow(first.stacks, 30, RULES);
    check("c's first tick", second.amount === 1 && second.owners.join() === "c" && second.stacks.length === 2);

    const last = dueNow(dueNow(second.stacks, 40, RULES).stacks, 50, RULES);
    check("the last ticks empty the list", last.stacks.length === 0, JSON.stringify(last.stacks));
    done();
});

test("a late step catches up without losing the rhythm, and a zero interval cannot spin", () => {
    const { check, done } = checks();
    const late = dueNow([{ owner: "a", due: 20, left: 2 }], 25, RULES);
    check("a stack due at 20, dealt at 25, is next due at 40, not 45", late.amount === 1 && late.stacks[0].due === 40, JSON.stringify(late.stacks));

    const zero = dueNow([{ owner: "a", due: 20, left: 2 }], 20, { ...RULES, intervalTicks: 0 });
    check("an interval of 0 still moves on by a tick", zero.stacks[0].due === 21, JSON.stringify(zero.stacks));

    const bigger = dueNow([{ owner: "a", due: 20, left: 2 }, { owner: "b", due: 20, left: 2 }], 20, { ...RULES, damage: 3 });
    check("the damage per stack is the rule's", bigger.amount === 6, String(bigger.amount));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The baton's stun
// ---------------------------------------------------------------------------------------------------------

const { rollStun } = await load("logic/melee.js");

test("the stun roll: below the chance stuns, at it or above does not, and the rate over many seeded rolls is the chance", () => {
    const { check, done } = checks();
    check("0 stuns", rollStun(0, 0.25));
    check("just below the chance stuns", rollStun(0.2499, 0.25));
    check("exactly the chance does not", !rollStun(0.25, 0.25));
    check("above does not", !rollStun(0.7, 0.25));
    check("a chance of 0 never stuns", !rollStun(0, 0));
    check("a chance of 1 always does", rollStun(0.9999, 1));

    // A small seeded generator (a linear congruential one), so the count is the same every run.
    let seed = 12345;
    const dice = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let stuns = 0;
    for (let i = 0; i < 20000; i++) if (rollStun(dice(), 0.25)) stuns++;
    const rate = stuns / 20000;
    check("about a quarter over 20000 rolls", rate > 0.24 && rate < 0.26, String(rate));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The axe
// ---------------------------------------------------------------------------------------------------------

const { inCone, cooldownStatus, formatSeconds } = await load("logic/melee.js");

test("the cone: in front and to either side counts, behind does not, and exactly 90 degrees is decided as inside", () => {
    const { check, done } = checks();
    // Facing +z (0, 1); the half circle in front is z >= 0.
    check("straight ahead", inCone(0, 5, 0, 1, 90));
    check("to the right", inCone(5, 0, 0, 1, 90));
    check("to the left", inCone(-5, 0, 0, 1, 90));
    check("diagonally ahead", inCone(3, 3, 0, 1, 90));
    check("89 degrees off", inCone(Math.sin(89 * Math.PI / 180), Math.cos(89 * Math.PI / 180), 0, 1, 90));
    check("91 degrees off is out", !inCone(Math.sin(91 * Math.PI / 180), Math.cos(91 * Math.PI / 180), 0, 1, 90));
    check("straight behind", !inCone(0, -5, 0, 1, 90));
    check("behind and to the side", !inCone(5, -0.5, 0, 1, 90));
    done();
});

test("the cone follows the facing and the half angle it is given, whatever the length of the vectors", () => {
    const { check, done } = checks();
    check("facing east, east is ahead", inCone(2, 0, 1, 0, 90));
    check("facing east, west is behind", !inCone(-2, 0, 1, 0, 90));
    check("a facing that is not a unit vector", inCone(0, 1, 0, 40, 90) && !inCone(0, -1, 0, 40, 90));
    check("a narrower cone: 45 degrees off is the edge, 60 is out", inCone(1, 1, 0, 1, 45) && !inCone(Math.sin(60 * Math.PI / 180), Math.cos(60 * Math.PI / 180), 0, 1, 45));
    check("a full circle takes everything", inCone(0, -5, 0, 1, 180));
    check("a facing between the axes", inCone(1, 0, 1, 1, 90) && inCone(0, 1, 1, 1, 90) && !inCone(-1, -1, 1, 1, 90));
    done();
});

test("with no direction to measure, everything counts: on top of the wielder, or looking straight up or down", () => {
    const { check, done } = checks();
    check("on top of them", inCone(0, 0, 0, 1, 90));
    check("a hair away (the same thing)", inCone(1e-9, 0, 0, 1, 90));
    check("looking straight down, one way", inCone(0, -3, 0, 0, 90));
    check("looking straight down, the other", inCone(3, 3, 0, 0, 90));
    done();
});

test("a cooldown is a step function: ready, then 'same click' for a couple of ticks, then cooling until it ends", () => {
    const { check, done } = checks();
    check("no attack yet", cooldownStatus(undefined, 0, 100, 2) === "ready");
    check("the tick it begins", cooldownStatus(120, 100, 100, 2) === "same");
    check("2 ticks in", cooldownStatus(120, 100, 102, 2) === "same");
    check("3 ticks in", cooldownStatus(120, 100, 103, 2) === "cooling");
    check("a tick before the end", cooldownStatus(120, 100, 119, 2) === "cooling");
    check("the tick it ends", cooldownStatus(120, 100, 120, 2) === "ready");
    check("long after", cooldownStatus(120, 100, 500, 2) === "ready");
    check("a window longer than the cooldown still ends with it", cooldownStatus(120, 100, 120, 50) === "ready");
    done();
});

test("ticks as seconds: to a tenth, rounded up so a cooldown never reads as over early", () => {
    const { check, done } = checks();
    check("20 ticks", formatSeconds(20) === "1.0");
    check("10 ticks", formatSeconds(10) === "0.5");
    check("11 ticks", formatSeconds(11) === "0.6");
    check("1 tick", formatSeconds(1) === "0.1");
    check("30 ticks", formatSeconds(30) === "1.5");
    check("nothing left", formatSeconds(0) === "0.0");
    check("less than nothing", formatSeconds(-4) === "0.0");
    done();
});
