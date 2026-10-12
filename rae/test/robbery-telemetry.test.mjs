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
    const start = t.find((e) => e.k === "robbery.start");
    const [keypad, door, box] = t.filter((e) => e.k === "robbery.element");
    const end = t.find((e) => e.k === "robbery.end");

    check("the whole story in order: a pick opens the keypad, then it and the door are done, a pick opens the lockbox, then it is done and pays, the win pays, and it ends",
        t.map((e) => e.k).join() === "robbery.start,robbery.pick,robbery.element,robbery.element,robbery.pick,robbery.element,robbery.payout,robbery.payout,robbery.end", t.map((e) => e.k).join());
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
    const one = t.filter((e) => e.r === starts[0].r);
    const two = t.filter((e) => e.r === starts[1].r);
    check("every line belongs to one of the two runs, and each run has the elements it did", one.length + two.length === t.length && one.filter((e) => e.k === "robbery.element").length === 3 && two.filter((e) => e.k === "robbery.element").length === 2, JSON.stringify(t.map((e) => `${e.k}:${e.r}`)));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Picks and payouts
// ---------------------------------------------------------------------------------------------------------

const picksOf = (from) => told(from).filter((e) => e.k === "robbery.pick");
const payoutsOf = (from) => told(from).filter((e) => e.k === "robbery.payout");

test("a lock that jams is told as jammed with the progress it lost and the misses that jammed it, and one that opens as unlocked", async () => {
    const built = setup();
    const { check, done } = checks();
    const ada = outlaw();
    const from = mark();

    guess(41);                                          // one hit banked
    guess(95); guess(96); guess(97);                    // then three misses in a row
    touch(ada, SITE.keypad);
    await settle();

    fake.advance(20 * 20);                              // the jam ends
    guess(40); guess(40);                               // two hits: the lost progress means two are needed
    touch(ada, SITE.keypad);
    await settle();

    const [jam, open] = picksOf(from);

    check("two pick lines, in order", picksOf(from).length === 2, JSON.stringify(picksOf(from)));
    check("the jam: the keypad, by her, one hit lost, three misses", jam?.result === "jammed" && jam.el === built.keypad.id && jam.p === ada.id && jam.hits === 1 && jam.misses === 3, JSON.stringify(jam));
    check("the opening: both hits, no misses", open?.result === "unlocked" && open.el === built.keypad.id && open.p === ada.id && open.hits === 2 && open.misses === 0, JSON.stringify(open));
    check("both belong to the run", jam?.r === open?.r && Number.isInteger(jam?.r) && jam.id === "bank", JSON.stringify([jam, open]));
    done();
});

test("a miss between two hits is counted in the opening that follows", async () => {
    setup();
    const ada = outlaw();
    const from = mark();

    guess(41); guess(90); guess(40);                    // a hit, a miss, a hit
    touch(ada, SITE.keypad);
    await settle();

    const [open] = picksOf(from);
    assert.equal(open?.result, "unlocked", JSON.stringify(open));
    assert.equal(open.hits, 2);
    assert.equal(open.misses, 1);
});

test("a reward is told once, with the coins and the bounty added up over everyone paid", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    outlaw("Bob");
    outlaw("Cy");
    const from = mark();

    await openKeypad(ada);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();
    fake.advance(70);                                   // the win, and its hook

    const t = told(from);
    const [bounty, win] = payoutsOf(from);
    const run = t.find((e) => e.k === "robbery.start").r;

    check("two rewards: the lockbox's bounty, then the win's coins", payoutsOf(from).length === 2, JSON.stringify(payoutsOf(from)));
    check("a 250 bounty to the three in the area is 750, and no coins", bounty?.bounty === 750 && bounty.coins === 0 && bounty.to === "area" && bounty.players === 3, JSON.stringify(bounty));
    check("100 coins to the three is 300, and no bounty", win?.coins === 300 && win.bounty === 0 && win.to === "area" && win.players === 3, JSON.stringify(win));
    check("both belong to the run", bounty?.r === run && win?.r === run && bounty.id === "bank", JSON.stringify([bounty, win, run]));
    check("the lockbox, its bounty, the win's coins and the end come in that order", t.slice(-4).map((e) => e.k).join() === "robbery.element,robbery.payout,robbery.payout,robbery.end", t.map((e) => e.k).join());
    done();
});

test("a reward nobody is there to receive is not told", async () => {
    const built = setup();
    const ada = outlaw();
    // The law is who the reward is for, and there is no law player.
    assert.equal(S.saveRobbery(ok(L.setHook(built.r, "start", [{ kind: "reward", coins: 50, bounty: 0, to: "law" }]))).ok, true);
    const from = mark();

    await openKeypad(ada);

    assert.equal(payoutsOf(from).length, 0, JSON.stringify(payoutsOf(from)));
});

test("a reward delayed past the end of the run is told after the end, with the run's own number", async () => {
    const built = setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    assert.equal(S.saveRobbery(ok(L.setHook(built.r, "win", [{ kind: "reward", coins: 10, bounty: 0, to: "area", delaySeconds: 5 }]))).ok, true);
    const from = mark();

    await openKeypad(ada);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();
    fake.advance(70);                                   // the win

    check("the end is told, and the delayed reward has not come yet", told(from).some((e) => e.k === "robbery.end") && payoutsOf(from).filter((p) => p.coins === 10).length === 0, JSON.stringify(told(from).map((e) => e.k)));

    fake.advance(5 * 20 + 20);

    const late = payoutsOf(from).find((p) => p.coins === 10);
    check("then it is", late !== undefined && late.players === 1 && late.to === "area", JSON.stringify(payoutsOf(from)));
    const all = told(from);
    check("with the run's number, and after the end", late?.r === all[0].r && all.findIndex((e) => e.k === "robbery.end") < all.findIndex((e) => e.k === "robbery.payout" && e.coins === 10), JSON.stringify(all.map((e) => e.k)));
    done();
});

test("a player who only jammed a lock took part: counted in the people, though they completed nothing", async () => {
    setup();
    const ada = outlaw();
    const from = mark();

    guess(95); guess(96); guess(97);                    // three misses and a jam, nothing completed
    touch(ada, SITE.keypad);
    await settle();
    Run.stopRobbery("bank");

    const end = told(from).find((e) => e.k === "robbery.end");
    assert.equal(end?.done, 0, JSON.stringify(end));
    assert.equal(end.people, 1);
});
