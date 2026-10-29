import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, fakeUi, fakeApi, load, checks, strip, useBlock } from "./helpers.mjs";
import { L as RL, SITE, bank, buildSite, ok } from "./robbery-fixtures.mjs";

// systems/jailbreak.ts's jail buttons and core/jailbind.ts: a block an operator has bound to a jail starts the lockpick for that jail when an outlaw right-clicks it,
// without a command block. The click handler runs in RESTRICTED execution (it may only decide and cancel; the form opens a tick later), a held click counts once, a
// button of a jail nobody is held in says so, and an operator binds a block by pressing a button on the jail's screen and then right-clicking it.

await load("main.js");
const store = await load("core/jailstore.js");
const bind = await load("core/jailbind.js");
const robberies = await load("core/robberystore.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const J = await load("logic/jails.js");
const { resetAllSystems } = await load("core/registry.js");
const { JAILS } = await load("config/balance.js");
const { JAIL_SITES } = await load("config/world.js");
const { uiFake } = fakeUi;
const robberyEdit = await load("core/robberyedit.js");
const { PlayerPermissionLevel } = fakeApi;

const realRandom = Math.random;
let roll = 0;
Math.random = () => roll;
process.on("exit", () => { Math.random = realRandom; });

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const scriptEvent = (id, sourceEntity) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message: "" });
const said = (player) => player.messages.map(strip);
const chat = () => fake.chat.map(strip);
const shownTitles = () => uiFake.shown.map((form) => strip(String(form.calls.find((c) => c[0] === "title")?.[1] ?? "")));
const setblocks = () => fake.dimension("overworld").commands.filter((c) => c.startsWith("setblock"));
const CLOSE = { canceled: true };
const hit = (slider) => ({ canceled: false, formValues: [slider] });

function answers(...responses) {
    const queue = [...responses];
    uiFake.responses = Object.assign([], { shift: () => queue.shift() ?? CLOSE });
}

function scene() {
    fake.reset();
    resetAllSystems();
    store.forgetJails();
    bind.forgetBinds();
    robberies.forgetLoaded();
    uiFake.shown.length = 0;
    answers();
    roll = 0;
    fake.strictBefore = true;                    // the real engine's rule for every "before" handler
    fake.addObjective("coins");
    fake.addObjective("bounty");
}

function cast(...specs) {
    const made = specs.map(([name, options]) => fake.makePlayer(name, options));
    fake.advance(1);
    return made;
}

const BUTTON = [10, 70, 5];
const OTHER = [20, 70, 5];
const edited = (jail, patch) => { const r = J.edit(jail, patch); assert.ok(r.ok, r.reason); return r.value; };

/** A jail's blocks in the world, and the jail with them as buttons. */
function bindButton(id, ...cells) {
    for (const cell of cells) fake.placeBlock("overworld", { x: cell[0], y: cell[1], z: cell[2] }, "minecraft:stone_button");
    const saved = store.saveJail(edited(store.getJail(id), { buttons: cells.map(([x, y, z]) => ({ x, y, z })) }));
    assert.ok(saved.ok, saved.reason);
}

/** A free outlaw, a prisoner held in the jail the roll picks (jail_1), and a law player far away. */
function standard() {
    bindButton("jail_1", BUTTON);
    const [ada, bob, law, cy] = cast(["Ada", { tags: ["outlaw"], location: { x: 10, y: 70, z: 7 } }], ["Bob", { tags: ["outlaw"] }], ["Law", { tags: ["law"], location: { x: 900, y: 70, z: 900 } }], ["Cy", { tags: ["outlaw"], location: { x: 10, y: 70, z: 8 } }]);
    scriptEvent("bounty:test_capture", bob);
    fake.advance(1);
    return { ada, bob, law, cy };
}

