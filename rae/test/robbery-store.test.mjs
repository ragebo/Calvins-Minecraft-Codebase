import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks } from "./helpers.mjs";
import { L, bank, ok } from "./robbery-fixtures.mjs";

// core/robberystore.ts: where robberies live. The contract is that authored work is never lost quietly: every edit is
// written at once under its own world property, an edit that does not fit is refused before anything changes, an
// unreadable save is listed and never overwritten, and a reload (forgetting what was read) finds everything again.

const S = await load("core/robberystore.js");
const { ROBBERY: R } = await load("config/balance.js");

const property = (id) => `rae:robbery:def:${id}`;

function fresh() {
    fake.reset();
    S.forgetLoaded();
}

const save = (robbery) => {
    const result = S.saveRobbery(robbery);
    assert.equal(result.ok, true, result.reason);
    return result.robbery;
};

test("an empty world has no robberies and no bound blocks", () => {
    fresh();
    const { check, done } = checks();

    check("none listed", S.listStored().length === 0 && S.allRobberies().length === 0);
    check("none by id", S.getRobbery("bank") === undefined && S.getStored("bank") === undefined);
    check("no block is bound", S.boundAt("minecraft:overworld", 1, 2, 3) === undefined && S.anyBoundBlocks() === false);
    check("nothing to clean up", S.dirtyCount() === 0 && S.dirtyEntries().length === 0);
    done();
});

test("saving writes a world property at once, and a reload finds exactly what was saved", () => {
    fresh();
    const { check, done } = checks();
    const { r } = bank();

    save(r);

    const text = world.getDynamicProperty(property("bank"));
    check("it is a world property named for the id", typeof text === "string" && text.length > 0);
    check("it is the saved text of the robbery", text === L.serialize(r));

    S.forgetLoaded();                                    // what a script reload does
    const back = S.getRobbery("bank");
    check("after a reload it is still there", back !== undefined);
    check("and identical", JSON.stringify(back) === JSON.stringify(r));
    check("listed", S.listStored().map((s) => s.id).join() === "bank");
    done();
});

test("an edit that does not fit in a save is refused and changes nothing", () => {
    fresh();
    const { check, done } = checks();
    const { r } = bank();
    save(r);
    const before = world.getDynamicProperty(property("bank"));

    // Every effect list full of the longest message: each list is valid on its own, but together they are over the cap.
    const long = Array.from({ length: R.maxEffectsPerList }, () => ({ kind: "say", text: "x".repeat(R.maxTextLength), channel: "chat", to: "area" }));
    let fat = r;
    for (const id of ["e1", "e2", "e3"]) fat = ok(L.updateElement(fat, id, { onDone: long, onFail: long }));
    for (const hook of ["start", "win", "fail"]) fat = ok(L.setHook(fat, hook, long));
    check("the fat robbery really is over the cap", L.serialize(fat).length > R.maxSavedChars, String(L.serialize(fat).length));

    const refused = S.saveRobbery(fat);
    check("refused", refused.ok === false && /characters/.test(refused.reason), JSON.stringify(refused));
    check("the property is untouched", world.getDynamicProperty(property("bank")) === before);
    check("and so is what is in memory", JSON.stringify(S.getRobbery("bank")) === JSON.stringify(r));
    done();
});

test("only so many robberies fit, and the limit refuses a new one without touching the others", () => {
    fresh();
    const { check, done } = checks();

    for (let i = 0; i < R.maxRobberies; i++) save(ok(L.newRobbery(`rob${i}`, `Robbery ${i}`, "overworld")));

    const extra = S.saveRobbery(ok(L.newRobbery("one_more", "One more", "overworld")));
    check("the next new one is refused", extra.ok === false && /room for/.test(extra.reason), JSON.stringify(extra));
    check("an existing one can still be edited", S.saveRobbery(ok(L.renameRobbery(S.getRobbery("rob0"), "Renamed"))).ok === true);
    check("the count is what it was", S.listStored().length === R.maxRobberies);
    done();
});

test("a save the game refuses to write is reported, and nothing changes", () => {
    fresh();
    const { check, done } = checks();
    const { r } = bank();
    save(ok(L.newRobbery("bank", "Old name", "overworld")));
    const before = world.getDynamicProperty(property("bank"));

    fake.dynamicStringLimit = 20;
    const result = S.saveRobbery(r);
    fake.dynamicStringLimit = null;

    check("refused with the engine's reason", result.ok === false && /refused the save/.test(result.reason), JSON.stringify(result));
    check("the old save is untouched", world.getDynamicProperty(property("bank")) === before);
    check("memory still has the old robbery", S.getRobbery("bank").name === "Old name");
    done();
});

