import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, fakeUi, world, load, checks, strip, useBlock } from "./helpers.mjs";
import { L, at, ok, added, pay, say } from "./robbery-fixtures.mjs";

// Playing a robbery with item frames in it: a jewelry store. The contract: taking from a frame (a right-click, or a punch the
// game cannot stop and the framework undoes) gives the thief the loot, empties the frame and counts as that element done, under
// every rule any element has (who may, what it waits for, its locks); a frame nobody may take from still shows its item; the
// site being put back shows the item again, whether it ended, was stopped, was reset, crashed or was in an unloaded chunk; and a
// frame is never taken from twice in one run. The game's own behaviour on a punch is ASSUMED by the fake (fake.punchFrame):
// docs/test-cards/ROBBERY-FRAME.md is what measures it.

const { ItemStack } = fakeApi;
const S = await load("core/robberystore.js");
const Run = await load("core/robberyrun.js");
const World = await load("core/robberyworld.js");
const Edit = await load("core/robberyedit.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
await load("systems/robberyrun.js");
const { ROBBERY: R } = await load("config/balance.js");

const NECKLACE = [200, 65, 200];
const RING = [202, 65, 200];
const ALARM = [204, 65, 200];
const IN_STORE = { x: 201, y: 65, z: 197 };
const OUTSIDE = { x: 500, y: 65, z: 500 };
const AREA = { min: [190, 60, 190], max: [210, 80, 210] };

const overworld = fake.dimension("overworld");

async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The store: a necklace (a diamond, a bounty on the thief), a ring (3 emeralds, ends the robbery), and an alarm button. */
function jewelry({ necklaceLocks = [], ringLocks = [], ringReq = [], necklaceTable } = {}) {
    let r = ok(L.newRobbery("jewels", "Jewelry Store", "overworld"));
    r = ok(L.setArea(r, AREA.min, AREA.max));

    const necklace = added(L.addElement(r, {
        kind: "frame", name: "Necklace", cells: [NECKLACE], items: necklaceTable ? [] : [["minecraft:diamond", 1]], ...(necklaceTable ? { table: necklaceTable } : {}),
        locks: necklaceLocks, onDone: [{ kind: "reward", coins: 0, bounty: 100, to: "actor" }]
    }));
    r = necklace.robbery;

    const ring = added(L.addElement(r, {
        kind: "frame", name: "Ring", cells: [RING], items: [["minecraft:emerald", 3]], locks: ringLocks, req: ringReq, onDone: [{ kind: "end", result: "win" }]
    }));
    r = ring.robbery;

    const alarm = added(L.addElement(r, { kind: "switch", name: "Alarm", cells: [ALARM], onDone: [say("Alarm!", "law")] }));
    r = alarm.robbery;

    return { r, necklace: necklace.element, ring: ring.element, alarm: alarm.element };
}

function setup(options = {}) {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    fakeUi.uiFake.responses.length = 0;
    fakeUi.uiFake.shown.length = 0;
    fake.strictBefore = true;
    R.guardFramePunches = true;
    R.pickGuessCooldownTicks = 0;

    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);

    fake.placeBlock("overworld", at(NECKLACE), "minecraft:frame", { facing_direction: 2 });
    fake.setFrameItem("overworld", at(NECKLACE), "minecraft:diamond");
    fake.placeBlock("overworld", at(RING), "minecraft:glow_frame", { facing_direction: 2 });
    fake.setFrameItem("overworld", at(RING), "minecraft:emerald", 3);
    fake.placeBlock("overworld", at(ALARM), "minecraft:stone_button");

    const built = jewelry(options);
    assert.equal(S.saveRobbery(built.r).ok, true);

    // What binding a frame does: saves it as it is.
    for (const cell of [NECKLACE, RING]) assert.equal(World.captureFrame("overworld", "jewels", cell).ok, true);

    return built;
}

function outlaw(name = "Ada", where = IN_STORE, coins = 0) {
    const player = fake.makePlayer(name, { location: { ...where }, inventory: true });
    state.update(player, { role: "outlaw" });
    fake.setScore("coins", player, coins);
    return player;
}

const lawman = (name = "Sheriff", where = IN_STORE) => {
    const player = fake.makePlayer(name, { location: { ...where }, inventory: true });
    state.update(player, { role: "law" });
    return player;
};