test("a bound button of the jail that holds a prisoner is cancelled at once and opens the lockpick a tick later, once per press", async () => {
    scene();
    const { check, done } = checks();
    const { ada } = standard();

    check("(setup) the prisoner is in jail_1", state.getJailSite()?.jail.x === JAIL_SITES[0].jail.x);

    const press = useBlock(ada, BUTTON);

    check("the click was cancelled, so the button does not also press", press.cancel === true);
    check("nothing was opened inside the before-event", uiFake.shown.length === 0);

    fake.advance(1);
    await settle();
    check("a tick later the lockpick form is up", shownTitles().length === 1 && shownTitles()[0] === "Pick the Lock", shownTitles().join(" | "));

    const repeats = [1, 2, 3, 4].map(() => useBlock(ada, BUTTON, { first: false }));
    fake.advance(1);
    await settle();
    check("a held click repeats the event: every repeat is cancelled and none opens another form", repeats.every((e) => e.cancel === true) && uiFake.shown.length === 1, String(uiFake.shown.length));

    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("a second press right after the first is the same press (one click can be reported twice)", uiFake.shown.length === 1, String(uiFake.shown.length));

    fake.advance(JAILS.pressGapTicks + 1);
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("a press after the gap is a new one", uiFake.shown.length === 2, String(uiFake.shown.length));
    done();
});

