// Reads the game's content logs and keeps the telemetry lines in an archive of its own (tasks/plan.md has the reasoning). Plain JavaScript, no
// dependencies, and read-only on the logs: the game is usually still running and holding its current log open.
//
// A log line looks like `18:36:51[Scripting][warning]-[telemetry] {json}`: a time of day and no date, and the game ends every entry with
// "\r\n\r\r\n" (a stray extra carriage return). The date comes from the log's file name, which holds the launch. The writer of the lines is
// rae/src/logic/telemetry.ts; this file reads them with a small parser of its own because it cannot import TypeScript, and the tests keep the
// two in step.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** The version of the line this reads. Lines of another version are counted and skipped, never guessed at. */
const SCHEMA_VERSION = 1;

const HALF_DAY_SECONDS = 12 * 60 * 60;
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})\[/;
const TAGGED = /^\d{2}:\d{2}:\d{2}\[Scripting\]\[[^\]]*\]-\[telemetry\] ?(.*)$/;
const LAUNCH_IN_NAME = /^ContentLog(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

const two = (n) => String(n).padStart(2, "0");

/** Local time as `2026-10-11T18:36:53`: no zone, because the log has none, and it sorts as text. */
const stamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

const secondsOfDay = (d) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

/** One event's place in the archive: a world, one load of its scripts, and the line's number in that load. */
const keyOf = (event) => `${event.w}|${event.b}|${event.n}`;

/** Where the game keeps its content logs, or undefined where there is no APPDATA to look under. */
export function defaultLogsDir() {
    return process.env.APPDATA ? path.join(process.env.APPDATA, "Minecraft Bedrock", "logs") : undefined;
}

/** The moment a game launched, read from its log's name (`ContentLog2026-10-11_18-36-29_1.txt`), or undefined for any other name. */
export function launchTime(fileName) {

    const m = LAUNCH_IN_NAME.exec(fileName);

    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : undefined;
}

/** What one telemetry line's text after the tag is: an event, "skipped" (another version), "damaged", or "unparsable" (not JSON at all). */
function readEvent(payload) {

    let value;

    try {
        value = JSON.parse(payload);
    } catch {
        return "unparsable";
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) return "damaged";
    if (value.v !== SCHEMA_VERSION) return typeof value.v === "number" ? "skipped" : "damaged";
    if (typeof value.k !== "string" || typeof value.w !== "string" || typeof value.b !== "string" || !Number.isFinite(value.n)) return "damaged";

    return value;
}

/**
 * The telemetry events in one log's text, each with `at`, the moment it was written. `launch` is the day and time the game started.
 * Every line, not only the telemetry ones, carries a clock, so a day is counted whenever the clock jumps back by most of a day.
 *
 * shortcut: a gap of over 12 hours with no log line at all is not seen as a new day; a running game logs far more often than that.
 * Upgrade if the logs of an idle server ever matter.
 */
export function parseLog(text, launch) {

    const result = { events: [], found: 0, skipped: 0, damaged: 0, unfinished: 0 };
    const lines = text.split(/\r*\n/);

    // A log still being written ends in the middle of an entry; a finished one ends in a newline.
    const open = text.length > 0 && !text.endsWith("\n") ? lines.length - 1 : -1;

    let day = 0;
    let previous = secondsOfDay(launch);

    lines.forEach((line, index) => {

        const clock = CLOCK.exec(line);

        if (!clock) return;

        const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);

        // Jumping back a little is two threads writing a second out of order; jumping back most of a day is midnight.
        if (previous - seconds > HALF_DAY_SECONDS) day++;
        previous = seconds;

        const tagged = TAGGED.exec(line);

        if (!tagged) return;

        result.found++;

        const read = readEvent(tagged[1]);

        if (read === "skipped") result.skipped++;
        else if (read === "damaged") result.damaged++;
        else if (read === "unparsable") result[index === open ? "unfinished" : "damaged"]++;
        else result.events.push({ at: stamp(new Date(launch.getFullYear(), launch.getMonth(), launch.getDate() + day, Number(clock[1]), Number(clock[2]), Number(clock[3]))), ...read });
    });

    return result;
}

/** The events in an archive's text, and how many of its lines were not events (a line cut by a crash mid-write). */
function parseArchive(text) {

    const result = { events: [], damaged: 0 };

    for (const line of text.split("\n")) {

        if (line.trim() === "") continue;

        try {
            const value = JSON.parse(line);
            const whole = value !== null && typeof value === "object" && typeof value.at === "string" && typeof value.k === "string" && typeof value.w === "string" && typeof value.b === "string" && Number.isFinite(value.n);

            if (whole) result.events.push(value);
            else result.damaged++;
        } catch {
            result.damaged++;
        }
    }

    return result;
}

/** Everything in an archive file, oldest first. A file that is not there is an empty archive. */
export function readArchive(file) {
    return parseArchive(existsSync(file) ? readFileSync(file, "utf8") : "");
}

function isInside(child, parent) {

    const relative = path.relative(parent, child);

    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Reads every `.txt` in the logs folder and adds the telemetry events it has not seen before to the archive (one JSON object per line,
 * appended). Returns what it found: files looked at, telemetry lines found, and what became of them (added, duplicates, skipped,
 * damaged, unfinished) plus the files that could not be read. The logs are only ever read, and an archive placed inside them is refused.
 *
 * shortcut: a log whose name does not carry its launch is dated by the day it was last changed, which is wrong only for a session that
 * ran past midnight. Upgrade if collected logs from other machines get renamed.
 */
export function ingest({ logsDir, archive }) {

    const logs = path.resolve(logsDir);
    const out = path.resolve(archive);

    if (isInside(out, logs)) throw new Error(`the archive ${out} is inside the logs folder ${logs}; the logs are only ever read`);

    let names;

    try {
        names = readdirSync(logs);
    } catch (err) {
        throw new Error(`the logs folder ${logs} could not be read (${err.code ?? err.message}); pass the right one with --logs <folder>`);
    }

    const before = existsSync(out) ? readFileSync(out, "utf8") : "";
    const known = new Set(parseArchive(before).events.map(keyOf));
    const counts = { files: 0, found: 0, added: 0, duplicates: 0, skipped: 0, damaged: 0, unfinished: 0, unreadable: 0 };
    const fresh = [];

    for (const name of names.filter((n) => /\.txt$/i.test(n)).sort()) {

        counts.files++;

        let text;
        let launch;

        try {
            text = readFileSync(path.join(logs, name), "utf8");
            launch = launchTime(name) ?? statSync(path.join(logs, name)).mtime;
        } catch {
            counts.unreadable++;
            continue;
        }

        // Most logs hold none: skip the line-by-line pass for them.
        if (!text.includes("[telemetry]")) continue;

        const parsed = parseLog(text, launch);

        counts.found += parsed.found;
        counts.skipped += parsed.skipped;
        counts.damaged += parsed.damaged;
        counts.unfinished += parsed.unfinished;

        for (const event of parsed.events) {

            const key = keyOf(event);

            if (known.has(key)) {
                counts.duplicates++;
                continue;
            }

            known.add(key);
            fresh.push(event);
            counts.added++;
        }
    }

    if (fresh.length > 0) {
        mkdirSync(path.dirname(out), { recursive: true });

        // An archive cut off by a crash ends mid-line: the next events start on a line of their own.
        const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";

        appendFileSync(out, `${lead}${fresh.map((event) => JSON.stringify(event)).join("\n")}\n`);
    }

    return counts;
}
