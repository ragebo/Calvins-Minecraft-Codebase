import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checks, fake, load, system, world } from "./helpers.mjs";

// core/telemetryevents.ts: how an event leaves the game, as one line in the content log. The console is replaced for the whole file (what it is
// given is kept in `lines`) and time only moves when a test moves it. The module keeps its numbering, its boot id and its rate limit for as long
// as the file runs, exactly as it does in a world, so each test reads "what was added since I looked" and never assumes a clean slate. The tests
// that need a SECOND copy of the module (a script reload) come last, so the copy cannot disturb the numbering the others read.

const lines = [];
const realWarn = console.warn;
const capture = (...args) => { lines.push(args.join(" ")); };
console.warn = capture;
process.on("exit", () => { console.warn = realWarn; });

const E = await load("core/telemetryevents.js");          // imported with the console already replaced
const { TELEMETRY } = await load("config/balance.js");
const { BUILD_VERSION } = await load("config/build.js");

const TAG = "[telemetry] ";
const WORLD_PROPERTY = "rae:telemetry:world";
const sent = () => lines.filter((text) => text.startsWith(`${TAG}{`)).map((text) => JSON.parse(text.slice(TAG.length)));

/** Runs `body` with some of the live telemetry config changed, and puts it back whatever happens. */
function withConfig(changes, body) {
    const before = { ...TELEMETRY.events };
    Object.assign(TELEMETRY.events, changes);
    try { body(); } finally { Object.assign(TELEMETRY.events, before); }
}

const open = (p) => E.emit("shop.open", { id: "general", p });

test("telemetry is on by default, and the limits are real numbers", () => {
    const { check, done } = checks();
    const e = TELEMETRY.events;

    check("on", e.enabled === true);
    check("a rate limit that lets lines through", e.maxLinesPerWindow >= 1 && e.windowTicks >= 1, `${e.maxLinesPerWindow} per ${e.windowTicks}`);
    check("size caps that leave room for a line", e.textChars >= 1 && e.listItems >= 1 && e.lineChars >= 100, `${e.textChars} ${e.listItems} ${e.lineChars}`);
    done();
});

test("a boot line is written on the first tick after the scripts load, saying which world and which build", () => {
    const { check, done } = checks();

    check("nothing is written at import: a world property cannot be read while the scripts are still starting", sent().length === 0, JSON.stringify(sent()));

    fake.advance(1);
    const boots = sent().filter((e) => e.k === "boot");
    const boot = boots[0] ?? {};

    check("exactly one boot line", boots.length === 1, JSON.stringify(sent()));
    check("it is the first line of the boot", boot.n === 1, JSON.stringify(boot));
    check("it carries the schema version and the build", boot.v === 1 && boot.bv === BUILD_VERSION, JSON.stringify(boot));
    check("a world id of six characters and a boot id of four", boot.w?.length === 6 && boot.b?.length === 4, JSON.stringify(boot));
    check("the tick it was written at", boot.t === system.currentTick, `${boot.t} vs ${system.currentTick}`);
    check("the world id is kept in the world", world.getDynamicProperty(WORLD_PROPERTY) === boot.w, String(world.getDynamicProperty(WORLD_PROPERTY)));

    fake.advance(40);
    check("and only one: the boot handler stops itself", sent().filter((e) => e.k === "boot").length === 1);
    done();
});

test("every line is stamped: the same world and boot, a number that rises by one, the tick it was written at, and the fields as given", () => {
    const { check, done } = checks();
    const before = sent().length;

    E.emit("round.end", { reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 });
    fake.advance(7);
    E.emit("shop.open", { id: "general", p: "7", role: "law" });

    const added = sent().slice(before);
    const [a, b] = added;

    check("two lines", added.length === 2, String(added.length));
    check("the same world and the same boot", a.w === b.w && a.b === b.b, JSON.stringify(added));
    check("the number rises by one", b.n === a.n + 1, `${a.n} then ${b.n}`);
    check("the tick is when each was written", b.t - a.t === 7 && b.t === system.currentTick, `${a.t} then ${b.t}`);
    check("the fields are as given", a.k === "round.end" && a.reason === "law_win" && a.coins === 640 && b.k === "shop.open" && b.id === "general" && b.p === "7" && b.role === "law", JSON.stringify(added));
    check("each went out as one console line under the telemetry tag", lines.filter((text) => text.startsWith(TAG)).length === sent().length);
    done();
});

test("rae:persist_reset clears saved game data but leaves the world's id alone", async () => {
    const { check, done } = checks();

    await load("core/persist.js");           // registers the script event, as the game does
    const w = sent().at(-1).w;
    world.setDynamicProperty("rae:persist:dummy", "1");

    system.afterEvents.scriptEventReceive.emit({ id: "rae:persist_reset" });

    check("the reset ran: a saved key is gone", world.getDynamicProperty("rae:persist:dummy") === undefined);
    check("the world's id is still there", world.getDynamicProperty(WORLD_PROPERTY) === w, String(world.getDynamicProperty(WORLD_PROPERTY)));

    const before = sent().length;
    open("7");
    check("and the next line carries it", sent()[before]?.w === w, JSON.stringify(sent().slice(before)));
    done();
});

