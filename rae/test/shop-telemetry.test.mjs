import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks } from "./helpers.mjs";
import { ui, problems, press, close, script } from "./robbery-ui.mjs";

// core/shopforms.ts as the telemetry sees it: a customer's screen is told as a `shop.open` (once, however many deals are done on it), a
// `shop.trade` for each deal that goes through and a `shop.refuse` for each that does not (with the reason the customer was shown). What the
// screen DOES is shop-forms.test.mjs's business; these tests read only what it says about itself, with the same stand-in player pressing buttons.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

const { ItemStack } = fakeApi;
const forms = await load("core/shopforms.js");
const store = await load("core/shopstore.js");
const state = await load("core/state.js");
const L = await load("logic/shop.js");

const sword = { type: "minecraft:iron_sword", amount: 1 };
const arrows = { type: "minecraft:arrow", amount: 6 };
const feathers = { type: "minecraft:feather", amount: 3 };

const must = (result) => { assert.ok(result.ok, result.reason); return result.shop ?? result.value; };

function setup({ coins = 100, deals = [L.buyDeal(sword, 60)], role } = {}) {
    fake.reset();
    store.forgetLoaded();
    problems.length = 0;
    ui.shown.length = 0;
    fake.addObjective("coins");
    const ada = fake.makePlayer("Ada", { inventory: true, permission: 2 });
    fake.setScore("coins", ada, coins);
    if (role !== undefined) state.update(ada, { role });
    let shop = must(L.newShop("habiti", "Habiti"));
    for (const deal of deals) shop = must(L.addTrade(shop, deal));
    must(store.saveShop(shop));
    return ada;
}

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const quietly = (fn) => { const original = console.error; console.error = () => {}; try { return fn(); } finally { console.error = original; } };

/** How many lines have been written so far: take it before the part of a test whose lines are wanted. */
const mark = () => lines.length;

/** The shop lines written since `from`, parsed, in order. */
function told(from) {
    return lines.slice(from)
        .filter((text) => text.startsWith("[telemetry] {"))
        .map((text) => JSON.parse(text.slice("[telemetry] ".length)))
        .filter((e) => e.k.startsWith("shop."));
}

test("buying one item is told as an open and then a trade: the shop, the deal, the coins paid and the item handed over", async () => {
    const ada = setup({ role: "law" });
    const { check, done } = checks();
    const from = mark();

    script(press("Iron Sword for 60 coins"), press("Close"));
    await forms.openShop(ada, "habiti");

    const t = told(from);
    const [open, trade] = t;

    check("an open, then a trade, and nothing else", t.map((e) => e.k).join() === "shop.open,shop.trade", t.map((e) => e.k).join());
    check("the open: which shop, who, as what", open?.id === "habiti" && open.p === ada.id && open.role === "law", JSON.stringify(open));
    check("the trade: the same shop, the deal, a purchase of 60 coins that handed over a sword, by the same player", JSON.stringify([trade?.id, trade?.deal, trade?.face, trade?.spent, trade?.got, trade?.give, trade?.take, trade?.svc, trade?.p, trade?.role]) === JSON.stringify(["habiti", "t1", "buy", 60, 0, ["Iron Sword"], [], [], ada.id, "law"]), JSON.stringify(trade));
    done();
});

test("a sale and a swap are told with the coins and the items the right way round, on one open", async () => {
    const ada = setup({ coins: 0, deals: [L.sellDeal(feathers, 8), L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 2 }])] });
    const { check, done } = checks();
    ada.container.addItem(new ItemStack("minecraft:feather", 5));
    ada.container.addItem(new ItemStack("minecraft:gold_ingot", 2));
    const from = mark();

    script(press("Sell Feather x3"), press("Diamond for Gold Ingot x2"), close);
    await forms.openShop(ada, "habiti");

    const t = told(from);
    const [sale, swap] = t.filter((e) => e.k === "shop.trade");

    check("one open for the whole visit, then two trades", t.map((e) => e.k).join() === "shop.open,shop.trade,shop.trade", t.map((e) => e.k).join());
    check("the sale: coins in, a stack out", sale?.face === "sell" && sale.spent === 0 && sale.got === 8 && JSON.stringify(sale.take) === JSON.stringify(["Feather x3"]) && sale.give.length === 0, JSON.stringify(sale));
    check("the swap: a diamond in, gold out", swap?.face === "trade" && JSON.stringify(swap.give) === JSON.stringify(["Diamond"]) && JSON.stringify(swap.take) === JSON.stringify(["Gold Ingot x2"]), JSON.stringify(swap));
    done();
});

