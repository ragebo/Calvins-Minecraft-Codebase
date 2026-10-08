import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks } from "./helpers.mjs";
import { L, at, ok, added } from "./robbery-fixtures.mjs";

// Item frames in the robbery framework, the parts that need no player: what a frame element is as data (one block, loot,
// saved and read back), which blocks can be one, and the world layer that saves a frame as it is, empties it, puts it back
// with its item, and clears out an item a punch popped. In the game a frame is a BLOCK whose item no script can read or set,
// so the saved copy (a one-block structure) is the only thing that can put the item back.

const Meta = await load("logic/robberymeta.js");
const Class = await load("logic/blockclass.js");
const World = await load("core/robberyworld.js");
const Edit = await load("core/robberyedit.js");
const S = await load("core/robberystore.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

const FRAME = [200, 65, 200];
const GLOW = [202, 65, 200];

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    fake.placeBlock("overworld", at(FRAME), "minecraft:frame", { facing_direction: 2 });
    fake.setFrameItem("overworld", at(FRAME), "minecraft:diamond");
    fake.placeBlock("overworld", at(GLOW), "minecraft:glow_frame", { facing_direction: 3 });
    fake.setFrameItem("overworld", at(GLOW), "minecraft:emerald", 3);
}

const base = () => ok(L.newRobbery("jewels", "Jewelry Store", "overworld"));

// ---------------------------------------------------------------------------------------------------------
// As data
// ---------------------------------------------------------------------------------------------------------

test("a frame element is one block with loot, and is saved and read back exactly", () => {
    const { check, done } = checks();

    const made = added(L.addElement(base(), { kind: "frame", name: "Necklace", cells: [FRAME], table: "chests/gold_2", items: [["minecraft:diamond", 2]] }));

    check("it is a frame with its loot", made.element.kind === "frame" && made.element.items[0][0] === "minecraft:diamond" && made.element.table === "chests/gold_2");
    check("it reads as an element that holds loot", L.holdsLoot(made.element) === true);

    const back = L.parse(L.serialize(made.robbery));
    check("saved and read back, it is the same", back.ok === true && JSON.stringify(back.value) === JSON.stringify(made.robbery), JSON.stringify(back));
    check("its short code in the save is fr", JSON.parse(L.serialize(made.robbery)).e[0].k === "fr");
    done();
});

test("a frame is bound to exactly one block, and says so when asked for more", () => {
    const { check, done } = checks();

    const two = L.addElement(base(), { kind: "frame", cells: [FRAME, GLOW], items: [["minecraft:diamond", 1]] });
    check("two blocks are refused, with a sentence", two.ok === false && /at most 1 block\b/.test(two.reason), two.reason);

    const none = L.addElement(base(), { kind: "frame", cells: [], items: [["minecraft:diamond", 1]] });
    check("none is refused too", none.ok === false);

    check("a chest still takes two", L.addElement(base(), { kind: "chest", cells: [[1, 65, 1], [2, 65, 1]] }).ok === true);
    done();
});

test("loot can be set on a frame and on a chest, and on nothing else", () => {
    const { check, done } = checks();
    let r = base();
    const frame = added(L.addElement(r, { kind: "frame", name: "Necklace", cells: [FRAME] }));
    r = frame.robbery;
    const sw = added(L.addElement(r, { kind: "switch", name: "Button", cells: [[1, 65, 1]] }));
    r = sw.robbery;

    check("a frame takes loot", L.updateElement(r, frame.element.id, { items: [["minecraft:emerald", 3]] }).ok === true);
    check("so does its table", L.updateElement(r, frame.element.id, { table: "chests/gold_2" }).ok === true);
    const refused = L.updateElement(r, sw.element.id, { items: [["minecraft:emerald", 3]] });
    check("a switch does not, and the sentence names frames", refused.ok === false && /chest or an item frame/.test(refused.reason), refused.reason);
    check("an element that is neither holds no loot", L.holdsLoot(sw.element) === false);
    done();
});

