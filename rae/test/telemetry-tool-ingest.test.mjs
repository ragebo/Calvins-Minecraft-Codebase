import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checks } from "./helpers.mjs";
import { defaultLogsDir, ingest, launchTime, parseLog, readArchive } from "../../tools/telemetry/ingest.mjs";

// tools/telemetry/ingest.mjs: reads the game's content logs and keeps the telemetry lines in an archive of its own. Plain JavaScript that
// runs outside the game, so nothing here touches the fake game; the logs are fixtures written into a scratch folder. Their shape is copied
// from the real ones (measured 2026-10-11): `HH:MM:SS[Scripting][level]-text`, a time of day and no date, and every entry ended by
// "\r\n\r\r\n" (a stray extra carriage return), not by a plain newline.

const SEP = "\r\n\r\r\n";
const entry = (time, level, text) => `${time}[Scripting][${level}]-${text}${SEP}`;
const tele = (time, event) => entry(time, "warning", `[telemetry] ${JSON.stringify(event)}`);
const ev = (k, fields = {}) => ({ v: 1, k, w: "a3f9c1", b: "x7q2", n: 1, t: 100, bv: "0.2.5", ...fields });

const scratch = mkdtempSync(path.join(import.meta.dirname, "..", ".test-build", "ingest-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** A new empty folder for one test: { logs, archive }, the logs folder made, the archive's not. */
function folders() {
    const dir = path.join(scratch, `case${++counter}`);
    mkdirSync(path.join(dir, "logs"), { recursive: true });
    return { dir, logs: path.join(dir, "logs"), archive: path.join(dir, "data", "events.jsonl") };
}

const LAUNCH = new Date(2026, 9, 11, 18, 36, 29);        // 2026-10-11 18:36:29, local time

test("the game's logs folder is under APPDATA, and there is none to guess where APPDATA is not set", () => {
    const before = process.env.APPDATA;

    try {
        process.env.APPDATA = path.join("C:", "Users", "someone", "AppData", "Roaming");
        assert.equal(defaultLogsDir(), path.join("C:", "Users", "someone", "AppData", "Roaming", "Minecraft Bedrock", "logs"));

        delete process.env.APPDATA;
        assert.equal(defaultLogsDir(), undefined);
    } finally {
        if (before === undefined) delete process.env.APPDATA; else process.env.APPDATA = before;
    }
});

test("the launch time is read from the log's file name, and a name that does not say gives nothing", () => {
    const { check, done } = checks();

    const at = launchTime("ContentLog2026-10-11_18-36-29_1.txt");
    check("a game log's name gives its launch", at instanceof Date && at.getFullYear() === 2026 && at.getMonth() === 9 && at.getDate() === 11 && at.getHours() === 18 && at.getMinutes() === 36 && at.getSeconds() === 29, String(at));
    check("a name of another shape gives nothing", launchTime("friend.txt") === undefined && launchTime("ContentLog.txt") === undefined);
    done();
});

test("telemetry lines are found among the game's other lines and given the right wall-clock time", () => {
    const { check, done } = checks();

    const log = [
        entry("18:36:50", "verbose", "Plugin Discovered [BountySys] PackId [b8f707c3-9ce5-470d-8cad-081de86c10ac_0.2.5]"),
        entry("18:36:52", "warning", "[robbery-probe] RESULT bench chest at 26,65,390 = ok"),
        tele("18:36:53", ev("boot", { n: 1 })),
        entry("18:37:10", "warning", "[Watchdog] Slowdown from 'BountySys' (25ms average)"),
        tele("18:40:00", ev("round.end", { n: 2, t: 4800, reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 })),
        entry("18:41:00", "error", "[preflight] 1 problem(s) found before load: Missing structure")
    ].join("");

    const parsed = parseLog(log, LAUNCH);

    check("both telemetry lines, no others", parsed.events.length === 2 && parsed.found === 2, JSON.stringify(parsed));
    check("dated by the launch's day and the line's time of day", parsed.events[0]?.at === "2026-10-11T18:36:53" && parsed.events[1]?.at === "2026-10-11T18:40:00", JSON.stringify(parsed.events.map((e) => e.at)));
    check("the event is kept whole", parsed.events[1]?.k === "round.end" && parsed.events[1].reason === "law_win" && parsed.events[1].coins === 640 && parsed.events[1].w === "a3f9c1" && parsed.events[1].n === 2, JSON.stringify(parsed.events[1]));
    check("nothing else was counted", parsed.skipped === 0 && parsed.damaged === 0 && parsed.unfinished === 0, JSON.stringify(parsed));

    const plain = parseLog(log.replaceAll(SEP, "\n"), LAUNCH);
    check("plain newlines read the same", JSON.stringify(plain) === JSON.stringify(parsed));
    done();
});

test("the cut last line of a log still being written is dropped and counted, a whole one without its newline is kept", () => {
    const { check, done } = checks();

    const whole = tele("10:00:00", ev("shop.open", { n: 1, id: "general", p: "7" }));
    const cut = '10:05:00[Scripting][warning]-[telemetry] {"v":1,"k":"shop.open","w":"a3f9c1","b":"x7q2","n":2,"t":5,"bv":"0.2.5","id":"gen';

    const withCut = parseLog(whole + cut, LAUNCH);
    check("the whole line is kept", withCut.events.length === 1 && withCut.events[0].n === 1, JSON.stringify(withCut.events));
    check("the cut one is counted as unfinished, not as damaged", withCut.unfinished === 1 && withCut.damaged === 0 && withCut.found === 2, JSON.stringify(withCut));

    const last = `10:06:00[Scripting][warning]-[telemetry] ${JSON.stringify(ev("shop.open", { n: 3, id: "general", p: "8" }))}`;
    const noNewline = parseLog(whole + last, LAUNCH);
    check("a last line that is complete is kept even without a newline", noNewline.events.length === 2 && noNewline.unfinished === 0, JSON.stringify(noNewline));

    const middle = parseLog(`10:05:00[Scripting][warning]-[telemetry] {"v":1,"k":"sh${SEP}${whole}`, LAUNCH);
    check("a cut line in the middle is damaged, not unfinished", middle.damaged === 1 && middle.unfinished === 0 && middle.events.length === 1, JSON.stringify(middle));
    done();
});

test("a log that runs past midnight is dated onto the next day, by any line's clock and not only the telemetry lines', and a second of jitter is not a new day", () => {
    const { check, done } = checks();

    const late = new Date(2026, 9, 11, 23, 50, 0);
    const log = [
        tele("23:55:00", ev("shop.open", { n: 1, id: "g", p: "7" })),
        entry("23:59:59", "verbose", "something else"),
        tele("00:05:00", ev("shop.open", { n: 2, id: "g", p: "7" })),
        entry("00:04:59", "verbose", "a line written a second out of order"),
        tele("00:10:00", ev("shop.open", { n: 3, id: "g", p: "7" })),
        entry("23:30:00", "verbose", "the next evening"),
        tele("00:20:00", ev("shop.open", { n: 4, id: "g", p: "7" }))
    ].join("");

    const ats = parseLog(log, late).events.map((e) => e.at);

    check("before midnight, after it, after the jitter, and a second midnight", JSON.stringify(ats) === JSON.stringify(["2026-10-11T23:55:00", "2026-10-12T00:05:00", "2026-10-12T00:10:00", "2026-10-13T00:20:00"]), JSON.stringify(ats));

    const justBefore = parseLog(tele("00:00:05", ev("boot", { n: 1 })), new Date(2026, 9, 11, 23, 59, 50));
    check("a game launched just before midnight whose first line is just after it", justBefore.events[0]?.at === "2026-10-12T00:00:05", JSON.stringify(justBefore.events));
    done();
});

test("lines that are not usable events are counted and skipped, never fatal; another source's lines are not telemetry at all", () => {
    const { check, done } = checks();

    const log = [
        tele("10:00:00", ev("boot", { n: 1 })),
        tele("10:00:01", { ...ev("boot", { n: 2 }), v: 2 }),
        entry("10:00:02", "warning", "[telemetry] {not json"),
        entry("10:00:03", "warning", "[telemetry] "),
        entry("10:00:04", "warning", "[telemetry] hello there"),
        entry("10:00:05", "warning", "[telemetry] null"),
        entry("10:00:06", "warning", '[telemetry] {"v":1}'),
        entry("10:00:07", "warning", "[telemetry-problem] a line could not be written: the console broke")
    ].join("");

    const parsed = parseLog(log, LAUNCH);

    check("one usable event", parsed.events.length === 1 && parsed.events[0].n === 1, JSON.stringify(parsed.events));
    check("a line of another version is skipped", parsed.skipped === 1, String(parsed.skipped));
    check("not JSON, empty, garbage, null and a stub without world, boot or number are damaged", parsed.damaged === 5, String(parsed.damaged));
    check("the problem line is another source: not counted at all", parsed.found === 7, String(parsed.found));
    check("everything found is accounted for", parsed.found === parsed.events.length + parsed.skipped + parsed.damaged + parsed.unfinished);
    done();
});

test("ingest keeps new events in the archive, adds nothing the second time or for a copy under another name, and leaves the logs folder as it was", () => {
    const { check, done } = checks();
    const { logs, archive } = folders();

    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), [
        tele("18:36:53", ev("boot", { n: 1 })),
        tele("18:40:00", ev("round.end", { n: 2, reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 })),
        tele("18:45:00", ev("shop.open", { n: 3, id: "general", p: "7" }))
    ].join(""));

    const first = ingest({ logsDir: logs, archive });
    check("one file, three events, all new", first.files === 1 && first.found === 3 && first.added === 3 && first.duplicates === 0, JSON.stringify(first));

    const stored = readArchive(archive);
    check("they are in the archive, dated", stored.events.length === 3 && stored.events[0].at === "2026-10-11T18:36:53" && stored.events[1].coins === 640, JSON.stringify(stored.events[0]));

    const again = ingest({ logsDir: logs, archive });
    check("the same log again adds nothing", again.added === 0 && again.duplicates === 3 && readArchive(archive).events.length === 3, JSON.stringify(again));

    copyFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), path.join(logs, "friend.txt"));
    const copied = ingest({ logsDir: logs, archive });
    check("a copy under another name adds nothing", copied.files === 2 && copied.added === 0 && copied.duplicates === 6, JSON.stringify(copied));

    writeFileSync(path.join(logs, "ContentLog2026-10-12_09-00-00_1.txt"), [
        tele("09:00:05", ev("boot", { n: 1, b: "k2m9" })),
        tele("09:10:00", ev("shop.open", { n: 2, b: "k2m9", id: "general", p: "8" })),
        tele("09:10:01", ev("shop.open", { n: 2, b: "k2m9", id: "general", p: "8" }))
    ].join(""));

    const snapshot = () => readdirSync(logs).map((name) => `${name}:${statSync(path.join(logs, name)).size}:${statSync(path.join(logs, name)).mtimeMs}`).join("|");
    const before = snapshot();
    const second = ingest({ logsDir: logs, archive });

    check("a later boot adds its two events, and a line repeated inside one log counts once", second.added === 2 && readArchive(archive).events.length === 5, JSON.stringify(second));
    check("the logs folder is exactly as it was: no file made, none changed", snapshot() === before);
    check("the counts add up", second.found === second.added + second.duplicates + second.skipped + second.damaged + second.unfinished, JSON.stringify(second));
    done();
});