const ref = (pos) => S.boundAt("overworld", pos[0], pos[1], pos[2]);
const touch = (player, pos) => Run.touch(player, ref(pos));
const shows = (pos) => fake.frameItemAt("overworld", at(pos));
const said = (player) => player.messages.map(strip);
const bar = (player) => player.actionBar.map(strip);
const bagOf = (player) => {
    const out = [];
    for (let i = 0; i < player.container.size; i++) {
        const stack = player.container.getItem(i);
        if (stack) out.push(`${stack.typeId.replace("minecraft:", "")}x${stack.amount}`);
    }
    return out;
};
const looseItems = () => fake.entities.filter((e) => e.typeId === "minecraft:item" && e.isValid);
const bountyOf = (player) => world.scoreboard.getObjective("bounty").getScore(player) ?? 0;
const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player) ?? 0;
const stateOf = (name) => Run.viewOf("jewels")?.elements.find((e) => e.name === name)?.state;
const refills = () => S.dirtyEntries().filter((entry) => entry.action === "refill");

// ---------------------------------------------------------------------------------------------------------
// Taking from a frame
// ---------------------------------------------------------------------------------------------------------

test("taking from a frame gives the thief the loot, empties the frame, and is done", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    check("the frame shows a diamond", shows(NECKLACE)?.typeId === "minecraft:diamond");

    touch(ada, NECKLACE);

    check("she has the diamond", bagOf(ada).join() === "diamondx1", bagOf(ada).join());
    check("she was told what she took", said(ada).some((m) => /You took diamond\./.test(m)), said(ada).join(" | "));
    check("the frame shows nothing now", shows(NECKLACE) === undefined);
    check("but it is still a frame on the wall", fake.blockAt("overworld", at(NECKLACE)).typeId === "minecraft:frame" && fake.blockAt("overworld", at(NECKLACE)).permutation.getState("facing_direction") === 2);
    check("the robbery started by itself, and the necklace is done", Run.runningIds().join() === "jewels" && stateOf("Necklace") === "done", String(stateOf("Necklace")));
    check("what it was set to do happened: a bounty on the thief", bountyOf(ada) === 100, String(bountyOf(ada)));
    check("every frame of the robbery is noted to be shown again from the moment it starts, saved at once", refills().map((e) => e.pos.join()).sort().join("|") === [NECKLACE, RING].map((p) => p.join()).sort().join("|"), JSON.stringify(S.dirtyEntries()));
    check("the other frame is untouched", shows(RING)?.typeId === "minecraft:emerald" && stateOf("Ring") === "armed");
    done();
});

test("a frame is taken from once a run: a second try gives nothing more", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const bea = outlaw("Bea");

    touch(ada, NECKLACE);
    touch(ada, NECKLACE);
    touch(bea, NECKLACE);

    check("one diamond in all", bagOf(ada).join() === "diamondx1");
    check("the second thief got none", bagOf(bea).length === 0, bagOf(bea).join());
    check("the bounty was given once", bountyOf(ada) === 100);
    done();
});

test("loot that does not fit in the bag falls at the thief's feet", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    for (let i = 0; i < ada.container.size; i++) ada.container.setItem(i, new ItemStack("minecraft:stone", 64));

    touch(ada, NECKLACE);

    const dropped = overworld.spawnedItems.filter((entry) => entry.stack.typeId === "minecraft:diamond");
    check("the diamond is on the ground", dropped.length === 1, JSON.stringify(overworld.spawnedItems.map((e) => e.stack.typeId)));
    check("at her feet, not at the frame", Math.abs(dropped[0].location.x - ada.location.x) < 0.01 && Math.abs(dropped[0].location.z - ada.location.z) < 0.01);
    check("and she was still told she took it", said(ada).some((m) => /You took diamond/.test(m)));
    done();
});

