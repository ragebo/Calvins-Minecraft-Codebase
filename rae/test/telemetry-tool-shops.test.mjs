import { test } from "node:test";
import assert from "node:assert/strict";
import { checks } from "./helpers.mjs";
import { summarize } from "../../tools/telemetry/aggregate.mjs";
import { renderReport } from "../../tools/telemetry/report.mjs";

// The shops section and the coin-flow panel of the report (tools/telemetry/aggregate.mjs and report.mjs). The game tells a shop visit as a
// `shop.open`, a `shop.trade` for each deal that went through and a `shop.refuse` for each that did not. The events below are fixtures shaped like
// the archive's lines (`at` first, then the line's own fields); every figure the tests expect was worked out by hand from them.

const A = "aaaaaa";

let line = 0;
const ev = (k, at, fields = {}) => ({ at, v: 1, k, w: A, b: "b001", n: ++line, t: 100, bv: "0.2.6", ...fields });
const open = (at, id, p) => ev("shop.open", at, { id, p, role: "law" });
const trade = (at, id, deal, fields) => ev("shop.trade", at, { id, deal, face: "buy", spent: 0, got: 0, give: [], take: [], svc: [], p: "p1", role: "law", ...fields });
const refuse = (at, id, deal, why, p = "p1") => ev("shop.refuse", at, { id, deal, why, p });

const run = { w: A, b: "b001", id: "bank", r: 1 };
const rev = (k, at, fields = {}) => ev(k, at, { id: run.id, r: run.r, ...fields });
const testRun = { id: "bank", r: 2 };

/** One general store with a busy day, a tavern nobody bought from, a bank run that paid out, a test run that paid out too, and a round. */
const SHOPS = [
    open("2026-10-11T19:00:00", "general", "p1"), trade("2026-10-11T19:01:00", "general", "t1", { give: ["Iron Sword"], spent: 60 }), refuse("2026-10-11T19:02:00", "general", "t1", "Not yet: you need 60 coins (you have 12).", "p1"),
    open("2026-10-11T19:10:00", "general", "p2"), trade("2026-10-11T19:11:00", "general", "t1", { give: ["Iron Sword"], spent: 60, p: "p2" }),
    trade("2026-10-11T19:12:00", "general", "t2", { face: "sell", got: 8, take: ["Feather x3"], p: "p2" }), refuse("2026-10-11T19:13:00", "general", "t1", "Not yet: you need 60 coins (you have 5).", "p2"),
    open("2026-10-11T19:20:00", "general", "p1"), trade("2026-10-11T19:21:00", "general", "t3", { face: "service", spent: 20, svc: ["effect"] }),
    trade("2026-10-11T19:22:00", "general", "t1", { give: ["Iron Sword"], spent: 90 }), refuse("2026-10-11T19:23:00", "general", "t3", "Not yet: only outlaw players can do this."),
    open("2026-10-11T19:30:00", "general", "p3"), trade("2026-10-11T19:31:00", "general", "t4", { face: "service", spent: 30, svc: ["enchant"], p: "p3" }),
    trade("2026-10-11T19:32:00", "general", "t5", { face: "gift", give: ["Bread x4"], p: "p3" }),

    open("2026-10-11T20:00:00", "tavern", "p1"),

    ev("round.end", "2026-10-11T19:40:00", { reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 }),

    rev("robbery.start", "2026-10-11T18:00:00", { test: false, p: "p1", role: "outlaw", inside: 2 }), rev("robbery.payout", "2026-10-11T18:10:00", { coins: 300, bounty: 750, to: "area", players: 3 }),
    rev("robbery.end", "2026-10-11T18:20:00", { result: "win", test: false, dur: 100, done: 1, of: 1, people: 1 }),
    ev("robbery.start", "2026-10-11T18:30:00", { id: "bank", r: testRun.r, test: true, p: "p1", role: "outlaw", inside: 1 }), ev("robbery.payout", "2026-10-11T18:31:00", { id: "bank", r: testRun.r, coins: 1000, bounty: 0, to: "area", players: 1 })
];

