import { test } from "node:test";
import { fake, fakeUi, world, load, checks, strip, useBlock } from "./helpers.mjs";
import { L, SITE, at, bank, buildSite, ok, say } from "./robbery-fixtures.mjs";

// systems/robberyrun.ts: game events into engine calls. The contract: a before-event handler only decides and cancels
// (the engine forbids it anything else, so every test here runs the handlers in RESTRICTED execution and an attempt at a
// world change would throw), the real work happens a tick later, a held right-click counts once, a chest that was unlocked is
// left for the game to open, the builder's wand is not played with, protection spares operators, and a handler that fails
// reports to operators and never breaks the click.

const S = await load("core/robberystore.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
await load("systems/robberyrun.js");
const { ROBBERY: R } = await load("config/balance.js");

const IN_AREA = { x: 100, y: 65, z: 170 };
const OUTSIDE = { x: 500, y: 65, z: 500 };

const originalRandom = Math.random;
Math.random = () => 0.4;

async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

function setup(settings = {}) {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    fakeUi.uiFake.responses.length = 0;
    fakeUi.uiFake.shown.length = 0;
    R.pickGuessCooldownTicks = 0;
    fake.strictBefore = true;                  // the real engine's rule for every "before" handler

    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);
    buildSite();

    const built = bank("bank");
    const robbery = Object.keys(settings).length > 0 ? ok(L.setSettings(built.r, settings)) : built.r;
    S.saveRobbery(robbery);
    return built;
}

const outlaw = (name = "Ada", where = IN_AREA) => {
    const player = fake.makePlayer(name, { location: { ...where } });
    state.update(player, { role: "outlaw" });
    return player;
};

const operator = (name = "Op", where = IN_AREA) => fake.makePlayer(name, { location: { ...where }, permission: 2 });
const bar = (player) => player.actionBar.map(strip);
const said = (player) => player.messages.map(strip);
const errorsTo = (player) => said(player).filter((m) => /^\[robbery\]/.test(m));
const openBit = (pos) => fake.blockAt("overworld", at(pos)).permutation.getState("open_bit");

// ---------------------------------------------------------------------------------------------------------

test("a block no robbery owns is left completely alone", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:chest");

    const event = useBlock(ada, [1, 70, 1]);
    fake.advance(2);

    check("not cancelled", event.cancel === false);
    check("nothing started", Run.runningIds().length === 0);
    check("the player was told nothing", ada.messages.length === 0 && ada.actionBar.length === 0);
    done();
});

test("a right-click on a bound block is cancelled at once, and the work happens a tick later, outside restricted execution", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const op = operator("Op", OUTSIDE);

    fakeUi.uiFake.responses.push({ canceled: true, cancelationReason: "UserClosed" });
    const event = useBlock(ada, SITE.keypad);

    check("cancelled in the before-event, so the game does not press the button", event.cancel === true);
    check("nothing has happened yet: the handler only decided", Run.runningIds().length === 0 && fakeUi.uiFake.shown.length === 0);
    check("no restricted call was attempted (no error reached an operator)", errorsTo(op).length === 0, said(op).join("|"));

    fake.advance(1);
    await settle();
    check("a tick later it started the robbery (autoStart on the keypad)", Run.runningIds().join() === "bank");
    check("and put the pick form in front of her", fakeUi.uiFake.shown.length === 1, String(fakeUi.uiFake.shown.length));
    check("still no error", errorsTo(op).length === 0);
    done();
});

test("a held right-click repeats the event every tick, but only the first is a use; the repeats are still cancelled", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    const first = useBlock(ada, SITE.keypad, { first: true });
    const repeats = [1, 2, 3, 4].map(() => useBlock(ada, SITE.keypad, { first: false }));

    check("every event is cancelled", first.cancel && repeats.every((e) => e.cancel));

    fake.advance(1);
    await settle();
    check("one use: one form", fakeUi.uiFake.shown.length === 1, String(fakeUi.uiFake.shown.length));
    done();
});