test("a frame's loot can be a loot table, and a stack of several things is all told", () => {
    setup({ necklaceTable: "chests/gold_2" });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);

    check("the table's roll", bagOf(ada).join() === "gold_ingotx12", bagOf(ada).join());
    check("said in words, with the amount", said(ada).some((m) => /You took 12 gold ingot\./.test(m)), said(ada).join(" | "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The rules every element has
// ---------------------------------------------------------------------------------------------------------

test("only an outlaw may take: anyone else is refused, gets nothing, and the frame still shows its item", () => {
    setup();
    const { check, done } = checks();
    const sheriff = lawman();

    touch(sheriff, NECKLACE);

    check("nothing in the bag", bagOf(sheriff).length === 0);
    check("told why", bar(sheriff).some((m) => /only outlaws can do this/i.test(m)), bar(sheriff).join(" | "));
    check("the frame still shows the diamond", shows(NECKLACE)?.typeId === "minecraft:diamond");
    check("nothing started", Run.runningIds().length === 0);
    done();
});

test("a lock must be opened first, and a lock that is not opened leaves the item where it is", () => {
    setup({ necklaceLocks: [pay] });
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_STORE, 5);

    touch(poor, NECKLACE);
    check("a poor thief is told the price", bar(poor).some((m) => /it costs 25 coins and you have 5/i.test(m)), bar(poor).join(" | "));
    check("no loot, and the frame is full", bagOf(poor).length === 0 && shows(NECKLACE)?.typeId === "minecraft:diamond");
    check("not done", stateOf("Necklace") === "armed");

    const rich = outlaw("Rich", IN_STORE, 100);
    touch(rich, NECKLACE);
    check("a thief who pays is given it", bagOf(rich).join() === "diamondx1" && coinsOf(rich) === 75, `${bagOf(rich).join()} ${coinsOf(rich)}`);
    check("and the frame is empty", shows(NECKLACE) === undefined);
    done();
});

test("a frame can wait for something else, and then waits to be touched rather than handing out its loot", () => {
    setup({ ringReq: ["e1"] });
    const { check, done } = checks();
    const ada = outlaw();

    // The ring waits for the necklace (e1). Touched too soon it is sealed.
    Run.startRobbery("jewels", { by: ada });
    touch(ada, RING);
    check("sealed until the necklace is taken", bar(ada).some((m) => /sealed until something else is done/i.test(m)) && shows(RING)?.typeId === "minecraft:emerald");

    touch(ada, NECKLACE);
    check("the necklace is done", stateOf("Necklace") === "done");

    // An unlocked door that waits on something opens by itself; a frame must not give its loot to whoever finished the other step.
    check("the ring did NOT hand itself over", bagOf(ada).join() === "diamondx1" && shows(RING)?.typeId === "minecraft:emerald" && stateOf("Ring") === "armed", `${bagOf(ada).join()} ${stateOf("Ring")}`);

    touch(ada, RING);
    check("touched, it is taken", bagOf(ada).join() === "diamondx1,emeraldx3" && shows(RING) === undefined, bagOf(ada).join());
    done();
});

test("completing it from a command, with nobody to hand it to, lets the loot fall from the frame", () => {
    setup();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { location: { ...OUTSIDE }, inventory: true, permission: 2 });

    const result = Run.activateElement("jewels", "Necklace");

    check("it worked", result.ok === true, JSON.stringify(result));
    const fell = overworld.spawnedItems.filter((entry) => entry.stack.typeId === "minecraft:diamond");
    check("a diamond fell from the frame", fell.length === 1 && Math.abs(fell[0].location.x - 200.5) < 0.01 && Math.abs(fell[0].location.y - 65.5) < 0.01, JSON.stringify(overworld.spawnedItems));
    check("the frame is empty", shows(NECKLACE) === undefined);
    check("nobody else got anything", bagOf(op).length === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Putting it back
// ---------------------------------------------------------------------------------------------------------

test("when the robbery ends and its reset time comes, every frame shows its item again", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    touch(ada, RING);                                  // the ring ends the robbery with a win
    check("both are empty and the run is over", shows(NECKLACE) === undefined && shows(RING) === undefined && Run.viewOf("jewels")?.phase === "ended");
    check("two frames are noted", refills().length === 2);

    fake.advance(R.janitorEvery * 3);
    check("not yet: the reset time has not come", shows(NECKLACE) === undefined && refills().length === 2);

    fake.advance(60 * 20 + R.janitorEvery * 2);
    check("the necklace is back", JSON.stringify(shows(NECKLACE)) === JSON.stringify({ typeId: "minecraft:diamond", amount: 1 }), JSON.stringify(shows(NECKLACE)));
    check("the ring is back, with its three emeralds", JSON.stringify(shows(RING)) === JSON.stringify({ typeId: "minecraft:emerald", amount: 3 }), JSON.stringify(shows(RING)));
    check("nothing is waiting to be put back", S.dirtyCount() === 0);
    check("and it can be robbed again once the cooldown is over", Run.viewOf("jewels") === undefined);
    done();
});

test("stopping a robbery by hand, and resetting the site, put the frames back at once", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    check("emptied", shows(NECKLACE) === undefined);

    const reset = Run.resetSiteNow("jewels");
    check("both frames put back: the one taken from, and the one that was not", reset.cleaned === 2 && reset.left === 0, JSON.stringify(reset));
    check("with its diamond", shows(NECKLACE)?.typeId === "minecraft:diamond");
    check("and the ring still shows its emeralds", JSON.stringify(shows(RING)) === JSON.stringify({ typeId: "minecraft:emerald", amount: 3 }));
    check("and the run is forgotten", Run.runningIds().length === 0);
    done();
});

test("a frame is noted at the moment it is emptied, even if the note made when the run started is gone", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);                                          // starts the run, which notes both frames
    for (const entry of S.dirtyEntries()) S.clearDirty(entry);  // as if the list had been full, or cleared from outside
    check("nothing is noted now", S.dirtyCount() === 0);

    touch(ada, NECKLACE);

    check("the frame she took from is noted again by the theft itself", refills().some((entry) => entry.pos.join() === NECKLACE.join()), JSON.stringify(S.dirtyEntries()));
    done();
});

