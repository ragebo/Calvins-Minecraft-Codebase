import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, load } from "./helpers.mjs";

// logic/robbery.ts: a robbery as data. The contract is that a robbery which exists can always be saved, reloaded and
// played: every edit validates the WHOLE result, parse runs the same checks and never throws, ids are stable and never
// reused, nothing loops, no block belongs to two elements.

const L = await load("logic/robbery.js");
const { ROBBERY: R } = await load("config/balance.js");

const pick = { kind: "pick", hits: 2, tolerance: 10, strikes: 3, jamSeconds: 20 };
const key = { kind: "key", item: "minecraft:iron_pickaxe", consume: false };
const pay = { kind: "pay", coins: 25 };
const say = (text, to = "area", extra = {}) => ({ kind: "say", text, channel: "chat", to, ...extra });

const ok = (edit) => { assert.equal(edit.ok, true, edit.reason); return edit.robbery; };
const added = (result) => { assert.equal(result.ok, true, result.reason); return result; };

/** A small bank: a keypad (switch) that opens a vault door, then a lockbox, then the way out. */
function bank() {
    let r = ok(L.newRobbery("bank", "Saint Diego Bank", "overworld"));
    r = ok(L.setArea(r, [82, 60, 159], [108, 80, 179]));
    const keypad = added(L.addElement(r, { kind: "switch", name: "Keypad", cells: [[103, 66, 171]], locks: [pick], onFail: [say("Too noisy!", "area")] }));
    r = keypad.robbery;
    const door = added(L.addElement(r, { kind: "door", name: "Vault door", cells: [[104, 65, 170], [104, 66, 170]], req: [keypad.element.id] }));
    r = door.robbery;
    const box = added(L.addElement(r, {
        kind: "chest", name: "Lockbox", cells: [[107, 65, 175]], table: "chests/gold_2", items: [["minecraft:diamond", 2]],
        locks: [pick, pay], req: [door.element.id], onDone: [{ kind: "reward", coins: 0, bounty: 250, to: "area" }, { kind: "end", result: "win", delaySeconds: 3 }]
    }));
    r = box.robbery;
    r = ok(L.setHook(r, "win", [{ kind: "reward", coins: 100, bounty: 0, to: "area" }, say("The bank is empty.", "all", { sound: "random.levelup" })]));
    return { r, keypad: keypad.element, door: door.element, box: box.element };
}

// ---------------------------------------------------------------------------------------------------------
// Ids and names
// ---------------------------------------------------------------------------------------------------------

test("a robbery id is a short lowercase slug; a name is cleaned of colour codes and kept to a sane length", () => {
    const { check, done } = checks();

    check("a good id is accepted", L.newRobbery("saint_diego", "Saint Diego", "overworld").ok);
    for (const bad of ["a", "Bank", "1bank", "bank-1", "bank name", "", "x".repeat(R.maxIdLength + 1)]) {
        check(`"${bad}" is refused as an id`, L.newRobbery(bad, "Name", "overworld").ok === false);
    }
    check("the longest allowed id works", L.newRobbery("x".repeat(R.maxIdLength), "Name", "overworld").ok);

    const coloured = ok(L.newRobbery("bank", "  §6The   §lBank  ", "overworld"));
    check("colour codes and extra spaces are stripped from the name", coloured.name === "The Bank", coloured.name);
    check("an empty name is refused", L.newRobbery("bank", "   ", "overworld").ok === false);
    check("a name made only of colour codes is refused", L.newRobbery("bank", "§a§b", "overworld").ok === false);
    check("a name over the limit is refused", L.newRobbery("bank", "n".repeat(R.maxNameLength + 1), "overworld").ok === false);
    check("an unknown dimension is refused", L.newRobbery("bank", "Bank", "mars").ok === false);
    check("renaming cleans the name too", ok(L.renameRobbery(coloured, "§cNew name")).name === "New name");
    done();
});

