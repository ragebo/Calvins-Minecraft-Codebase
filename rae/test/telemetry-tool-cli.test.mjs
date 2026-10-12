import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checks } from "./helpers.mjs";
import { DEFAULT_OUT, main } from "../../tools/telemetry/cli.mjs";

// tools/telemetry/cli.mjs: reads the logs, keeps the archive, writes the report and the CSV files, and says what it did. Its output goes to a
// scratch folder; `run` keeps what it printed and records whether it would have opened the report, so nothing opens a browser from a test.

const SEP = "\r\n\r\r\n";
const entry = (time, level, text) => `${time}[Scripting][${level}]-${text}${SEP}`;
const tele = (time, event) => entry(time, "warning", `[telemetry] ${JSON.stringify(event)}`);
const ev = (k, fields = {}) => ({ v: 1, k, w: "a3f9c1", b: "x7q2", n: 1, t: 100, bv: "0.2.5", ...fields });

const scratch = mkdtempSync(path.join(import.meta.dirname, "..", ".test-build", "cli-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/** A logs folder holding one game's log: a boot and two rounds. `out` is where the tool should write, not made yet. */
function folders(extra = "") {
    const dir = path.join(scratch, `case${++counter}`);
    const logs = path.join(dir, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), [
        tele("18:36:53", ev("boot", { n: 1 })),
        tele("18:40:00", ev("round.end", { n: 2, reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 })),
        tele("18:50:00", ev("round.end", { n: 3, reason: "outlaw_win", dur: 2400, kills: 2, deaths: 2, lawKills: 0, outlawKills: 2, coins: 90 }))
    ].join("") + extra);
    return { dir, logs, out: path.join(dir, "out") };
}

/**
 * Runs the command with the given arguments; returns the exit code, what it printed, and the files it would have opened. A run that was given no
 * --out gets one in the scratch folder, so that no test can ever write into the real output folder, even if the command goes wrong.
 */
function run(args) {
    const said = [];
    const errors = [];
    const opened = [];
    const safe = args.includes("--out") ? args : [...args, "--out", path.join(scratch, "unused-out")];
    const code = main(safe, { log: (text) => said.push(text), error: (text) => errors.push(text), open: (file) => opened.push(file), now: () => new Date(2026, 9, 12, 21, 0, 0) });

    return { code, said: said.join("\n"), errors: errors.join("\n"), opened };
}

test("a run reads the logs, keeps the archive, writes the report and a CSV per kind, and says what it did", () => {
    const { check, done } = checks();
    const { logs, out } = folders();

    const r = run(["--logs", logs, "--out", out]);

    check("it worked", r.code === 0, r.errors);
    check("the archive, the report and a CSV per kind are in the output folder", existsSync(path.join(out, "events.jsonl")) && existsSync(path.join(out, "report.html")) && existsSync(path.join(out, "csv", "round.end.csv")) && existsSync(path.join(out, "csv", "boot.csv")), readdirSync(out).join());
    check("the report was made at the time it was run and from the three events", readFileSync(path.join(out, "report.html"), "utf8").includes("Made 2026-10-12 21:00 from 3 events"));
    check("it says what it read", r.said.includes("Read 1 log file: 3 telemetry lines, 3 new, 0 already known."), r.said);
    check("and where the archive and the report are", r.said.includes(`Archive: ${path.join(out, "events.jsonl")} (3 events)`) && r.said.includes(`Report:  ${path.join(out, "report.html")}`), r.said);
    check("a CSV holds its rows", readFileSync(path.join(out, "csv", "round.end.csv"), "utf8").split("\r\n").length === 4);
    done();
});

test("a second run adds nothing and still writes the report", () => {
    const { check, done } = checks();
    const { logs, out } = folders();

    run(["--logs", logs, "--out", out]);
    const again = run(["--logs", logs, "--out", out]);

    check("nothing new", again.said.includes("3 telemetry lines, 0 new, 3 already known."), again.said);
    check("the archive still has three events", again.said.includes("(3 events)"), again.said);
    check("and the report is there", existsSync(path.join(out, "report.html")));
    done();
});

test("--world shows one world's rounds, and a world with no events says so instead of failing", () => {
    const { check, done } = checks();
    const { logs, out } = folders();

    const one = run(["--logs", logs, "--out", out, "--world", "a3f9c1"]);
    check("the report says which world", one.code === 0 && readFileSync(path.join(out, "report.html"), "utf8").includes("Showing world a3f9c1 only."));

    const none = run(["--logs", logs, "--out", out, "--world", "nope"]);
    check("a world that is not in the data: still a report, and the worlds there are named", none.code === 0 && none.said.includes("No events for world nope. Worlds in the data: a3f9c1."), none.said);
    check("whose rounds are empty", readFileSync(path.join(out, "report.html"), "utf8").includes("No finished rounds"));
    done();
});

test("--include-tests brings a builder's test runs of a robbery into the report, and without it they are left out and the report says so", () => {
    const { check, done } = checks();

    const robbery = (k, at, fields) => tele(at, ev(k, { id: "bank", r: 1, b: "t3st", ...fields }));
    const { logs, out } = folders([
        robbery("robbery.start", "19:00:00", { n: 1, test: true, p: "7", role: "outlaw", inside: 1 }),
        robbery("robbery.end", "19:05:00", { n: 2, result: "stopped", test: true, dur: 100, done: 0, of: 3, people: 0 })
    ].join(""));

    const without = run(["--logs", logs, "--out", out]);
    const html = () => readFileSync(path.join(out, "report.html"), "utf8");

    check("by default the test run is left out, and the report says how to see it", without.code === 0 && html().includes("1 test run is left out") && html().includes("--include-tests") && !html().includes("Robbery: bank"), html().slice(0, 300));

    const withTests = run(["--logs", logs, "--out", out, "--include-tests"]);

    check("with the flag it is in, and marked", withTests.code === 0 && html().includes("Robbery: bank") && html().includes("Test runs are included, and marked."), withTests.errors);
    done();
});

test("--open opens the report, --no-open undoes it, and by default nothing opens", () => {
    const { check, done } = checks();
    const { logs, out } = folders();
    const report = path.join(out, "report.html");

    check("by default nothing opens", run(["--logs", logs, "--out", out]).opened.length === 0);
    check("--open opens the report once", JSON.stringify(run(["--logs", logs, "--out", out, "--open"]).opened) === JSON.stringify([report]));
    check("the last of --open and --no-open wins", run(["--logs", logs, "--out", out, "--open", "--no-open"]).opened.length === 0 && run(["--logs", logs, "--out", out, "--no-open", "--open"]).opened.length === 1);
    done();
});

test("a logs folder that is not there is an error with exit code 1, and nothing is written", () => {
    const { check, done } = checks();
    const { dir, out } = folders();

    const r = run(["--logs", path.join(dir, "nope"), "--out", out]);

    check("exit code 1", r.code === 1, String(r.code));
    check("it says which folder, and how to give another", r.errors.includes("logs folder") && r.errors.includes("--logs"), r.errors);
    check("no output folder was made", !existsSync(out));
    done();
});

test("with no --logs and nowhere to look for the game's logs, it says so and exits with code 1", () => {
    const before = process.env.APPDATA;

    try {
        delete process.env.APPDATA;

        const r = run([]);

        assert.equal(r.code, 1);
        assert.ok(r.errors.includes("--logs"), r.errors);
    } finally {
        if (before === undefined) delete process.env.APPDATA; else process.env.APPDATA = before;
    }
});

test("a wrong command line is exit code 2 with the usage, and --help is exit code 0 with the usage", () => {
    const { check, done } = checks();

    const unknown = run(["--bogus"]);
    check("an unknown option", unknown.code === 2 && unknown.errors.includes("Unknown option --bogus") && unknown.errors.includes("Usage"), unknown.errors);

    const missing = run(["--logs"]);
    check("an option without its value", missing.code === 2 && missing.errors.includes("--logs needs a value"), missing.errors);

    const help = run(["--help"]);
    check("help", help.code === 0 && help.said.includes("Usage") && help.said.includes("--world") && help.said.includes("--logs") && help.said.includes("--out") && help.said.includes("--include-tests"), help.said);
    done();
});

test("an event kind that is a path cannot write outside the CSV folder", () => {
    const { check, done } = checks();
    const { dir, logs, out } = folders();

    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "events.jsonl"), `${JSON.stringify({ at: "2026-10-11T18:00:00", ...ev("../../evil", { n: 9 }) })}\n`);

    const r = run(["--logs", logs, "--out", out]);

    check("it ran", r.code === 0, r.errors);
    check("the file is named safely and is inside the CSV folder", readdirSync(path.join(out, "csv")).includes(".._.._evil.csv"), readdirSync(path.join(out, "csv")).join());
    check("nothing was made outside the output folder", readdirSync(dir).sort().join() === "logs,out" && !existsSync(path.join(dir, "evil.csv")));
    done();
});

