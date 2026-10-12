import { test } from "node:test";
import assert from "node:assert/strict";
import { checks } from "./helpers.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";
import { renderReport } from "../../tools/telemetry/report.mjs";

// The robberies section of the report (tools/telemetry/aggregate.mjs and report.mjs). The game tells a robbery run as a start, elements, picks,
// payouts and an end, all sharing the robbery's id and the run's number within its boot. Two boots can both have a run 1, so a run is told apart
// by world + boot + robbery + number. The events below are fixtures shaped like the archive's lines (`at` first, then the line's own fields), and
// every figure the tests expect was worked out by hand from them, not by running the code under test.

const A = "aaaaaa";
const B = "bbbbbb";

let line = 0;
const rev = (k, at, run, fields = {}) => ({ at, v: 1, k, w: run.w, b: run.b, n: ++line, t: 100, bv: "0.2.6", id: run.id, r: run.r, ...fields });
const start = (at, run, test = false) => rev("robbery.start", at, run, { test, p: "7", role: "outlaw", inside: 2 });
const element = (at, run, el, name, kind, after) => rev("robbery.element", at, run, { el, name, kind, locks: [], after, p: "7" });
const pick = (at, run, el, name, result, hits, misses) => rev("robbery.pick", at, run, { el, name, result, hits, misses, p: "7" });
const payout = (at, run, coins, bounty) => rev("robbery.payout", at, run, { coins, bounty, to: "area", players: 3 });
const finish = (at, run, result, dur, done, of, people, test = false) => rev("robbery.end", at, run, { result, test, dur, done, of, people });

const bank = (b, r) => ({ w: A, b, id: "bank", r });
const R1 = bank("b001", 1), R2 = bank("b001", 2), R3 = bank("b001", 3), R4 = bank("b001", 4), R5 = bank("b001", 5), R6 = bank("b002", 1);
const V1 = { w: B, b: "b003", id: "vault", r: 1 };

/** Seven runs of two robberies, in the order the game wrote them. */
const ROBBERIES = [
    start("2026-10-11T19:00:00", R1), pick("2026-10-11T19:00:04", R1, "e1", "Keypad", "unlocked", 2, 1), element("2026-10-11T19:00:05", R1, "e1", "Keypad", "switch", 0),
    element("2026-10-11T19:00:05", R1, "e2", "Vault door", "door", 0), pick("2026-10-11T19:10:00", R1, "e3", "Lockbox", "unlocked", 2, 0), element("2026-10-11T19:10:00", R1, "e3", "Lockbox", "chest", 600),
    payout("2026-10-11T19:10:00", R1, 0, 750), payout("2026-10-11T19:12:00", R1, 300, 0), finish("2026-10-11T19:52:00", R1, "win", 3100, 3, 5, 3),

    start("2026-10-11T20:00:00", R2), element("2026-10-11T20:00:05", R2, "e1", "Keypad", "switch", 0), element("2026-10-11T20:00:05", R2, "e2", "Vault door", "door", 0),
    pick("2026-10-11T20:05:00", R2, "e3", "Lockbox", "jammed", 1, 3), pick("2026-10-11T20:06:00", R2, "e4", "Safe", "jammed", 0, 3), finish("2026-10-11T20:33:00", R2, "fail", 2000, 2, 5, 2),

    start("2026-10-11T20:30:00", R3), element("2026-10-11T20:30:05", R3, "e1", "Keypad", "switch", 0), finish("2026-10-11T20:38:00", R3, "stopped", 500, 1, 5, 1),

    start("2026-10-11T20:40:00", R4, true), finish("2026-10-11T20:42:00", R4, "stopped", 100, 0, 5, 0, true),

    start("2026-10-11T21:00:00", R5), element("2026-10-11T21:00:05", R5, "e1", "Keypad", "switch", 0),

    start("2026-10-12T09:00:00", R6), element("2026-10-12T09:00:05", R6, "e1", "Keypad", "switch", 0), element("2026-10-12T09:01:00", R6, "e2", "Vault door", "door", 100),
    payout("2026-10-12T09:05:00", R6, 50, 0), finish("2026-10-12T09:16:00", R6, "win", 1000, 2, 5, 1),

    start("2026-10-12T10:00:00", V1), element("2026-10-12T10:00:05", V1, "e1", "Safe", "chest", 0), finish("2026-10-12T10:13:00", V1, "win", 800, 1, 1, 1)
];

/** Events that are not robberies: a boot and a round. */
const OTHER = [
    { at: "2026-10-11T18:36:53", v: 1, k: "boot", w: A, b: "b001", n: 900, t: 1, bv: "0.2.6" },
    { at: "2026-10-11T19:30:00", v: 1, k: "round.end", w: A, b: "b001", n: 901, t: 2, bv: "0.2.6", reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 }
];

