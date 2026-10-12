import { test } from "node:test";
import assert from "node:assert/strict";
import { checks } from "./helpers.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";
import { clock, renderReport, toCsv } from "../../tools/telemetry/report.mjs";

// tools/telemetry/aggregate.mjs turns the archive's events into figures; report.mjs turns the figures into one HTML file and one CSV per kind.
// Plain JavaScript outside the game. The events are fixtures shaped like the archive's lines (`at` first, then the line's own fields).

const A = "aaaaaa";
const B = "bbbbbb";

let line = 0;
const event = (k, at, fields = {}) => ({ at, v: 1, k, w: A, b: "b001", n: ++line, t: 100, bv: "0.2.5", ...fields });
const ended = (at, reason, dur, kills, deaths, lawKills, outlawKills, coins, w = A) => event("round.end", at, { w, reason, dur, kills, deaths, lawKills, outlawKills, coins });

/** Five rounds in two worlds, worked out by hand: see the first test. */
const ROUNDS = [
    ended("2026-10-11T19:00:00", "law_win", 4800, 5, 4, 3, 2, 640),
    ended("2026-10-11T19:30:00", "outlaw_win", 3600, 3, 3, 1, 2, 900),
    ended("2026-10-11T20:10:00", "law_win", 6000, 8, 6, 5, 3, 300),
    ended("2026-10-12T10:00:00", "aborted", 1200, 0, 0, 0, 0, 100, B),
    ended("2026-10-12T10:30:00", "law_win", 2400, 2, 2, 1, 1, 500, B)
];
const NOISE = [event("boot", "2026-10-11T18:36:53"), event("shop.open", "2026-10-11T19:05:00", { id: "general", p: "7" })];

/** Out of order on purpose, with events that are not rounds among them. */
const MIXED = [ROUNDS[3], NOISE[0], ROUNDS[0], ROUNDS[4], ROUNDS[1], NOISE[1], ROUNDS[2]];

/** The byte order mark a CSV starts with so that Excel reads it as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** What a person reads: the page without its style, its tags and its extra white space. */
const visible = (html) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("rounds: every figure is exact, only round.end events count, and the order they arrive in does not matter", () => {
    const { check, done } = checks();

    const r = summarize(MIXED).rounds;

    check("five rounds", r.count === 5, String(r.count));
    check("how they ended", r.byReason.law_win === 3 && r.byReason.outlaw_win === 1 && r.byReason.aborted === 1, JSON.stringify(r.byReason));
    check("the law side won 3 of the 4 that were decided", r.lawWinShare === 0.75 && r.decided === 4, `${r.lawWinShare} of ${r.decided}`);
    check("length: 4800 + 3600 + 6000 + 1200 + 2400 ticks", r.length.average === 3600 && r.length.median === 3600 && r.length.shortest === 1200 && r.length.longest === 6000, JSON.stringify(r.length));
    check("kills", r.kills.total === 18 && r.kills.perRound === 3.6, JSON.stringify(r.kills));
    check("deaths", r.deaths.total === 15 && r.deaths.perRound === 3, JSON.stringify(r.deaths));
    check("kills by side", r.lawKills === 10 && r.outlawKills === 8, `${r.lawKills} ${r.outlawKills}`);
    check("coins at the end: the average, the middle one, and the newest round's", r.coins.average === 488 && r.coins.median === 500 && r.coins.last === 500, JSON.stringify(r.coins));
    check("newest first", r.latest.map((x) => x.at).join() === "2026-10-12T10:30:00,2026-10-12T10:00:00,2026-10-11T20:10:00,2026-10-11T19:30:00,2026-10-11T19:00:00", r.latest.map((x) => x.at).join());
    check("a row keeps what the page shows", JSON.stringify(r.latest[0]) === JSON.stringify({ at: "2026-10-12T10:30:00", w: B, reason: "law_win", dur: 2400, kills: 2, deaths: 2, lawKills: 1, outlawKills: 1, coins: 500 }), JSON.stringify(r.latest[0]));
    done();
});

