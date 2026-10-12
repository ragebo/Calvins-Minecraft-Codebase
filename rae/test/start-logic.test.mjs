import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, load } from "./helpers.mjs";

// logic/start.ts: the pure rules of the start sequence. A shot is two marks (where the camera is and which way it faces) that an operator
// records by standing somewhere; picking which shots a Start plays; how the intro's seconds are split; and the operator's list of start
// commands with its edits. Nothing here knows the game: the random source comes in as an argument, and the caps are config/balance.ts's START.

const L = await load("logic/start.js");
const { START } = await load("config/balance.js");

const mark = (x = 10, y = 70, z = -20, pitch = 15, yaw = 90) => ({ x, y, z, pitch, yaw });
const shot = (id, name = id) => {
    const made = L.makeShot(id, name, mark(1, 70, 2), mark(30, 90, 40, -10, 180));
    assert.ok(made.ok, made.reason);
    return made.value;
};

// ---------------------------------------------------------------------------------------------------------
// A shot
// ---------------------------------------------------------------------------------------------------------

test("a shot keeps its marks, rounded to two decimals so the saved text stays short", () => {
    const { check, done } = checks();

    const made = L.makeShot("s1", "  Bridge  ", mark(10.123456, 70.987654, -20.5, 15.555, 90.004), mark(1.006, 2.449, 3.5, -0.001, 0));

    check("it is made", made.ok === true, made.reason);
    check("the id and the trimmed name", made.value.id === "s1" && made.value.name === "Bridge", JSON.stringify(made.value));
    check("the start mark, rounded", JSON.stringify(made.value.start) === JSON.stringify({ x: 10.12, y: 70.99, z: -20.5, pitch: 15.56, yaw: 90 }), JSON.stringify(made.value.start));
    // A pitch of -0.001 rounds to -0, which is written as 0.
    check("the end mark, rounded the same way", JSON.stringify(made.value.end) === JSON.stringify({ x: 1.01, y: 2.45, z: 3.5, pitch: 0, yaw: 0 }), JSON.stringify(made.value.end));
    check("a version", made.value.version === L.START_VERSION);
    done();
});

test("a shot survives its saved text exactly", () => {
    const original = shot("s7", "Rooftops");
    const back = L.parseShot(L.serializeShot(original));

    assert.ok(back.ok, back.reason);
    assert.deepEqual(back.value, original);
});

test("a saved shot is short enough for its cap", () => {
    const text = L.serializeShot(shot("s12", "x".repeat(START.maxNameChars)));

    assert.ok(text.length <= START.maxShotChars, `${text.length} characters against a cap of ${START.maxShotChars}`);
});

test("a mark that cannot be a camera is refused with a reason, and no shot comes out", () => {
    const { check, done } = checks();
    const bad = (label, result) => check(label, result.ok === false && typeof result.reason === "string" && result.reason.length > 0, JSON.stringify(result));

    bad("NaN position", L.makeShot("s1", "a", mark(NaN), mark()));
    bad("infinite position", L.makeShot("s1", "a", mark(10, Infinity), mark()));
    bad("pitch above 90", L.makeShot("s1", "a", mark(10, 70, 0, 91), mark()));
    bad("pitch below -90", L.makeShot("s1", "a", mark(10, 70, 0, -91), mark()));
    bad("above the build limit", L.makeShot("s1", "a", mark(10, 321), mark()));
    bad("below the world", L.makeShot("s1", "a", mark(10, -65), mark()));
    bad("beyond the world's edge", L.makeShot("s1", "a", mark(30000001), mark()));
    bad("beyond the world's edge on the other axis", L.makeShot("s1", "a", mark(10, 70, -30000001), mark()));
    bad("a yaw past a half turn", L.makeShot("s1", "a", mark(10, 70, 0, 0, 181), mark()));
    bad("a yaw past a half turn the other way", L.makeShot("s1", "a", mark(), mark(10, 70, 0, 0, -181)));
    bad("the end is bad too", L.makeShot("s1", "a", mark(), mark(0, 70, 0, 0, NaN)));
    bad("an empty id", L.makeShot("", "a", mark(), mark()));
    bad("an id with a space", L.makeShot("bad id", "a", mark(), mark()));
    bad("a name longer than the cap", L.makeShot("s1", "x".repeat(START.maxNameChars + 1), mark(), mark()));
    check("the edges themselves are fine", L.makeShot("s1", "a", mark(10, 320, 0, 90, 180), mark(-30000000, -64, 0, -90, -180)).ok === true);
    check("an empty name is fine (a screen shows the id)", L.makeShot("s1", "", mark(), mark()).ok === true);
    done();
});

