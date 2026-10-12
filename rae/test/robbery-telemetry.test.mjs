import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeUi, load, checks } from "./helpers.mjs";
import { L, SITE, added, bank, buildSite, ok } from "./robbery-fixtures.mjs";

// core/robberyrun.ts as the telemetry sees it: a run is told as a `robbery.start`, a `robbery.element` for each element as it is done, and exactly
// one `robbery.end`, however the run ends (the win, the time limit, everyone leaving, an operator's stop or reset, a round reset, the robbery
// being deleted). Every line of one run carries its robbery's id and the run's number (`r`). What the run DOES is robbery-run.test.mjs's business;
// these tests only read what it says about itself, so each one drives the same bank those tests do.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

const S = await load("core/robberystore.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

const IN_AREA = { x: 100, y: 65, z: 170 };
const OUTSIDE = { x: 500, y: 65, z: 500 };

const originalRandom = Math.random;
Math.random = () => 0.4;                       // the hidden pick target is always 40
process.on("exit", () => { Math.random = originalRandom; });

async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Forgets what the last test left noted for cleanup. Several of these tests end with a site still held (a win, then a round reset), and the
 * store keeps that list in memory: left alone it would hand the next test a robbery that "is still being put back" and will not start.
 */
function freshStore() {
    for (const entry of S.dirtyEntries()) S.clearDirty(entry);
}

const guess = (value) => fakeUi.uiFake.responses.push({ canceled: false, formValues: [value] });

function setup(settings = {}) {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    freshStore();
    fakeUi.uiFake.responses.length = 0;
    fakeUi.uiFake.shown.length = 0;
    R.pickGuessCooldownTicks = 0;

    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);
    buildSite();

    const built = bank("bank");
    let robbery = built.r;
    if (Object.keys(settings).length > 0) robbery = ok(L.setSettings(robbery, settings));

    assert.equal(S.saveRobbery(robbery).ok, true);

    return { ...built, r: robbery };
}

function outlaw(name = "Ada", at = IN_AREA, coins = 0) {
    const player = fake.makePlayer(name, { location: { ...at } });
    state.update(player, { role: "outlaw" });
    fake.setScore("coins", player, coins);
    return player;
}

const ref = (pos) => S.boundAt("overworld", pos[0], pos[1], pos[2]);
const touch = (player, pos) => Run.touch(player, ref(pos));

/** Plays the keypad: two correct picks (the target is always 40). */
async function openKeypad(player) {
    guess(40); guess(40);
    touch(player, SITE.keypad);
    await settle();
}

/** How many lines have been written so far: take it before the part of a test whose lines are wanted. */
const mark = () => lines.length;

/** The robbery lines written since `from`, parsed, in order. */
function told(from) {
    return lines.slice(from)
        .filter((text) => text.startsWith("[telemetry] {"))
        .map((text) => JSON.parse(text.slice("[telemetry] ".length)))
        .filter((e) => e.k.startsWith("robbery."));
}

test("a whole robbery is told in order: the start, each element as it is done, and one end that says it was won", async () => {
    const built = setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    outlaw("Bob", OUTSIDE, 0);
    const from = mark();

    await openKeypad(ada);
    fake.advance(30);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();
    fake.advance(70);                                  // past the win's 3-second delay

    const t = told(from);
    const [start, keypad, door, box, end] = t;

    check("a start, three elements and an end, in that order", t.map((e) => e.k).join() === "robbery.start,robbery.element,robbery.element,robbery.element,robbery.end", t.map((e) => e.k).join());
    check("the start: who, as what, and how many were inside", start?.id === "bank" && start.test === false && start.p === ada.id && start.role === "outlaw" && start.inside === 1, JSON.stringify(start));
    check("the keypad: a switch with a pick lock, done at once by her", keypad?.el === built.keypad.id && keypad.kind === "switch" && JSON.stringify(keypad.locks) === "[\"pick\"]" && keypad.after === 0 && keypad.p === ada.id, JSON.stringify(keypad));
    check("the vault door: opened by the keypad in the same moment, still by her", door?.el === built.door.id && door.kind === "door" && JSON.stringify(door.locks) === "[]" && door.after === 0 && door.p === ada.id, JSON.stringify(door));
    check("the lockbox: a chest with a pick and a price, 30 ticks in", box?.el === built.box.id && box.kind === "chest" && JSON.stringify(box.locks) === "[\"pick\",\"pay\"]" && box.after === 30 && box.p === ada.id, JSON.stringify(box));
    check("the end: won, all three elements, one person, 90 ticks (and a loop tick) after it began", end?.result === "win" && end.test === false && end.done === 3 && end.of === 3 && end.people === 1 && end.dur >= 90 && end.dur < 90 + R.tickEvery, JSON.stringify(end));
    check("every line of the run carries the same run number", new Set(t.map((e) => e.r)).size === 1 && Number.isInteger(start?.r), JSON.stringify(t.map((e) => e.r)));
    done();
});