test("a frame emptied where the script never saw it is shown again when the site is put back", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);                                      // starts the run, which notes every frame
    // The game pops the Ring's item and tells no script anything: no punch report, no dropped-item report.
    fake.punchFrame(ada, "overworld", at(RING), { signals: [], announce: false });
    check("the ring is empty and the framework knows nothing about it", shows(RING) === undefined && stateOf("Ring") === "armed");

    Run.stopRobbery("jewels");
    fake.advance(R.janitorEvery * 2);

    check("the ring shows its emeralds again", JSON.stringify(shows(RING)) === JSON.stringify({ typeId: "minecraft:emerald", amount: 3 }), JSON.stringify(shows(RING)));
    check("and so does the necklace", shows(NECKLACE)?.typeId === "minecraft:diamond");
    check("the item that popped is still on the floor: nothing ever heard of it", looseItems().length === 1);
    check("nothing is left waiting", S.dirtyCount() === 0);
    done();
});

test("resetting by hand shows every frame again, even one nobody was seen taking from", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    fake.punchFrame(ada, "overworld", at(RING), { signals: [], announce: false });
    check("no run, and the ring is empty", Run.runningIds().length === 0 && shows(RING) === undefined);

    const reset = Run.resetSiteNow("jewels");

    check("both frames were put back", reset.cleaned === 2 && reset.left === 0, JSON.stringify(reset));
    check("the ring shows its emeralds again", JSON.stringify(shows(RING)) === JSON.stringify({ typeId: "minecraft:emerald", amount: 3 }));
    check("and the necklace is as it was", shows(NECKLACE)?.typeId === "minecraft:diamond");
    done();
});

test("a frame the game refuses to put back is tried again until it works", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const original = console.warn;
    const place = world.structureManager.place;

    touch(ada, NECKLACE);
    Run.stopRobbery("jewels");

    console.warn = () => {};
    world.structureManager.place = () => { throw new Error("the game refused"); };

    try {
        fake.advance(R.janitorEvery * 3);
        check("still empty, and still noted: a refusal is not a success", shows(NECKLACE) === undefined && refills().length === 2, `${JSON.stringify(shows(NECKLACE))} ${refills().length}`);
    } finally {
        world.structureManager.place = place;
        console.warn = original;
    }

    fake.advance(R.janitorEvery * 3);
    check("once the game allows it, both are back", shows(NECKLACE)?.typeId === "minecraft:diamond" && S.dirtyCount() === 0, `${JSON.stringify(shows(NECKLACE))} ${S.dirtyCount()}`);
    done();
});

test("after a theft and the reset a player can SEE the item back in the frame, and in the one nobody touched", () => {
    setup();
    fake.strictFrameSync = true;                       // the suspected case the owner reported on 2026-10-08 (see the fake's header)
    const { check, done } = checks();
    const ada = outlaw();

    check("before, players see both items", fake.frameShown("overworld", at(NECKLACE))?.typeId === "minecraft:diamond" && fake.frameShown("overworld", at(RING))?.typeId === "minecraft:emerald");

    touch(ada, NECKLACE);
    check("after the theft players see the necklace's frame empty", fake.frameShown("overworld", at(NECKLACE)) === undefined);

    Run.stopRobbery("jewels");
    fake.advance(R.janitorEvery * 2);

    check("the diamond is back, and visible", fake.frameShown("overworld", at(NECKLACE))?.typeId === "minecraft:diamond", JSON.stringify(fake.frameShown("overworld", at(NECKLACE))));
    check("the emeralds are visible too, three of them", fake.frameShown("overworld", at(RING))?.typeId === "minecraft:emerald" && fake.frameShown("overworld", at(RING))?.amount === 3, JSON.stringify(fake.frameShown("overworld", at(RING))));
    done();
});

