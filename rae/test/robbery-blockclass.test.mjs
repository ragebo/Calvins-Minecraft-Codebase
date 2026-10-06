import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

// logic/blockclass.ts: what kind of block a type id is, as far as a robbery cares. Matching is by suffix, so a
// variant added by a later game version should classify without an edit; this table is the contract.

const { classOfBlockType, bareId, swingsOpen } = await load("logic/blockclass.js");

const CASES = [
    // doors: every wood, metal and copper variant ends in _door, and a trapdoor is NOT a door
    ["minecraft:wooden_door", "door"], ["minecraft:iron_door", "door"], ["minecraft:spruce_door", "door"],
    ["minecraft:copper_door", "door"], ["minecraft:waxed_exposed_copper_door", "door"],
    ["minecraft:trapdoor", "trapdoor"], ["minecraft:iron_trapdoor", "trapdoor"], ["minecraft:crimson_trapdoor", "trapdoor"],
    ["minecraft:fence_gate", "gate"], ["minecraft:spruce_fence_gate", "gate"],
    // things that hold items
    ["minecraft:chest", "container"], ["minecraft:trapped_chest", "container"], ["minecraft:barrel", "container"],
    ["minecraft:ender_chest", "container"], ["minecraft:undyed_shulker_box", "container"], ["minecraft:white_shulker_box", "container"],
    ["minecraft:hopper", "container"], ["minecraft:furnace", "container"], ["minecraft:copper_chest", "container"],
    // things that are pressed
    ["minecraft:stone_button", "button"], ["minecraft:wooden_button", "button"], ["minecraft:polished_blackstone_button", "button"],
    ["minecraft:lever", "lever"],
    ["minecraft:stone_pressure_plate", "plate"], ["minecraft:light_weighted_pressure_plate", "plate"], ["minecraft:wooden_pressure_plate", "plate"],
    ["minecraft:trip_wire", "tripwire"], ["minecraft:tripwire_hook", "tripwire"],
    // everything else is a real answer, not an error
    ["minecraft:stone", "other"], ["minecraft:crafting_table", "other"], ["minecraft:air", "other"], ["minecraft:door_frame_decoration", "other"],
    // an id with no namespace is read the same way
    ["iron_door", "door"], ["chest", "container"]
];

test("block types classify by suffix: door, trapdoor, gate, container, button, lever, plate, tripwire, other", () => {
    const wrong = CASES.filter(([id, expected]) => classOfBlockType(id) !== expected)
        .map(([id, expected]) => `${id}: expected ${expected}, got ${classOfBlockType(id)}`);
    assert.deepEqual(wrong, []);
});

test("bareId drops the namespace and leaves an id without one alone", () => {
    assert.equal(bareId("minecraft:oak_door"), "oak_door");
    assert.equal(bareId("bountysys:thing"), "thing");
    assert.equal(bareId("plain"), "plain");
});

test("only doors, trapdoors and gates swing open through open_bit", () => {
    assert.deepEqual(
        ["door", "trapdoor", "gate", "container", "button", "lever", "plate", "tripwire", "other"].filter((c) => swingsOpen(c)),
        ["door", "trapdoor", "gate"]
    );
});