test("an unreadable save is listed with the reason, never overwritten, and can be deleted and undone", () => {
    fresh();
    const { check, done } = checks();

    world.setDynamicProperty(property("broken"), "{ this is not a robbery");
    world.setDynamicProperty(property("future"), JSON.stringify({ v: 99, id: "future" }));
    world.setDynamicProperty(property("wrong"), L.serialize(ok(L.newRobbery("other", "Other", "overworld"))));
    save(ok(L.newRobbery("fine", "Fine", "overworld")));
    S.forgetLoaded();

    const byId = new Map(S.listStored().map((s) => [s.id, s]));
    check("the good one reads", byId.get("fine")?.ok === true);
    check("garbage is listed as unreadable with a reason", byId.get("broken")?.ok === false && /JSON/.test(byId.get("broken").problem), JSON.stringify(byId.get("broken")));
    check("a different version says so", byId.get("future")?.ok === false && /different version/.test(byId.get("future").problem), JSON.stringify(byId.get("future")));
    check("a save under the wrong name is unreadable too", byId.get("wrong")?.ok === false && /other/.test(byId.get("wrong").problem), JSON.stringify(byId.get("wrong")));
    check("unreadable ones are not in the playable list", S.allRobberies().map((x) => x.id).join() === "fine");

    const overwrite = S.saveRobbery(ok(L.newRobbery("broken", "Mine", "overworld")));
    check("saving over an unreadable one is refused", overwrite.ok === false && /cannot be read/.test(overwrite.reason), JSON.stringify(overwrite));
    check("its text is untouched", world.getDynamicProperty(property("broken")) === "{ this is not a robbery");

    check("deleting it is allowed", S.deleteRobbery("broken").ok === true && world.getDynamicProperty(property("broken")) === undefined);
    check("and undo brings the damaged text back", S.undoLast("broken").ok === true && world.getDynamicProperty(property("broken")) === "{ this is not a robbery");
    done();
});

test("one level of undo: an edit, a create, a delete, and undoing again redoes", () => {
    fresh();
    const { check, done } = checks();

    const v1 = save(ok(L.newRobbery("bank", "First", "overworld")));
    check("a robbery that was just created can be undone away", S.undoAvailable("bank"));

    const v2 = save(ok(L.renameRobbery(v1, "Second")));
    check("edit then undo goes back to the first", S.undoLast("bank").ok && S.getRobbery("bank").name === "First");
    check("the property went back too", world.getDynamicProperty(property("bank")) === L.serialize(v1));
    check("undo again redoes the edit", S.undoLast("bank").ok && S.getRobbery("bank").name === "Second");
    check("redo wrote the property", world.getDynamicProperty(property("bank")) === L.serialize(v2));

    check("an edit that changes nothing does not use up the undo", (() => { save(v2); return S.undoLast("bank").ok && S.getRobbery("bank").name === "First"; })());

    S.undoLast("bank");                                   // back to Second
    check("delete removes it", S.deleteRobbery("bank").ok && S.getRobbery("bank") === undefined && world.getDynamicProperty(property("bank")) === undefined);
    check("undo of a delete brings it back", S.undoLast("bank").ok && S.getRobbery("bank")?.name === "Second");

    check("there is nothing to undo for a robbery never saved", S.undoLast("ghost").ok === false);
    check("deleting one that does not exist is refused", S.deleteRobbery("ghost").ok === false);
    done();
});

test("a robbery can be undone right back to not existing", () => {
    fresh();
    const { check, done } = checks();

    save(ok(L.newRobbery("bank", "Fresh", "overworld")));
    check("undo removes it", S.undoLast("bank").ok && S.getRobbery("bank") === undefined && world.getDynamicProperty(property("bank")) === undefined);
    check("redo makes it again", S.undoLast("bank").ok && S.getRobbery("bank")?.name === "Fresh");
    done();
});

test("blocks are found by position, in any spelling of the dimension, and the index follows edits", () => {
    fresh();
    const { check, done } = checks();
    const { r, keypad, door, box } = bank();

    save(r);

    check("the keypad block", S.boundAt("minecraft:overworld", 103, 66, 171)?.element === keypad.id);
    check("it says which robbery", S.boundAt("minecraft:overworld", 103, 66, 171)?.robbery === "bank");
    check("a bare dimension id works too", S.boundAt("overworld", 103, 66, 171)?.element === keypad.id);
    check("both halves of the door", S.boundAt("overworld", 104, 65, 170)?.element === door.id && S.boundAt("overworld", 104, 66, 170)?.element === door.id);
    check("the lockbox", S.boundAt("overworld", 107, 65, 175)?.element === box.id);
    check("another block is nobody's", S.boundAt("overworld", 0, 0, 0) === undefined);
    check("the same coordinates in the nether are nobody's", S.boundAt("minecraft:nether", 103, 66, 171) === undefined);

    save(ok(L.removeElement(r, keypad.id)));
    check("a removed element's block is free at once", S.boundAt("overworld", 103, 66, 171) === undefined);

    S.deleteRobbery("bank");
    check("and a deleted robbery binds nothing", S.anyBoundBlocks() === false);
    done();
});