test("rounds: the middle of an even number is the mean of the two in the middle, and no rounds at all gives no averages", () => {
    const { check, done } = checks();

    const two = summarize([ended("2026-10-11T19:00:00", "law_win", 1000, 1, 1, 1, 0, 10), ended("2026-10-11T19:10:00", "law_win", 3000, 1, 1, 1, 0, 30)]).rounds;
    check("median 2000, average 2000", two.length.median === 2000 && two.length.average === 2000 && two.coins.median === 20, JSON.stringify(two));

    const none = summarize(NOISE).rounds;
    check("no rounds", none.count === 0 && none.length === null && none.coins === null && none.lawWinShare === null && none.latest.length === 0, JSON.stringify(none));

    const onlyAborted = summarize([ended("2026-10-11T19:00:00", "aborted", 100, 0, 0, 0, 0, 0)]).rounds;
    check("only an abort: nothing was decided, so there is no win rate", onlyAborted.decided === 0 && onlyAborted.lawWinShare === null, JSON.stringify(onlyAborted));
    done();
});

test("rounds: the list keeps the 20 newest, and a world filter narrows the rounds but not the data panel", () => {
    const { check, done } = checks();

    const many = Array.from({ length: 25 }, (_, i) => ended(`2026-10-11T19:${String(i).padStart(2, "0")}:00`, "law_win", 100, 0, 0, 0, 0, 0));
    const r = summarize(many).rounds;
    check("25 counted, 20 listed, the newest first", r.count === 25 && r.latest.length === 20 && r.latest[0].at === "2026-10-11T19:24:00" && r.latest[19].at === "2026-10-11T19:05:00", `${r.count} ${r.latest.length}`);

    const only = summarize(MIXED, { world: B });
    check("world B had two rounds", only.rounds.count === 2 && only.rounds.byReason.aborted === 1, JSON.stringify(only.rounds.byReason));
    check("the panel still lists both worlds", only.data.worlds.length === 2, JSON.stringify(only.data.worlds));
    check("and the report says which world it shows", only.world === B);
    done();
});

test("data panel: the events, the period, each world and build, the restarts and the lines the rate limit dropped", () => {
    const { check, done } = checks();
    const ingest = { files: 100, found: 7, added: 5, duplicates: 1, skipped: 1, damaged: 0, unfinished: 1, unreadable: 0 };

    const d = summarize([
        event("boot", "2026-10-11T18:36:53"),
        event("round.end", "2026-10-11T18:40:00", { reason: "law_win", dur: 1, kills: 0, deaths: 0, lawKills: 0, outlawKills: 0, coins: 0 }),
        event("telemetry.dropped", "2026-10-11T18:41:00", { lines: 37 }),
        // World B's boot id is the same as world A's first: two loads of two worlds that happened to draw the same four characters.
        event("boot", "2026-10-12T09:00:05", { w: B, b: "b001", bv: "0.2.6" }),
        event("shop.open", "2026-10-12T09:10:00", { w: B, b: "b001", bv: "0.2.6", id: "general", p: "7" }),
        event("telemetry.dropped", "2026-10-12T09:20:00", { w: B, b: "b001", bv: "0.2.6", lines: 3 }),
        event("boot", "2026-10-12T20:00:00", { b: "b003", bv: "0.2.6" })
    ], { ingest }).data;

    check("seven events over the period", d.events === 7 && d.firstAt === "2026-10-11T18:36:53" && d.lastAt === "2026-10-12T20:00:00", JSON.stringify(d));
    check("two worlds, the one with the newest activity first", d.worlds.map((w) => `${w.w}:${w.events}:${w.firstAt}:${w.lastAt}`).join("|") === `${A}:4:2026-10-11T18:36:53:2026-10-12T20:00:00|${B}:3:2026-10-12T09:00:05:2026-10-12T09:20:00`, JSON.stringify(d.worlds));
    check("two builds, the one with more events first", d.builds.map((b) => `${b.bv}:${b.events}`).join() === "0.2.6:4,0.2.5:3", JSON.stringify(d.builds));
    check("three loads of the scripts", d.boots === 3, String(d.boots));
    check("40 lines dropped by the rate limit", d.dropped === 40, String(d.dropped));
    check("and what the last read found is carried through", JSON.stringify(d.ingest) === JSON.stringify(ingest));
    check("an empty archive has none of it", summarize([]).data.events === 0 && summarize([]).data.firstAt === null && summarize([]).data.ingest === null);
    done();
});