test("a punch that is undone leaves the frame looking full to a player", () => {
    setup({ necklaceLocks: [pay] });
    fake.strictFrameSync = true;
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_STORE, 0);

    fake.punchFrame(poor, "overworld", at(NECKLACE));
    check("the game's pop is seen at once: the frame looks empty", fake.frameShown("overworld", at(NECKLACE)) === undefined);

    fake.advance(R.frameCleanupTicks);

    check("a moment later it looks full again", fake.frameShown("overworld", at(NECKLACE))?.typeId === "minecraft:diamond", JSON.stringify(fake.frameShown("overworld", at(NECKLACE))));
    done();
});

test("a robbery that was running when the world closed has its frames put back after the reload", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    check("emptied", shows(NECKLACE) === undefined);

    // The world closes: memory is lost, the saved note is not.
    resetAllSystems();
    S.forgetLoaded();
    fake.advance(R.janitorEvery * 2);

    check("the frame is full again", shows(NECKLACE)?.typeId === "minecraft:diamond", JSON.stringify(shows(NECKLACE)));
    check("and nothing is left to do", S.dirtyCount() === 0);
    done();
});

test("a frame in a chunk that is not loaded is put back when the chunk is", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    Run.stopRobbery("jewels");

    fake.setUnloaded("overworld", [{ from: { x: 190, y: 0, z: 190 }, to: { x: 210, y: 100, z: 210 } }]);
    fake.advance(R.janitorEvery * 3);
    check("still empty, and still noted along with the other frame", shows(NECKLACE) === undefined && refills().length === 2);

    fake.setUnloaded("overworld", []);
    fake.advance(R.janitorEvery * 2);
    check("the chunk is back: the frame is full", shows(NECKLACE)?.typeId === "minecraft:diamond" && S.dirtyCount() === 0);
    done();
});

test("a frame with no saved copy stays empty, and does not keep the robbery from running again", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
        touch(ada, NECKLACE);
        Run.stopRobbery("jewels");
        fake.structures.delete(World.frameStructureId("jewels", NECKLACE));       // someone deleted the structure

        fake.advance(R.janitorEvery * 2);
    } finally {
        console.warn = original;
    }

    check("the frame stays empty: nothing can put it back", shows(NECKLACE) === undefined);
    check("but nothing is stuck waiting", S.dirtyCount() === 0 && S.robberyIsDirty("jewels") === false);
    check("the log says why", warnings.some((w) => /no saved copy/.test(w) && /Save what the frame shows now/.test(w)), warnings.join(" | "));
    check("and the robbery can start again", Run.whyCannotStart("jewels", { test: true }) === undefined, String(Run.whyCannotStart("jewels", { test: true })));
    done();
});

test("a frame knocked out of the wall during a robbery is made again when the site is put back", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    fake.placeBlock("overworld", at(NECKLACE), "minecraft:air");        // an operator took the frame down
    Run.resetSiteNow("jewels");

    check("the frame is back on the wall with its diamond", fake.blockAt("overworld", at(NECKLACE)).typeId === "minecraft:frame" && shows(NECKLACE)?.typeId === "minecraft:diamond");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The game's events
// ---------------------------------------------------------------------------------------------------------

test("a right-click on a bound frame is cancelled at once (the frame does not turn or take the held item) and played a tick later", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    const event = useBlock(ada, NECKLACE);

    check("cancelled in the before-event", event.cancel === true);
    check("nothing has happened yet: the handler only decided", bagOf(ada).length === 0 && shows(NECKLACE)?.typeId === "minecraft:diamond");

    fake.advance(1);
    check("a tick later she has taken it", bagOf(ada).join() === "diamondx1" && shows(NECKLACE) === undefined);
    check("no error reached anyone", said(ada).every((m) => !/^\[robbery\]/.test(m)));
    done();
});

test("a builder who sneaks at a frame is left to change what it shows", () => {
    setup();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { location: { ...IN_STORE }, inventory: true, permission: 2 });
    op.isSneaking = true;

    const event = useBlock(op, NECKLACE);
    fake.advance(1);

    check("not cancelled: the game does what it does", event.cancel === false);
    check("and no theft", bagOf(op).length === 0 && shows(NECKLACE)?.typeId === "minecraft:diamond" && Run.runningIds().length === 0);

    op.isSneaking = false;
    const standing = useBlock(op, NECKLACE);
    check("standing up, the same operator plays it like anyone", standing.cancel === true);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Punching a frame
// ---------------------------------------------------------------------------------------------------------

test("a punch on a frame is undone and counts as taking it: she ends with the loot once, not twice", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    check("the punch lands", fake.punchFrame(ada, "overworld", at(NECKLACE)) === true);
    check("the game popped the item out: it is on the floor and the frame is bare", looseItems().length === 1 && shows(NECKLACE) === undefined);

    fake.advance(R.frameCleanupTicks);

    check("the popped item is gone", looseItems().length === 0, String(looseItems().length));
    check("she has the loot exactly once", bagOf(ada).join() === "diamondx1", bagOf(ada).join());
    check("the frame is empty, as it should be after a theft", shows(NECKLACE) === undefined);
    check("the necklace is done and its bounty given", stateOf("Necklace") === "done" && bountyOf(ada) === 100);
    done();
});