test("events of different worlds are different events, even with the same boot id and number", () => {
    const { logs, archive } = folders();
    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), [
        tele("18:36:53", ev("boot", { n: 1 })),
        tele("18:36:54", ev("boot", { n: 1, w: "zzzzzz" }))
    ].join(""));

    assert.equal(ingest({ logsDir: logs, archive }).added, 2);
});

test("an archive inside the logs folder is refused before anything is written", () => {
    const { logs } = folders();
    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), tele("18:36:53", ev("boot", { n: 1 })));

    assert.throws(() => ingest({ logsDir: logs, archive: path.join(logs, "events.jsonl") }), /inside the logs folder/);
    assert.equal(existsSync(path.join(logs, "events.jsonl")), false);
});

test("a log another process holds open is read all the same", () => {
    const { logs, archive } = folders();
    const file = path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt");
    writeFileSync(file, tele("18:36:53", ev("boot", { n: 1 })));

    const handle = openSync(file, "a");          // stands in for the game, which keeps its current log open
    try {
        const counts = ingest({ logsDir: logs, archive });
        assert.equal(counts.added, 1);
        assert.equal(counts.unreadable, 0);
    } finally {
        closeSync(handle);
    }
});

test("a file that cannot be read is counted and the others are still read", () => {
    const { logs, archive } = folders();
    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), tele("18:36:53", ev("boot", { n: 1 })));
    mkdirSync(path.join(logs, "folder.txt"));         // reading a folder as a file fails

    const counts = ingest({ logsDir: logs, archive });

    assert.equal(counts.unreadable, 1);
    assert.equal(counts.added, 1);
});