/** Out of order on purpose. */
const SCRAMBLED = [...SHOPS.slice(12), ...SHOPS.slice(0, 12)];

/** What a person reads: the page without its style, its tags and its extra white space. */
const visible = (html) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const general = (options) => summarize(SCRAMBLED, options).shops.list.find((x) => x.id === "general");

test("each shop's figures are exact: visits, customers, deals done and refused, and the coins each way", () => {
    const { check, done } = checks();

    const all = summarize(SCRAMBLED).shops;
    const g = all.list.find((x) => x.id === "general");
    const t = all.list.find((x) => x.id === "tavern");

    check("two shops, the one with the newest activity first", all.list.map((x) => x.id).join() === "tavern,general", all.list.map((x) => x.id).join());
    check("the general store: four visits by three people, seven deals, three refusals, 1.75 deals a visit", g.opens === 4 && g.customers === 3 && g.trades === 7 && g.refusals === 3 && g.tradesPerOpen === 1.75, JSON.stringify(g));
    check("the coins: 60 + 60 + 20 + 90 + 30 spent, 8 paid out", g.spent === 260 && g.got === 8, `${g.spent} ${g.got}`);
    check("the tavern: one visit and nothing else", t.opens === 1 && t.customers === 1 && t.trades === 0 && t.refusals === 0 && t.tradesPerOpen === 0 && t.spent === 0 && t.got === 0 && t.topDeals.length === 0 && t.services.length === 0 && t.refusalReasons.length === 0, JSON.stringify(t));
    check("a shop only refused, never opened, has no deals per visit", summarize([refuse("2026-10-11T19:00:00", "x", "t1", "no")]).shops.list[0].tradesPerOpen === null);
    done();
});

test("the top deals: the same deal at another price is another deal, ties by name, and only the first five are kept", () => {
    const { check, done } = checks();

    const g = general();

    check("five deals, the one done twice first, then the single ones by name", g.topDeals.map((d) => d.label).join(" | ") === "Iron Sword for 60 coins | 8 coins for Feather x3 | Bread x4 for free | Iron Sword for 90 coins | effect for 20 coins", g.topDeals.map((d) => d.label).join(" | "));
    check("the one done twice: its id, kind, how often and the coins", JSON.stringify(g.topDeals[0]) === JSON.stringify({ deal: "t1", label: "Iron Sword for 60 coins", face: "buy", count: 2, spent: 120, got: 0 }), JSON.stringify(g.topDeals[0]));
    check("a sale", JSON.stringify(g.topDeals[1]) === JSON.stringify({ deal: "t2", label: "8 coins for Feather x3", face: "sell", count: 1, spent: 0, got: 8 }), JSON.stringify(g.topDeals[1]));
    done();
});

test("services done are counted by kind, and refusal reasons are grouped once their numbers are taken out", () => {
    const { check, done } = checks();

    const g = general();

    check("an effect and an enchantment, once each, by name", JSON.stringify(g.services) === JSON.stringify([{ kind: "effect", count: 1 }, { kind: "enchant", count: 1 }]), JSON.stringify(g.services));
    check("two refusals that differ only in the coins are one reason", JSON.stringify(g.refusalReasons) === JSON.stringify([{ why: "Not yet: you need # coins (you have #).", count: 2 }, { why: "Not yet: only outlaw players can do this.", count: 1 }]), JSON.stringify(g.refusalReasons));
    done();
});