test("a punch on a frame she cannot open takes the item back out of her hands and puts the frame as it was", () => {
    setup({ necklaceLocks: [pay] });
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_STORE, 5);

    fake.punchFrame(poor, "overworld", at(NECKLACE));
    check("popped", looseItems().length === 1 && shows(NECKLACE) === undefined);

    fake.advance(R.frameCleanupTicks);

    check("the popped item is gone", looseItems().length === 0);
    check("the frame shows the diamond again", JSON.stringify(shows(NECKLACE)) === JSON.stringify({ typeId: "minecraft:diamond", amount: 1 }), JSON.stringify(shows(NECKLACE)));
    check("she has nothing and was told the price", bagOf(poor).length === 0 && bar(poor).some((m) => /it costs 25 coins/i.test(m)), bar(poor).join(" | "));
    check("it is not done", stateOf("Necklace") === "armed");
    done();
});

test("a law player's punch is undone too, and refused", () => {
    setup();
    const { check, done } = checks();
    const sheriff = lawman();

    fake.punchFrame(sheriff, "overworld", at(NECKLACE));
    fake.advance(R.frameCleanupTicks);

    check("nothing on the floor, nothing in the bag", looseItems().length === 0 && bagOf(sheriff).length === 0);
    check("the frame shows its diamond", shows(NECKLACE)?.typeId === "minecraft:diamond");
    check("refused", bar(sheriff).some((m) => /only outlaws can do this/i.test(m)));
    done();
});

test("whichever of the game's reports comes first, or comes alone, a punch is handled once", () => {
    const { check, done } = checks();

    for (const [label, options] of [
        ["the pop first, then the start of breaking", { order: "pop-first" }],
        ["the start of breaking first, then the pop", { order: "signal-first" }],
        ["only an entity hitting the block", { signals: ["hit"] }],
        ["both reports of the same punch", { signals: ["start", "hit"] }]
    ]) {
        setup();
        const ada = outlaw();

        fake.punchFrame(ada, "overworld", at(NECKLACE), options);
        fake.advance(R.frameCleanupTicks + 1);

        check(`${label}: she has the diamond once`, bagOf(ada).join() === "diamondx1", `${bagOf(ada).join()}`);
        check(`${label}: nothing is left on the floor`, looseItems().length === 0);
        check(`${label}: the bounty came once`, bountyOf(ada) === 100, String(bountyOf(ada)));
    }

    done();
});

test("only what popped out of the frame is taken; an item lying beside it is left alone", () => {
    setup({ necklaceLocks: [pay] });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_STORE, 0);

    const lying = overworld.spawnItem({ typeId: "minecraft:stick", amount: 5 }, { x: 200.9, y: 65, z: 200.2 });
    fake.advance(R.frameRecentTicks + 5);                 // it has been there a while

    fake.punchFrame(ada, "overworld", at(NECKLACE));
    fake.advance(R.frameCleanupTicks);

    check("the stick is still there", lying.isValid === true);
    check("the popped diamond is not", looseItems().every((e) => e.id === lying.id));
    done();
});

test("with the guard switched off, a punch is left to the game", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    R.guardFramePunches = false;

    try {
        fake.punchFrame(ada, "overworld", at(NECKLACE));
        fake.advance(R.frameCleanupTicks + 2);

        check("the item is on the floor, as the game left it", looseItems().length === 1);
        check("the frame is bare and was not put back", shows(NECKLACE) === undefined);
        check("nothing was counted", bagOf(ada).length === 0 && Run.runningIds().length === 0);
    } finally {
        R.guardFramePunches = true;
    }
    done();
});

test("a frame already taken from this run is left empty by a punch, with nothing to undo", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    const before = bagOf(ada).join();

    fake.punchFrame(ada, "overworld", at(NECKLACE));
    fake.advance(R.frameCleanupTicks + 2);

    check("still empty", shows(NECKLACE) === undefined);
    check("no second loot", bagOf(ada).join() === before);
    done();
});