test("damaged saved text never throws and never gives a shot", () => {
    const { check, done } = checks();
    const good = JSON.parse(L.serializeShot(shot("s1")));
    const refused = (label, text) => check(label, L.parseShot(text).ok === false && L.parseShot(text).reason.length > 0, String(text));

    refused("nothing saved", undefined);
    refused("empty text", "");
    refused("not JSON", "this is not json");
    refused("JSON that is not an object", "[1,2,3]");
    refused("another version", JSON.stringify({ ...good, v: L.START_VERSION + 1 }));
    refused("no start mark", JSON.stringify({ ...good, a: undefined }));
    refused("a mark with four numbers", JSON.stringify({ ...good, a: [1, 2, 3, 4] }));
    refused("a mark with a string in it", JSON.stringify({ ...good, a: [1, "2", 3, 4, 5] }));
    refused("an id that is a number", JSON.stringify({ ...good, id: 5 }));
    refused("a pitch that is out of range", JSON.stringify({ ...good, b: [1, 2, 3, 200, 5] }));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Picking shots
// ---------------------------------------------------------------------------------------------------------

/** A seeded random source: the same seed gives the same sequence, so a test can be exact and still vary. */
const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const pool3 = () => [shot("a"), shot("b"), shot("c")];
const ids = (shots) => shots.map((s) => s.id).join();

test("pickShots is exact for a fixed random, and gives distinct shots", () => {
    const { check, done } = checks();

    check("random 0 on [a, b, c] gives b, c, a, so two shots are b and c", ids(L.pickShots(pool3(), 2, undefined, () => 0)) === "b,c", ids(L.pickShots(pool3(), 2, undefined, () => 0)));
    check("all three are b, c, a", ids(L.pickShots(pool3(), 3, undefined, () => 0)) === "b,c,a");
    check("a random that is nearly 1 leaves the order as it was", ids(L.pickShots(pool3(), 3, undefined, () => 0.99)) === "a,b,c", ids(L.pickShots(pool3(), 3, undefined, () => 0.99)));

    let allDistinct = true;
    for (let seed = 1; seed < 100; seed++) {
        const picked = L.pickShots(pool3(), 3, undefined, seeded(seed));
        if (new Set(picked.map((s) => s.id)).size !== picked.length) allDistinct = false;
    }
    check("a hundred random picks are all distinct", allDistinct);
    done();
});

test("pickShots never gives more than the pool, nothing for nothing, and does not touch the pool", () => {
    const { check, done } = checks();
    const pool = Object.freeze(pool3());

    check("more than the pool gives the whole pool", L.pickShots(pool, 9, undefined, () => 0.5).length === 3);
    check("none wanted gives none", L.pickShots(pool, 0, undefined, () => 0.5).length === 0);
    check("a negative count gives none", L.pickShots(pool, -2, undefined, () => 0.5).length === 0);
    check("NaN gives none", L.pickShots(pool, NaN, undefined, () => 0.5).length === 0);
    check("a fraction is taken down", L.pickShots(pool, 2.9, undefined, () => 0.5).length === 2);
    check("an empty pool gives none", L.pickShots([], 2, undefined, () => 0.5).length === 0);
    check("the pool is as it was", ids(pool) === "a,b,c");
    done();
});

test("pickShots does not open with the shot that opened last time when there is another", () => {
    const { check, done } = checks();

    check("random 0 would open with b: told b opened last time, it opens with c", ids(L.pickShots(pool3(), 2, "b", () => 0)) === "c,b", ids(L.pickShots(pool3(), 2, "b", () => 0)));

    let repeated = 0;
    for (let seed = 1; seed < 300; seed++) {
        const picked = L.pickShots(pool3(), 2, "a", seeded(seed));
        if (picked[0].id === "a") repeated++;
    }
    check("in 300 random picks told a opened last time, a never opens", repeated === 0, `${repeated} repeats`);

    check("one shot in the pool opens with it however it is told", ids(L.pickShots([shot("a")], 2, "a", () => 0.3)) === "a");
    check("an id that is not in the pool changes nothing", ids(L.pickShots(pool3(), 2, "zzz", () => 0)) === "b,c");
    done();
});

test("the intro's seconds are shared evenly, and never divide by zero", () => {
    const { check, done } = checks();

    check("10 seconds, 2 shots: 5 each", L.secondsPerShot(10, 2) === 5);
    check("10 seconds, 3 shots", Math.abs(L.secondsPerShot(10, 3) - 10 / 3) < 1e-9);
    check("no shots: 0, not Infinity", L.secondsPerShot(10, 0) === 0);
    check("no seconds: 0", L.secondsPerShot(0, 2) === 0);
    check("a negative total: 0", L.secondsPerShot(-5, 2) === 0);
    check("NaN: 0", L.secondsPerShot(NaN, 2) === 0 && L.secondsPerShot(10, NaN) === 0);
    done();
});

test("the next shot id continues from the highest one used", () => {
    const { check, done } = checks();

    check("none yet: s1", L.nextShotId([]) === "s1");
    check("after s1, s2: s3", L.nextShotId(["s1", "s2"]) === "s3");
    check("a gap is not filled: the highest wins", L.nextShotId(["s2", "s10", "s4"]) === "s11");
    check("ids of another shape are ignored", L.nextShotId(["intro", "s3", "x9"]) === "s4");
    check("an id that only ends like one is ignored too", L.nextShotId(["abs7", "s2"]) === "s3");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

test("a command is cleaned the same way every time, and a line that cannot be run is refused with a reason", () => {
    const { check, done } = checks();
    const clean = (text) => L.cleanCommand(text);

    check("spaces and a leading slash go", clean("  /effect @a clear  ").value === "effect @a clear");
    check("a command without a slash is left as it is", clean("gamemode survival @a").value === "gamemode survival @a");
    check("only one slash is dropped", clean("//x").value === "/x");
    check("a space after the slash goes with it", clean("/ effect @a clear").value === "effect @a clear");
    check("the cap itself is fine", clean("x".repeat(START.maxCommandChars)).ok === true);

    const refused = (label, result, mentions) => check(label, result.ok === false && result.reason.includes(mentions), JSON.stringify(result));

    refused("one over the cap says the cap", clean("x".repeat(START.maxCommandChars + 1)), String(START.maxCommandChars));
    refused("empty", clean(""), "command");
    refused("only spaces", clean("    "), "command");
    refused("only a slash", clean("/"), "command");
    refused("a new line", clean("say a\nsay b"), "one line");
    refused("a carriage return", clean("say a\rsay b"), "one line");
    done();
});

test("adding, editing and removing a command never change the list they were given", () => {
    const { check, done } = checks();
    const list = Object.freeze(["effect @a clear", "gamemode survival @a"]);

    const added = L.addCommand(list, "/clear @a");
    check("add puts it last, cleaned", added.ok && added.value.join("|") === "effect @a clear|gamemode survival @a|clear @a", JSON.stringify(added));

    const edited = L.editCommand(list, 1, "gamemode adventure @a");
    check("edit replaces that one", edited.ok && edited.value.join("|") === "effect @a clear|gamemode adventure @a", JSON.stringify(edited));

    const removed = L.removeCommand(list, 0);
    check("remove takes that one out and keeps the order of the rest", removed.ok && removed.value.join("|") === "gamemode survival @a", JSON.stringify(removed));

    check("the original is as it was", list.join("|") === "effect @a clear|gamemode survival @a");
    done();
});

test("an edit that cannot be made says why and changes nothing", () => {
    const { check, done } = checks();
    const list = ["a", "b"];
    const refused = (label, result) => check(label, result.ok === false && result.reason.length > 0, JSON.stringify(result));

    refused("an empty add", L.addCommand(list, "  "));
    refused("an edit past the end", L.editCommand(list, 2, "x"));
    refused("an edit before the start", L.editCommand(list, -1, "x"));
    refused("an edit at a fraction", L.editCommand(list, 0.5, "x"));
    refused("an edit to an empty line", L.editCommand(list, 0, ""));
    refused("a remove past the end", L.removeCommand(list, 5));
    refused("a remove at NaN", L.removeCommand(list, NaN));

    const full = Array.from({ length: START.maxCommands }, (_, i) => `say ${i}`);
    const over = L.addCommand(full, "say one more");
    check("a full list refuses another and says the most", over.ok === false && over.reason.includes(String(START.maxCommands)), JSON.stringify(over));
    check("a full list can still be edited and removed from", L.editCommand(full, 0, "say x").ok === true && L.removeCommand(full, 0).ok === true);
    done();
});

test("the command list survives its saved text, and a saved empty list is a real list", () => {
    const { check, done } = checks();
    const list = ["effect @a clear", "scoreboard players set @a coins 0"];

    const back = L.parseCommands(L.serializeCommands(list));
    check("a list comes back as it went", back.ok && back.value.join("|") === list.join("|"), JSON.stringify(back));

    const exactlyFull = Array.from({ length: START.maxCommands }, (_, i) => `say ${i}`);
    check("a saved list at exactly the cap is read", L.parseCommands(L.serializeCommands(exactlyFull)).ok === true);

    const empty = L.parseCommands(L.serializeCommands([]));
    check("an empty list comes back empty, and is not an error", empty.ok === true && empty.value.length === 0, JSON.stringify(empty));
    done();
});

test("damaged saved commands never throw and never give a list", () => {
    const { check, done } = checks();
    const refused = (label, text) => check(label, L.parseCommands(text).ok === false && L.parseCommands(text).reason.length > 0, String(text));

    refused("nothing saved", undefined);
    refused("empty text", "");
    refused("not JSON", "say hello");
    refused("not an array", '{"a":1}');
    refused("an entry that is not text", "[\"say a\", 5]");
    refused("an empty entry", "[\"say a\", \"\"]");
    refused("an entry with a new line", "[\"say a\\nsay b\"]");
    refused("an entry over the cap", JSON.stringify(["x".repeat(START.maxCommandChars + 1)]));
    refused("more entries than the cap", JSON.stringify(Array.from({ length: START.maxCommands + 1 }, (_, i) => `say ${i}`)));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------------------------------------

test("the START numbers are the plan's, and the default commands are valid as they stand", () => {
    const { check, done } = checks();

    check("the intro is on, 10 seconds, 2 shots", START.introEnabled === true && START.introSeconds === 10 && START.shotsPerStart === 2);
    check("20 seconds to pick, a 3 second fly-down from 30 blocks up", START.pickSeconds === 20 && START.flyDownSeconds === 3 && START.flyDownHeight === 30);
    check("the owner's last-game list", START.defaultCommands.join(" | ") === [
        "effect @a clear",
        "effect @a instant_health 1 10 true",
        "effect @a saturation 1 10 true",
        "clear @a[m=!creative]",
        "gamemode survival @a",
        "scoreboard players set @a coins 0",
        "scoreboard players set @a bounty 0"
    ].join(" | "), START.defaultCommands.join(" | "));
    check("every default is already clean, so a save of them changes nothing", START.defaultCommands.every((c) => L.cleanCommand(c).ok && L.cleanCommand(c).value === c));
    check("and they fit the cap", START.defaultCommands.length <= START.maxCommands);
    check("a saved list of the defaults fits its own cap", L.serializeCommands(START.defaultCommands).length <= START.maxCommandListChars, `${L.serializeCommands(START.defaultCommands).length} of ${START.maxCommandListChars}`);
    done();
});
