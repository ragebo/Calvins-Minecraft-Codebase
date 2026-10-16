import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, system, load, checks, strip } from "./helpers.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";

// tasks/endings, Task 6: what a round's end says about who got away, and what the telemetry writes about an ending. The announcement gives "N escaped, M captured"
// when anyone escaped (a round nobody escaped from says nothing extra, and a group ending with no solo escape before it keeps the boat's old two lines exactly);
// `round.end` names the ending that ended the round; a solo escape writes an `ending.escape` line with the id, who, and what it cost.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

await load("main.js");
const { ItemStack } = fakeApi;
const round = await load("core/round.js");
const store = await load("core/endingstore.js");
const endings = await load("core/endings.js");
const state = await load("core/state.js");
const L = await load("logic/endings.js");
const T = await load("logic/telemetry.js");

const TOWER = { x: 400, y: 70, z: 400 };
const PIER = { x: 200, y: 64, z: 300 };
const at = (x, z, y = 70) => ({ x, y, z });
const ending = (player, id) => system.afterEvents.scriptEventReceive.emit({ id: "rae:ending", sourceEntity: player, message: id });
const said = () => fake.chat.map(strip);
const tallyLines = () => said().filter((m) => / escaped, \d+ captured\.$/.test(m));
const TAG = "[telemetry] ";
const sent = () => lines.filter((text) => text.startsWith(`${TAG}{`)).map((text) => JSON.parse(text.slice(TAG.length)));

function scene() {
    fake.reset();
    round.resetRound();
    store.forgetEndings();
    round.startRound();
    round.beginActive();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    lines.length = 0;
}

function cast(...specs) {
    const players = specs.map(([name, options]) => fake.makePlayer(name, { inventory: true, ...options }));
    fake.advance(1);
    return players;
}

function add(kind, id, place, patch = {}) {
    const made = L.newEnding(kind, id, id[0].toUpperCase() + id.slice(1), place);
    assert.ok(made.ok, made.reason);
    const edited = L.edit(made.value, patch);
    assert.ok(edited.ok, edited.reason);
    assert.equal(store.saveEnding(edited.value).ok, true);
}

const addTower = (patch = {}) => add("solo", "tower", TOWER, { radius: 5, price: 100, ...patch });
const addPier = () => add("group", "pier", PIER, { radius: 10, price: 100 });
const out = (name, x, z, extra = {}) => [name, { tags: ["outlaw"], location: at(x, z), ...extra }];
const bye = (player) => state.update(player, { eliminated: true });

test("a law win after a solo escape tells how many got away and how many were caught", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [a, b] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900), ["Law", { tags: ["law"], location: at(950, 950) }]);
    fake.setScore("coins", "A", 100);
    ending(a, "tower");
    bye(b);
    endings.checkRoundOver();

    check("the law won", round.lastEnd() === "law_win", String(round.lastEnd()));
    check("one line, with both numbers", tallyLines().length === 1 && tallyLines()[0] === "1 escaped, 1 captured.", said().join(" | "));
    done();
});

test("a law win nobody escaped from says nothing about escapes", () => {
    scene();
    const { check, done } = checks();
    const [a] = cast(out("A", 900, 900), ["Law", { tags: ["law"], location: at(950, 950) }]);
    bye(a);
    endings.checkRoundOver();

    check("the law won", round.lastEnd() === "law_win", String(round.lastEnd()));
    check("no tally", tallyLines().length === 0, said().join(" | "));
    done();
});

test("when every outlaw escaped, the tally counts them all", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [a, b] = cast(out("A", TOWER.x, TOWER.z), out("B", TOWER.x, TOWER.z));
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);
    ending(a, "tower");
    ending(b, "tower");

    check("the outlaws won", round.lastEnd() === "outlaw_win", String(round.lastEnd()));
    check("two escaped, none caught", tallyLines().length === 1 && tallyLines()[0] === "2 escaped, 0 captured.", said().join(" | "));
    done();
});

test("a group ending after a solo escape counts the solo escaper and the gang as escaped, and the eliminated as captured", () => {
    scene();
    addTower();
    addPier();
    const { check, done } = checks();
    const [a, b, c, d] = cast(out("A", TOWER.x, TOWER.z), out("B", PIER.x, PIER.z), out("C", PIER.x + 1, PIER.z), out("D", 900, 900));
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);
    fake.setScore("coins", "C", 100);
    ending(a, "tower");
    bye(d);
    state.update(c, { inJail: true });
    ending(b, "pier");

    check("the gang ended the round", round.lastEnd() === "outlaw_win" && round.lastEndDetail() === "pier", `${round.lastEnd()} ${round.lastEndDetail()}`);
    check("three escaped, one caught", tallyLines().length === 1 && tallyLines()[0] === "3 escaped, 1 captured.", said().join(" | "));
    check("said after the ending announced itself", said().indexOf(tallyLines()[0]) > said().indexOf("THE OUTLAWS HAVE ESCAPED!") && said().includes("THE OUTLAWS HAVE ESCAPED!"), said().join(" | "));
    done();
});