/** The ways a run can end, and what each should be told as. `end` ends it; it may need the robber (to walk her out of the area). */
const ENDINGS = [
    ["the time limit", { timeLimitSeconds: 100, resetAfterSeconds: 5, failWhenEmptySeconds: 0 }, () => fake.advance(100 * 20 + 20), "fail", 3],
    ["everyone leaving", { failWhenEmptySeconds: 30, timeLimitSeconds: 0 }, (ada) => { ada.teleport({ ...OUTSIDE }); fake.advance(40 * 20); }, "fail", 3],
    ["an operator's stop", {}, () => { Run.stopRobbery("bank"); }, "stopped", 3],
    ["an operator's site reset", {}, () => { Run.resetSiteNow("bank"); }, "stopped", 3],
    ["a round reset", {}, () => resetAllSystems(), "round", 3],
    // The robbery is gone, so how many elements it had is no longer known: the ones that were done are all there is to say.
    ["the robbery being deleted", {}, () => { S.deleteRobbery("bank"); fake.advance(R.tickEvery * 2); }, "stopped", 2]
];

for (const [name, settings, end, result, of] of ENDINGS) {
    test(`${name} ends the run with exactly one robbery.end, and it says '${result}'`, async () => {
        setup(settings);
        const { check, done } = checks();
        const ada = outlaw();
        const from = mark();

        await openKeypad(ada);
        end(ada);
        fake.advance(R.tickEvery * 2);

        const t = told(from);
        const ends = t.filter((e) => e.k === "robbery.end");

        check("one start", t.filter((e) => e.k === "robbery.start").length === 1, t.map((e) => e.k).join());
        check("one end", ends.length === 1, t.map((e) => e.k).join());
        check(`told as '${result}'`, ends[0]?.result === result, JSON.stringify(ends[0]));
        check("with the elements that were done by then (the keypad and the door), of how many there were, and one person", ends[0]?.done === 2 && ends[0].of === of && ends[0].people === 1, JSON.stringify(ends[0]));
        done();
    });
}

for (const [name, after] of [["the robbery being deleted", () => { S.deleteRobbery("bank"); fake.advance(R.tickEvery * 2); }], ["a round reset", () => resetAllSystems()]]) {
    test(`${name} after a win adds no second robbery.end`, async () => {
        setup({ resetAfterSeconds: 600 });
        const ada = outlaw("Ada", IN_AREA, 100);
        const from = mark();

        await openKeypad(ada);
        guess(40); guess(40);
        touch(ada, SITE.box);
        await settle();
        fake.advance(70);                              // the win

        after();

        const ends = told(from).filter((e) => e.k === "robbery.end");
        assert.equal(ends.length, 1, JSON.stringify(ends));
        assert.equal(ends[0].result, "win");
    });
}

test("a round reset does not start the run numbers over", async () => {
    setup();
    const ada = outlaw();
    const from = mark();

    await openKeypad(ada);
    resetAllSystems();
    ada.teleport({ ...OUTSIDE });                      // the janitor waits for the area to be empty
    fake.advance(R.janitorEvery + R.tickEvery);
    assert.equal(Run.startRobbery("bank", { by: ada }).ok, true);

    const starts = told(from).filter((e) => e.k === "robbery.start");
    assert.equal(starts.length, 2, JSON.stringify(told(from)));
    assert.equal(starts[1].r, starts[0].r + 1);
});

