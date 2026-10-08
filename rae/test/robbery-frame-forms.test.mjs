import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks, strip } from "./helpers.mjs";
import { buttonsOf, close, fill, press, problems, script, titleOf, ui } from "./robbery-ui.mjs";
import { L, at, ok } from "./robbery-fixtures.mjs";

// The builder's side of item frames: the wand on a frame block offers an item frame, binds it (and saves what it shows), the loot
// form is the chest's, "Save what the frame shows now" saves it again, and a frame cannot be given a second block. Driven by a
// stand-in player, as the other robbery screens are. Also the live switch for undoing punches.

const { PlayerPermissionLevel } = fakeApi;
const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const F = await load("core/robberyforms.js");
const World = await load("core/robberyworld.js");
const configoverrides = await load("core/configoverrides.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

const FRAME = [200, 65, 200];
const GLOW = [202, 65, 200];

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.placeBlock("overworld", at(FRAME), "minecraft:frame", { facing_direction: 2 });
    fake.setFrameItem("overworld", at(FRAME), "minecraft:diamond");
    fake.placeBlock("overworld", at(GLOW), "minecraft:glow_frame", { facing_direction: 2 });
    fake.setFrameItem("overworld", at(GLOW), "minecraft:emerald", 3);
}

const builder = (name = "Builder") => fake.makePlayer(name, { location: { x: 201, y: 65, z: 197 }, permission: PlayerPermissionLevel.Operator });
const said = (player) => player.messages.map(strip);
const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const robbery = () => S.getRobbery("jewels");
const frameElement = (name) => robbery()?.elements.find((e) => e.name === name);
const titles = () => ui.shown.map((form) => strip(titleOf(form)));

function started(player) {
    E.createRobbery(player, "jewels", "Jewelry Store");
    return robbery();
}

// ---------------------------------------------------------------------------------------------------------
// Binding one
// ---------------------------------------------------------------------------------------------------------

test("pointing the wand at a frame offers an item frame, already chosen, and binds it with a saved copy", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);

    script(fill({ "Its name": "Necklace" }), close);
    await F.openAddElement(ann, "jewels", FRAME, "minecraft:frame");

    const form = ui.shown[0];
    const kind = form.calls.find((c) => c[0] === "dropdown");
    const options = kind[2].map(strip);

    check("an item frame is one of the choices", options.some((o) => /^An item frame: what it shows can be stolen$/.test(o)), options.join(" | "));
    check("and it is the one chosen to start with", strip(String(kind[2][kind[3].defaultValueIndex])).startsWith("An item frame"), String(kind[3].defaultValueIndex));
    check("the door, chest and switch are still offered", ["A door", "A chest", "A switch"].every((start) => options.some((o) => o.startsWith(start))));
    check("no 'bind the chest beside it' question for a frame", !form.calls.some((c) => c[0] === "toggle"));

    const made = frameElement("Necklace");
    check("it is bound as a frame on that block", made?.kind === "frame" && made.cells[0].join() === FRAME.join(), JSON.stringify(made));
    check("what it shows was saved", World.frameIsCaptured("jewels", FRAME) === true);
    check("the builder was not warned of anything", !said(ann).some((m) => /could not be saved/.test(m)), said(ann).join(" | "));
    check("its screen opened", titles().includes("Necklace"), titles().join(" > "));
    check("nothing went wrong in the stand-in", problems.length === 0, problems.join("\n"));
    done();
});

test("a frame that could not be saved is bound all the same, and the builder is told what that means", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    fake.structureMax = 0;

    script(fill({ "Its name": "Necklace" }), close);
    await F.openAddElement(ann, "jewels", FRAME, "minecraft:frame");

    check("bound", frameElement("Necklace") !== undefined);
    check("with a warning that nothing can put it back", said(ann).some((m) => /could not be saved/.test(m) && /nothing can put it back/.test(m)), said(ann).join(" | "));

    const screen = ui.shown.find((form) => strip(titleOf(form)) === "Necklace");
    check("and its screen says there is no saved copy", /Saved copy of the frame: NO/.test(bodyOf(screen)), bodyOf(screen));
    done();
});