test("a side that won no round has no segment in the bar but is still in the legend, and the length bars are drawn against the longest round", () => {
    const { check, done } = checks();

    const html = renderReport(summarize([
        ended("2026-10-11T19:00:00", "law_win", 6000, 1, 1, 1, 0, 1234),
        ended("2026-10-11T19:30:00", "law_win", 1200, 1, 1, 1, 0, 5)
    ]), { generated: "2026-10-12 21:00" });

    check("one segment in the bar, not three", (html.match(/style="flex:/g) ?? []).length === 1, String((html.match(/style="flex:/g) ?? []).length));
    check("all three are in the legend and the label", visible(html).includes("Law won 2") && visible(html).includes("Outlaw won 0") && visible(html).includes("Aborted 0") && html.includes("aria-label=\"Law won 2, outlaw won 0, aborted 0 of 2 rounds\""));
    check("the longest round's bar is full width and the other is a fifth of it", html.includes("style=\"width: 100%\"") && html.includes("style=\"width: 20%\""));
    check("thousands are separated", visible(html).includes("1,234"));
    done();
});

test("a length of ticks is shown as minutes and seconds, and as hours when it needs them", () => {
    const { check, done } = checks();

    check("4800 ticks are 4:00", clock(4800) === "4:00", clock(4800));
    check("seconds are padded", clock(20 * 65) === "1:05", clock(20 * 65));
    check("a part of a second rounds, half a second up", clock(29) === "0:01" && clock(9) === "0:00" && clock(30) === "0:02" && clock(10) === "0:01", `${clock(29)} ${clock(9)} ${clock(30)} ${clock(10)}`);
    check("an hour", clock(72000) === "1:00:00" && clock(72000 + 20 * 61) === "1:01:01", `${clock(72000)} ${clock(72000 + 20 * 61)}`);
    done();
});

test("the report shows the rounds in words a person can read, newest first, with the law and outlaw colours from the checked palette", () => {
    const { check, done } = checks();

    const html = renderReport(summarize(MIXED), { generated: "2026-10-12 21:00" });
    const text = visible(html);

    check("a page with a title and a language", html.startsWith("<!doctype html>") && html.includes("<html lang=\"en\">") && html.includes("<title>RAE telemetry</title>"));
    check("when it was made, from how many events", text.includes("Made 2026-10-12 21:00 from 7 events"), text.slice(0, 200));
    check("the headline figures", text.includes("Rounds 5") && text.includes("Law win rate 75%") && text.includes("3 of 4 decided") && text.includes("Median length 3:00") && text.includes("Kills per round 3.6"), text.slice(0, 400));
    check("how the rounds ended, with the counts", text.includes("Law won 3") && text.includes("Outlaw won 1") && text.includes("Aborted 1"), text.slice(0, 600));
    check("the newest round's row, columns in order", text.includes("2026-10-12 10:30 bbbbbb Law won 2:00 2 2 1 1 500"), text);
    check("newest first", text.indexOf("2026-10-12 10:30") < text.indexOf("2026-10-11 19:00"));
    check("the share bar can be read without seeing it", html.includes("role=\"img\"") && html.includes("aria-label=\"Law won 3, outlaw won 1, aborted 1 of 5 rounds\""));
    check("dark mode is its own set of colours", html.includes("prefers-color-scheme: dark"));
    check("law blue and outlaw orange are the validated ones, for light and for dark", ["--law: #2a78d6", "--outlaw: #eb6834", "--law: #3987e5", "--outlaw: #d95926"].every((declaration) => html.includes(declaration)));
    check("each side's segment wears its own colour, and an abort the neutral one", html.includes("class=\"law\" style=\"flex: 3 1 0\"") && html.includes("class=\"outlaw\" style=\"flex: 1 1 0\"") && html.includes("class=\"neutral\" style=\"flex: 1 1 0\""));
    check("and the classes mean what they say", html.includes(".law { background: var(--law); }") && html.includes(".outlaw { background: var(--outlaw); }"));
    done();
});