test("two robberies keep their blocks apart", () => {
    fresh();
    const { check, done } = checks();

    save(bank("bank").r);
    let second = ok(L.newRobbery("mine", "The Mine", "overworld"));
    second = L.addElement(second, { kind: "door", cells: [[500, 40, 500]] }).robbery;
    save(second);

    check("the bank's block belongs to the bank", S.boundAt("overworld", 103, 66, 171)?.robbery === "bank");
    check("the mine's block belongs to the mine", S.boundAt("overworld", 500, 40, 500)?.robbery === "mine");
    done();
});

test("the raw text of a robbery is available for a backup", () => {
    fresh();
    const { check, done } = checks();
    const { r } = bank();
    save(r);

    check("it is the saved text", S.rawText("bank") === L.serialize(r));
    check("nothing for an id that is not saved", S.rawText("ghost") === undefined);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Blocks a run has changed and not yet put back
// ---------------------------------------------------------------------------------------------------------

const door = (pos = [104, 65, 170], robbery = "bank") => ({ robbery, dimension: "overworld", pos, action: "close" });
const chest = (pos = [107, 65, 175], robbery = "bank") => ({ robbery, dimension: "overworld", pos, action: "empty" });

test("a changed block is noted at once, survives a reload, and is crossed off when put back", () => {
    fresh();
    const { check, done } = checks();

    check("noting it succeeds", S.markDirty(door()) && S.markDirty(chest()));
    check("it is a world property right now", typeof world.getDynamicProperty("rae:robbery:dirty") === "string");
    check("noting the same block twice is one note", S.markDirty(door()) && S.dirtyCount() === 2);

    S.forgetLoaded();
    check("after a reload both are still waiting", S.dirtyCount() === 2);
    check("with what to do to each", S.dirtyEntries().some((d) => d.action === "close" && d.pos.join() === "104,65,170") && S.dirtyEntries().some((d) => d.action === "empty" && d.pos.join() === "107,65,175"));
    check("asked by position", S.isDirtyAt("overworld", [104, 65, 170]) && !S.isDirtyAt("overworld", [1, 2, 3]));
    check("asked by robbery", S.robberyIsDirty("bank") && !S.robberyIsDirty("mine"));

    S.clearDirty(door());
    check("crossed off", S.dirtyCount() === 1 && !S.isDirtyAt("overworld", [104, 65, 170]));
    S.clearDirty(chest());
    check("and with none left the property is removed", world.getDynamicProperty("rae:robbery:dirty") === undefined && !S.robberyIsDirty("bank"));
    done();
});

test("a damaged cleanup list is ignored entry by entry, not all or nothing", () => {
    fresh();
    const { check, done } = checks();

    world.setDynamicProperty("rae:robbery:dirty", JSON.stringify(["bank|overworld|1,2,3|c", "garbage", 42, "bank|overworld|x,y,z|e", "bank|overworld|4,5,6|e"]));

    check("the two good entries are kept", S.dirtyCount() === 2 && S.isDirtyAt("overworld", [1, 2, 3]) && S.isDirtyAt("overworld", [4, 5, 6]), String(S.dirtyCount()));

    S.forgetLoaded();
    world.setDynamicProperty("rae:robbery:dirty", "not json");
    check("an unreadable list is treated as empty", S.dirtyCount() === 0);
    done();
});

test("the cleanup list has a cap, and a note that cannot be kept says so", () => {
    fresh();
    const { check, done } = checks();

    for (let i = 0; i < R.maxDirtyEntries; i++) S.markDirty({ robbery: "bank", dimension: "overworld", pos: [i, 70, 0], action: "close" });
    check("full", S.dirtyCount() === R.maxDirtyEntries);
    check("one more is refused", S.markDirty({ robbery: "bank", dimension: "overworld", pos: [9999, 70, 0], action: "close" }) === false);
    check("and not added", S.dirtyCount() === R.maxDirtyEntries);

    fresh();
    fake.dynamicStringLimit = 5;
    check("a write the game refuses answers false", S.markDirty(door()) === false);
    fake.dynamicStringLimit = null;
    done();
});
