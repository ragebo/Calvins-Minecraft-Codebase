import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checks, fake, load, world } from "./helpers.mjs";
import { ingest, readArchive } from "../../tools/telemetry/ingest.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";
import { renderReport } from "../../tools/telemetry/report.mjs";

// Where the two halves meet. The whole game (compiled, under the fake game API) plays a round and writes its telemetry to the console. This
// puts those exact lines into a content log the way the real game does (its time of day and level in front, its odd entry separator after),
// reads the log with the tool, and shows the round in the report. The game's writer is TypeScript and the tool's reader is plain JavaScript
// with a parser of its own, so if the line one writes and the line the other reads ever drift apart, this is the test that fails.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

await load("main.js");
const round = await load("core/round.js");
const T = await load("logic/telemetry.js");

const scratch = mkdtempSync(path.join(import.meta.dirname, "..", ".test-build", "contract-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const SEP = "\r\n\r\r\n";
const entry = (time, level, text) => `${time}[Scripting][${level}]-${text}${SEP}`;

// One law player kills one outlaw in a round that lasts 60 ticks (3 seconds).
const law = fake.makePlayer("L", { tags: ["law"] });
const outlaw = fake.makePlayer("O", { tags: ["outlaw"] });

fake.advance(40);                                  // the boot line, and the roles settle
round.startRound();
round.beginActive();
fake.advance(40);
world.afterEvents.entityDie.emit({ deadEntity: outlaw, damageSource: { damagingEntity: law } });
fake.advance(20);
round.endRound("law_win");

/** What the game wrote that is telemetry, in the order it wrote it. */
const written = lines.filter((text) => text.startsWith("[telemetry] {"));

/** The game's lines inside a content log with other lines around them, read by the tool. */
function readByTool() {
    const dir = path.join(scratch, "case");
    const logs = path.join(dir, "logs");
    const archive = path.join(dir, "out", "events.jsonl");

    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, "ContentLog2026-10-11_18-36-29_1.txt"), [
        entry("18:36:50", "verbose", "Plugin Discovered [BountySys] PackId [b8f707c3-9ce5-470d-8cad-081de86c10ac_0.2.5]"),
        ...written.map((text, i) => entry(`18:37:${String(10 + i).padStart(2, "0")}`, "warning", text)),
        entry("18:40:00", "warning", "[Watchdog] Slowdown from 'BountySys' (25ms average)")
    ].join(""));

    const counts = ingest({ logsDir: logs, archive });

    return { counts, events: readArchive(archive).events };
}

test("every telemetry line the game wrote is read by the tool: none skipped, none damaged", () => {
    const { check, done } = checks();

    const { counts, events } = readByTool();

    check("the game wrote a boot line and a round.end line", written.length >= 2 && written.some((l) => l.includes("\"k\":\"boot\"")) && written.some((l) => l.includes("\"k\":\"round.end\"")), written.join("\n"));
    check("the tool found as many as the game wrote, and took them all", counts.found === written.length && counts.added === written.length && counts.skipped === 0 && counts.damaged === 0 && counts.unfinished === 0, JSON.stringify(counts));
    check("each kind the game wrote is one the contract names", events.every((e) => T.EVENT_KINDS.includes(e.k)), events.map((e) => e.k).join());
    check("each is stamped with a world, a boot, a number and the build", events.every((e) => e.w.length === 6 && e.b.length === 4 && Number.isInteger(e.n) && typeof e.bv === "string" && e.at.startsWith("2026-10-11T18:37:")), JSON.stringify(events[0]));
    done();
});

test("the round the game played is the round the report shows", () => {
    const { check, done } = checks();

    const { events } = readByTool();
    const figures = summarize(events);
    const r = figures.rounds;
    const text = renderReport(figures, { generated: "2026-10-12 21:00" }).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    check("one round, won by the law side", r.count === 1 && r.byReason.law_win === 1, JSON.stringify(r.byReason));
    check("60 ticks long, one kill and one death, by the law side", r.length.median === 60 && r.kills.total === 1 && r.deaths.total === 1 && r.lawKills === 1 && r.outlawKills === 0, JSON.stringify(r));
    check("the page says so in words", text.includes("Law won 1") && text.includes("Rounds 1") && text.includes("Median length 0:03") && text.includes("Law win rate 100%"), text.slice(0, 500));
    check("and shows the game's world and build", figures.data.worlds.length === 1 && figures.data.builds.length === 1 && figures.data.boots === 1, JSON.stringify(figures.data));
    done();
});