test("with telemetry off nothing is written and no line number is used up", () => {
    const { check, done } = checks();
    const last = sent().at(-1);
    const count = sent().length;

    withConfig({ enabled: false }, () => {
        open("7");
        E.emit("round.end", { reason: "aborted", dur: 1, kills: 0, deaths: 0, lawKills: 0, outlawKills: 0, coins: 0 });
    });

    check("nothing was written", sent().length === count, String(sent().length - count));

    open("7");
    check("and the numbering did not skip", sent().at(-1).n === last.n + 1, `${last.n} then ${sent().at(-1).n}`);
    done();
});

test("over the rate limit the extra lines are dropped, and the next window opens with one line saying how many", () => {
    const { check, done } = checks();

    withConfig({ maxLinesPerWindow: 3, windowTicks: 100 }, () => {
        fake.advance(100);                                  // the window an earlier test left open has ended
        const start = sent().length;

        for (let i = 0; i < 5; i++) open(String(i));
        const first = sent().slice(start);
        check("three of the five are written", first.length === 3 && first.every((e) => e.k === "shop.open"), JSON.stringify(first));

        fake.advance(100);
        for (let i = 5; i < 8; i++) open(String(i));
        const next = sent().slice(start + 3);

        check("the new window opens with the notice, counting the two that were dropped", next[0]?.k === "telemetry.dropped" && next[0].lines === 2, JSON.stringify(next[0]));
        check("the notice does not use up the new window: all three of its lines are written", next.filter((e) => e.k === "shop.open").length === 3, JSON.stringify(next));
        check("every line, the notice too, has the next number", next.every((e, i) => i === 0 || e.n === next[i - 1].n + 1), JSON.stringify(next.map((e) => e.n)));
    });

    done();
});

test("a console that throws costs the game nothing: emit does not throw, and says so once", () => {
    const { check, done } = checks();
    const before = sent().length;

    // Breaks only the telemetry lines, so the one-time complaint can be seen.
    console.warn = (...args) => {
        const text = args.join(" ");
        if (text.startsWith(`${TAG}{`)) throw new Error("the console broke");
        lines.push(text);
    };

    try {
        assert.doesNotThrow(() => open("7"));
        assert.doesNotThrow(() => open("8"));
    } finally {
        console.warn = capture;
    }

    const said = lines.filter((text) => text.startsWith("[telemetry-problem] "));

    check("nothing was written", sent().length === before);
    check("it said so, once, with the reason", said.length === 1 && said[0].includes("the console broke"), JSON.stringify(said));
    done();
});

test("a field that cannot be written as JSON costs the game nothing either, and the lines after it still go out", () => {
    const { check, done } = checks();
    const cycle = {};
    cycle.self = cycle;

    assert.doesNotThrow(() => E.emit("shop.refuse", { id: "general", deal: "t1", why: cycle, p: "7" }));

    const before = sent().length;
    open("7");
    check("the next line is written", sent().length === before + 1);
    done();
});

test("the size caps are read from the config at every line", () => {
    const { check, done } = checks();
    const before = sent().length;

    withConfig({ textChars: 10 }, () => E.emit("shop.refuse", { id: "general", deal: "t1", why: "x".repeat(50), p: "7" }));

    const line = sent()[before];
    check("the text was cut to the configured length", line?.why.length === 10 && line.cut === 1, JSON.stringify(line));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// A second copy of the module is what a script reload gives: its numbering, boot id and rate limit start over, and the world keeps its properties.
// ---------------------------------------------------------------------------------------------------------

const url = pathToFileURL(path.resolve(import.meta.dirname, "..", ".test-build", "core", "telemetryevents.js")).href;

test("a reload keeps the world's id and starts a new boot: a new boot id, the numbering from 1, a boot line on its first tick", async () => {
    const { check, done } = checks();
    const first = sent().at(-1);

    await import(`${url}?reload=1`);

    const before = sent().length;
    fake.advance(1);
    const boot = sent().slice(before).find((e) => e.k === "boot");

    check("a boot line on its first tick", boot !== undefined, JSON.stringify(sent().slice(before)));
    check("the same world", boot?.w === first.w, `${boot?.w} vs ${first.w}`);
    check("a new boot id", boot?.b !== first.b && boot?.b.length === 4, `${boot?.b} vs ${first.b}`);
    check("numbered from 1 again", boot?.n === 1, String(boot?.n));
    done();
});

test("even a console that throws on everything, the complaint included, does not make emit throw", async () => {
    const fresh = await import(`${url}?reload=2`);       // its one-time complaint has not been used yet

    console.warn = () => { throw new Error("no console at all"); };

    try {
        assert.doesNotThrow(() => fresh.emit("shop.open", { id: "general", p: "7" }));
    } finally {
        console.warn = capture;
    }
});