test("a frame with no loot and nothing set to happen is on the checklist as doing nothing", () => {
    const { check, done } = checks();
    const win = { kind: "end", result: "win" };

    const bare = added(L.addElement(base(), { kind: "frame", name: "Empty case", cells: [FRAME], onDone: [win] }));
    const wired = L.whyNotRunnable(bare.robbery);
    check("with only a win effect it is fine", !wired.some((p) => /does nothing/.test(p)), wired.join("; "));

    const nothing = added(L.addElement(base(), { kind: "frame", name: "Empty case", cells: [FRAME] }));
    check("with nothing it is on the list", L.whyNotRunnable(nothing.robbery).some((p) => /"Empty case": an item frame with no loot/.test(p)), L.whyNotRunnable(nothing.robbery).join("; "));

    const loot = added(L.addElement(base(), { kind: "frame", name: "Case", cells: [FRAME], items: [["minecraft:diamond", 1]], onDone: [win] }));
    check("with loot it is fine", !L.whyNotRunnable(loot.robbery).some((p) => /does nothing/.test(p)));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Which blocks
// ---------------------------------------------------------------------------------------------------------

test("an item frame and a glow item frame are frames; nothing else is", () => {
    const { check, done } = checks();

    check("minecraft:frame", Class.classOfBlockType("minecraft:frame") === "frame");
    check("minecraft:glow_frame", Class.classOfBlockType("minecraft:glow_frame") === "frame");
    check("a bare id too", Class.classOfBlockType("frame") === "frame" && Class.classOfBlockType("glow_frame") === "frame");
    check("a picture frame by another name is not", Class.classOfBlockType("minecraft:item_frame") === "other" && Class.classOfBlockType("minecraft:stone") === "other");
    check("the old classes are as they were", Class.classOfBlockType("minecraft:chest") === "container" && Class.classOfBlockType("minecraft:iron_door") === "door" && Class.classOfBlockType("minecraft:stone_button") === "button");
    done();
});

test("a frame block is suggested as a frame element, and only a frame can be one", () => {
    const { check, done } = checks();

    check("suggested", Meta.suggestKind(Class.classOfBlockType("minecraft:frame")) === "frame" && Meta.suggestKind(Class.classOfBlockType("minecraft:glow_frame")) === "frame");
    check("the old suggestions are as they were", Meta.suggestKind("container") === "chest" && Meta.suggestKind("door") === "door" && Meta.suggestKind("button") === "switch");

    check("a frame can be one", Meta.whyBlockCannotBe("frame", "minecraft:frame") === undefined && Meta.whyBlockCannotBe("frame", "minecraft:glow_frame") === undefined);
    const stone = Meta.whyBlockCannotBe("frame", "minecraft:stone");
    check("stone cannot, and the sentence says what can", /stone is not an item frame/.test(stone) && /item frame or a glow item frame/.test(stone), stone);
    check("air cannot be anything", Meta.whyBlockCannotBe("frame", "minecraft:air") === "there is no block there");
    check("a frame can still be a plain switch if the builder wants", Meta.whyBlockCannotBe("switch", "minecraft:frame") === undefined);
    done();
});

test("a frame element is described with its loot and its noun", () => {
    const { check, done } = checks();
    const made = added(L.addElement(base(), { kind: "frame", name: "Necklace", cells: [FRAME], items: [["minecraft:diamond", 2]] }));
    const lines = Meta.describeElement(made.robbery, made.element).map((l) => l.replace(/§./g, ""));

    check("it names itself an item frame", lines[0].includes("item frame"), lines[0]);
    check("it lists its loot", lines.some((l) => /^Loot: minecraft:diamond 2$/.test(l)), lines.join(" | "));
    check("the label is Frame", L.kindLabel("frame") === "Frame");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The world layer
// ---------------------------------------------------------------------------------------------------------

test("a frame's saved copy is named by robbery and position, with a minus sign spelt as an m", () => {
    const { check, done } = checks();

    check("an ordinary place", World.frameStructureId("jewels", [200, 65, 200]) === `${R.frameStructurePrefix}jewels_200_65_200`);
    check("negative coordinates", World.frameStructureId("jewels", [-251, -60, 186]) === `${R.frameStructurePrefix}jewels_m251_m60_186`);
    check("the id has the namespace a structure needs", /^[a-z0-9_]+:[a-z0-9_]+$/.test(World.frameStructureId("jewels", [-1, 0, -1])));
    done();
});

test("capturing a frame saves what it shows, and capturing again keeps the newer item", () => {
    setup();
    const { check, done } = checks();

    const first = World.captureFrame("overworld", "jewels", FRAME);
    check("the first save works", first.ok === true, JSON.stringify(first));
    check("a copy exists", World.frameIsCaptured("jewels", FRAME) === true);
    check("it is a World-mode, entity-free structure of one block", fake.structureLog.some((e) => e.op === "create" && e.options.saveMode === "World" && e.options.includeEntities === false && e.from.x === 200 && e.to.x === 200));

    // The builder changes what the frame shows and saves again: the old copy must go, since an id must be new to be made.
    fake.setFrameItem("overworld", at(FRAME), "minecraft:gold_ingot", 4);
    check("saving again works", World.captureFrame("overworld", "jewels", FRAME).ok === true);

    fake.setFrameItem("overworld", at(FRAME), "minecraft:stick");
    World.emptyFrame("overworld", FRAME);
    World.restoreFrame("overworld", "jewels", FRAME);
    check("and the newer item is what comes back", JSON.stringify(fake.frameItemAt("overworld", at(FRAME))) === JSON.stringify({ typeId: "minecraft:gold_ingot", amount: 4 }), JSON.stringify(fake.frameItemAt("overworld", at(FRAME))));
    done();
});

test("a frame cannot be saved when it is not a frame, is not loaded, or the game refuses, and each says why", () => {
    setup();
    const { check, done } = checks();

    fake.placeBlock("overworld", at([5, 65, 5]), "minecraft:stone");
    const stone = World.captureFrame("overworld", "jewels", [5, 65, 5]);
    check("stone", stone.ok === false && /there is no item frame at 5, 65, 5/.test(stone.problem), JSON.stringify(stone));
    check("and nothing was made", World.frameIsCaptured("jewels", [5, 65, 5]) === false);

    fake.setUnloaded("overworld", [{ from: { x: 190, y: 0, z: 190 }, to: { x: 210, y: 100, z: 210 } }]);
    const far = World.captureFrame("overworld", "jewels", FRAME);
    check("an unloaded chunk (a structure there would be air, silently)", far.ok === false && /not loaded/.test(far.problem), JSON.stringify(far));
    fake.setUnloaded("overworld", []);

    fake.structureMax = 0;
    const refused = World.captureFrame("overworld", "jewels", FRAME);
    check("the game refusing is reported, not thrown", refused.ok === false && /exceed/.test(refused.problem), JSON.stringify(refused));
    done();
});

test("emptying a frame leaves the same frame, facing the same way, showing nothing", () => {
    setup();
    const { check, done } = checks();

    check("it showed something", fake.frameItemAt("overworld", at(FRAME)) !== undefined);
    check("emptying works", World.emptyFrame("overworld", FRAME) === true);
    check("it shows nothing now", fake.frameItemAt("overworld", at(FRAME)) === undefined);

    const block = fake.blockAt("overworld", at(FRAME));
    check("it is still a frame, with the same facing", block.typeId === "minecraft:frame" && block.permutation.getState("facing_direction") === 2, `${block.typeId} ${block.permutation.getState("facing_direction")}`);
    check("a glow frame keeps being a glow frame", World.emptyFrame("overworld", GLOW) === true && fake.blockAt("overworld", at(GLOW)).typeId === "minecraft:glow_frame" && fake.blockAt("overworld", at(GLOW)).permutation.getState("facing_direction") === 3);

    check("where there is no frame there is nothing to empty", World.emptyFrame("overworld", [5, 65, 5]) === true);
    fake.setUnloaded("overworld", [{ from: { x: 190, y: 0, z: 190 }, to: { x: 210, y: 100, z: 210 } }]);
    check("an unloaded frame cannot be reached", World.emptyFrame("overworld", FRAME) === false);
    done();
});

test("emptying where a frame no longer stands leaves whatever is there alone", () => {
    setup();
    const { check, done } = checks();

    fake.placeBlock("overworld", at(FRAME), "minecraft:chest");
    const chest = fake.blockAt("overworld", at(FRAME));
    chest.getComponent("minecraft:inventory").container.addItem(new fakeApi.ItemStack("minecraft:diamond", 3));

    check("nothing to empty, and no harm done", World.emptyFrame("overworld", FRAME) === true);
    check("the chest that stands there now still has its diamonds", chest.getComponent("minecraft:inventory").container.getItem(0)?.amount === 3);
    done();
});

test("restoring a frame puts it back with its item, and says when it cannot", () => {
    setup();
    const { check, done } = checks();

    World.captureFrame("overworld", "jewels", FRAME);
    World.emptyFrame("overworld", FRAME);
    check("empty before", fake.frameItemAt("overworld", at(FRAME)) === undefined);

    check("restored", World.restoreFrame("overworld", "jewels", FRAME) === "restored");
    check("with its item", JSON.stringify(fake.frameItemAt("overworld", at(FRAME))) === JSON.stringify({ typeId: "minecraft:diamond", amount: 1 }));

    // Even if the frame itself was knocked out of the wall, putting it back makes it again.
    fake.placeBlock("overworld", at(FRAME), "minecraft:air");
    check("a frame that is gone is made again", World.restoreFrame("overworld", "jewels", FRAME) === "restored" && fake.blockAt("overworld", at(FRAME)).typeId === "minecraft:frame" && fake.frameItemAt("overworld", at(FRAME))?.typeId === "minecraft:diamond");

    check("a frame never saved is missing, for good", World.restoreFrame("overworld", "jewels", GLOW) === "missing");

    fake.setUnloaded("overworld", [{ from: { x: 190, y: 0, z: 190 }, to: { x: 210, y: 100, z: 210 } }]);
    check("an unloaded one is for later", World.restoreFrame("overworld", "jewels", FRAME) === "unreachable");
    done();
});

test("clearing out what a punch popped takes only the items named, only near the frame", () => {
    setup();
    const { check, done } = checks();
    const dim = fake.dimension("overworld");
    const centre = { x: 200.5, y: 65.5, z: 200.5 };

    const popped = dim.spawnItem({ typeId: "minecraft:diamond", amount: 1 }, { x: 200.5, y: 65.5, z: 200.5 });
    const lying = dim.spawnItem({ typeId: "minecraft:stick", amount: 5 }, { x: 200.9, y: 65, z: 200.2 });
    const far = dim.spawnItem({ typeId: "minecraft:diamond", amount: 1 }, { x: 230, y: 65, z: 230 });

    const removed = World.removeItemsNear("overworld", centre, R.frameCleanupReach, new Set([popped.id, far.id]));

    check("one went", removed === 1, String(removed));
    check("the popped item is gone", popped.isValid === false);
    check("an unnamed item beside it was left alone", lying.isValid === true);
    check("a named one too far away was left alone", far.isValid === true);
    check("naming nothing removes nothing", World.removeItemsNear("overworld", centre, R.frameCleanupReach, new Set()) === 0);
    done();
});

test("loot is made from a table and fixed items, and dropped where it is told", () => {
    setup();
    const { check, done } = checks();
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);

    const made = World.lootStacks("chests/gold_2", [["minecraft:diamond", 2], ["minecraft:emerald", 5]]);
    check("the table's roll first, then the items", made.stacks.map((s) => `${s.typeId}x${s.amount}`).join() === "minecraft:gold_ingotx12,minecraft:diamondx2,minecraft:emeraldx5", made.stacks.map((s) => s.typeId).join());
    check("nothing went wrong", made.problems.length === 0);

    const missing = World.lootStacks("chests/nothing", []);
    check("a table that is not there is a problem, not a crash", missing.stacks.length === 0 && /no loot table chests\/nothing/.test(missing.problems.join()));

    check("dropping puts them on the ground", World.dropItems("overworld", { x: 1, y: 65, z: 1 }, made.stacks) === 3 && fake.dimension("overworld").spawnedItems.length === 3);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Binding one
// ---------------------------------------------------------------------------------------------------------

test("binding a frame saves it as it is; binding anything else as a frame is refused", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);

    const bound = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });
    check("it works", bound.ok === true, JSON.stringify(bound));
    check("with no warning", bound.ok && bound.note === undefined);
    check("the frame has a saved copy", World.frameIsCaptured("jewels", FRAME) === true);
    check("the element is a frame on that block", bound.ok && bound.element.kind === "frame" && bound.element.cells[0].join() === FRAME.join());

    fake.placeBlock("overworld", at([5, 65, 5]), "minecraft:stone");
    const stone = Edit.addElementAt("jewels", { kind: "frame", name: "Stone", pos: [5, 65, 5], withNeighbour: false });
    check("stone as a frame is refused", stone.ok === false && /stone is not an item frame/.test(stone.reason), JSON.stringify(stone));
    done();
});

test("a frame that cannot be saved is still bound, and the builder is told what that means", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    fake.structureMax = 0;

    const bound = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    check("it is bound", bound.ok === true);
    check("with a warning that nothing can put it back", bound.ok && /could not be saved/.test(bound.note ?? "") && /nothing can put it back/.test(bound.note ?? ""), JSON.stringify(bound));
    check("and no copy exists", World.frameIsCaptured("jewels", FRAME) === false);

    fake.structureMax = Infinity;
    const again = Edit.recaptureFrame("jewels", bound.element.id);
    check("saving it again works once the game allows", again.ok === true && World.frameIsCaptured("jewels", FRAME) === true, JSON.stringify(again));
    done();
});