/** The same, in an order nothing can rely on, with other events among them. */
const SCRAMBLED = [...ROBBERIES.slice(20), OTHER[1], ...ROBBERIES.slice(0, 20), OTHER[0]];

/** What a person reads: the page without its style, its tags and its extra white space. */
const visible = (html) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const bankFigures = (options) => summarize(SCRAMBLED, options).robberies.list.find((x) => x.id === "bank");

test("each robbery's figures are exact, a run is told apart by its boot, a run with no end counts as one, and test runs are left out", () => {
    const { check, done } = checks();

    const all = summarize(SCRAMBLED).robberies;
    const b = all.list.find((x) => x.id === "bank");

    check("two robberies, the one with the newest activity first", all.list.map((x) => x.id).join() === "vault,bank", all.list.map((x) => x.id).join());
    check("one test run was left out, and the report knows it", all.excludedTests === 1 && all.includeTests === false, JSON.stringify([all.excludedTests, all.includeTests]));
    check("five bank runs: two boots both have a run 1, and they are two runs", b.runs === 5, String(b.runs));
    check("how they ended: two wins, a fail, a stop, and one with no end recorded", JSON.stringify(b.byResult) === JSON.stringify({ win: 2, fail: 1, stopped: 1, round: 0, unfinished: 1 }), JSON.stringify(b.byResult));
    check("2 of the 3 that were decided were won", b.decided === 3 && Math.abs(b.winShare - 2 / 3) < 1e-9, `${b.winShare} of ${b.decided}`);
    check("length over the four that ended: 3100, 2000, 500 and 1000 ticks", b.length.average === 1650 && b.length.median === 1500, JSON.stringify(b.length));
    check("elements done, of five: 3, 2, 1 and 2", b.elementsDone.average === 2 && b.elementsDone.of === 5, JSON.stringify(b.elementsDone));
    check("pay: 300 + 50 coins and 750 bounty over five runs, each payout on its own run", b.coins.total === 350 && b.coins.perRun === 70 && b.bounty.total === 750 && b.bounty.perRun === 150, JSON.stringify([b.coins, b.bounty]));
    check("the vault: one run, won, paid nothing", all.list[0].runs === 1 && all.list[0].byResult.win === 1 && all.list[0].coins.total === 0, JSON.stringify(all.list[0]));
    done();
});

test("each element's share of runs, median time, jams and misses: one nobody completed shows 0%, and the ones never touched are counted", () => {
    const { check, done } = checks();

    const b = bankFigures();
    const row = (el) => b.elements.find((x) => x.el === el);

    check("four elements were seen, in the order they were built", b.elements.map((x) => x.el).join() === "e1,e2,e3,e4", b.elements.map((x) => x.el).join());
    check("the keypad: done in all five, at once, opened once by a pick that had one miss", JSON.stringify(row("e1")) === JSON.stringify({ el: "e1", name: "Keypad", kind: "switch", completed: 5, share: 1, medianAfter: 0, jams: 0, avgMisses: 1 }), JSON.stringify(row("e1")));
    check("the vault door: done in three of five, never picked", JSON.stringify(row("e2")) === JSON.stringify({ el: "e2", name: "Vault door", kind: "door", completed: 3, share: 0.6, medianAfter: 0, jams: 0, avgMisses: null }), JSON.stringify(row("e2")));
    check("the lockbox: done once, 600 ticks in, jammed once, and 1.5 misses a pick", JSON.stringify(row("e3")) === JSON.stringify({ el: "e3", name: "Lockbox", kind: "chest", completed: 1, share: 0.2, medianAfter: 600, jams: 1, avgMisses: 1.5 }), JSON.stringify(row("e3")));
    check("the safe: only ever jammed, so 0% and no kind or time", JSON.stringify(row("e4")) === JSON.stringify({ el: "e4", name: "Safe", kind: null, completed: 0, share: 0, medianAfter: null, jams: 1, avgMisses: 3 }), JSON.stringify(row("e4")));
    check("one of the five elements was never touched in any run", b.untouched === 1, String(b.untouched));
    done();
});

test("the newest runs are listed, and one with no end has no result, length or people", () => {
    const { check, done } = checks();

    const b = bankFigures();
    const [newest, second] = b.latest;

    check("newest first", b.latest.map((x) => x.at).join() === "2026-10-12T09:00:00,2026-10-11T21:00:00,2026-10-11T20:30:00,2026-10-11T20:00:00,2026-10-11T19:00:00", b.latest.map((x) => x.at).join());
    check("a finished run's row", JSON.stringify(newest) === JSON.stringify({ at: "2026-10-12T09:00:00", w: A, r: 1, test: false, result: "win", dur: 1000, done: 2, of: 5, people: 1, coins: 50, bounty: 0 }), JSON.stringify(newest));
    check("a run with no end", JSON.stringify(second) === JSON.stringify({ at: "2026-10-11T21:00:00", w: A, r: 5, test: false, result: null, dur: null, done: null, of: null, people: null, coins: 0, bounty: 0 }), JSON.stringify(second));
    done();
});