test("the coin flow adds up what the sections say: robbery payouts and shop sales in, shop purchases out, test runs left out", () => {
    const { check, done } = checks();

    const all = summarize(SCRAMBLED);
    const flow = all.shops.flow;
    const robberyCoins = all.robberies.list.reduce((total, x) => total + x.coins.total, 0);
    const sales = all.shops.list.reduce((total, x) => total + x.got, 0);
    const purchases = all.shops.list.reduce((total, x) => total + x.spent, 0);

    check("in: 300 from the bank and 8 from a sale; out: 260; so 48 more went in than out", flow.robberyCoins === 300 && flow.shopSales === 8 && flow.in === 308 && flow.out === 260 && flow.net === 48, JSON.stringify(flow));
    check("each is the sum of the section's own figures", flow.robberyCoins === robberyCoins && flow.shopSales === sales && flow.out === purchases && flow.in === robberyCoins + sales);
    check("the bounty is told apart from coins, and the round's coins are the newest round's", flow.robberyBounty === 750 && flow.lastRoundCoins === 640, JSON.stringify(flow));

    const withTests = summarize(SCRAMBLED, { includeTests: true }).shops.flow;
    check("with test runs the bank paid 1,300", withTests.robberyCoins === 1300 && withTests.in === 1308 && withTests.net === 1048, JSON.stringify(withTests));

    const noRound = summarize(SHOPS.filter((e) => e.k !== "round.end")).shops.flow;
    check("with no round there is no round total", noRound.lastRoundCoins === null, JSON.stringify(noRound));
    done();
});

test("a deal done twice adds up its coins, a service done twice counts twice, and only the five commonest refusal reasons are kept", () => {
    const { check, done } = checks();

    const sale = { face: "sell", got: 8, take: ["Feather x3"] };
    const same = (n, why) => Array.from({ length: n }, (_, i) => refuse(`2026-10-11T19:${String(10 + i).padStart(2, "0")}:00`, "s", "t1", why));

    const s = summarize([
        open("2026-10-11T19:00:00", "s", "p1"),
        trade("2026-10-11T19:01:00", "s", "t1", sale), trade("2026-10-11T19:02:00", "s", "t1", sale),
        trade("2026-10-11T19:03:00", "s", "t2", { face: "service", spent: 20, svc: ["effect"] }), trade("2026-10-11T19:04:00", "s", "t3", { face: "service", spent: 30, svc: ["effect"] }),
        ...same(3, "r-a"), ...same(2, "r-b"), ...same(1, "r-c"), ...same(1, "r-d"), ...same(1, "r-e"), ...same(1, "r-f")
    ]).shops.list[0];

    check("the sale done twice: two times, 16 coins received, none paid", s.topDeals[0].label === "8 coins for Feather x3" && s.topDeals[0].count === 2 && s.topDeals[0].got === 16 && s.topDeals[0].spent === 0, JSON.stringify(s.topDeals[0]));
    check("two services of one kind are two", JSON.stringify(s.services) === JSON.stringify([{ kind: "effect", count: 2 }]), JSON.stringify(s.services));
    check("nine refusals, five reasons: the commonest first and the same count by name, the last cut", s.refusals === 9 && s.refusalReasons.map((r) => `${r.why}:${r.count}`).join() === "r-a:3,r-b:2,r-c:1,r-d:1,r-e:1", `${s.refusals} ${JSON.stringify(s.refusalReasons)}`);
    done();
});

test("shops with the same latest activity come out by name, and a shop's latest activity is its last event and not its first", () => {
    const { check, done } = checks();

    const tied = summarize([open("2026-10-11T10:00:00", "b", "p1"), open("2026-10-11T10:00:00", "a", "p1")]).shops.list.map((x) => x.id).join();
    const spread = summarize([open("2026-10-11T10:00:00", "x", "p1"), open("2026-10-11T11:00:00", "y", "p1"), trade("2026-10-11T12:00:00", "x", "t1", { give: ["Bread"], spent: 1 })]).shops.list.map((x) => x.id).join();

    check("the same time, by name", tied === "a,b", tied);
    check("opened first and dealt last is still the newest", spread === "x,y", spread);
    done();
});

