import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checks, fake, fakeUi, load } from "./helpers.mjs";
import { SITE, bank, buildSite } from "./robbery-fixtures.mjs";
import { ingest, readArchive } from "../../tools/telemetry/ingest.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";
import { renderReport } from "../../tools/telemetry/report.mjs";

// The robbery half of the contract with the tool (telemetry-contract.test.mjs has the rounds). The whole game plays the bank: two robbers in its
// area, one of them picks the keypad, opens the lockbox and wins. Its exact console lines are put in a content log the way the real game does,
// read with the tool, and the report must show that run with the figures the game itself would give. If the lines the TypeScript writes and the
// JavaScript reader's idea of them ever drift apart, this is the test that fails.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

await load("main.js");
const S = await load("core/robberystore.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const T = await load("logic/telemetry.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

const originalRandom = Math.random;
Math.random = () => 0.4;                                  // the hidden pick target is always 40
process.on("exit", () => { Math.random = originalRandom; });

const scratch = mkdtempSync(path.join(import.meta.dirname, "..", ".test-build", "contract-robbery-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const SEP = "\r\n\r\r\n";
const entry = (time, level, text) => `${time}[Scripting][${level}]-${text}${SEP}`;

const guess = (value) => fakeUi.uiFake.responses.push({ canceled: false, formValues: [value] });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

// A fresh world with the bank built and saved, and two outlaws standing in its area.
fake.reset();
resetAllSystems();
fake.advance(1);
S.forgetLoaded();
for (const entryToClear of S.dirtyEntries()) S.clearDirty(entryToClear);
R.pickGuessCooldownTicks = 0;
fake.addObjective("coins");
fake.addObjective("bounty");
fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);
buildSite();
assert.equal(S.saveRobbery(bank("bank").r).ok, true);

const outlaw = (name, coins) => {
    const player = fake.makePlayer(name, { location: { x: 100, y: 65, z: 170 } });
    state.update(player, { role: "outlaw" });
    fake.setScore("coins", player, coins);
    return player;
};

const ada = outlaw("Ada", 100);
outlaw("Bob", 0);

const ref = (pos) => S.boundAt("overworld", pos[0], pos[1], pos[2]);

guess(40); guess(40);
Run.touch(ada, ref(SITE.keypad));
await settle();
fake.advance(30);
guess(40); guess(40);
Run.touch(ada, ref(SITE.box));
await settle();
fake.advance(70);                                         // past the win's delay

/** What the game wrote that is telemetry, in the order it wrote it. */
const written = lines.filter((text) => text.startsWith("[telemetry] {"));

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

test("every robbery line the game wrote is read by the tool: none skipped, none damaged, all of them kinds the contract names", () => {
    const { check, done } = checks();

    const { counts, events } = readByTool();
    const kinds = new Set(events.map((e) => e.k));

    check("the game wrote a start, elements, picks, payouts and an end", ["robbery.start", "robbery.element", "robbery.pick", "robbery.payout", "robbery.end"].every((k) => written.some((l) => l.includes(`"k":"${k}"`))), written.map((l) => l.slice(12, 60)).join("\n"));
    check("the tool took every line", counts.found === written.length && counts.added === written.length && counts.skipped === 0 && counts.damaged === 0 && counts.unfinished === 0, JSON.stringify(counts));
    check("each kind is one the contract names", [...kinds].every((k) => T.EVENT_KINDS.includes(k)), [...kinds].join());
    done();
});

test("the run the game played is the run the report shows", () => {
    const { check, done } = checks();

    const { events } = readByTool();
    const figures = summarize(events);
    const b = figures.robberies.list[0];
    const text = renderReport(figures, { generated: "2026-10-12 21:00" }).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    check("one robbery, one run, won, with all three elements done by one person", figures.robberies.list.length === 1 && b.id === "bank" && b.runs === 1 && b.byResult.win === 1 && b.elementsDone.average === 3 && b.elementsDone.of === 3 && b.latest[0].people === 1, JSON.stringify(b));
    check("paid: the lockbox's 250 bounty to the two in the area, and the win's 100 coins to both", b.bounty.total === 500 && b.coins.total === 200, JSON.stringify([b.coins, b.bounty]));
    check("every element is named and was done in the one run, the lockbox 30 ticks in", ["Keypad", "Vault door", "Lockbox"].every((name) => b.elements.some((e) => e.name === name && e.completed === 1)) && b.elements.find((e) => e.name === "Lockbox").medianAfter === 30, JSON.stringify(b.elements));
    check("the page says so in words", text.includes("Robbery: bank") && text.includes("Win rate 100% 1 of 1 decided") && text.includes("Paid per run 200 coins 500 bounty") && text.includes("Keypad (switch) 1 100%") && text.includes("Lockbox (chest) 1 100% 0:02"), text.slice(0, 900));
    done();
});
