// Shared by the robbery tests (not a test itself): a small bank built through logic/robbery.ts's own edits, and the
// blocks it is bound to placed in the fake world, so the store, run, events and builder tests all play the same one.
import assert from "node:assert/strict";
import { fake, load } from "./helpers.mjs";

export const L = await load("logic/robbery.js");

export const pick = { kind: "pick", hits: 2, tolerance: 10, strikes: 3, jamSeconds: 20 };
export const key = { kind: "key", item: "minecraft:iron_pickaxe", consume: false };
export const pay = { kind: "pay", coins: 25 };
export const say = (text, to = "area", extra = {}) => ({ kind: "say", text, channel: "chat", to, ...extra });

export const ok = (edit) => { assert.equal(edit.ok, true, edit.reason); return edit.robbery; };
export const added = (result) => { assert.equal(result.ok, true, result.reason); return result; };

/** Where the bank's blocks are. */
export const SITE = {
    keypad: [103, 66, 171],
    doorLow: [104, 65, 170],
    doorHigh: [104, 66, 170],
    box: [107, 65, 175],
    area: { min: [82, 60, 159], max: [108, 80, 179] }
};

/**
 * A keypad (a switch with a pick lock) that opens a vault door, which lets a player at a lockbox (pick + pay, loot
 * and a bounty, then a win). `extra` changes what the lockbox is locked with and what it does.
 */
export function bank(id = "bank", extra = {}) {
    let r = ok(L.newRobbery(id, "Saint Diego Bank", "overworld"));
    r = ok(L.setArea(r, SITE.area.min, SITE.area.max));
    const keypad = added(L.addElement(r, { kind: "switch", name: "Keypad", cells: [SITE.keypad], locks: extra.keypadLocks ?? [pick], onFail: [say("Too noisy!", "area")] }));
    r = keypad.robbery;
    const door = added(L.addElement(r, { kind: "door", name: "Vault door", cells: [SITE.doorLow, SITE.doorHigh], req: [keypad.element.id] }));
    r = door.robbery;
    const box = added(L.addElement(r, {
        kind: "chest", name: "Lockbox", cells: [SITE.box], table: "chests/gold_2", items: [["minecraft:diamond", 2]],
        locks: extra.boxLocks ?? [pick, pay], req: [door.element.id],
        onDone: [{ kind: "reward", coins: 0, bounty: 250, to: "area" }, { kind: "end", result: "win", delaySeconds: 3 }]
    }));
    r = box.robbery;
    r = ok(L.setHook(r, "win", [{ kind: "reward", coins: 100, bounty: 0, to: "area" }, say("The bank is empty.", "all", { sound: "random.levelup" })]));
    r = ok(L.setHook(r, "start", [say("Alarm! Someone is in the bank.", "law")]));
    return { r, keypad: keypad.element, door: door.element, box: box.element };
}

/** Puts the bank's blocks in the fake world: a button, an iron door (two halves) and a chest. */
export function buildSite(dimension = "overworld") {
    fake.placeBlock(dimension, SITE.keypad, "minecraft:stone_button");
    fake.placeBlock(dimension, SITE.doorLow, "minecraft:iron_door", { upper_block_bit: false });
    fake.placeBlock(dimension, SITE.doorHigh, "minecraft:iron_door", { upper_block_bit: true });
    fake.placeBlock(dimension, SITE.box, "minecraft:chest");
}