test("a held click on a sealed element is one refusal, not one per tick", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    // The lockbox is sealed until the vault door is open. Each tick of a held click that was taken for a fresh use would
    // post another refusal, so this is the thing that tells a first event from a repeat (a pick form would hide it: the
    // run refuses to open two forms for one player).
    Run.startRobbery("bank", { by: ada });
    const events = [useBlock(ada, SITE.box, { first: true }), ...[1, 2, 3, 4].map(() => useBlock(ada, SITE.box, { first: false }))];
    fake.advance(1);

    const refusals = ada.actionBar.filter((m) => /sealed tight/.test(strip(m))).length;
    check("every event is cancelled", events.every((e) => e.cancel === true));
    check("but she was refused once", refusals === 1, String(refusals));
    check("with one thud", ada.privateSounds.filter((s) => s.id === R.cues.denied.id).length === 1, String(ada.privateSounds.length));
    done();
});

test("a chest that was unlocked this run is left to the game; before that it is cancelled", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    check("locked: cancelled", useBlock(ada, SITE.box).cancel === true);

    Run.activateElement("bank", "Keypad", ada);
    Run.activateElement("bank", "Lockbox", ada);

    const event = useBlock(ada, SITE.box);
    check("unlocked: the game opens it", event.cancel === false);
    fake.advance(1);
    check("and the run is not bothered again", Run.viewOf("bank").elements.find((e) => e.name === "Lockbox").state === "done");

    check("the open vault door still ignores clicks", useBlock(ada, SITE.doorLow).cancel === true);
    done();
});

test("an operator holding the wand is editing, not playing: nothing is cancelled or started; anyone else with a wand plays", () => {
    setup();
    const { check, done } = checks();
    const op = operator("Op");
    const ada = outlaw();

    const editing = useBlock(op, SITE.keypad, { held: R.wandItemId });
    fake.advance(2);
    check("the run leaves an operator's wand click to the builder", editing.cancel === false && Run.runningIds().length === 0);

    const playing = useBlock(ada, SITE.keypad, { held: R.wandItemId });
    check("a player with the same item plays: it is cancelled", playing.cancel === true);

    const opWithOtherItem = useBlock(op, SITE.keypad, { held: "minecraft:stick" });
    check("an operator with any other item plays too", opWithOtherItem.cancel === true);
    done();
});