test("a deal is worded as what the customer got for what they paid, and a damaged line is counted and not trusted", () => {
    const { check, done } = checks();

    const labels = (events) => summarize(events).shops.list[0].topDeals.map((d) => d.label).join(" | ");

    check("one coin is a coin, and two are coins", labels([trade("2026-10-11T19:01:00", "s", "t1", { give: ["Bread"], spent: 1 }), trade("2026-10-11T19:02:00", "s", "t2", { give: ["Bread"], spent: 2 })]) === "Bread for 1 coin | Bread for 2 coins");
    check("coins and items together, on both sides", labels([trade("2026-10-11T19:01:00", "s", "t1", { got: 5, give: ["Bread"], take: ["Gold x2"], spent: 3 })]) === "Bread, 5 coins for Gold x2, 3 coins", labels([trade("2026-10-11T19:01:00", "s", "t1", { got: 5, give: ["Bread"], take: ["Gold x2"], spent: 3 })]));
    check("nothing handed over is said", labels([trade("2026-10-11T19:01:00", "s", "t1", { spent: 5 })]) === "nothing for 5 coins");

    const damaged = summarize([ev("shop.trade", "2026-10-11T19:01:00", { id: "s", deal: "t1", p: "p1" })]).shops.list[0];

    check("a trade with no lists and no numbers is one deal for nothing", damaged.trades === 1 && damaged.spent === 0 && damaged.got === 0 && damaged.topDeals[0].label === "nothing for free", JSON.stringify(damaged));
    done();
});

test("the last round's coins are the newest round's, not an average", () => {
    const round = (at, coins) => ev("round.end", at, { reason: "law_win", dur: 1, kills: 0, deaths: 0, lawKills: 0, outlawKills: 0, coins });

    // Newest by time is 300; the median of the four is 200 and the average 312.5, so neither can stand in for it.
    assert.equal(summarize([round("2026-10-11T10:00:00", 100), round("2026-10-11T12:00:00", 300), round("2026-10-11T11:00:00", 800), round("2026-10-11T09:00:00", 50)]).shops.flow.lastRoundCoins, 300);
});

test("a world filter narrows shops too, and no shop events means no shops", () => {
    const { check, done } = checks();

    check("another world has no shops", summarize(SCRAMBLED, { world: "bbbbbb" }).shops.list.length === 0);
    check("this one has both", summarize(SCRAMBLED, { world: A }).shops.list.length === 2);
    check("nothing about shops, an empty list", summarize(SHOPS.filter((e) => !e.k.startsWith("shop."))).shops.list.length === 0);
    done();
});

test("the report has a section for each shop: its figures, its top deals, its services and why customers were refused", () => {
    const { check, done } = checks();

    const html = renderReport(summarize(SCRAMBLED), { generated: "2026-10-12 21:00" });
    const text = visible(html);

    check("a section for each shop, the newest activity first", text.indexOf("Shop: tavern") > 0 && text.indexOf("Shop: tavern") < text.indexOf("Shop: general"), text.slice(0, 300));
    check("the headline figures", text.includes("Visits 4 3 customers Deals done 7 1.8 per visit Spent by customers 260 coins paid for goods and services Paid to customers 8 coins for what they sold"), text);
    check("the top deals", text.includes("Top deals Deal Kind Times Coins paid Coins received Iron Sword for 60 coins buy 2 120 0 8 coins for Feather x3 sell 1 0 8"), text);
    check("the services", text.includes("Services done: effect 1, enchant 1"), text);
    check("the reasons, grouped", text.includes("Why customers were refused Reason Times Not yet: you need # coins (you have #). 2 Not yet: only outlaw players can do this. 1"), text);
    check("a shop nobody bought from says so, and has no empty tables", text.includes("No deals were done here yet.") && !text.includes("Services done: ,"), text);
    done();
});