test("binding stone as an item frame is refused in a sentence", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    fake.placeBlock("overworld", at([5, 65, 5]), "minecraft:stone");

    script(fill({ "Bind stone": "An item frame" }), close);
    await F.openAddElement(ann, "jewels", [5, 65, 5], "minecraft:stone");

    check("nothing was bound", robbery().elements.length === 0);
    check("told why", said(ann).some((m) => /Not changed: stone is not an item frame/.test(m)), said(ann).join(" | "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The element's screen
// ---------------------------------------------------------------------------------------------------------

test("a frame's screen has the loot form, a way to save the frame again, and says whether a copy exists", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    script(close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    const buttons = buttonsOf(ui.shown[0]).map(strip);
    check("Loot", buttons.includes("Loot"));
    check("Save what the frame shows now", buttons.includes("Save what the frame shows now"));
    check("the usual ones", ["Rename", "Locks (0)", "Delete it"].every((b) => buttons.includes(b)), buttons.join(" | "));
    check("it says there is a saved copy", /Saved copy of the frame: yes/.test(bodyOf(ui.shown[0])), bodyOf(ui.shown[0]));
    check("and what the loot is", /Loot: none/.test(bodyOf(ui.shown[0])));

    // A chest and a switch have neither the frame line nor the button.
    fake.placeBlock("overworld", at([5, 65, 5]), "minecraft:stone_button");
    const button = E.addElementAt("jewels", { kind: "switch", name: "Button", pos: [5, 65, 5], withNeighbour: false });
    ui.shown.length = 0;
    script(close);
    await F.openElementMenu(ann, "jewels", button.element.id);
    check("a switch has no such button or line", !buttonsOf(ui.shown[0]).map(strip).includes("Save what the frame shows now") && !/Saved copy/.test(bodyOf(ui.shown[0])));
    done();
});

test("the loot form is the chest's, and for a frame it says what the loot is for", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    script(press("Loot"), fill({ "Items to add on top": "minecraft:diamond 2, minecraft:emerald" }), close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    check("the loot was saved on the frame", JSON.stringify(frameElement("Necklace").items) === JSON.stringify([["minecraft:diamond", 2], ["minecraft:emerald", 1]]), JSON.stringify(frameElement("Necklace").items));
    check("the builder was told what it is for and what to do about the display", said(ann).some((m) => /what the thief is given/.test(m) && /Save what the frame shows now/.test(m)), said(ann).join(" | "));
    check("not the chest's wording", !said(ann).some((m) => /goes in the chest/.test(m)));

    ui.shown.length = 0;
    script(close);
    await F.openElementMenu(ann, "jewels", bound.element.id);
    check("the screen now lists it", /Loot: minecraft:diamond 2, minecraft:emerald/.test(bodyOf(ui.shown[0])), bodyOf(ui.shown[0]));
    done();
});

test("a loot table that is not in the game is warned about in words that fit a frame", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    script(press("Loot"), fill({ "A loot table": "chests/nothing" }), close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    check("the warning says what will be given", said(ann).some((m) => /no loot table called chests\/nothing, so only the items you listed will be given/.test(m)), said(ann).join(" | "));
    done();
});

test("saving the frame again keeps what it shows now, and says so", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    // The builder swaps what the frame shows, then saves.
    fake.setFrameItem("overworld", at(FRAME), "minecraft:gold_ingot", 4);

    script(press("Save what the frame shows now"), close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    check("told it is saved", said(ann).some((m) => /^Saved\. The frame will be put back looking like this\.$/.test(m)), said(ann).join(" | "));

    World.emptyFrame("overworld", FRAME);
    World.restoreFrame("overworld", "jewels", FRAME);
    check("and the newer item is what is put back", JSON.stringify(fake.frameItemAt("overworld", at(FRAME))) === JSON.stringify({ typeId: "minecraft:gold_ingot", amount: 4 }), JSON.stringify(fake.frameItemAt("overworld", at(FRAME))));
    done();
});

test("saving a frame that has been taken down says so instead of pretending", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });
    fake.placeBlock("overworld", at(FRAME), "minecraft:air");

    script(press("Save what the frame shows now"), close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    check("refused, with where", said(ann).some((m) => /Not changed: the frame could not be saved: there is no item frame at 200, 65, 200/.test(m)), said(ann).join(" | "));
    done();
});

test("saving a frame the site is waiting to put back is refused in a sentence, and the real copy survives", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    // A robbery took it: the frame is bare, and noted to be shown again.
    S.markDirty({ robbery: "jewels", dimension: "overworld", pos: FRAME, action: "refill" });
    World.emptyFrame("overworld", FRAME);

    script(press("Save what the frame shows now"), close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    check("told why, by name", said(ann).some((m) => /^Not changed: Necklace is waiting to be put back after a robbery, so saving it now could save it empty\./.test(m)), said(ann).join(" | "));
    check("not told it was saved", !said(ann).some((m) => /^Saved\./.test(m)));

    World.restoreFrame("overworld", "jewels", FRAME);
    check("the diamond comes back", fake.frameItemAt("overworld", at(FRAME))?.typeId === "minecraft:diamond");
    done();
});

test("a frame is one block: it can be moved to another frame but not given a second", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    const bound = E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    script(press("Change its blocks"), close, close);
    await F.openElementMenu(ann, "jewels", bound.element.id);

    const blocks = ui.shown.find((form) => /blocks$/.test(strip(titleOf(form))));
    const buttons = buttonsOf(blocks).map(strip);
    check("it can be moved", buttons.includes("Move it: click the new block"), buttons.join(" | "));
    check("there is no 'add another block'", !buttons.some((b) => /Add another block/.test(b)), buttons.join(" | "));

    // And a chest still can.
    fake.placeBlock("overworld", at([5, 65, 5]), "minecraft:chest");
    const chest = E.addElementAt("jewels", { kind: "chest", name: "Safe", pos: [5, 65, 5], withNeighbour: false });
    ui.shown.length = 0;
    script(press("Change its blocks"), close, close);
    await F.openElementMenu(ann, "jewels", chest.element.id);
    const chestBlocks = ui.shown.find((form) => /blocks$/.test(strip(titleOf(form))));
    check("a chest is still offered a second block", buttonsOf(chestBlocks).map(strip).some((b) => /Add another block/.test(b)));
    done();
});