test("a half-written last line in the archive (a crash mid-append) is counted, and the next events start on a line of their own", () => {
    const { check, done } = checks();
    const { logs, archive } = folders();

    mkdirSync(path.dirname(archive), { recursive: true });
    const good = JSON.stringify({ at: "2026-10-11T18:36:53", ...ev("boot", { n: 1 }) });
    writeFileSync(archive, `${good}\n{"at":"2026-10-11T18:3`);
    writeFileSync(path.join(logs, "ContentLog2026-10-12_09-00-00_1.txt"), tele("09:00:05", ev("boot", { n: 1, b: "k2m9" })));

    const counts = ingest({ logsDir: logs, archive });
    const stored = readArchive(archive);

    check("the new event was added", counts.added === 1, JSON.stringify(counts));
    check("the good one and the new one read back; the stub is counted", stored.events.length === 2 && stored.damaged === 1, JSON.stringify(stored));
    check("the new event is intact", stored.events[1]?.b === "k2m9" && stored.events[1].at === "2026-10-12T09:00:05", JSON.stringify(stored.events[1]));
    done();
});

test("a logs folder with no telemetry in it finishes quietly and makes no archive", () => {
    const { check, done } = checks();
    const { logs, archive } = folders();
    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), entry("18:36:50", "verbose", "Plugin Discovered [BountySys]") + entry("18:36:52", "warning", "[robbery-probe] RESULT ok"));

    const counts = ingest({ logsDir: logs, archive });

    check("one file read, nothing found", counts.files === 1 && counts.found === 0 && counts.added === 0 && counts.unreadable === 0, JSON.stringify(counts));
    check("no archive was made for nothing", !existsSync(archive));
    check("reading a missing archive gives an empty one", readArchive(archive).events.length === 0);
    done();
});

test("a logs folder that is not there is an error that says so", () => {
    const { dir, archive } = folders();

    assert.throws(() => ingest({ logsDir: path.join(dir, "nope"), archive }), /logs folder/);
});

test("a log whose name does not carry its launch is dated by the day it was last changed", () => {
    const { logs, archive } = folders();
    const file = path.join(logs, "friend.txt");
    writeFileSync(file, tele("20:30:00", ev("boot", { n: 1 })));
    const changed = new Date(2026, 8, 20, 21, 0, 0);
    utimesSync(file, changed, changed);

    ingest({ logsDir: logs, archive });

    assert.equal(readArchive(archive).events[0].at, "2026-09-20T20:30:00");
});