test("a builder's punch is left alone: with the wand, or sneaking", () => {
    setup();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { location: { ...IN_STORE }, inventory: true, permission: 2 });

    op.isSneaking = true;
    fake.punchFrame(op, "overworld", at(NECKLACE));
    fake.advance(R.frameCleanupTicks + 2);
    check("sneaking: the item stays on the floor, nothing counted", looseItems().length === 1 && Run.runningIds().length === 0);

    op.isSneaking = false;
    for (const item of looseItems()) item.remove();
    fake.setFrameItem("overworld", at(RING), "minecraft:emerald", 3);
    op.container.setItem(op.selectedSlotIndex, new ItemStack(R.wandItemId, 1));
    fake.punchFrame(op, "overworld", at(RING));
    fake.advance(R.frameCleanupTicks + 2);
    check("with the wand: left alone too", looseItems().length === 1 && Run.runningIds().length === 0);
    done();
});

test("a punch on a bound block that is not a frame does nothing special", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    fake.setFrameItem("overworld", at(ALARM), "minecraft:stick");           // not a frame, so nothing can be punched out of it
    check("the fake knows it is not a frame", fake.punchFrame(ada, "overworld", at(ALARM)) === false);

    fake.advance(R.frameCleanupTicks + 2);
    check("nothing happened", Run.runningIds().length === 0 && looseItems().length === 0);
    done();
});

test("if the game never says an item appeared, nothing is removed and the frame is not put back, so the popped item is the thief's to pick up", () => {
    setup({ necklaceLocks: [pay] });
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_STORE, 0);

    fake.punchFrame(poor, "overworld", at(NECKLACE), { announce: false });
    fake.advance(R.frameCleanupTicks + 2);

    check("the popped item is still there: it was never known about", looseItems().length === 1);
    check("the frame was not put back, so there is not a second copy", shows(NECKLACE) === undefined);
    done();
});

test("the known limit: if the game never says an item appeared and the thief CAN take it, she keeps the popped item and is given the loot too", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    fake.punchFrame(ada, "overworld", at(NECKLACE), { announce: false });
    fake.advance(R.frameCleanupTicks + 2);

    check("the popped diamond lies there for her to pick up", looseItems().length === 1 && looseItems()[0].getComponent("minecraft:item")?.itemStack.typeId === "minecraft:diamond", String(looseItems().length));
    check("and she was handed the loot as well: two diamonds in all, where the shop meant one", bagOf(ada).join() === "diamondx1");
    done();
});

test("a frame taken from between a punch and its undo is not put back by the undo", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    fake.punchFrame(ada, "overworld", at(NECKLACE));        // the item pops out, and the punch is reported
    touch(ada, NECKLACE);                                   // and a right-click lands in the same moment: she takes the loot
    fake.advance(R.frameCleanupTicks + 2);

    check("the frame stays empty: the theft already emptied it, and the undo must not bring the display back", shows(NECKLACE) === undefined, JSON.stringify(shows(NECKLACE)));
    check("the popped item is gone", looseItems().length === 0, String(looseItems().length));
    check("she has the loot once", bagOf(ada).join() === "diamondx1", bagOf(ada).join());
    done();
});

test("an item that appeared long before the punch is left alone, even right beside the frame", () => {
    setup({ necklaceLocks: [pay] });
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_STORE, 0);

    const lying = overworld.spawnItem({ typeId: "minecraft:stick", amount: 5 }, { x: 200.9, y: 65.2, z: 200.4 });
    world.afterEvents.entitySpawn.emit({ entity: lying, cause: "Spawned" });      // the game told us about it, back then
    fake.advance(R.frameRecentTicks + 8);

    fake.punchFrame(poor, "overworld", at(NECKLACE));
    fake.advance(R.frameCleanupTicks);

    check("the stick is still there", lying.isValid === true);
    check("the diamond that popped is gone and the frame shows it again", looseItems().every((e) => e.id === lying.id) && shows(NECKLACE)?.typeId === "minecraft:diamond");
    done();
});