test("saving a frame again says why it could not, and refuses what is not a frame element", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    const frame = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });
    const button = (fake.placeBlock("overworld", at([5, 65, 5]), "minecraft:stone_button"), Edit.addElementAt("jewels", { kind: "switch", name: "Button", pos: [5, 65, 5], withNeighbour: false }));

    check("an unknown robbery", Edit.recaptureFrame("nobody", "e1").ok === false);
    check("an unknown element", /gone/.test(Edit.recaptureFrame("jewels", "e99").reason));
    check("a button is not a frame", /not an item frame/.test(Edit.recaptureFrame("jewels", button.element.id).reason));

    fake.placeBlock("overworld", at(FRAME), "minecraft:air");
    const gone = Edit.recaptureFrame("jewels", frame.element.id);
    check("a frame that has been taken down", gone.ok === false && /there is no item frame at 200, 65, 200/.test(gone.reason), JSON.stringify(gone));
    done();
});

test("moving a frame element to another frame saves the new one", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    const frame = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });
    const builder = fake.makePlayer("Builder", { permission: 2 });

    Edit.setPending(builder, { kind: "rebind", robbery: "jewels", element: frame.element.id, mode: "replace" });
    const told = Edit.wandOnBlock(builder, "overworld", GLOW, "minecraft:glow_frame");

    check("it was moved", told.kind === "say" && /is now bound to 202, 65, 200/.test(told.text), JSON.stringify(told));
    check("with no warning", told.kind === "say" && !/could not be saved/.test(told.text));
    check("the new frame has its saved copy", World.frameIsCaptured("jewels", GLOW) === true);
    done();
});