test("who may press: only an outlaw, not the prisoner, and only while someone is jailed; each is told why and none gets a form", async () => {
    scene();
    const { check, done } = checks();
    const { ada, bob, law } = standard();
    law.teleport({ x: 10, y: 70, z: 7 });

    useBlock(law, BUTTON);
    useBlock(bob, BUTTON);
    fake.advance(1);
    await settle();

    check("law is told only outlaws can", said(law).includes("Only outlaws can attempt this."), said(law).join(" | "));
    check("the prisoner cannot pick their own lock", said(bob).some((m) => /can't pick your own lock/.test(m)), said(bob).join(" | "));
    check("no form was opened for either", uiFake.shown.length === 0);

    // free everyone: a button with nobody jailed
    state.update(bob, { inJail: false });
    fake.advance(JAILS.pressGapTicks + 1);
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("with nobody jailed an outlaw is told so", said(ada).includes("No one is currently jailed."), said(ada).join(" | "));
    check("and still no form", uiFake.shown.length === 0);
    done();
});

test("a button of a jail nobody is held in says so, and starts nothing", async () => {
    scene();
    const { check, done } = checks();
    const { ada } = standard();
    bindButton("jail_2", OTHER);

    const press = useBlock(ada, OTHER);
    fake.advance(1);
    await settle();

    check("it is still cancelled (it is a jail button)", press.cancel === true);
    check("the outlaw is told no one is held in Jail 2", said(ada).includes("No one is held in Jail 2."), said(ada).join(" | "));
    check("no form", uiFake.shown.length === 0);
    done();
});

test("a block that is not a button, and a button of a jail that is off and holds nobody, are left to the game", async () => {
    scene();
    const { check, done } = checks();
    const { ada } = standard();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone_button");
    bindButton("jail_2", OTHER);
    store.saveJail(edited(store.getJail("jail_2"), { enabled: false }));

    const plain = useBlock(ada, [1, 70, 1]);
    const off = useBlock(ada, OTHER);
    fake.advance(1);
    await settle();

    check("an unbound block is not cancelled", plain.cancel === false);
    check("a button of a jail that is switched off does nothing and is not cancelled", off.cancel === false);
    check("no form and no message", uiFake.shown.length === 0 && ada.messages.length === 0);
    done();
});

test("a click handler that meets something strange never breaks the click", () => {
    scene();
    const { check, done } = checks();
    const [ada] = cast(["Ada", { tags: ["outlaw"] }]);
    const event = { player: ada, block: {}, isFirstEvent: true, cancel: false };

    let threw = false;
    try { world.beforeEvents.playerInteractWithBlock.emit(event); } catch { threw = true; }

    check("nothing was thrown", threw === false);
    check("the click is left to the game", event.cancel === false);
    done();
});

test("a whole jailbreak through a button: two right picks (from two outlaws) free the prisoner, open that jail's door and only that one", async () => {
    scene();
    const { check, done } = checks();
    const { ada, bob, cy } = standard();

    // Two different rescuers: one player cannot pick twice inside the cooldown, which is the jail's own rule.
    answers(hit(0));
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    answers(hit(0));
    useBlock(cy, BUTTON);
    fake.advance(1);
    await settle();

    check("the jailbreak succeeded", chat().includes("The jailbreak succeeded!"), chat().join(" | "));
    check("the prisoner is free", state.getRecord(bob).inJail === false && state.getRecord(bob).escortVulnerable === true);
    const door = JAIL_SITES[0].doorTrigger;
    check("it placed the redstone block at jail_1's door, and only there", setblocks().length === 1 && setblocks()[0] === `setblock ${door.x} ${door.y} ${door.z} redstone_block`, setblocks().join(" | "));
    done();
});

test("a jail with no door trigger frees its prisoners and places nothing, without an error", async () => {
    scene();
    const { check, done } = checks();

    // a new jail with no door, the only one that is on, so it is the one the next capture is sent to
    const yard = J.newJail("yard", "Yard", { x: 300.5, y: 70, z: 300.5 });
    assert.ok(store.saveJail(yard.value).ok);
    store.saveJail(edited(store.getJail("jail_1"), { enabled: false }));
    store.saveJail(edited(store.getJail("jail_2"), { enabled: false }));
    bindButton("yard", BUTTON);

    const [ada, bob, cy] = cast(["Ada", { tags: ["outlaw"], location: { x: 300, y: 70, z: 305 } }], ["Bob", { tags: ["outlaw"] }], ["Cy", { tags: ["outlaw"], location: { x: 300, y: 70, z: 306 } }]);
    scriptEvent("bounty:test_capture", bob);
    fake.advance(1);

    check("(setup) Bob is held at the yard", state.getJailSite()?.jail.x === 300.5 && state.getJailSite()?.doorTrigger === undefined, JSON.stringify(state.getJailSite()));

    answers(hit(0));
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    answers(hit(0));
    useBlock(cy, BUTTON);
    fake.advance(1);
    await settle();

    check("the jailbreak succeeded", chat().includes("The jailbreak succeeded!"), chat().join(" | "));
    check("Bob is free", state.getRecord(bob).inJail === false);
    check("no redstone block was placed", setblocks().length === 0, setblocks().join(" | "));
    check("and nobody was told of an error", !chat().some((m) => /door trigger|could not/i.test(m)), chat().join(" | "));
    done();
});

test("bounty:lockpick still works as it did, for a world that wires it to a command block", async () => {
    scene();
    const { check, done } = checks();
    const { ada } = standard();

    answers(CLOSE);
    scriptEvent("bounty:lockpick", ada);
    await settle();

    check("the lockpick form opens", shownTitles().includes("Pick the Lock"), shownTitles().join(" | "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Binding a block by clicking it
// ---------------------------------------------------------------------------------------------------------

const operator = (name = "Op") => fake.makePlayer(name, { permission: 2, location: { x: 30, y: 70, z: 5 } });

test("after 'bind a button' the operator's next right-click, on any block, becomes a button of that jail", async () => {
    scene();
    const { check, done } = checks();
    const [op] = [operator()];
    fake.advance(1);
    fake.placeBlock("overworld", { x: 40, y: 70, z: 5 }, "minecraft:oak_door");

    bind.startBind(op, "jail_1", "button");
    check("a bind is waiting", bind.hasPendingBind(op) === true);

    const click = useBlock(op, [40, 70, 5]);

    check("the click was cancelled so the block does not also act", click.cancel === true);
    check("nothing is saved inside the before-event", store.getJail("jail_1").buttons.length === 0);

    fake.advance(1);
    check("a tick later it is a button of jail_1", store.getJail("jail_1").buttons.length === 1 && store.getJail("jail_1").buttons[0].x === 40);
    check("the operator is told, naming the block and the jail", said(op).some((m) => /Bound: oak_door at 40, 70, 5 now starts the lockpick for Jail 1/.test(m)), said(op).join(" | "));
    check("the wait is over", bind.hasPendingBind(op) === false);

    const next = useBlock(op, [41, 70, 5]);
    check("the next click is an ordinary one", next.cancel === false && store.getJail("jail_1").buttons.length === 1);
    done();
});

test("a held click completes a bind once", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);

    bind.startBind(op, "jail_1", "button");
    const first = useBlock(op, [40, 70, 5]);
    const repeat = useBlock(op, [40, 70, 5], { first: false });
    fake.advance(1);

    check("the first and the repeat are both cancelled", first.cancel === true && repeat.cancel === true);
    check("one button, and one message", store.getJail("jail_1").buttons.length === 1 && said(op).filter((m) => /Bound:/.test(m)).length === 1, said(op).join(" | "));
    done();
});

test("'set the door trigger' takes the next click as the door trigger", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);

    bind.startBind(op, "jail_2", "door");
    useBlock(op, [50, 61, 9]);
    fake.advance(1);

    check("the door trigger moved to that block", L2(store.getJail("jail_2").doorTrigger) === "50,61,9", JSON.stringify(store.getJail("jail_2").doorTrigger));
    check("the operator is told", said(op).some((m) => /door trigger of Jail 2 is now the block at 50, 61, 9/.test(m)), said(op).join(" | "));
    done();
});

const L2 = (p) => `${p.x},${p.y},${p.z}`;

test("a bind that is not answered in time is dropped, and the click after it is an ordinary one", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);

    bind.startBind(op, "jail_1", "button");
    fake.advance(JAILS.bindSeconds * 20 + 2);

    check("it is no longer waiting", bind.hasPendingBind(op) === false);
    const click = useBlock(op, [40, 70, 5]);
    fake.advance(1);

    check("the click is not cancelled and binds nothing", click.cancel === false && store.getJail("jail_1").buttons.length === 0);
    done();
});