test("a round with fields missing counts them as zero instead of turning the figures into NaN, and the middle is found by number, not by text", () => {
    const { check, done } = checks();

    const damaged = summarize([event("round.end", "2026-10-11T19:00:00", { reason: "law_win" })]).rounds;
    check("no NaN", damaged.length.average === 0 && damaged.kills.total === 0 && damaged.coins.last === 0 && damaged.latest[0].dur === 0, JSON.stringify(damaged));

    const odd = summarize([1, 10, 2].map((coins, i) => ended(`2026-10-11T19:0${i}:00`, "law_win", 100, 0, 0, 0, 0, coins))).rounds;
    check("the middle of 1, 10 and 2 is 2", odd.coins.median === 2, JSON.stringify(odd.coins));
    done();
});

test("the headline figures are rounded and worded the way a person expects, and the median and the average are told apart", () => {
    const { check, done } = checks();

    const text = visible(renderReport(summarize([
        ended("2026-10-11T19:00:00", "law_win", 1000, 3, 2, 3, 0, 10),
        ended("2026-10-11T19:10:00", "law_win", 1000, 4, 2, 4, 0, 10),
        ended("2026-10-11T19:20:00", "outlaw_win", 10000, 4, 2, 0, 4, 10)
    ]), { generated: "2026-10-12 21:00" }));

    check("2 of 3 is 67%", text.includes("Law win rate 67% 2 of 3 decided"), text.slice(0, 300));
    check("11 kills in 3 rounds is 3.7 a round, and 6 deaths is 2", text.includes("Kills per round 3.7 2 deaths per round"), text.slice(0, 300));
    check("the median is the middle round and the average is not", text.includes("Median length 0:50 average 3:20"), text.slice(0, 300));
    done();
});

test("one of something is said in the singular", () => {
    const text = visible(renderReport(summarize([event("boot", "2026-10-11T19:00:00")], { ingest: { files: 1, found: 1, added: 1, duplicates: 0, skipped: 0, damaged: 0, unfinished: 0, unreadable: 0 } }), { generated: "x" }));

    assert.ok(text.includes("from 1 event") && text.includes("1 log file,") && text.includes("1 telemetry line:") && text.includes("loaded 1 time."), text);
});

test("the report says which world it shows, how the last read went, and what the rate limit dropped", () => {
    const { check, done } = checks();
    const ingest = { files: 100, found: 7, added: 5, duplicates: 1, skipped: 1, damaged: 0, unfinished: 1, unreadable: 0 };

    const text = visible(renderReport(summarize([...MIXED, event("telemetry.dropped", "2026-10-12T11:00:00", { lines: 40 })], { world: B, ingest }), { generated: "2026-10-12 21:00" }));

    check("which world", text.includes("Showing world bbbbbb only"), text.slice(0, 300));
    check("the last read", text.includes("100 log files") && text.includes("5 new") && text.includes("1 already known") && text.includes("1 skipped") && text.includes("1 cut off"), text);
    check("what was dropped", text.includes("dropped 40 lines"), text);
    check("both worlds are listed for reference", text.includes("aaaaaa") && text.includes("bbbbbb"));
    done();
});

test("an empty archive says there is no data yet instead of failing, and so does one with no finished rounds", () => {
    const { check, done } = checks();

    const empty = visible(renderReport(summarize([], { ingest: { files: 100, found: 0, added: 0, duplicates: 0, skipped: 0, damaged: 0, unfinished: 0, unreadable: 0 } }), { generated: "2026-10-12 21:00" }));
    check("no data yet, and why", empty.includes("No telemetry yet") && empty.includes("100 log files"), empty);
    check("and nothing was dropped", empty.includes("dropped no lines"), empty);

    const noRounds = visible(renderReport(summarize(NOISE), { generated: "2026-10-12 21:00" }));
    check("events but no finished round", noRounds.includes("No finished rounds") && !noRounds.includes("No telemetry yet"), noRounds);
    done();
});

