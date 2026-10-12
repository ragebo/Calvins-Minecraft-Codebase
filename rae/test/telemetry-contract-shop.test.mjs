import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checks, fake, fakeApi, load } from "./helpers.mjs";
import { ui, problems, press, close, script } from "./robbery-ui.mjs";
import { ingest, readArchive } from "../../tools/telemetry/ingest.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";
import { renderReport } from "../../tools/telemetry/report.mjs";

// The shop half of the contract with the tool (telemetry-contract.test.mjs has the rounds, telemetry-contract-robbery.test.mjs the robberies). One
// customer visits a shop under the fake game: buys a sword, sells feathers, buys an effect, and is turned away from a second sword. The exact console
// lines the game wrote are put in a content log the way the real game does, read with the tool, and the report must show that visit with the figures
// the player themselves would give. If the lines the TypeScript writes and the JavaScript reader's idea of them ever drift apart, this fails.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

const { ItemStack } = fakeApi;
const forms = await load("core/shopforms.js");
const store = await load("core/shopstore.js");
const state = await load("core/state.js");
const L = await load("logic/shop.js");
const T = await load("logic/telemetry.js");

const scratch = mkdtempSync(path.join(import.meta.dirname, "..", ".test-build", "contract-shop-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const SEP = "\r\n\r\r\n";
const entry = (time, level, text) => `${time}[Scripting][${level}]-${text}${SEP}`;

const must = (result) => { assert.ok(result.ok, result.reason); return result.shop; };

// A fresh world with a shop of three deals, and a law customer with 100 coins and five feathers.
fake.reset();
store.forgetLoaded();
problems.length = 0;
ui.shown.length = 0;
fake.addObjective("coins");

const ada = fake.makePlayer("Ada", { inventory: true, permission: 2 });
fake.setScore("coins", ada, 100);
state.update(ada, { role: "law" });
ada.container.addItem(new ItemStack("minecraft:feather", 5));

let shop = must(L.newShop("habiti", "Habiti"));
for (const deal of [L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), L.sellDeal({ type: "minecraft:feather", amount: 3 }, 8), L.effectDeal("regeneration", 10, 2, 20)]) shop = must(L.addTrade(shop, deal));
assert.equal(store.saveShop(shop).ok, true);

// 100 - 60 + 8 - 20 leaves 28, so the second sword (60) is refused.
script(press("Iron Sword for 60 coins"), press("Sell Feather x3"), press("Regeneration 3 (10s) for 20 coins"), press("Iron Sword for 60 coins"), close);
await forms.openShop(ada, "habiti");

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

/** The page as a person reads it. */
const readable = (html) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("every shop line the game wrote is read by the tool: none skipped, none damaged, all of them kinds the contract names", () => {
    const { check, done } = checks();

    const { counts, events } = readByTool();
    const kinds = new Set(events.map((e) => e.k));

    check("the game wrote an open, three trades and a refusal", written.filter((l) => l.includes('"k":"shop.open"')).length === 1 && written.filter((l) => l.includes('"k":"shop.trade"')).length === 3 && written.filter((l) => l.includes('"k":"shop.refuse"')).length === 1, written.map((l) => l.slice(12, 70)).join("\n"));
    check("the tool took every line", counts.found === written.length && counts.added === written.length && counts.skipped === 0 && counts.damaged === 0 && counts.unfinished === 0, JSON.stringify(counts));
    check("each kind is one the contract names", [...kinds].every((k) => T.EVENT_KINDS.includes(k)), [...kinds].join());
    done();
});

test("the visit the player made is the visit the report shows", () => {
    const { check, done } = checks();

    const { events } = readByTool();
    const figures = summarize(events);
    const s = figures.shops.list[0];
    const flow = figures.shops.flow;
    const text = readable(renderReport(figures, { generated: "2026-10-12 21:00" }));

    check("one shop: one visit, one customer, three deals and one refusal", figures.shops.list.length === 1 && s.id === "habiti" && s.opens === 1 && s.customers === 1 && s.trades === 3 && s.refusals === 1 && s.tradesPerOpen === 3, JSON.stringify(s));
    check("the coins: 60 + 20 spent, 8 received", s.spent === 80 && s.got === 8, `${s.spent} ${s.got}`);
    check("each deal is in the top deals once, in words, with its kind", JSON.stringify(s.topDeals.map((d) => [d.label, d.face, d.count])) === JSON.stringify([["8 coins for Feather x3", "sell", 1], ["Iron Sword for 60 coins", "buy", 1], ["effect for 20 coins", "service", 1]]), JSON.stringify(s.topDeals));
    check("the effect is counted as a service", JSON.stringify(s.services) === JSON.stringify([{ kind: "effect", count: 1 }]), JSON.stringify(s.services));
    check("the refusal is the second sword's, with the coins taken out of the reason", s.refusalReasons.length === 1 && /you need # coins \(you have #\)/.test(s.refusalReasons[0].why), JSON.stringify(s.refusalReasons));
    check("the coin flow: 8 in, 80 out, 72 down", flow.in === 8 && flow.out === 80 && flow.net === -72 && flow.robberyCoins === 0, JSON.stringify(flow));

    check("the page says so in words", text.includes("Shop: habiti") && text.includes("Visits 1 1 customer") && text.includes("Deals done 3 3 per visit") && text.includes("Spent by customers 80 coins paid") && text.includes("Paid to customers 8 coins for what they sold"), text.slice(0, 900));
    check("and lists the three deals and the one service", text.includes("Iron Sword for 60 coins buy 1 60 0") && text.includes("8 coins for Feather x3 sell 1 0 8") && text.includes("effect for 20 coins service 1 20 0") && text.includes("Services done: effect 1"), text);
    check("and the coin flow", text.includes("Coins in 8 0 from robberies, 8 from shop sales") && text.includes("Coins out 80 spent in shops") && text.includes("Net -72"), text);
    done();
});
