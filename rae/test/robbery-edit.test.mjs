import { test } from "node:test";
import { fake, load, checks } from "./helpers.mjs";
import { L, SITE, at, bank, buildSite, ok } from "./robbery-fixtures.mjs";

// core/robberyedit.ts: editing without a screen. The contract: an edit changes nothing unless all of it works (the
// pure edit, the whole-robbery validation, no block claimed by two robberies, the store); a wand click means one thing in each
// situation; a menu that asked for a click gets that click (two corners, a block to bind) or a clear reason it did not; and
// each builder's selection is their own and survives a reload.

const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
}

const builder = (name = "Builder", where = { x: 100, y: 65, z: 170 }) => fake.makePlayer(name, { location: { ...where }, permission: 2 });
const save = (robbery) => { const saved = S.saveRobbery(robbery); if (!saved.ok) throw new Error(saved.reason); return saved.robbery; };
const empty = (id = "bank", name = "Bank", dimension = "overworld") => save(ok(L.newRobbery(id, name, dimension)));
const cellsOf = (robbery, name) => robbery.elements.find((e) => e.name === name)?.cells.map((c) => c.join(",")).join(" ");

// ---------------------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------------------

test("each builder has their own selected robbery, kept on the player; with none chosen the only robbery is it", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    const bob = builder("Bob");

    check("nothing exists: nothing selected", E.selectedRobbery(ann) === undefined);

    empty("bank", "Bank");
    check("one robbery exists: it is the default", E.selectedRobbery(ann)?.id === "bank");

    empty("mine", "Mine");
    check("two exist and none chosen: nothing is guessed", E.selectedRobbery(ann) === undefined);

    E.select(ann, "mine");
    E.select(bob, "bank");
    check("Ann chose the mine", E.selectedRobbery(ann)?.id === "mine");
    check("Bob chose the bank: it is theirs alone", E.selectedRobbery(bob)?.id === "bank");

    S.forgetLoaded();
    check("a reload forgets nothing: the choice is on the player", E.selectedRobbery(ann)?.id === "mine");

    E.select(ann, "ghost");
    check("a robbery that no longer exists selects nothing", E.selectedRobbery(ann) === undefined);

    E.select(ann, undefined);
    check("clearing the selection works", E.selectedId(ann) === undefined);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Making and editing
// ---------------------------------------------------------------------------------------------------------

test("creating a robbery makes the id from the name, lowercases a typed one, refuses a clash, and selects it", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");

    const made = E.createRobbery(ann, "", "Saint Diego Bank");
    check("an id from the name (cut to the longest an id may be)", made.ok && made.robbery.id === "saint_diego_bank" && made.robbery.id.length <= R.maxIdLength, JSON.stringify(made));
    check("selected", E.selectedRobbery(ann)?.id === "saint_diego_bank");
    check("in the builder's dimension", made.robbery.dimension === "overworld");

    const typed = E.createRobbery(ann, "  MINE ", "The Mine");
    check("a typed id is lowercased and trimmed", typed.ok && typed.robbery.id === "mine");

    check("the same id again is refused", E.createRobbery(ann, "mine", "Other").ok === false);
    check("a bad id gets the validator's reason", /lowercase letters/.test(E.createRobbery(ann, "9lives", "Nine").reason ?? ""));
    check("no id and no letters in the name", /some letters/.test(E.createRobbery(ann, "", "123 !!!").reason ?? ""));
    check("an empty name is refused", E.createRobbery(ann, "x1", "  ").ok === false);

    const inNether = fake.makePlayer("Nina", { location: { x: 0, y: 70, z: 0 }, dimension: fake.dimension("nether") });
    check("it takes the dimension the builder stands in", E.createRobbery(inNether, "hell", "Hell").robbery?.dimension === "nether");
    done();
});

test("applyEdit changes nothing unless the whole edit works", () => {
    setup();
    const { check, done } = checks();
    const { r } = bank();
    save(r);
    const before = S.rawText("bank");

    check("an unknown robbery", E.applyEdit("ghost", (x) => L.renameRobbery(x, "x")).ok === false);

    const invalid = E.applyEdit("bank", (x) => L.updateElement(x, "e1", { name: "Vault door" }));
    check("an edit the logic refuses is refused with its reason", invalid.ok === false && /already an element called/.test(invalid.reason), JSON.stringify(invalid));
    check("and the save is untouched", S.rawText("bank") === before);

    const good = E.applyEdit("bank", (x) => L.renameRobbery(x, "Renamed"));
    check("a good edit saves", good.ok && S.getRobbery("bank").name === "Renamed");
    done();
});