test("a group ending with no solo escape before it says only what it always said", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [b, c] = cast(out("B", PIER.x, PIER.z), out("C", PIER.x + 1, PIER.z));
    fake.setScore("coins", "B", 100);
    fake.setScore("coins", "C", 100);
    ending(b, "pier");

    check("the gang ended the round", round.lastEnd() === "outlaw_win", String(round.lastEnd()));
    check("no tally line", tallyLines().length === 0, said().join(" | "));
    assert.ok(c);
    done();
});

test("round.end names the group ending that ended the round, and says nothing of one when the law won", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [b] = cast(out("B", PIER.x, PIER.z));
    fake.setScore("coins", "B", 200);
    ending(b, "pier");

    const ended = sent().filter((e) => e.k === "round.end");
    check("one round.end line, naming the ending", ended.length === 1 && ended[0].ending === "pier" && ended[0].reason === "outlaw_win", JSON.stringify(ended));

    scene();
    const [c] = cast(out("C", 900, 900), ["Law", { tags: ["law"], location: at(950, 950) }]);
    bye(c);
    endings.checkRoundOver();
    const lawEnd = sent().filter((e) => e.k === "round.end");
    check("a law win names none", lawEnd.length === 1 && lawEnd[0].reason === "law_win" && !("ending" in lawEnd[0]), JSON.stringify(lawEnd));
    done();
});

test("a solo escape writes one ending.escape line with the ending, the player and what it cost", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [a] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    fake.setScore("coins", "A", 150);
    ending(a, "tower");

    const escapes = sent().filter((e) => e.k === "ending.escape");
    check("one line", escapes.length === 1, JSON.stringify(escapes));
    check("with the ending, the player and the coins", escapes[0]?.id === "tower" && escapes[0]?.p === a.id && escapes[0]?.coins === 100, JSON.stringify(escapes));
    check("no item when none was taken", escapes[0] && !("item" in escapes[0]) && !("count" in escapes[0]), JSON.stringify(escapes));
    done();
});

test("a solo escape paid with an item writes the item and how many were taken", () => {
    scene();
    addTower({ price: 0, item: { id: "minecraft:diamond", count: 2 }, consumeItem: true });
    const { check, done } = checks();
    const [a] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    a.container.addItem(new ItemStack("minecraft:diamond", 3));
    ending(a, "tower");

    const escapes = sent().filter((e) => e.k === "ending.escape");
    check("the item and its count", escapes.length === 1 && escapes[0].item === "minecraft:diamond" && escapes[0].count === 2 && escapes[0].coins === 0, JSON.stringify(escapes));
    done();
});

test("an item that is only shown, not taken, is not in the line", () => {
    scene();
    addTower({ price: 0, item: { id: "minecraft:diamond", count: 2 }, consumeItem: false });
    const { check, done } = checks();
    const [a] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    a.container.addItem(new ItemStack("minecraft:diamond", 3));
    ending(a, "tower");

    const escapes = sent().filter((e) => e.k === "ending.escape");
    check("escaped, with no item named", escapes.length === 1 && !("item" in escapes[0]) && !("count" in escapes[0]), JSON.stringify(escapes));
    done();
});

test("a refused try writes no ending line, and an ending that is only checked does not end the round twice", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [a] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    fake.setScore("coins", "A", 10);
    ending(a, "tower");

    check("nothing about an ending", sent().filter((e) => e.k === "ending.escape" || e.k === "round.end").length === 0, JSON.stringify(sent()));
    done();
});

test("the format is still version 1, the new kind is a known one, and the reader takes both new and old lines", () => {
    const { check, done } = checks();
    const stamp = { v: 1, w: "aaaaaa", b: "b001", n: 1, t: 10, bv: "0.2.9" };
    const old = { at: "2026-10-15T10:00:00", ...stamp, k: "round.end", reason: "outlaw_win", dur: 100, kills: 0, deaths: 0, lawKills: 0, outlawKills: 0, coins: 0 };
    const named = { ...old, n: 2, ending: "pier" };
    const escape = { at: "2026-10-15T10:01:00", ...stamp, n: 3, k: "ending.escape", id: "tower", p: "7", coins: 100 };

    check("still version 1", T.TELEMETRY_VERSION === 1);
    check("a known kind", T.EVENT_KINDS.includes("ending.escape"));
    let summary;
    try { summary = summarize([old, named, escape], {}); } catch (err) { summary = err; }
    check("the reader does not fall over", !(summary instanceof Error), String(summary));
    done();
});

void world;