test("a block that is part of a robbery is not bound, the robbery does not play that click, and the operator is told", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);
    buildSite();
    robberies.saveRobbery(bank("bank").r);

    bind.startBind(op, "jail_1", "button");
    const click = useBlock(op, SITE.keypad);
    fake.advance(2);

    check("the click was cancelled (it was the bind's)", click.cancel === true);
    check("the block was not bound", store.getJail("jail_1").buttons.length === 0);
    check("the operator is told it is part of a robbery", said(op).some((m) => /part of a robbery/.test(m)), said(op).join(" | "));
    check("and the robbery did not start", Run.runningIds().length === 0);
    done();
});

test("a block outside the overworld, a second bind of the same block, a jail that is gone and a block another jail uses are each refused with the reason", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);
    const told = () => said(op).at(-1) ?? "";

    bind.startBind(op, "jail_1", "button");
    bind.completeBind(op, { dimensionId: "minecraft:nether", x: 1, y: 2, z: 3, typeId: "minecraft:stone" });
    check("another dimension", /jails are in the overworld/.test(told()), told());

    bindButton("jail_1", BUTTON);
    bind.startBind(op, "jail_1", "button");
    bind.completeBind(op, { dimensionId: "overworld", x: BUTTON[0], y: BUTTON[1], z: BUTTON[2], typeId: "minecraft:stone_button" });
    check("the same block twice", /already a button of Jail 1/.test(told()), told());

    bind.startBind(op, "jail_2", "button");
    bind.completeBind(op, { dimensionId: "overworld", x: BUTTON[0], y: BUTTON[1], z: BUTTON[2], typeId: "minecraft:stone_button" });
    check("a block another jail uses", /already a button of Jail 1/.test(told()), told());

    bind.startBind(op, "ghost", "button");
    bind.completeBind(op, { dimensionId: "overworld", x: 1, y: 2, z: 3, typeId: "minecraft:stone" });
    check("a jail that is gone", /That jail is gone/.test(told()), told());

    bind.completeBind(op, { dimensionId: "overworld", x: 1, y: 2, z: 3, typeId: "minecraft:stone" });
    check("a click with no bind waiting", /took too long/.test(told()), told());
    done();
});