test("with debug logging on a frame's click and punch say what the game reported and what was done; with it off they say nothing", async () => {
    setup();
    const { check, done } = checks();
    const log = await load("core/log.js");
    const ada = outlaw();

    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args.join(" "));

    let main = [];
    let noise = [];
    let quiet = [];

    try {
        useBlock(ada, NECKLACE);
        fake.advance(1);
        fake.punchFrame(ada, "overworld", at(RING));
        fake.advance(R.frameCleanupTicks + 1);
        check("off by default: nothing about frames was written", lines.filter((l) => /\[robbery\]/.test(l)).length === 0, lines.join(" | "));

        log.setDebugLogging(true);

        setup();
        const bob = outlaw("Bob");
        const builder = fake.makePlayer("Builder", { location: { ...IN_STORE }, inventory: true, permission: 2 });
        lines.length = 0;

        useBlock(bob, NECKLACE);
        fake.advance(1);
        fake.punchFrame(bob, "overworld", at(RING), { signals: ["start", "hit"] });
        fake.advance(R.frameCleanupTicks + 1);

        builder.isSneaking = true;
        useBlock(builder, RING);
        fake.punchFrame(builder, "overworld", at(RING));
        fake.advance(R.frameCleanupTicks + 1);

        // What must not look like a punch on a frame: something other than an item appearing, a punch on a bound button, a zombie hitting a frame.
        const before = lines.length;
        const zombie = fake.makeEntity({ typeId: "minecraft:zombie", location: { ...IN_STORE } });
        world.afterEvents.entitySpawn.emit({ entity: zombie, cause: "Spawned" });
        world.afterEvents.playerStartBreakingBlock.emit({ player: bob, block: overworld.getBlock(at(ALARM)), face: "North" });
        world.afterEvents.entityHitBlock.emit({ damagingEntity: zombie, hitBlock: overworld.getBlock(at(RING)), blockFace: "North" });
        fake.advance(R.frameCleanupTicks + 1);
        noise = lines.slice(before).filter((l) => /^\[robbery\]/.test(l));

        // A world with no frame bound looks at nothing: not a dropped item, not a punch.
        main = lines.slice();
        fake.reset();
        resetAllSystems();
        fake.advance(1);
        S.forgetLoaded();
        lines.length = 0;
        const stick = overworld.spawnItem({ typeId: "minecraft:stick", amount: 1 }, { x: 1, y: 65, z: 1 });
        world.afterEvents.entitySpawn.emit({ entity: stick, cause: "Spawned" });
        quiet = lines.filter((l) => /^\[robbery\]/.test(l));
    } finally {
        log.setDebugLogging(false);
        console.warn = original;
    }

    const robbery = main.filter((l) => /^\[robbery\]/.test(l));
    check("a right-click says it was cancelled", robbery.some((l) => /right-click on frame jewels\/e\d+: cancel$/.test(l)), robbery.join(" | "));
    check("a dropped item says it appeared", robbery.some((l) => /a dropped item appeared \(\S+, Spawned\)/.test(l)), robbery.join(" | "));
    check("a punch says how the game reported it, both ways", robbery.some((l) => /punch on frame jewels\/e\d+ \(started breaking\)$/.test(l)) && robbery.some((l) => /punch on frame jewels\/e\d+ \(hit\)$/.test(l)), robbery.join(" | "));
    check("and what was done about it", robbery.some((l) => /punch on frame jewels\/Ring: 1 dropped item\(s\) appeared in the last \d+ ticks, 1 removed near the frame, put back/.test(l)), robbery.join(" | "));
    check("once, for the one punch the game reported twice", robbery.filter((l) => /punch on frame jewels\/Ring: /.test(l)).length === 1, robbery.join(" | "));
    check("a sneaking builder's click is left to the game, and says so", robbery.some((l) => /left to the game \(a builder sneaking\)/.test(l)), robbery.join(" | "));
    check("and so is her punch", robbery.some((l) => /\(started breaking\) ignored: a builder sneaking/.test(l)), robbery.join(" | "));
    check("a zombie appearing, a punch on a button and a zombie hitting a frame are none of its business", noise.length === 0, noise.join(" | "));
    check("a world with no frame bound writes nothing about a dropped item", quiet.length === 0, quiet.join(" | "));
    done();
});

test("a world with no item frame bound pays nothing for dropped items and punches", () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_STORE);

    check("no frame is bound", S.anyBoundFrames() === false && S.anyBoundBlocks() === false);

    const item = overworld.spawnItem({ typeId: "minecraft:stick", amount: 1 }, { x: 1, y: 65, z: 1 });
    world.afterEvents.entitySpawn.emit({ entity: item, cause: "Spawned" });
    fake.placeBlock("overworld", at(NECKLACE), "minecraft:frame");
    fake.punchFrame(ada, "overworld", at(NECKLACE));
    fake.advance(R.frameCleanupTicks + 2);

    check("nothing happened and nothing broke", Run.runningIds().length === 0 && item.isValid === true);
    done();
});

test("the cleanup list keeps a frame's note across a reload", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, NECKLACE);
    S.forgetLoaded();

    check("the note is read back, with its action", S.dirtyEntries().some((entry) => entry.action === "refill" && entry.pos.join() === NECKLACE.join() && entry.robbery === "jewels"), JSON.stringify(S.dirtyEntries()));
    done();
});