test("moving a frame element to a frame that cannot be saved says so", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    const frame = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });
    const builder = fake.makePlayer("Builder", { permission: 2 });

    fake.structureMax = 0;
    Edit.setPending(builder, { kind: "rebind", robbery: "jewels", element: frame.element.id, mode: "replace" });
    const told = Edit.wandOnBlock(builder, "overworld", GLOW, "minecraft:glow_frame");

    check("it was moved", told.kind === "say" && /is now bound to 202, 65, 200/.test(told.text), JSON.stringify(told));
    check("and the builder is told the new frame could not be saved, and what that means", told.kind === "say" && /could not be saved/.test(told.text) && /nothing can put it back/.test(told.text), JSON.stringify(told));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// A frame the site is waiting to put back must not be saved: it may be empty
// ---------------------------------------------------------------------------------------------------------

/** A run took from the frame: it is empty, and noted to be shown again. */
function takenFrom() {
    S.markDirty({ robbery: "jewels", dimension: "overworld", pos: FRAME, action: "refill" });
    World.emptyFrame("overworld", FRAME);
}

test("saving a frame that is waiting to be put back is refused, so an empty copy never replaces the real one", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    const frame = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    takenFrom();
    const refused = Edit.recaptureFrame("jewels", frame.element.id);

    check("refused, with the frame's name and the reason", refused.ok === false && /Necklace/.test(refused.reason) && /waiting to be put back/.test(refused.reason) && /save it empty/.test(refused.reason), JSON.stringify(refused));
    check("what is put back is still the diamond", World.restoreFrame("overworld", "jewels", FRAME) === "restored" && fake.frameItemAt("overworld", at(FRAME))?.typeId === "minecraft:diamond");

    // Once the site has put it back and the note is crossed off, saving works again.
    S.clearDirty({ robbery: "jewels", dimension: "overworld", pos: FRAME, action: "refill" });
    fake.setFrameItem("overworld", at(FRAME), "minecraft:gold_ingot");
    check("allowed again afterwards", Edit.recaptureFrame("jewels", frame.element.id).ok === true);
    World.emptyFrame("overworld", FRAME);
    World.restoreFrame("overworld", "jewels", FRAME);
    check("and it saved what the frame showed then", fake.frameItemAt("overworld", at(FRAME))?.typeId === "minecraft:gold_ingot");
    done();
});