test("element ids are e1, e2... stable, and never reused after a delete; default names are unique", () => {
    const { check, done } = checks();
    let r = ok(L.newRobbery("bank", "Bank", "overworld"));

    const a = added(L.addElement(r, { kind: "door", cells: [[0, 64, 0]] }));
    r = a.robbery;
    const b = added(L.addElement(r, { kind: "door", cells: [[5, 64, 0]] }));
    r = b.robbery;
    check("first two ids", a.element.id === "e1" && b.element.id === "e2", `${a.element.id} ${b.element.id}`);
    check("default names say the kind and the counter", a.element.name === "Door 1" && b.element.name === "Door 2", `${a.element.name} / ${b.element.name}`);

    r = L.removeElement(r, "e2").robbery;
    const c = added(L.addElement(r, { kind: "chest", cells: [[9, 64, 0]] }));
    check("the id of a deleted element is not handed out again", c.element.id === "e3", c.element.id);

    const clash = L.addElement(c.robbery, { kind: "switch", name: "DOOR 1", cells: [[12, 64, 0]] });
    check("a typed name that clashes is refused, ignoring case, and says which one", clash.ok === false && /already an element called DOOR 1/.test(clash.reason ?? ""), JSON.stringify(clash));

    // The next id is e4 and, after it, e5 (whose default name would be "Door 5"). Someone typed "Door 5" for e4.
    const taken = added(L.addElement(c.robbery, { kind: "door", name: "Door 5", cells: [[20, 64, 0]] }));
    const next = added(L.addElement(taken.robbery, { kind: "door", cells: [[24, 64, 0]] }));
    check("a default name that would collide gets a number instead", next.element.name === "Door 5 2", next.element.name);
    check("and every name is still unique", new Set(next.robbery.elements.map((e) => e.name.toLowerCase())).size === next.robbery.elements.length);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------------------

test("an element must be bound to real blocks: whole numbers, a sensible height, the right count, none shared", () => {
    const { check, done } = checks();
    const r = ok(L.newRobbery("bank", "Bank", "overworld"));

    const refused = (spec, why) => check(why, L.addElement(r, spec).ok === false, JSON.stringify(L.addElement(r, spec)));
    refused({ kind: "door", cells: [] }, "no blocks");
    refused({ kind: "door", cells: [[0, 64, 0], [0, 65, 0], [0, 66, 0]] }, "a door is at most two blocks");
    refused({ kind: "chest", cells: [[0, 64, 0], [1, 64, 0], [2, 64, 0]] }, "a chest is at most two blocks");
    refused({ kind: "door", cells: [[0.5, 64, 0]] }, "a fractional coordinate");
    refused({ kind: "door", cells: [[0, 999, 0]] }, "above the overworld build limit");
    refused({ kind: "door", cells: [[0, -200, 0]] }, "below the overworld build limit");
    refused({ kind: "door", cells: [[R.maxCoordinate + 1, 64, 0]] }, "past the world border");
    refused({ kind: "door", cells: [[0, 64, 0], [0, 64, 0]] }, "the same block twice");
    refused({ kind: "door", cells: [[0, 64]] }, "a position with two numbers");
    check("a switch may be bound to several blocks (a bank of buttons)", L.addElement(r, { kind: "switch", cells: [[0, 64, 0], [1, 64, 0], [2, 64, 0], [3, 64, 0]] }).ok);
    check("but not more than the cap", L.addElement(r, { kind: "switch", cells: Array.from({ length: R.maxCells + 1 }, (_, i) => [i, 64, 0]) }).ok === false);

    const first = ok({ ok: true, robbery: added(L.addElement(r, { kind: "door", name: "Vault", cells: [[4, 64, 4]] })).robbery });
    const clash = L.addElement(first, { kind: "chest", name: "Box", cells: [[4, 64, 4]] });
    check("a block already bound to another element is refused, naming it", clash.ok === false && /Vault/.test(clash.reason ?? ""), JSON.stringify(clash));

    const nether = ok(L.newRobbery("hell", "Hell", "nether"));
    check("the build limit is the overworld's: the nether is not held to it", L.addElement(nether, { kind: "door", cells: [[0, 100, 0]] }).ok);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------------------------------------

test("requirements must point at real elements, never at themselves, never in a loop", () => {
    const { check, done } = checks();
    const { r, keypad, door, box } = bank();

    check("a requirement on an unknown element is refused", L.updateElement(r, door.id, { req: ["e99"] }).ok === false);
    check("an element cannot require itself", L.updateElement(r, door.id, { req: [door.id] }).ok === false);
    check("the same requirement twice is refused", L.updateElement(r, door.id, { req: [keypad.id, keypad.id] }).ok === false);

    const loop = L.updateElement(r, keypad.id, { req: [box.id] });
    check("a loop is refused", loop.ok === false && /loop/.test(loop.reason ?? ""), JSON.stringify(loop));
    check("and the loop is named as a readable chain", /Keypad -> Lockbox -> Vault door -> Keypad|Lockbox -> Vault door -> Keypad -> Lockbox|Vault door -> Keypad -> Lockbox -> Vault door/.test(loop.reason ?? ""), loop.reason);

    check("two requirements (an AND) are fine", ok(L.updateElement(r, box.id, { req: [keypad.id, door.id] })).elements.find((e) => e.id === box.id).req.length === 2);
    check("the roots are the elements nothing waits on", JSON.stringify(L.rootElements(r).map((e) => e.name)) === JSON.stringify(["Keypad"]));
    check("dependents are found", JSON.stringify(L.dependentsOf(r, keypad.id).map((e) => e.name)) === JSON.stringify(["Vault door"]));
    done();
});

test("deleting an element removes the requirements that pointed at it, and says how many", () => {
    const { check, done } = checks();
    const { r, keypad, door, box } = bank();

    const result = L.removeElement(r, keypad.id);
    check("it worked", result.ok === true, JSON.stringify(result));
    check("one requirement was cleaned up", result.removedReferences === 1, String(result.removedReferences));
    check("the door no longer waits on the keypad", result.robbery.elements.find((e) => e.id === door.id).req.length === 0);
    check("the lockbox still waits on the door", result.robbery.elements.find((e) => e.id === box.id).req[0] === door.id);
    check("deleting something that is not there is refused", L.removeElement(r, "e99").ok === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Locks, loot and effects
// ---------------------------------------------------------------------------------------------------------

test("locks are checked: each kind once, at most the cap, sensible numbers", () => {
    const { check, done } = checks();
    const { r, door } = bank();
    const lockWith = (lock) => L.updateElement(r, door.id, { locks: [lock] });

    check("a pick, a key and a pay lock are each valid", lockWith(pick).ok && lockWith(key).ok && lockWith(pay).ok);
    check("two locks of one kind are refused", L.updateElement(r, door.id, { locks: [pick, pick] }).ok === false);
    check("more locks than the cap are refused", L.updateElement(r, door.id, { locks: [pick, key, pay] }).ok === false);
    check("zero hits is refused", lockWith({ ...pick, hits: 0 }).ok === false);
    check("a tolerance over half the slider is refused", lockWith({ ...pick, tolerance: Math.floor(R.pickSliderMax / 2) + 1 }).ok === false);
    check("strikes of 0 (never jams) is allowed", lockWith({ ...pick, strikes: 0 }).ok);
    check("a fractional price is refused", lockWith({ ...pay, coins: 2.5 }).ok === false);
    check("a free price is refused", lockWith({ ...pay, coins: 0 }).ok === false);
    check("a key must be a namespaced item id", lockWith({ ...key, item: "pickaxe" }).ok === false);
    check("an unknown lock method is refused", lockWith({ kind: "magic" }).ok === false);
    check("clearing the locks is a normal edit", ok(L.updateElement(r, door.id, { locks: [] })).elements.find((e) => e.id === door.id).locks.length === 0);
    done();
});

test("only a chest has loot, and loot is a table path plus a few real items", () => {
    const { check, done } = checks();
    const { r, door, box } = bank();

    check("a door cannot be given a loot table", L.updateElement(r, door.id, { table: "chests/gold_2" }).ok === false);
    check("a door cannot be given items", L.updateElement(r, door.id, { items: [["minecraft:gold_ingot", 1]] }).ok === false);
    check("a chest can be given a different table", ok(L.updateElement(r, box.id, { table: "chests/simple_dungeon" })).elements.find((e) => e.id === box.id).table === "chests/simple_dungeon");
    check("a table can be cleared with null", ok(L.updateElement(r, box.id, { table: null })).elements.find((e) => e.id === box.id).table === undefined);
    check("a bad table path is refused", L.updateElement(r, box.id, { table: "Chests/Gold 2" }).ok === false);
    check("an amount over a stack is refused", L.updateElement(r, box.id, { items: [["minecraft:gold_ingot", 65]] }).ok === false);
    check("an item without a namespace is refused", L.updateElement(r, box.id, { items: [["gold_ingot", 1]] }).ok === false);
    check("too many kinds of item are refused", L.updateElement(r, box.id, { items: Array.from({ length: R.maxItemStacks + 1 }, (_, i) => [`minecraft:item_${i}`, 1]) }).ok === false);
    done();
});

test("effects are checked: a message needs text and an audience, a reward needs something to give, delays are bounded", () => {
    const { check, done } = checks();
    const { r, box } = bank();
    const doneWith = (...effects) => L.updateElement(r, box.id, { onDone: effects });

    check("a message, a reward and an end are valid", doneWith(say("hi"), { kind: "reward", coins: 5, bounty: 0, to: "actor" }, { kind: "end", result: "fail" }).ok);
    check("an empty message is refused", doneWith(say("   ")).ok === false);
    check("a message over the limit is refused", doneWith(say("x".repeat(R.maxTextLength + 1))).ok === false);
    check("an unknown channel is refused", doneWith({ ...say("hi"), channel: "megaphone" }).ok === false);
    check("an unknown audience is refused", doneWith(say("hi", "everyone")).ok === false);
    check("a sound id with spaces is refused", doneWith(say("hi", "all", { sound: "not a sound" })).ok === false);
    check("a reward of nothing is refused", doneWith({ kind: "reward", coins: 0, bounty: 0, to: "area" }).ok === false);
    check("a negative reward is refused", doneWith({ kind: "reward", coins: -1, bounty: 5, to: "area" }).ok === false);
    check("an end must win or fail", doneWith({ kind: "end", result: "draw" }).ok === false);
    check("a delay can be zero up to the cap", doneWith({ ...say("hi"), delaySeconds: R.maxDelaySeconds }).ok && doneWith({ ...say("hi"), delaySeconds: 0 }).ok);
    check("a delay over the cap is refused", doneWith({ ...say("hi"), delaySeconds: R.maxDelaySeconds + 1 }).ok === false);
    check("more effects than the cap are refused", doneWith(...Array.from({ length: R.maxEffectsPerList + 1 }, () => say("hi"))).ok === false);
    check("a zero delay is not stored (it means at once)", ok(doneWith({ ...say("hi"), delaySeconds: 0 })).elements.find((e) => e.id === box.id).onDone[0].delaySeconds === undefined);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Settings and the area
// ---------------------------------------------------------------------------------------------------------

test("settings change one at a time and are range-checked; the area is normalised and clearable", () => {
    const { check, done } = checks();
    let r = ok(L.newRobbery("bank", "Bank", "overworld"));

    check("a new robbery has the configured defaults", r.settings.cooldownSeconds === R.defaultCooldownSeconds && r.settings.timeLimitSeconds === R.defaultTimeLimitSeconds && r.settings.autoStart === true && r.settings.outlawsOnly === true && r.settings.roundOnly === false);
    r = ok(L.setSettings(r, { timeLimitSeconds: 0, roundOnly: true }));
    check("the patch landed and nothing else moved", r.settings.timeLimitSeconds === 0 && r.settings.roundOnly === true && r.settings.cooldownSeconds === R.defaultCooldownSeconds);
    check("a negative time is refused", L.setSettings(r, { cooldownSeconds: -1 }).ok === false);
    check("a fractional time is refused", L.setSettings(r, { cooldownSeconds: 1.5 }).ok === false);
    check("a time past the cap is refused", L.setSettings(r, { resetAfterSeconds: R.maxSettingSeconds + 1 }).ok === false);
    check("a flag must be a boolean", L.setSettings(r, { protect: "yes" }).ok === false);

    r = ok(L.setArea(r, [10, 70, 20], [2, 60, 5]));
    check("corners given in any order are normalised", JSON.stringify(r.area) === JSON.stringify({ min: [2, 60, 5], max: [10, 70, 20] }), JSON.stringify(r.area));
    check("an area above the build limit is refused", L.setArea(r, [0, 0, 0], [1, 999, 1]).ok === false);
    check("clearing the area works", ok(L.clearArea(r)).area === undefined);
    done();
});

test("the box contains every block of it whole, edges included, and nothing beyond", () => {
    const { check, done } = checks();
    const box = L.normalizeBox([10, 64, 10], [12, 66, 14]);

    check("a corner block's whole cube is inside", L.boxContains(box, 10, 64, 10) && L.boxContains(box, 10.99, 64.99, 10.99));
    check("the far corner block is inside up to just before the next block", L.boxContains(box, 12.99, 66.99, 14.99));
    check("one step beyond is outside", !L.boxContains(box, 13, 65, 12) && !L.boxContains(box, 11, 67, 12) && !L.boxContains(box, 11, 65, 15) && !L.boxContains(box, 9.99, 65, 12));
    check("its size counts blocks", JSON.stringify(L.boxSize(box)) === JSON.stringify({ x: 3, y: 3, z: 5 }));

    const edges = L.edgePoints(box, 1, 10000);
    check("edge points are unique", new Set(edges.map((p) => p.join(","))).size === edges.length);
    check("they include all eight corners of the outer cube", [[10, 64, 10], [13, 64, 10], [10, 67, 10], [13, 67, 15], [10, 64, 15], [13, 64, 15], [10, 67, 15], [13, 67, 10]].every((c) => edges.some((p) => p.join(",") === c.join(","))));
    check("the limit caps how many are returned", L.edgePoints(box, 1, 5).length === 5);
    check("a bigger spacing gives fewer points", L.edgePoints(box, 3, 10000).length < edges.length);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Saving and loading
// ---------------------------------------------------------------------------------------------------------

test("a whole robbery survives being saved and loaded, and the saved text uses the short keys", () => {
    const { check, done } = checks();
    const { r } = bank();

    const text = L.serialize(r);
    const back = L.parse(text);

    check("it parses", back.ok === true, JSON.stringify(back));
    check("it comes back exactly", back.ok && JSON.stringify(back.value) === JSON.stringify(r), back.ok ? "" : back.reason);
    check("the saved text is short-keyed JSON", text.includes('"nm":"Saint Diego Bank"') && !text.includes('"settings"') && !text.includes('"elements"'), text.slice(0, 120));
    check("a full bank fits in a small fraction of the cap", text.length < R.maxSavedChars / 4, `${text.length} of ${R.maxSavedChars}`);
    check("saving a loaded robbery gives the same text", back.ok && L.serialize(back.value) === text);
    done();
});

test("a robbery with the most elements allowed fits the saved-size cap when its elements are ordinary", () => {
    // An ordinary element: one lock and one message. (A very busy one, with two locks and several effects, takes
    // about twice this, which is why the store refuses an edit that would pass the size cap long before the element cap.)
    let r = ok(L.newRobbery("full", "Full", "overworld"));
    for (let i = 0; i < R.maxElements; i++) {
        r = added(L.addElement(r, {
            kind: i % 3 === 0 ? "door" : i % 3 === 1 ? "chest" : "switch", cells: [[i * 2, 64, 0]], locks: [pick],
            onDone: [say("Something happened over here, listen closely.", "area")]
        })).robbery;
    }

    assert.equal(r.elements.length, R.maxElements);
    const size = L.serialize(r).length;
    assert.ok(size <= R.maxSavedChars, `${R.maxElements} ordinary elements take ${size} of the ${R.maxSavedChars} characters`);
});

test("parse never throws, and says why when it cannot read something", () => {
    const { check, done } = checks();
    const { r } = bank();
    const text = L.serialize(r);
    const stored = JSON.parse(text);

    const mutate = (fn) => { const copy = JSON.parse(text); fn(copy); return JSON.stringify(copy); };

    const cases = [
        ["undefined", undefined], ["empty text", ""], ["not JSON", "not json at all"], ["an array", "[]"], ["null", "null"], ["a number", "7"],
        ["truncated", text.slice(0, text.length - 40)], ["an empty object", "{}"],
        ["a newer version", mutate((s) => { s.v = 2; })],
        ["an unknown dimension", mutate((s) => { s.d = "mars"; })],
        ["a bad id", mutate((s) => { s.id = "Bad Id"; })],
        ["a damaged element counter", mutate((s) => { s.n = "x"; })],
        ["a damaged area", mutate((s) => { s.a = [1, 2]; })],
        ["no settings", mutate((s) => { delete s.s; })],
        ["a setting out of range", mutate((s) => { s.s.cd = -5; })],
        ["no elements list", mutate((s) => { delete s.e; })],
        ["an element of an unknown kind", mutate((s) => { s.e[0].k = "zz"; })],
        ["an element with no id", mutate((s) => { delete s.e[0].i; })],
        ["a duplicate element id", mutate((s) => { s.e[1].i = s.e[0].i; })],
        ["a requirement on nothing", mutate((s) => { s.e[1].r = ["e99"]; })],
        ["two elements on one block", mutate((s) => { s.e[1].p = s.e[0].p; })],
        ["a requirement loop", mutate((s) => { s.e[0].r = [s.e[2].i]; })],
        ["an unknown lock method", mutate((s) => { s.e[0].l = [{ m: "magic" }]; })],
        ["an unknown effect", mutate((s) => { s.e[0].x = [{ a: "explode" }]; })],
        ["a string where cells should be", mutate((s) => { s.e[0].p = "here"; })]
    ];

    for (const [what, input] of cases) {
        let result;
        try { result = L.parse(input); } catch (error) { check(`${what}: does not throw`, false, String(error)); continue; }
        check(`${what}: refused with a reason`, result.ok === false && typeof result.reason === "string" && result.reason.length > 0, JSON.stringify(result));
    }

    check("a newer version is reported as left alone", /left alone/.test(L.parse(mutate((s) => { s.v = 2; })).reason ?? ""));
    check("the original is still fine (the cases above only touched copies)", L.parse(text).ok && stored.v === 1);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Can it run?
// ---------------------------------------------------------------------------------------------------------

test("whyNotRunnable is the builder's checklist: empty, no way to succeed, an area is missing, a pointless chest", () => {
    const { check, done } = checks();
    let r = ok(L.newRobbery("bank", "Bank", "overworld"));

    check("an empty robbery has no elements", L.whyNotRunnable(r).some((p) => /no elements/.test(p)));

    const door = added(L.addElement(r, { kind: "door", name: "Gate", cells: [[0, 64, 0]], locks: [pay] }));
    r = door.robbery;
    check("with nothing that makes it a success, it says so, and says it can sit on any element", L.whyNotRunnable(r).some((p) => /nothing makes it a success/.test(p) && /on any element/.test(p)), L.whyNotRunnable(r).join(" | "));
    check("and no longer tells the builder it must be the last element", !L.whyNotRunnable(r).some((p) => /last element/.test(p)), L.whyNotRunnable(r).join(" | "));
    check("the default fail-when-empty needs an area", L.whyNotRunnable(r).some((p) => /area/.test(p)));

    r = ok(L.setSettings(r, { failWhenEmptySeconds: 0 }));
    r = ok(L.updateElement(r, door.element.id, { onDone: [{ kind: "end", result: "win" }] }));
    check("an end-win effect and no area need clears the checklist", L.whyNotRunnable(r).length === 0, L.whyNotRunnable(r).join(" | "));

    r = ok(L.updateElement(r, door.element.id, { onDone: [say("Open!", "area"), { kind: "end", result: "win" }] }));
    check("an effect that goes to the area needs the area", L.whyNotRunnable(r).some((p) => /goes to the area/.test(p)));
    r = ok(L.setArea(r, [0, 60, 0], [5, 70, 5]));
    check("setting the area fixes it", L.whyNotRunnable(r).length === 0, L.whyNotRunnable(r).join(" | "));

    const idle = added(L.addElement(r, { kind: "chest", name: "Idle", cells: [[9, 64, 9]] }));
    check("a chest with no loot, lock or requirement is flagged", L.whyNotRunnable(idle.robbery).some((p) => /Idle.*does nothing/.test(p)));

    check("the finished bank is runnable", L.whyNotRunnable(bank().r).length === 0, L.whyNotRunnable(bank().r).join(" | "));
    done();
});

test("an end-win effect anywhere counts: in a hook, on an element, with a delay", () => {
    const { check, done } = checks();
    const base = ok(L.setSettings(ok(L.newRobbery("bank", "Bank", "overworld")), { failWhenEmptySeconds: 0 }));
    const withDoor = added(L.addElement(base, { kind: "door", cells: [[0, 64, 0]] }));

    check("in the win hook", L.whyNotRunnable(ok(L.setHook(withDoor.robbery, "win", [{ kind: "end", result: "win" }]))).length === 0);
    check("in the start hook, delayed", L.whyNotRunnable(ok(L.setHook(withDoor.robbery, "start", [{ kind: "end", result: "win", delaySeconds: 30 }]))).length === 0);
    check("an end-fail alone does not count", L.whyNotRunnable(ok(L.setHook(withDoor.robbery, "fail", [{ kind: "end", result: "fail" }]))).some((p) => /nothing makes it a success/.test(p)));
    done();
});

test("lookups: the element at a block, found by any of its cells; positions key by dimension", () => {
    const { check, done } = checks();
    const { r, door, keypad } = bank();

    check("either half of the door finds it", L.elementAt(r, [104, 65, 170])?.id === door.id && L.elementAt(r, [104, 66, 170])?.id === door.id);
    check("the keypad is found", L.elementAt(r, [103, 66, 171])?.id === keypad.id);
    check("a block that is bound to nothing finds nothing", L.elementAt(r, [0, 0, 0]) === undefined);
    check("an element is found by id", L.findElement(r, door.id)?.name === "Vault door" && L.findElement(r, "e99") === undefined);
    check("a position key includes the dimension", L.posKey("overworld", [1, 2, 3]) === "overworld|1,2,3" && L.posKey("nether", [1, 2, 3]) !== L.posKey("overworld", [1, 2, 3]));
    check("a dimension id loses its namespace", L.sameDimension("minecraft:overworld") === "overworld" && L.sameDimension("the_end") === "the_end");
    done();
});

test("an edit that fails leaves the original untouched (robberies are immutable)", () => {
    const { r, door } = bank();
    const before = L.serialize(r);

    L.updateElement(r, door.id, { req: [door.id] });
    L.addElement(r, { kind: "door", cells: [] });
    L.removeElement(r, "e99");
    L.setSettings(r, { cooldownSeconds: -1 });

    assert.equal(L.serialize(r), before);
});
