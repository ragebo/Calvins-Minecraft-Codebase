// The command: reads the game's content logs, keeps the telemetry events in an archive, and writes a report and a CSV per kind of event
// (tasks/plan.md has the reasoning). Run it with `node tools/telemetry/cli.mjs`, or double-click tools/telemetry.cmd. It only ever reads the
// logs; everything it writes goes to the output folder.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./aggregate.mjs";
import { defaultLogsDir, ingest, readArchive } from "./ingest.mjs";
import { renderReport, toCsv } from "./report.mjs";

/** Where the archive, the report and the CSV files go unless --out says otherwise: beside the tools folder, which git leaves alone. */
export const DEFAULT_OUT = path.resolve(import.meta.dirname, "..", "..", "telemetry-data");

const USAGE = `Usage: node tools/telemetry/cli.mjs [options]

Reads the game's content logs, keeps every telemetry event in an archive, and writes a report.

  --logs <folder>   where the game's logs are (default: %APPDATA%\\Minecraft Bedrock\\logs)
  --out <folder>    where the archive, the report and the CSV files go (default: telemetry-data, beside the tools folder)
  --world <id>      show the rounds of one world only (the report lists the world ids)
  --open            open the report when it is done
  --no-open         do not (the last of --open and --no-open wins)
  --help            this text`;

const two = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A file name made of safe characters only: an event kind comes out of a log, and must not be able to name a path. */
const safeName = (kind) => kind.replace(/[^A-Za-z0-9._-]/g, "_");

function parseArgs(argv) {

    const args = { logs: undefined, out: undefined, world: undefined, open: false, help: false };

    for (let i = 0; i < argv.length; i++) {

        const arg = argv[i];

        if (arg === "--open") args.open = true;
        else if (arg === "--no-open") args.open = false;
        else if (arg === "--help" || arg === "-h") args.help = true;
        else if (arg === "--logs" || arg === "--out" || arg === "--world") {

            const value = argv[++i];

            if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };

            args[arg.slice(2)] = value;
        } else {
            return { error: `Unknown option ${arg}` };
        }
    }

    return args;
}

function openFile(file) {

    const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];

    // A missing opener must not crash the run that already wrote the report.
    spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

/**
 * Runs the command and returns its exit code: 0 for success, 1 when the logs could not be read, 2 for a command line it does not understand.
 * `io` is for tests: where its words go, how a report is opened, and what time it is.
 */
export function main(argv, io = {}) {

    const say = io.log ?? console.log;
    const complain = io.error ?? console.error;
    const open = io.open ?? openFile;
    const now = io.now ?? (() => new Date());

    const args = parseArgs(argv);

    if (args.error) {
        complain(`${args.error}\n\n${USAGE}`);
        return 2;
    }

    if (args.help) {
        say(USAGE);
        return 0;
    }

    const logsDir = args.logs ?? defaultLogsDir();

    if (logsDir === undefined) {
        complain("There is no logs folder to look in: say where the game's logs are with --logs <folder>.");
        return 1;
    }

    const out = path.resolve(args.out ?? DEFAULT_OUT);
    const archivePath = path.join(out, "events.jsonl");
    const reportPath = path.join(out, "report.html");

    let counts;

    try {
        counts = ingest({ logsDir, archive: archivePath });
    } catch (err) {
        complain(err instanceof Error ? err.message : String(err));
        return 1;
    }

    const archive = readArchive(archivePath);
    const figures = summarize(archive.events, { world: args.world, ingest: counts });

    mkdirSync(path.join(out, "csv"), { recursive: true });
    writeFileSync(reportPath, renderReport(figures, { generated: stamp(now()) }));

    for (const [kind, text] of toCsv(archive.events)) writeFileSync(path.join(out, "csv", `${safeName(kind)}.csv`), text);

    say(`Read ${plural(counts.files, "log file")}: ${plural(counts.found, "telemetry line")}, ${counts.added} new, ${counts.duplicates} already known.`);
    say(`Archive: ${archivePath} (${plural(archive.events.length, "event")})`);
    say(`Report:  ${reportPath}`);

    if (counts.unfinished > 0) say(`${plural(counts.unfinished, "line")} ${counts.unfinished === 1 ? "was" : "were"} still being written (the game is running); run it again later to get ${counts.unfinished === 1 ? "it" : "them"}.`);
    if (counts.skipped + counts.damaged > 0) say(`${plural(counts.skipped + counts.damaged, "line")} skipped: another format, or damaged.`);
    if (counts.unreadable > 0) say(`${plural(counts.unreadable, "file")} could not be read.`);
    if (archive.damaged > 0) say(`${plural(archive.damaged, "line")} of the archive ${archive.damaged === 1 ? "is" : "are"} not an event (a crash while saving?) and ${archive.damaged === 1 ? "is" : "are"} left alone.`);

    if (archive.events.length === 0) {
        say("No telemetry in the logs yet. The game writes it when a world loads and a round ends, so it needs a build that has telemetry in it. The log file itself must be on (Settings, Creator, Enable Content Log File).");
    } else if (args.world !== undefined && !figures.data.worlds.some((w) => w.w === args.world)) {
        say(`No events for world ${args.world}. Worlds in the data: ${figures.data.worlds.map((w) => w.w).join(", ")}.`);
    }

    if (args.open) open(reportPath);

    return 0;
}

// Run from the command line (not when a test imports it).
const here = path.resolve(fileURLToPath(import.meta.url));
const started = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);

if (process.platform === "win32" ? here.toLowerCase() === started.toLowerCase() : here === started) process.exitCode = main(process.argv.slice(2));