test("with test runs included they count, and are marked", () => {
    const { check, done } = checks();

    const all = summarize(SCRAMBLED, { includeTests: true }).robberies;
    const b = all.list.find((x) => x.id === "bank");

    check("nothing is left out", all.excludedTests === 0 && all.includeTests === true);
    check("six bank runs, two of them stopped", b.runs === 6 && b.byResult.stopped === 2, JSON.stringify(b.byResult));
    check("the test run is in the list and marked", b.latest.some((x) => x.test === true && x.r === 4), JSON.stringify(b.latest.map((x) => `${x.r}:${x.test}`)));
    done();
});

test("a world filter narrows robberies too, and an end or a payout whose start was lost still makes a run", () => {
    const { check, done } = checks();

    const onlyB = summarize(SCRAMBLED, { world: B }).robberies;
    check("world B has the one vault run", onlyB.list.map((x) => x.id).join() === "vault", onlyB.list.map((x) => x.id).join());

    const lost = summarize([
        finish("2026-10-11T19:52:00", R1, "win", 3100, 3, 5, 3),
        payout("2026-10-11T19:50:00", R1, 300, 0),
        payout("2026-10-11T22:00:00", R2, 20, 0)
    ]).robberies.list[0];
    check("a run with an end but no start: counted, won, paid", lost.runs === 2 && lost.byResult.win === 1 && lost.coins.total === 320, JSON.stringify(lost));
    check("a run with only a payout: counted as one with no end", lost.byResult.unfinished === 1, JSON.stringify(lost.byResult));
    check("no robbery events, no robberies", summarize(OTHER).robberies.list.length === 0 && summarize(OTHER).robberies.excludedTests === 0);
    done();
});

test("the report has a section for each robbery: its figures, how its runs ended, its elements, its latest runs, and what was left out", () => {
    const { check, done } = checks();

    const html = renderReport(summarize(SCRAMBLED), { generated: "2026-10-12 21:00" });
    const text = visible(html);

    check("a section for each robbery, the newest activity first", text.indexOf("Robbery: vault") > 0 && text.indexOf("Robbery: vault") < text.indexOf("Robbery: bank"), text.slice(0, 200));
    check("the headline figures", text.includes("Runs 5") && text.includes("Win rate 67% 2 of 3 decided") && text.includes("Median length 1:15 average 1:23") && text.includes("Paid per run 70 coins 150 bounty"), text);
    check("the test run left out is said", text.includes("1 test run is left out"), text);
    check("how the runs ended can be read without seeing the bar", html.includes("aria-label=\"Won 2, failed 1, stopped 1, cut short by a round reset 0, no end recorded 1 of 5 runs\""));
    check("the elements, in build order", text.includes("Keypad (switch) 5 100% 0:00 0 1 Vault door (door) 3 60% 0:00 0 - Lockbox (chest) 1 20% 0:30 1 1.5 Safe 0 0% - 1 3"), text);
    check("and the one never touched", text.includes("1 more element was never touched in these runs"), text);
    check("a robbery whose elements were all touched has no such note", !text.includes("0 more element"), text);
    check("the elements table has its caption and its columns", text.includes("Elements Element Done in Share of runs Median time in Jams Average misses Keypad"), text);
    check("the newest run's row, and one with no end", text.includes("2026-10-12 09:00 aaaaaa Won 0:50 2 of 5 1 50 0") && text.includes("2026-10-11 21:00 aaaaaa No end recorded - - - 0 0"), text);
    check("a win is the status green and a fail the status red, from the fixed status palette", html.includes("--good: #0ca30c") && html.includes("--critical: #d03b3b"));
    check("and the classes mean what they say", html.includes(".good { background: var(--good); }") && html.includes(".critical { background: var(--critical); }"));

    const bankSection = html.match(/<section aria-labelledby="robbery-1">[\s\S]*?<\/section>/)?.[0] ?? "";
    check("the bar draws a segment for each result that happened (four of five), and none for 'cut short by a round reset', which did not", (bankSection.match(/style="flex:/g) ?? []).length === 4, String((bankSection.match(/style="flex:/g) ?? []).length));
    check("a win and a fail are told apart in the bar", bankSection.includes("class=\"good\" style=\"flex: 2 1 0\"") && bankSection.includes("class=\"critical\" style=\"flex: 1 1 0\""));
    done();
});

test("more than one element never touched is said in the plural, and an element with no name shows its id", () => {
    const x = { w: A, b: "b012", id: "mine", r: 1 };

    const text = visible(renderReport(summarize([
        start("2026-10-11T19:00:00", x), element("2026-10-11T19:00:05", x, "e7", "", "door", 0), finish("2026-10-11T19:10:00", x, "win", 100, 1, 6, 1)
    ]), { generated: "x" }));

    assert.ok(text.includes("5 more elements were never touched in these runs"), text);
    assert.ok(text.includes("e7 (door) 1 100%"), text);
});

