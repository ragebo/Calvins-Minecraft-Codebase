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