test("it says what the numbers do not: a line still being written, nothing found yet", () => {
    const { check, done } = checks();

    const live = folders('10:05:00[Scripting][warning]-[telemetry] {"v":1,"k":"shop.open","w":"a3f9c1","b":"x7q2","n":4,"t":5,"bv":"0.2.5","id":"gen');
    const cut = run(["--logs", live.logs, "--out", live.out]);
    check("a cut line is explained", cut.said.includes("1 line was still being written") && cut.said.includes("run it again"), cut.said);

    const emptyDir = path.join(scratch, `case${++counter}`);
    mkdirSync(path.join(emptyDir, "logs"), { recursive: true });
    writeFileSync(path.join(emptyDir, "logs", "ContentLog2026-10-11_18-36-29_1.txt"), entry("18:36:50", "verbose", "Plugin Discovered [BountySys]"));
    const none = run(["--logs", path.join(emptyDir, "logs"), "--out", path.join(emptyDir, "out")]);
    check("nothing found is explained", none.code === 0 && none.said.includes("No telemetry in the logs yet"), none.said);
    done();
});

test("it also says when lines were skipped, a file could not be read, or the archive has a line that is not an event", () => {
    const { check, done } = checks();

    const odd = folders(`${entry("10:00:00", "warning", "[telemetry] {not json")}${tele("10:00:01", { ...ev("boot", { n: 9 }), v: 2 })}`);
    mkdirSync(path.join(odd.logs, "folder.txt"));                 // reading a folder as a file fails
    mkdirSync(odd.out, { recursive: true });
    writeFileSync(path.join(odd.out, "events.jsonl"), "{\"at\":\"2026-10-11T18:3");

    const r = run(["--logs", odd.logs, "--out", odd.out]);

    check("it still worked", r.code === 0, r.errors);
    check("two lines skipped: one damaged, one of another format", r.said.includes("2 lines skipped: another format, or damaged."), r.said);
    check("one file that could not be read", r.said.includes("1 file could not be read."), r.said);
    check("and the cut line in the archive, left alone", r.said.includes("1 line of the archive is not an event") && r.said.includes("is left alone"), r.said);
    done();
});

test("the output folder is next to the tools folder by default", () => {
    assert.equal(path.basename(DEFAULT_OUT), "telemetry-data");
    assert.ok(existsSync(path.join(path.dirname(DEFAULT_OUT), "tools", "telemetry", "cli.mjs")), `${DEFAULT_OUT} should sit beside tools/`);
});

test("double-clicking the launcher works from any folder (Windows)", { skip: process.platform !== "win32" }, () => {
    const { logs, out } = folders();
    const launcher = path.resolve(import.meta.dirname, "..", "..", "tools", "telemetry.cmd");

    // --no-open comes after the launcher's own --open, and the last one wins, so no browser opens from a test.
    const result = spawnSync("cmd.exe", ["/c", launcher, "--logs", logs, "--out", out, "--no-open"], { cwd: os.tmpdir(), encoding: "utf8" });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(path.join(out, "report.html")), `${result.stdout}\n${result.stderr}`);
});