test("nothing the logs say can add markup to the page, and the page asks for nothing outside itself", () => {
    const { check, done } = checks();
    const hostile = "<img src=x onerror=alert(1)>";

    const html = renderReport(summarize([ended("2026-10-11T19:00:00", "<script>alert(2)</script>", 1, 0, 0, 0, 0, 0, hostile)]), { generated: "2026-10-12 21:00" });

    check("the world's name is shown as text", !html.includes("<img src=x") && html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    check("so is a reason", !html.includes("<script>alert(2)") && html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"));
    const awkward = renderReport(summarize([ended("2026-10-11T19:00:00", "R&D", 1, 0, 0, 0, 0, 0, "a\"b")]), { generated: "x" });
    check("an ampersand and a quote are escaped too", awkward.includes("R&amp;D") && awkward.includes("a&quot;b"));
    check("no script at all", !/<script/i.test(html));
    check("no link, import or address of another site", !/<link/i.test(html) && !/@import/i.test(html) && !/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(html) && !/url\(\s*["']?\s*(https?:)?\/\//i.test(html));
    done();
});

test("a CSV per kind: its header, a row per event in time order, lists joined, awkward text quoted, and a mark Excel reads UTF-8 by", () => {
    const { check, done } = checks();

    const files = toCsv([
        event("shop.trade", "2026-10-11T19:10:00", { id: "general", deal: "t1", face: "buy", spent: 20, got: 0, give: ["minecraft:bread x4", "minecraft:apple x1"], take: [], svc: [], p: "7", role: "law" }),
        event("shop.refuse", "2026-10-11T19:05:00", { id: "general", deal: "t1", why: "you need 20 coins, you have 12", p: "7" }),
        event("shop.trade", "2026-10-11T19:00:00", { id: "general", deal: "t2", face: "sell", spent: 0, got: 5, give: [], take: ["minecraft:gold_ingot x1"], svc: [], p: "8" }),
        event("shop.refuse", "2026-10-11T19:06:00", { id: "general", deal: "t1", why: "say \"no\"", p: "7" }),
        event("shop.refuse", "2026-10-11T19:07:00", { id: "general", deal: "t1", why: "line one\nline two", p: "7" })
    ]);

    check("one file per kind there is", [...files.keys()].sort().join() === "shop.refuse,shop.trade", [...files.keys()].join());

    const trade = files.get("shop.trade").replace(BOM, "").split("\r\n");
    check("a mark so Excel reads UTF-8", files.get("shop.trade").startsWith(BOM));
    check("the header: the stamp, then the kind's own fields in the order they first appear", trade[0] === "at,w,b,n,t,bv,id,deal,face,spent,got,give,take,svc,p,role", trade[0]);
    check("a header and a row per event, oldest first, and the last row ends in a line break like the others", trade.length === 4 && trade[3] === "" && trade[1].startsWith("2026-10-11T19:00:00,aaaaaa,b001,") && trade[2].startsWith("2026-10-11T19:10:00,"), trade.join(" // "));
    check("a list is its entries joined by ' | ', an empty one is empty, a missing field is empty", trade[2].endsWith("buy,20,0,minecraft:bread x4 | minecraft:apple x1,,,7,law") && trade[1].endsWith("sell,0,5,,minecraft:gold_ingot x1,,8,"), trade.join(" // "));

    const refuse = files.get("shop.refuse").replace(BOM, "").split("\r\n");
    check("a comma makes a field quoted", refuse[1].includes(",\"you need 20 coins, you have 12\","), refuse[1]);
    check("a quote is doubled", refuse[2].includes(",\"say \"\"no\"\"\","), refuse[2]);
    check("a line break inside a field keeps the field in quotes", files.get("shop.refuse").includes(",\"line one\nline two\","), JSON.stringify(refuse[3]));
    done();
});