test("a robbery built with frames is runnable once the frames have loot, and says what is missing before", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder();
    started(ann);
    E.addElementAt("jewels", { kind: "frame", name: "Necklace", pos: FRAME, withNeighbour: false });

    check("with a bare frame it is not ready, and says so", L.whyNotRunnable(robbery()).some((p) => /an item frame with no loot/.test(p)), L.whyNotRunnable(robbery()).join("; "));

    ok(await Promise.resolve(E.applyEdit("jewels", (current) => L.updateElement(current, frameElement("Necklace").id, { items: [["minecraft:diamond", 1]], onDone: [{ kind: "end", result: "win" }] }))));
    check("with loot and a win it only wants the area, as any robbery does", L.whyNotRunnable(robbery()).length === 1 && /area is not set/.test(L.whyNotRunnable(robbery())[0]), L.whyNotRunnable(robbery()).join("; "));

    ok(await Promise.resolve(E.applyEdit("jewels", (current) => L.setArea(current, [190, 60, 190], [210, 80, 210]))));
    check("and with the area it is ready", L.whyNotRunnable(robbery()).length === 0, L.whyNotRunnable(robbery()).join("; "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The live switch
// ---------------------------------------------------------------------------------------------------------

test("undoing punches on frames can be switched off in the game, and back, with no redeploy", () => {
    fake.reset();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    const field = configoverrides.getField("robbery.guardFramePunches");

    check("the switch exists, is a boolean, and is under Robbery", field?.kind === "boolean" && field.category === "Robbery");
    check("it says what it does", (field?.label ?? "").length > 30 && /punch/i.test(field?.label ?? ""));
    check("on by default", R.guardFramePunches === true);

    check("off", configoverrides.setOverride(op, "robbery.guardFramePunches", false).ok === true && R.guardFramePunches === false);
    check("reset puts it back", configoverrides.resetOverride(op, "robbery.guardFramePunches").ok === true && R.guardFramePunches === true);
    check("a number is not a switch", configoverrides.setOverride(op, "robbery.guardFramePunches", 1).ok === false && R.guardFramePunches === true);
    check("a member cannot", configoverrides.setOverride(fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member }), "robbery.guardFramePunches", false).ok === false && R.guardFramePunches === true);
    done();
});