test("a block cannot be claimed by two robberies, whichever way it is bound", () => {
    setup();
    const { check, done } = checks();
    save(bank("bank").r);
    const other = empty("mine", "Mine");
    const before = S.rawText("mine");

    const stolen = E.applyEdit("mine", (x) => L.addElement(x, { kind: "switch", cells: [SITE.keypad] }));
    check("binding the bank's keypad into another robbery is refused, naming the owner", stolen.ok === false && /belongs to the robbery bank/.test(stolen.reason), JSON.stringify(stolen));
    check("and nothing was saved", S.rawText("mine") === before);

    const mine = E.applyEdit("mine", (x) => L.addElement(x, { kind: "switch", cells: [[1, 70, 1]] }));
    check("an unclaimed block is fine", mine.ok);
    void other;
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Adding elements at blocks
// ---------------------------------------------------------------------------------------------------------

test("a door binds both halves whichever half was clicked; the saved order is the same", () => {
    setup();
    const { check, done } = checks();
    buildSite();
    empty();

    const fromUpper = E.addElementAt("bank", { kind: "door", name: "Vault door", pos: SITE.doorHigh, withNeighbour: false });
    check("added", fromUpper.ok, fromUpper.reason);
    check("both halves, lower first", cellsOf(fromUpper.robbery, "Vault door") === "104,65,170 104,66,170", cellsOf(fromUpper.robbery, "Vault door"));
    check("the element knows its kind", fromUpper.element.kind === "door");
    done();
});

test("a chest binds alone, or with its twin when asked and there is exactly one", () => {
    setup();
    const { check, done } = checks();
    fake.placeBlock("overworld", { x: 5, y: 70, z: 5 }, "minecraft:chest");
    fake.placeBlock("overworld", { x: 6, y: 70, z: 5 }, "minecraft:chest");
    fake.placeBlock("overworld", { x: 20, y: 70, z: 5 }, "minecraft:chest");
    fake.placeBlock("overworld", { x: 19, y: 70, z: 5 }, "minecraft:chest");
    fake.placeBlock("overworld", { x: 21, y: 70, z: 5 }, "minecraft:chest");
    empty();

    const alone = E.addElementAt("bank", { kind: "chest", name: "Single", pos: [5, 70, 5], withNeighbour: false });
    check("by default only the clicked chest", cellsOf(alone.robbery, "Single") === "5,70,5");

    const double = E.addElementAt("bank", { kind: "chest", name: "Double", pos: [6, 70, 5], withNeighbour: true });
    check("asked for the twin: it is already bound, so the edit is refused", double.ok === false && /already an element|bound to both/.test(double.reason ?? ""), JSON.stringify(double));

    fake.placeBlock("overworld", { x: 30, y: 70, z: 5 }, "minecraft:chest");
    fake.placeBlock("overworld", { x: 31, y: 70, z: 5 }, "minecraft:chest");
    const twin = E.addElementAt("bank", { kind: "chest", name: "Twin", pos: [30, 70, 5], withNeighbour: true });
    check("a chest with one neighbour binds both", twin.ok && cellsOf(twin.robbery, "Twin") === "30,70,5 31,70,5", JSON.stringify(twin));

    const crowded = E.addElementAt("bank", { kind: "chest", name: "Crowded", pos: [20, 70, 5], withNeighbour: true });
    check("a chest with two neighbours is not guessed at: it binds alone", crowded.ok && cellsOf(crowded.robbery, "Crowded") === "20,70,5", JSON.stringify(crowded));
    done();
});

test("an element is refused on a block that cannot be it, with the reason in words", () => {
    setup();
    const { check, done } = checks();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone");
    empty();
    const add = (kind, pos) => E.addElementAt("bank", { kind, name: "", pos, withNeighbour: false });

    check("a door element on stone", /does not open and close/.test(add("door", [1, 70, 1]).reason ?? ""));
    check("a chest element on stone", /cannot hold loot/.test(add("chest", [1, 70, 1]).reason ?? ""));
    check("anything on air", /no block there/.test(add("switch", [9, 70, 9]).reason ?? ""));
    check("a switch on stone is allowed", add("switch", [1, 70, 1]).ok);

    fake.setUnloaded("overworld", [{ from: { x: 40, y: 0, z: 40 }, to: { x: 50, y: 100, z: 50 } }]);
    check("a block in an unloaded chunk is not guessed at", /not loaded/.test(add("switch", [45, 70, 45]).reason ?? ""));
    check("an unknown robbery", E.addElementAt("ghost", { kind: "switch", name: "", pos: [1, 70, 1], withNeighbour: false }).ok === false);
    done();
});

test("names: a default is numbered, a typed one is kept, a clash is refused, and the same block cannot be bound twice", () => {
    setup();
    const { check, done } = checks();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone_button");
    fake.placeBlock("overworld", { x: 2, y: 70, z: 1 }, "minecraft:stone_button");
    fake.placeBlock("overworld", { x: 3, y: 70, z: 1 }, "minecraft:stone_button");
    empty();
    const add = (name, pos) => E.addElementAt("bank", { kind: "switch", name, pos, withNeighbour: false });

    check("a default name says the kind and the counter", add("", [1, 70, 1]).element.name === "Switch 1");
    check("a typed name is kept", add("  Keypad  ", [2, 70, 1]).element.name === "Keypad");
    check("a clashing typed name is refused", /already an element called keypad/i.test(add("keypad", [3, 70, 1]).reason ?? ""));
    check("the same block twice is refused", add("Again", [1, 70, 1]).ok === false);
    done();
});

test("removing an element reports the requirements it took with it", () => {
    setup();
    const { check, done } = checks();
    const { r, keypad } = bank();
    save(r);

    const removed = E.removeElementFrom("bank", keypad.id);
    check("removed", removed.ok && removed.robbery.elements.length === 2);
    check("the door that waited on it lost that requirement, and it said so", removed.removedReferences === 1, String(removed.removedReferences));
    check("an unknown element is refused", E.removeElementFrom("bank", "e99").ok === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The wand
// ---------------------------------------------------------------------------------------------------------

const click = (player, pos, type = "minecraft:stone", dimension = "minecraft:overworld") => E.wandOnBlock(player, dimension, pos, type);

test("a wand click on a block means: make a robbery, pick one, or add an element, depending on what exists", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");

    check("nothing exists: make one", click(ann, [1, 70, 1]).kind === "new");

    empty("bank", "Bank");
    empty("mine", "Mine");
    check("several exist and none is chosen: pick one", click(ann, [1, 70, 1]).kind === "pick");

    E.select(ann, "bank");
    const add = click(ann, [1, 70, 1], "minecraft:iron_door");
    check("one is chosen: add an element there", add.kind === "add" && add.robbery === "bank" && add.pos.join() === "1,70,1" && add.blockType === "minecraft:iron_door", JSON.stringify(add));

    empty("hell", "Hell", "nether");
    E.select(ann, "hell");
    const away = click(ann, [1, 70, 1]);
    check("a robbery in another dimension is not built into from here", away.kind === "say" && /is in the nether/.test(away.text), JSON.stringify(away));
    done();
});

test("a wand click on a bound block opens that element, and selects its robbery", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    save(bank("bank").r);
    empty("mine", "Mine");
    E.select(ann, "mine");

    const action = click(ann, SITE.keypad);
    check("the element screen, for the bank's keypad", action.kind === "element" && action.robbery === "bank" && action.element === "e1", JSON.stringify(action));
    check("and she is now working on the bank", E.selectedRobbery(ann).id === "bank");
    done();
});

test("a wand click in the air is the menu", () => {
    setup();
    const { check, done } = checks();

    check("the main menu", E.wandOnAir(builder()).kind === "menu");
    done();
});

test("setting the area by clicking: two corners, in any order, or the air for where you stand", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann", { x: 10.7, y: 64.2, z: -3.1 });
    empty();

    E.setPending(ann, { kind: "corner", robbery: "bank" });

    const first = click(ann, [0, 60, 0]);
    check("the first corner is remembered and the next click is asked for", first.kind === "say" && /Corner 1 is 0, 60, 0/.test(first.text), JSON.stringify(first));
    check("it is still waiting for the second", E.pendingFor(ann)?.first?.join() === "0,60,0");

    const second = click(ann, [10, 70, 20]);
    check("the second corner sets the area, naming its size", second.kind === "say" && /11 x 11 x 21 blocks/.test(second.text), JSON.stringify(second));
    check("the area is saved, normalised", JSON.stringify(S.getRobbery("bank").area) === JSON.stringify({ min: [0, 60, 0], max: [10, 70, 20] }));
    check("nothing is waiting any more", E.pendingFor(ann) === undefined);

    E.setPending(ann, { kind: "corner", robbery: "bank" });
    click(ann, [50, 80, 50]);
    const feet = E.wandOnAir(ann);
    check("the air click takes where she stands, to the block: floor of 10.7, 64.2, -3.1", feet.kind === "say" && /from 50, 80, 50 to 10, 64, -4/.test(feet.text), JSON.stringify(feet));
    done();
});

test("a click a menu asked for is kept for a limited time", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    empty();

    E.setPending(ann, { kind: "corner", robbery: "bank" });
    fake.advance(R.pendingSeconds * 20 - 1);
    check("a moment before it runs out it still waits", E.pendingFor(ann) !== undefined);
    fake.advance(2);
    check("after it, the click is just a click", E.pendingFor(ann) === undefined && click(ann, [1, 70, 1]).kind !== "say");
    done();
});

test("a corner click in another dimension, or for a robbery that was deleted, is explained and does not set anything", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    empty();

    E.setPending(ann, { kind: "corner", robbery: "bank" });
    const wrong = click(ann, [1, 70, 1], "minecraft:stone", "minecraft:nether");
    check("said so, and still waiting", wrong.kind === "say" && /in the nether, and Bank is in the overworld/.test(wrong.text) && E.pendingFor(ann) !== undefined, JSON.stringify(wrong));

    S.deleteRobbery("bank");
    const gone = click(ann, [1, 70, 1]);
    check("a robbery that was deleted ends the wait", gone.kind === "say" && /is gone/.test(gone.text) && E.pendingFor(ann) === undefined, JSON.stringify(gone));
    done();
});