test("a deal that does a service is told with the kind of service", async () => {
    const ada = setup({ deals: [L.effectDeal("regeneration", 10, 2, 20)] });
    const from = mark();

    script(press("Regeneration 3 (10s) for 20 coins"), close);
    await forms.openShop(ada, "habiti");

    const trade = told(from).find((e) => e.k === "shop.trade");
    assert.equal(trade?.face, "service", JSON.stringify(told(from)));
    assert.deepEqual(trade.svc, ["effect"]);
    assert.equal(trade.spent, 20);
});

test("a refused deal is told as a refusal with the reason the customer saw, and is not a trade", async () => {
    const ada = setup({ coins: 20 });
    const { check, done } = checks();
    const from = mark();

    script(press("Iron Sword"), close);
    await forms.openShop(ada, "habiti");

    const t = told(from);
    const refuse = t.find((e) => e.k === "shop.refuse");

    check("an open and a refusal, no trade", t.map((e) => e.k).join() === "shop.open,shop.refuse", t.map((e) => e.k).join());
    check("the shop, the deal, who, and why", refuse?.id === "habiti" && refuse.deal === "t1" && refuse.p === ada.id && /you need 60 coins \(you have 20\)/.test(refuse.why), JSON.stringify(refuse));
    done();
});

test("a deal the game throws on part-way, and undoes, is a refusal and not a trade", async () => {
    const ada = setup({ coins: 50, deals: [L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 3 }, { type: "minecraft:emerald", amount: 2 }], 10)] });
    const { check, done } = checks();
    ada.container.addItem(new ItemStack("minecraft:gold_ingot", 5));
    ada.container.addItem(new ItemStack("minecraft:emerald", 2));
    const from = mark();

    // The second thing taken fails: the engine throws on the second setItem, after the first has already been done.
    const container = ada.container;
    const realSet = container.setItem.bind(container);
    let calls = 0;
    container.setItem = (slot, s) => {
        calls++;
        if (calls === 2) throw new Error("the engine said no");
        return realSet(slot, s);
    };

    script(press("Diamond for"), close);
    await quietly(() => forms.openShop(ada, "habiti"));
    container.setItem = realSet;

    const t = told(from);
    check("an open and a refusal, no trade", t.map((e) => e.k).join() === "shop.open,shop.refuse", t.map((e) => e.k).join());
    check("with the reason the customer saw", /nothing was charged/.test(t.find((e) => e.k === "shop.refuse")?.why ?? ""), JSON.stringify(t));
    done();
});

test("a deal that changed under the screen and the Close button add nothing beyond the open", async () => {
    const ada = setup({ coins: 100 });
    const from = mark();

    script((form) => {
        must(store.saveShop(must(L.updateTrade(store.getShop("habiti"), "t1", { cost: { coins: 90, items: [] } }))));
        return press("Iron Sword")(form);
    }, close);

    await forms.openShop(ada, "habiti");

    assert.deepEqual(told(from).map((e) => e.k), ["shop.open"]);
});

test("a second request while a shop is up adds nothing, and a visit after a closed one is a new open", async () => {
    const ada = setup();
    const { check, done } = checks();
    const from = mark();

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    script(() => held);

    const first = forms.openShop(ada, "habiti");
    await settle();
    await forms.openShop(ada, "habiti");
    release(close());
    await first;

    check("one open so far", told(from).length === 1, JSON.stringify(told(from).map((e) => e.k)));

    script(close);
    await forms.openShop(ada, "habiti");

    check("and a second open for the second visit", told(from).map((e) => e.k).join() === "shop.open,shop.open", told(from).map((e) => e.k).join());
    done();
});

test("a shop that is gone, or has nothing in it, is not an open", async () => {
    const ada = setup({ deals: [] });
    const from = mark();

    script(close);
    await forms.openShop(ada, "habiti");                // nothing to sell
    await forms.openShop(ada, "nowhere");               // no such shop

    assert.deepEqual(told(from), []);
});