test("the first ending is the only one told: a stop, a reset and the time limit after a win add nothing", async () => {
    setup({ timeLimitSeconds: 200, resetAfterSeconds: 600 });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    const from = mark();

    await openKeypad(ada);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();
    fake.advance(70);                                  // the win

    Run.stopRobbery("bank");
    Run.resetSiteNow("bank");
    fake.advance(300 * 20);                            // far past the time limit

    const ends = told(from).filter((e) => e.k === "robbery.end");
    check("one end, and it is the win", ends.length === 1 && ends[0].result === "win", JSON.stringify(ends));
    done();
});

test("a test run is told as one, and a start from a command block has no player", async () => {
    setup();
    const { check, done } = checks();
    outlaw("Ada", IN_AREA);
    const from = mark();

    const started = Run.startRobbery("bank", { test: true });
    check("it started", started.ok === true, JSON.stringify(started));
    Run.stopRobbery("bank");
    fake.advance(R.tickEvery * 2);

    const t = told(from);
    const start = t.find((e) => e.k === "robbery.start");
    const end = t.find((e) => e.k === "robbery.end");

    check("the start is a test with nobody who started it, and the area's crowd counted (a test run lets anyone in)", start?.test === true && !("p" in start) && !("role" in start) && start.inside === 1, JSON.stringify(start));
    check("and so is the end", end?.test === true && end.result === "stopped", JSON.stringify(end));
    done();
});

test("a teller held up is an element of kind 'teller'", async () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    freshStore();
    fake.addObjective("coins");
    fake.addObjective("bounty");

    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    r = ok(L.setArea(r, SITE.area.min, SITE.area.max));
    // A robbery with no way to end is unfinished and will not start, so the hold-up itself wins it.
    const teller = added(L.addElement(r, { kind: "teller", name: "Teller", cells: [[100, 65, 172]], holdSeconds: 2, onDone: [{ kind: "end", result: "win" }] }));
    assert.equal(S.saveRobbery(teller.robbery).ok, true);

    const { check, done } = checks();
    const ada = outlaw();
    const from = mark();

    Run.touch(ada, { robbery: "bank", element: teller.element.id, kind: "teller" });
    await settle();

    const t = told(from);
    const element = t.find((e) => e.k === "robbery.element");
    check("the hold-up was told, by her, as a teller", element?.kind === "teller" && element.el === teller.element.id && element.p === ada.id && JSON.stringify(element.locks) === "[]", JSON.stringify(t));
    check("and it won the robbery", t.find((e) => e.k === "robbery.end")?.result === "win", JSON.stringify(t));
    done();
});

test("each run has a number of its own, and the people who took part are counted once each", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    const bob = outlaw("Bob", IN_AREA, 100);
    const from = mark();

    await openKeypad(ada);                             // Ada does the keypad (and so the door)
    guess(40); guess(40);
    touch(bob, SITE.box);                              // Bob does the lockbox
    await settle();
    Run.stopRobbery("bank");
    fake.advance(R.tickEvery * 2);
    Run.resetSiteNow("bank");
    fake.advance(R.janitorEvery + R.tickEvery);

    await openKeypad(ada);                             // a second run, by Ada alone
    Run.stopRobbery("bank");
    fake.advance(R.tickEvery * 2);

    const t = told(from);
    const [first, second] = t.filter((e) => e.k === "robbery.end");
    const starts = t.filter((e) => e.k === "robbery.start");

    check("two runs, two ends", starts.length === 2 && first !== undefined && second !== undefined, t.map((e) => e.k).join());
    check("two people in the first, one in the second", first?.people === 2 && second?.people === 1, JSON.stringify([first, second]));
    check("the second run's number is the first's plus one", starts[1].r === starts[0].r + 1, JSON.stringify(starts.map((e) => e.r)));
    check("and each run's lines share its own number", t.filter((e) => e.r === starts[0].r).length === 5 && t.filter((e) => e.r === starts[1].r).length === 4, JSON.stringify(t.map((e) => `${e.k}:${e.r}`)));
    done();
});