test("a bind is one operator's: another player's click is not taken for it", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    const [ada] = cast(["Ada", { tags: ["outlaw"] }]);

    bind.startBind(op, "jail_1", "button");
    const click = useBlock(ada, [40, 70, 5]);
    fake.advance(1);

    check("Ada's click is an ordinary one", click.cancel === false && store.getJail("jail_1").buttons.length === 0);
    check("and the operator's bind is still waiting", bind.hasPendingBind(op) === true);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The jail that holds the prisoners, and edits made while it does
// ---------------------------------------------------------------------------------------------------------

/** Prisoners held in jail_2 (a roll near 1), with a button on each jail. */
function heldInSecond() {
    bindButton("jail_1", BUTTON);
    bindButton("jail_2", OTHER);
    const [ada, bob] = cast(["Ada", { tags: ["outlaw"], location: { x: 10, y: 70, z: 7 } }], ["Bob", { tags: ["outlaw"] }]);
    roll = 0.99;
    scriptEvent("bounty:test_capture", bob);
    fake.advance(1);
    roll = 0;
    return { ada, bob };
}

test("with the prisoner in the SECOND jail, that jail's button opens the lockpick and the first jail's says nobody is held there", async () => {
    scene();
    const { check, done } = checks();
    const { ada } = heldInSecond();

    check("(setup) the prisoner is in jail_2", state.getJailSite()?.id === "jail_2" && state.getJailSite()?.jail.x === JAIL_SITES[1].jail.x, JSON.stringify(state.getJailSite()));

    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("jail_1's button: told no one is held there, no form", said(ada).includes("No one is held in Jail 1.") && uiFake.shown.length === 0, said(ada).join(" | "));

    fake.advance(JAILS.pressGapTicks + 1);
    useBlock(ada, OTHER);
    fake.advance(1);
    await settle();
    check("jail_2's button: the lockpick form", shownTitles().length === 1 && shownTitles()[0] === "Pick the Lock", shownTitles().join(" | "));
    done();
});

test("moving the jail that holds prisoners keeps its buttons working, and a jailbreak opens the door as it is NOW, or none if the door was cleared", async () => {
    scene();
    const { check, done } = checks();
    const { ada, cy } = standard();

    store.saveJail(edited(store.getJail("jail_1"), { jail: { x: 500.5, y: 70, z: 500.5 }, doorTrigger: { x: 7, y: 8, z: 9 } }));

    answers(hit(0));
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("its button still opens the lockpick after the jail was moved (and the form comes back after a right pick, which is not yet enough)", shownTitles().length >= 1 && shownTitles().every((t) => t === "Pick the Lock"), shownTitles().join(" | "));
    answers(hit(0));
    useBlock(cy, BUTTON);
    fake.advance(1);
    await settle();

    check("the jailbreak succeeded", chat().includes("The jailbreak succeeded!"), chat().join(" | "));
    check("the redstone block went to the door trigger as it is now, not as it was at the capture", setblocks().length === 1 && setblocks()[0] === "setblock 7 8 9 redstone_block", setblocks().join(" | "));
    done();
});

test("a door trigger cleared while prisoners are held means nothing is placed at the jailbreak", async () => {
    scene();
    const { check, done } = checks();
    const { ada, cy } = standard();
    store.saveJail(edited(store.getJail("jail_1"), { doorTrigger: null }));

    answers(hit(0));
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    answers(hit(0));
    useBlock(cy, BUTTON);
    fake.advance(1);
    await settle();

    check("the jailbreak succeeded and placed nothing", chat().includes("The jailbreak succeeded!") && setblocks().length === 0, setblocks().join(" | "));
    done();
});

test("a jail switched off while it holds prisoners still works until they are free, and then its buttons are left to the game", async () => {
    scene();
    const { check, done } = checks();
    const { ada, bob } = standard();
    store.saveJail(edited(store.getJail("jail_1"), { enabled: false }));

    const held = useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("while it holds a prisoner the button is cancelled and the lockpick opens", held.cancel === true && shownTitles().length === 1, shownTitles().join(" | "));

    state.update(bob, { inJail: false });
    fake.advance(JAILS.pressGapTicks + 1);
    const empty = useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("with nobody held it is an ordinary block again", empty.cancel === false && shownTitles().length === 1);
    done();
});

test("a jail that holds prisoners is shown as such on the list and its own screen, and cannot be deleted (the screens say why)", async () => {
    scene();
    const { check, done } = checks();
    standard();
    const F = await load("core/jailforms.js");
    const { ui, press, close, yes, script: uiScript, titleOf, buttonsOf } = await import("./robbery-ui.mjs");
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, inventory: true });
    fake.advance(1);
    ui.shown.length = 0;
    uiFake.responses = [];                       // a plain list again: script() fills it (answers() above left a queue of its own)

    uiScript(press("Jail 1"), press("Delete"), yes, close, close);
    await F.openJailsEditor(op);

    const labelsOf = (form) => buttonsOf(form).map(strip);
    check("the list marks it", ui.shown.some((f) => labelsOf(f).includes("Jail 1 (on, 1 button, holds prisoners)")), ui.shown.map((f) => labelsOf(f).join(",")).join(" | "));
    check("its own screen says prisoners are held there", ui.shown.some((f) => /Prisoners are held here now/.test(strip(String(f.calls.find((c) => c[0] === "body")?.[1] ?? "")))));
    check("the delete was refused, with the way out, and the jail is still there", store.getJail("jail_1") !== undefined && ui.shown.some((f) => /prisoners are held there now: free them/.test(strip(String(f.calls.find((c) => c[0] === "body")?.[1] ?? "")))), titleOf(ui.shown[0]));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The lockpick form from a click
// ---------------------------------------------------------------------------------------------------------

test("a lockpick form the game says the player is too busy for is tried again, not lost", async () => {
    scene();
    const { check, done } = checks();
    const { ada } = standard();

    answers({ canceled: true, cancelationReason: "UserBusy" }, CLOSE);
    useBlock(ada, BUTTON);
    fake.advance(1);
    await settle();
    check("the first try was refused as busy", uiFake.shown.length === 1);

    fake.advance(12);
    await settle();
    check("and the form was shown again a moment later", uiFake.shown.length === 2 && shownTitles()[1] === "Pick the Lock", shownTitles().join(" | "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Binding, and the other things that react to the same click
// ---------------------------------------------------------------------------------------------------------

test("a bind click made with the builder's wand in hand is the bind's: the wand's menu does not open over it", async () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);
    fake.placeBlock("overworld", { x: 40, y: 70, z: 5 }, "minecraft:stone_button");

    bind.startBind(op, "jail_1", "button");
    const click = useBlock(op, [40, 70, 5], { held: "bountysys:robbery_wand" });
    fake.advance(2);
    await settle();

    check("the click was cancelled and taken as the bind", click.cancel === true && store.getJail("jail_1").buttons.length === 1);
    check("the wand opened no menu and asked for nothing", uiFake.shown.length === 0, shownTitles().join(" | "));
    done();
});

test("the RAE menu item in the operator's hand does not open the menu over a bind click, a moment after it either, and does again later", async () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);
    fake.placeBlock("overworld", { x: 40, y: 70, z: 5 }, "minecraft:stone_button");
    const useItem = () => world.afterEvents.itemUse.emit({ source: op, itemStack: { typeId: "bountysys:game_menu" } });

    bind.startBind(op, "jail_1", "button");
    useBlock(op, [40, 70, 5], { held: "bountysys:game_menu" });
    useItem();
    await settle();
    check("an item use reported with the click, before it is finished: no menu", uiFake.shown.length === 0, shownTitles().join(" | "));

    fake.advance(1);
    useItem();
    await settle();
    check("one reported a tick later, after the bind is saved: still no menu", uiFake.shown.length === 0 && store.getJail("jail_1").buttons.length === 1, shownTitles().join(" | "));

    fake.advance(20);
    useItem();
    await settle();
    check("a real use of the item later opens the menu", uiFake.shown.length === 1 && shownTitles()[0] === "RAE Game Menu", shownTitles().join(" | "));
    done();
});

test("a bind is dropped if the player is no longer an operator when the click comes", () => {
    scene();
    const { check, done } = checks();
    const op = operator();
    fake.advance(1);

    bind.startBind(op, "jail_1", "button");
    op.permission = PlayerPermissionLevel.Member;
    useBlock(op, [40, 70, 5]);
    fake.advance(1);

    check("nothing was bound and nothing was said", store.getJail("jail_1").buttons.length === 0 && op.messages.length === 0, op.messages.join(" | "));
    done();
});

test("a robbery cannot bind a block a jail uses, in either order", () => {
    scene();
    const { check, done } = checks();
    bindButton("jail_1", BUTTON);
    store.saveJail(edited(store.getJail("jail_1"), { doorTrigger: { x: 60, y: 61, z: 9 } }));
    fake.placeBlock("overworld", { x: 60, y: 61, z: 9 }, "minecraft:stone");
    robberies.saveRobbery(ok(RL.newRobbery("bank", "Bank", "overworld")));

    const asSwitch = robberyEdit.addElementAt("bank", { kind: "switch", name: "Pad", pos: BUTTON, withNeighbour: false });
    check("a jail's button is refused, naming the jail", asSwitch.ok === false && /button or the door trigger of the jail Jail 1/.test(asSwitch.reason), JSON.stringify(asSwitch));

    const asDoor = robberyEdit.addElementAt("bank", { kind: "switch", name: "Pad", pos: [60, 61, 9], withNeighbour: false });
    check("a jail's door trigger is refused too", asDoor.ok === false && /door trigger of the jail Jail 1/.test(asDoor.reason), JSON.stringify(asDoor));

    fake.placeBlock("overworld", { x: 70, y: 70, z: 5 }, "minecraft:stone_button");
    check("a block no jail uses is fine", robberyEdit.addElementAt("bank", { kind: "switch", name: "Free", pos: [70, 70, 5], withNeighbour: false }).ok === true);
    done();
});