test("binding a frame again while the site is waiting to put it back keeps the earlier copy, and says so", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    const frame = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    takenFrom();
    assert.ok(Edit.removeElementFrom("jewels", frame.element.id).ok);

    const again = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    check("it is bound", again.ok === true);
    check("with a note that the earlier copy was kept", again.ok && /waiting to be put back/.test(again.note ?? "") && /earlier saved copy is kept/.test(again.note ?? ""), JSON.stringify(again));
    check("and the copy still has the diamond, not the empty frame", World.restoreFrame("overworld", "jewels", FRAME) === "restored" && fake.frameItemAt("overworld", at(FRAME))?.typeId === "minecraft:diamond");
    done();
});

test("moving a frame element onto a frame that is waiting to be put back keeps that frame's copy", () => {
    setup();
    const { check, done } = checks();
    assert.ok(S.saveRobbery(base()).ok);
    const frame = Edit.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });
    const other = Edit.addElementAt("jewels", { kind: "frame", name: "Ring", pos: GLOW, withNeighbour: false });
    const builder = fake.makePlayer("Builder", { permission: 2 });

    assert.ok(Edit.removeElementFrom("jewels", other.element.id).ok);
    S.markDirty({ robbery: "jewels", dimension: "overworld", pos: GLOW, action: "refill" });
    World.emptyFrame("overworld", GLOW);

    Edit.setPending(builder, { kind: "rebind", robbery: "jewels", element: frame.element.id, mode: "replace" });
    const told = Edit.wandOnBlock(builder, "overworld", GLOW, "minecraft:glow_frame");

    check("it was moved", told.kind === "say" && /is now bound to 202, 65, 200/.test(told.text), JSON.stringify(told));
    check("and the builder is told the earlier copy was kept", told.kind === "say" && /waiting to be put back/.test(told.text), JSON.stringify(told));
    check("the glow frame is put back with its emeralds, not as the empty frame it was just now", World.restoreFrame("overworld", "jewels", GLOW) === "restored" && fake.frameItemAt("overworld", at(GLOW))?.typeId === "minecraft:emerald");
    done();
});
