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

const { addStack, dueNow } = await load("logic/melee.js");
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