test("the report's coin flow says what came in, what went out, the difference and the last round's coins", () => {
    const { check, done } = checks();

    const text = visible(renderReport(summarize(SCRAMBLED), { generated: "x" }));

    check("the panel, with where the coins in came from", text.includes("Coin flow") && text.includes("Coins in 308 300 from robberies, 8 from shop sales"), text);
    check("coins out, the net, and the round", text.includes("Coins out 260 spent in shops") && text.includes("Net +48 coins in minus coins out") && text.includes("Last round ended with 640 coins held by the gang"), text);

    const negative = visible(renderReport(summarize([open("2026-10-11T19:00:00", "g", "p1"), trade("2026-10-11T19:01:00", "g", "t1", { give: ["Bread"], spent: 5 })]), { generated: "x" }));
    check("a net below zero is shown with its sign, and no round says so", negative.includes("Net -5 coins") && negative.includes("Last round ended with n/a"), negative);

    const robberiesOnly = visible(renderReport(summarize([rev("robbery.start", "2026-10-11T18:00:00", { test: false, inside: 1 }), rev("robbery.payout", "2026-10-11T18:10:00", { coins: 50, bounty: 0, to: "area", players: 1 }), rev("robbery.end", "2026-10-11T18:20:00", { result: "win", test: false, dur: 1, done: 1, of: 1, people: 1 })]), { generated: "x" }));
    check("with only robberies the flow still shows, and has no shops in it", robberiesOnly.includes("Coin flow") && robberiesOnly.includes("Coins in 50 50 from robberies, 0 from shop sales"), robberiesOnly);

    const rounds = visible(renderReport(summarize([ev("round.end", "2026-10-11T19:40:00", { reason: "law_win", dur: 1, kills: 0, deaths: 0, lawKills: 0, outlawKills: 0, coins: 5 })]), { generated: "x" }));
    check("with neither, no coin flow", !rounds.includes("Coin flow") && !rounds.includes("Shop:"), rounds);

    const even = visible(renderReport(summarize([open("2026-10-11T19:00:00", "g", "p1")]), { generated: "x" }));
    check("nothing in and nothing out is a net of 0, with no sign", even.includes("Net 0 coins in minus coins out"), even);
    done();
});

test("the coin flow says the bounty is not coins, so the figures are not read as more than they are", () => {
    const text = visible(renderReport(summarize(SCRAMBLED), { generated: "x" }));

    assert.ok(text.includes("Robbery bounty (750) is not coins"), text);
});

test("a shop with a visit and nothing else has no tables, and one only refused says it was never visited", () => {
    const { check, done } = checks();

    const visited = visible(renderReport(summarize([open("2026-10-11T19:00:00", "g", "p1")]), { generated: "x" }));
    const refused = visible(renderReport(summarize([refuse("2026-10-11T19:00:00", "g", "t1", "no")]), { generated: "x" }));

    check("a visit alone: its figures and the empty note, no tables", visited.includes("Visits 1 1 customer Deals done 0 0 per visit") && visited.includes("No deals were done here yet.") && !visited.includes("Top deals") && !visited.includes("Services done") && !visited.includes("Why customers were refused"), visited);
    check("a refusal alone: no visit recorded, and the reason table", refused.includes("Deals done 0 no visit recorded") && refused.includes("Why customers were refused"), refused);
    done();
});

test("a shop's id, a deal's items and a refusal's words are shown as text, never as markup", () => {
    const html = renderReport(summarize([
        open("2026-10-11T19:00:00", "<b>shop</b>", "p1"),
        trade("2026-10-11T19:01:00", "<b>shop</b>", "t1", { face: "<i>kind</i>", give: ["<img src=x onerror=alert(1)>"], spent: 1, svc: ["<u>service</u>"] }),
        refuse("2026-10-11T19:02:00", "<b>shop</b>", "t1", "<script>alert(2)</script>")
    ]), { generated: "x" });

    assert.ok(!html.includes("<b>shop") && !html.includes("<img src=x") && !html.includes("<script>alert") && html.includes("&lt;b&gt;shop&lt;/b&gt;") && html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("&lt;script&gt;alert(#)&lt;/script&gt;"));
    assert.ok(!html.includes("<i>kind") && !html.includes("<u>service") && html.includes("&lt;i&gt;kind&lt;/i&gt;") && html.includes("&lt;u&gt;service&lt;/u&gt;"));
});