test("with test runs included the report marks them, a robbery with only test runs says so, and no robbery lines means no robbery section", () => {
    const { check, done } = checks();

    const included = visible(renderReport(summarize(SCRAMBLED, { includeTests: true }), { generated: "x" }));
    check("included and marked", included.includes("Test runs are included") && included.includes("2026-10-11 20:40 aaaaaa Stopped 0:05 0 of 5 0 0 0 test"), included);

    const onlyTest = visible(renderReport(summarize([start("2026-10-11T20:40:00", R4, true), finish("2026-10-11T20:42:00", R4, "stopped", 100, 0, 5, 0, true)]), { generated: "x" }));
    check("only test runs: nothing to show but the note", onlyTest.includes("1 test run is left out") && !onlyTest.includes("Robbery: bank"), onlyTest);

    const none = visible(renderReport(summarize(OTHER), { generated: "x" }));
    check("no robbery lines, no robbery section", !none.includes("Robbery"));
    done();
});

test("runs of two worlds are two runs even when their boot id, robbery and run number are the same", () => {
    const one = { w: A, b: "same", id: "bank", r: 1 };
    const two = { w: B, b: "same", id: "bank", r: 1 };

    const b = summarize([
        start("2026-10-11T19:00:00", one), finish("2026-10-11T19:10:00", one, "win", 100, 1, 1, 1),
        start("2026-10-11T19:20:00", two), finish("2026-10-11T19:30:00", two, "fail", 200, 1, 1, 1)
    ]).robberies.list[0];

    assert.equal(b.runs, 2, JSON.stringify(b.byResult));
    assert.equal(b.byResult.win, 1);
    assert.equal(b.byResult.fail, 1);
});

test("a test flag that is only on a run's end still leaves the run out", () => {
    const all = summarize([finish("2026-10-11T19:10:00", R4, "stopped", 100, 0, 5, 0, true)]).robberies;

    assert.equal(all.list.length, 0, JSON.stringify(all.list));
    assert.equal(all.excludedTests, 1);
});

test("elements come out in the order they were built, by number, however they were first seen", () => {
    const x = { w: A, b: "b010", id: "mine", r: 1 };

    const b = summarize([
        start("2026-10-11T19:00:00", x),
        element("2026-10-11T19:00:01", x, "e10", "Tenth", "door", 0), element("2026-10-11T19:00:02", x, "e3", "Third", "door", 10),
        element("2026-10-11T19:00:03", x, "e1", "First", "door", 20), element("2026-10-11T19:00:04", x, "e2", "Second", "door", 30),
        finish("2026-10-11T19:10:00", x, "win", 100, 4, 10, 1)
    ]).robberies.list[0];

    assert.equal(b.elements.map((e) => e.el).join(), "e1,e2,e3,e10");
});

test("how many elements a robbery has is what its newest ended run says, whichever order the runs came in", () => {
    const old = { w: A, b: "b011", id: "edited", r: 1 };
    const recent = { w: A, b: "b011", id: "edited", r: 2 };
    const figures = (oldOf, recentOf) => summarize([
        start("2026-10-11T19:00:00", old), element("2026-10-11T19:00:05", old, "e1", "One", "door", 0), finish("2026-10-11T19:10:00", old, "win", 100, 1, oldOf, 1),
        start("2026-10-12T19:00:00", recent), element("2026-10-12T19:00:05", recent, "e1", "One", "door", 0), finish("2026-10-12T19:10:00", recent, "win", 100, 1, recentOf, 1)
    ]).robberies.list[0];

    const grown = figures(4, 6);
    const shrunk = figures(6, 4);

    assert.equal(grown.elementsDone.of, 6, "a builder added elements: the robbery has 6 now");
    assert.equal(grown.untouched, 5);
    assert.equal(shrunk.elementsDone.of, 4, "a builder took some away: the robbery has 4 now");
    assert.equal(shrunk.untouched, 3);
});

test("a robbery's id and an element's name are shown as text, never as markup", () => {
    const hostile = { w: A, b: "b009", id: "<b>bank</b>", r: 1 };
    const html = renderReport(summarize([start("2026-10-11T19:00:00", hostile), element("2026-10-11T19:00:05", hostile, "e1", "<img src=x onerror=alert(1)>", "switch", 0), finish("2026-10-11T19:10:00", hostile, "win", 100, 1, 1, 1)]), { generated: "x" });

    assert.ok(!html.includes("<b>bank") && !html.includes("<img src=x") && html.includes("&lt;b&gt;bank&lt;/b&gt;") && html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});