test("the vault door cannot be opened with a click, however it is clicked", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    for (const face of ["Up", "Down", "North", "South", "East", "West"]) {
        check(`face ${face} is cancelled`, useBlock(ada, SITE.doorLow, { face }).cancel === true);
    }
    check("so the door is still shut", openBit(SITE.doorLow) === false && openBit(SITE.doorHigh) === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Pressure plates and tripwires
// ---------------------------------------------------------------------------------------------------------

function withPlate() {
    setup();
    const built = bank("bank");
    let r = built.r;
    const plate = L.addElement(r, { kind: "switch", name: "Alarm plate", cells: [[110, 70, 110]], onDone: [say("The alarm sounds!", "all")] });
    r = plate.robbery;
    S.saveRobbery(r);
    fake.placeBlock("overworld", { x: 110, y: 70, z: 110 }, "minecraft:stone_pressure_plate");
    return plate.element;
}

const plateBlock = () => fake.blockAt("overworld", { x: 110, y: 70, z: 110 });

test("a player stepping on a bound pressure plate uses it; a cow does not", () => {
    withPlate();
    const { check, done } = checks();
    const ada = outlaw();
    const sheriff = fake.makePlayer("Sheriff", { location: { ...OUTSIDE } });
    const cow = fake.makeEntity({ typeId: "minecraft:cow" });

    world.afterEvents.pressurePlatePush.emit({ block: plateBlock(), source: cow, redstonePower: 15, previousRedstonePower: 0 });
    check("a cow on the plate does nothing", Run.runningIds().length === 0);

    world.afterEvents.pressurePlatePush.emit({ block: plateBlock(), source: ada, redstonePower: 15, previousRedstonePower: 0 });
    check("a player does: the robbery starts and the alarm plate completes", Run.runningIds().join() === "bank" && said(sheriff).some((m) => /The alarm sounds/.test(m)), said(sheriff).join("|"));
    done();
});

test("a tripwire trip counts every player among its sources", () => {
    withPlate();
    const { check, done } = checks();
    const ada = outlaw();
    const cow = fake.makeEntity({ typeId: "minecraft:cow" });

    // The same plate stands in for a tripwire: the handler only looks at the block's binding and the sources.
    world.afterEvents.tripWireTrip.emit({ block: plateBlock(), isPowered: true, sources: [cow, ada] });

    check("the player among the sources started it", Run.runningIds().join() === "bank");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------------------------------------

function breakBlock(player, pos) {
    const event = { player, block: fake.dimension("overworld").getBlock(at(pos)), itemStack: undefined, cancel: false };
    world.beforeEvents.playerBreakBlock.emit(event);
    return event;
}

test("a bound block cannot be broken by a player, with a throttled chat line; an operator may; an unbound block may", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const op = operator();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone");

    check("the vault door is protected", breakBlock(ada, SITE.doorLow).cancel === true);
    check("the lockbox is protected", breakBlock(ada, SITE.box).cancel === true);
    check("she was told, naming the robbery", said(ada).some((m) => /That belongs to the Saint Diego Bank/.test(m)), said(ada).join("|"));

    for (let i = 0; i < 20; i++) breakBlock(ada, SITE.doorLow);
    check("holding the mouse button does not flood chat", said(ada).length === 1, String(said(ada).length));

    fake.advance(R.noticeTicks + 1);
    breakBlock(ada, SITE.doorLow);
    check("after a while she is told again", said(ada).length === 2, String(said(ada).length));

    check("an operator can break it", breakBlock(op, SITE.doorLow).cancel === false);
    check("an unbound block can be broken", breakBlock(ada, [1, 70, 1]).cancel === false);
    done();
});

test("with protect off, nothing is protected", () => {
    setup({ protect: false });
    const { check, done } = checks();
    const ada = outlaw();

    check("the vault door can be broken", breakBlock(ada, SITE.doorLow).cancel === false);
    done();
});

function explode(blocks) {
    const event = {
        dimension: fake.dimension("overworld"), source: undefined, cancel: false, impacted: undefined,
        getImpactedBlocks() { return blocks; },
        setImpactedBlocks(next) { event.impacted = next; }
    };
    world.beforeEvents.explosion.emit(event);
    return event;
}

test("an explosion spares bound blocks and still blows up everything else", () => {
    setup();
    const { check, done } = checks();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone");
    const at1 = (pos) => fake.dimension("overworld").getBlock(at(pos));

    const event = explode([at1(SITE.doorLow), at1(SITE.box), at1([1, 70, 1])]);

    check("the impacted list was replaced", event.impacted !== undefined);
    check("only the unbound block is left in it", event.impacted?.length === 1 && event.impacted[0].location.x === 1, JSON.stringify(event.impacted?.map((b) => b.location)));
    check("the explosion itself was not cancelled", event.cancel === false);

    const harmless = explode([at1([1, 70, 1])]);
    check("an explosion that touches nothing bound leaves its list alone", harmless.impacted === undefined);
    done();
});

test("in a world with no robberies an explosion costs nothing: its blocks are not even listed", () => {
    fake.reset();
    resetAllSystems();
    S.forgetLoaded();
    fake.strictBefore = true;
    const { check, done } = checks();

    let listed = 0;
    const event = { dimension: fake.dimension("overworld"), cancel: false, getImpactedBlocks() { listed++; return []; }, setImpactedBlocks() {} };
    world.beforeEvents.explosion.emit(event);

    check("getImpactedBlocks was never called", listed === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------------------------------------

test("a handler that fails tells operators and never breaks the click", () => {
    setup();
    const { check, done } = checks();
    const op = operator("Op", OUTSIDE);
    const ada = outlaw();

    const event = { player: ada, block: {}, blockFace: "Up", faceLocation: { x: 0, y: 0, z: 0 }, isFirstEvent: true, itemStack: undefined, cancel: false };
    let threw = false;
    try { world.beforeEvents.playerInteractWithBlock.emit(event); } catch { threw = true; }

    check("nothing was thrown into the game", !threw);
    check("the click was left alone", event.cancel === false);
    check("an operator was told", errorsTo(op).some((m) => /interacting with a block failed/.test(m)), said(op).join("|"));
    check("the player was not", ada.messages.length === 0);
    done();
});

test.after(() => { Math.random = originalRandom; });