test("rebinding: the next click replaces an element's blocks, or adds to them; a wrong block is refused and the wait goes on", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone_button");
    fake.placeBlock("overworld", { x: 2, y: 70, z: 1 }, "minecraft:stone_button");
    fake.placeBlock("overworld", { x: 3, y: 70, z: 1 }, "minecraft:lever");
    buildSite();
    empty();
    const added = E.addElementAt("bank", { kind: "door", name: "Vault door", pos: SITE.doorLow, withNeighbour: false });
    const button = E.addElementAt("bank", { kind: "switch", name: "Button", pos: [1, 70, 1], withNeighbour: false });

    // A door element: only a door will do.
    E.setPending(ann, { kind: "rebind", robbery: "bank", element: added.element.id, mode: "replace" });
    const wrong = click(ann, [3, 70, 1], "minecraft:lever");
    check("a lever cannot be the vault door, and it says so", wrong.kind === "say" && /Not that block/.test(wrong.text) && /does not open and close/.test(wrong.text), JSON.stringify(wrong));
    check("it is still waiting for a better click", E.pendingFor(ann) !== undefined);

    // A switch element: replace its block, then add another.
    E.setPending(ann, { kind: "rebind", robbery: "bank", element: button.element.id, mode: "replace" });
    const replaced = click(ann, [2, 70, 1], "minecraft:stone_button");
    check("replaced", replaced.kind === "say" && /Button is now bound to 2, 70, 1/.test(replaced.text), JSON.stringify(replaced));
    check("only the new block is bound", cellsOf(S.getRobbery("bank"), "Button") === "2,70,1");

    E.setPending(ann, { kind: "rebind", robbery: "bank", element: button.element.id, mode: "add" });
    const more = click(ann, [3, 70, 1], "minecraft:lever");
    check("added", more.kind === "say" && /also uses 3, 70, 1/.test(more.text), JSON.stringify(more));
    check("both blocks are bound", cellsOf(S.getRobbery("bank"), "Button") === "2,70,1 3,70,1");

    E.setPending(ann, { kind: "rebind", robbery: "bank", element: button.element.id, mode: "add" });
    const claimed = click(ann, SITE.doorLow, "minecraft:iron_door");
    check("a block already bound to another element is refused, naming the clash", claimed.kind === "say" && /Not changed: .*bound to both/.test(claimed.text), JSON.stringify(claimed));
    check("and the button kept the blocks it had", cellsOf(S.getRobbery("bank"), "Button") === "2,70,1 3,70,1");

    E.setPending(ann, { kind: "rebind", robbery: "bank", element: button.element.id, mode: "replace" });
    check("the air will not do for a block", /Click the block you mean/.test(E.wandOnAir(ann).text));
    done();
});

test("rebinding a door by clicking either half binds both", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    buildSite();
    fake.placeBlock("overworld", { x: 50, y: 70, z: 50 }, "minecraft:iron_door", { upper_block_bit: false });
    fake.placeBlock("overworld", { x: 50, y: 71, z: 50 }, "minecraft:iron_door", { upper_block_bit: true });
    empty();
    const door = E.addElementAt("bank", { kind: "door", name: "Door", pos: SITE.doorLow, withNeighbour: false });

    E.setPending(ann, { kind: "rebind", robbery: "bank", element: door.element.id, mode: "replace" });
    const moved = click(ann, [50, 71, 50], "minecraft:iron_door");
    check("moved to the other door, both halves", /Door is now bound to 50, 70, 50 and 50, 71, 50/.test(moved.text ?? ""), JSON.stringify(moved));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The wand item
// ---------------------------------------------------------------------------------------------------------

test("the wand is given once, not again", () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");

    check("given", E.giveWand(ann) === true);
    check("it is the wand", ann.container.getItem(0)?.typeId === R.wandItemId);
    check("not given twice", E.giveWand(ann) === false);
    done();
});
