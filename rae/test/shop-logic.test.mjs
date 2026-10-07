import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, load } from "./helpers.mjs";

// logic/shop.ts is pure rules: what a deal is, which deals are legal, what a saved shop looks like, how a deal reads in plain words.
const shop = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

const sword = { type: "minecraft:iron_sword", amount: 1 };
const arrows = { type: "minecraft:arrow", amount: 6 };
const gold = { type: "minecraft:gold_ingot", amount: 3 };
const diamond = { type: "minecraft:diamond", amount: 1 };

const made = (id = "habiti", name = "Habiti") => {
    const result = shop.newShop(id, name);
    assert.ok(result.ok, result.reason);
    return result.shop;
};

const withDeals = (...deals) => deals.reduce((current, deal) => {
    const next = shop.addTrade(current, deal);
    assert.ok(next.ok, next.reason);
    return next.shop;
}, made());

test("a new shop is empty, named, and has a legal id", () => {
    const { check, done } = checks();
    const fresh = made("habiti", "  Habiti   the  Horseman ");
    check("the name is tidied", fresh.name === "Habiti the Horseman", fresh.name);
    check("no deals yet", fresh.trades.length === 0 && fresh.nextTrade === 1);
    check("colour codes are stripped from a name", made("a1", "§cRed§r Shop").name === "Red Shop");
    check("an id with capitals is refused", !shop.newShop("Habiti", "x").ok);
    check("an id starting with a digit is refused", !shop.newShop("1abc", "x").ok);
    check("a one-character id is refused", !shop.newShop("a", "x").ok);
    check("a too-long id is refused", !shop.newShop("a".repeat(SHOP.maxIdLength + 1), "x").ok);
    check("an empty name is refused", !shop.newShop("habiti", "   ").ok);
    check("a too-long name is refused", !shop.newShop("habiti", "n".repeat(SHOP.maxNameLength + 1)).ok);
    done();
});

test("slugify makes a legal id from a name, and uniqueId never reuses one", () => {
    const { check, done } = checks();
    check("spaces and capitals", shop.slugify("Habiti the Horseman") === "habiti_the_horseman");
    check("leading digits and symbols go", shop.slugify("  42 Mule!!") === "mule");
    check("nothing usable gives an empty string", shop.slugify("!!!") === "");
    check("cut to the id length", shop.slugify("x".repeat(80)).length <= SHOP.maxIdLength);
    check("a free id is kept", shop.uniqueId("habiti", new Set()) === "habiti");
    check("a taken id gets a number", shop.uniqueId("habiti", new Set(["habiti"])) === "habiti_2");
    check("and the next number after that", shop.uniqueId("habiti", new Set(["habiti", "habiti_2"])) === "habiti_3");
    check("an empty base falls back to shop", shop.uniqueId("", new Set()) === "shop");
    const long = "x".repeat(SHOP.maxIdLength);
    const next = shop.uniqueId(long, new Set([long]));
    check("a numbered id still fits the length limit", next.length <= SHOP.maxIdLength && next.endsWith("_2") && shop.whyBadId(next) === undefined, next);
    done();
});

test("deals get stable ids that are never reused, and edits leave the original alone", () => {
    const { check, done } = checks();
    const start = made();
    const one = shop.addTrade(start, shop.buyDeal(sword, 60));
    check("the first deal is t1", one.ok && one.trade.id === "t1");
    const two = shop.addTrade(one.shop, shop.buyDeal(arrows, 15));
    check("the second is t2", two.ok && two.trade.id === "t2");
    const gone = shop.removeTrade(two.shop, "t1");
    check("removing t1 leaves t2", gone.ok && gone.shop.trades.length === 1 && gone.shop.trades[0].id === "t2");
    const three = shop.addTrade(gone.shop, shop.buyDeal(sword, 70));
    check("a removed id is not handed out again", three.ok && three.trade.id === "t3", three.trade?.id);
    check("the starting shop was not changed", start.trades.length === 0 && start.nextTrade === 1);
    check("removing something that is not there says so", !shop.removeTrade(start, "t9").ok);
    done();
});

test("the four shapes of a deal read as plain sentences", () => {
    const { check, done } = checks();
    const buy = { id: "t1", ...shop.buyDeal(sword, 60) };
    const sell = { id: "t2", ...shop.sellDeal({ type: "minecraft:feather", amount: 3 }, 8) };
    const swap = { id: "t3", ...shop.swapDeal(diamond, [gold]) };
    const swapPlus = { id: "t4", ...shop.swapDeal(diamond, [gold], 10) };
    const gift = { id: "t5", cost: { coins: 0, items: [] }, rewards: [{ kind: "item", item: { type: "minecraft:bread", amount: 1 } }] };

    check("buy", shop.faceOf(buy) === "buy" && shop.describeTrade(buy) === "Iron Sword for 60 coins", shop.describeTrade(buy));
    check("sell", shop.faceOf(sell) === "sell" && shop.describeTrade(sell) === "Sell Feather x3 for 8 coins", shop.describeTrade(sell));
    check("trade", shop.faceOf(swap) === "trade" && shop.describeTrade(swap) === "Diamond for Gold Ingot x3", shop.describeTrade(swap));
    check("trade with coins as well", shop.describeTrade(swapPlus) === "Diamond for Gold Ingot x3 + 10 coins", shop.describeTrade(swapPlus));
    check("gift", shop.faceOf(gift) === "gift" && shop.describeTrade(gift) === "Free: Bread", shop.describeTrade(gift));
    check("one coin is not plural", shop.coinsText(1) === "1 coin" && shop.coinsText(2) === "2 coins");
    done();
});

test("a potion and a named item are told apart in words", () => {
    const { check, done } = checks();
    const potion = { type: "minecraft:splash_potion", amount: 1, potion: ["LongSwiftness", "ThrowSplash"] };
    check("a potion names its effect", shop.itemName(potion) === "Splash Potion of Long Swiftness", shop.itemName(potion));
    check("a custom name wins, without colour codes", shop.itemName({ ...sword, name: "§6Billy's Blade" }) === "Billy's Blade");
    check("an amount is shown as x", shop.describeItem(arrows) === "Arrow x6");
    done();
});

test("what makes a deal legal", () => {
    const { check, done } = checks();
    const base = made();
    const tryDeal = (deal) => shop.addTrade(base, deal);

    check("a plain buy is fine", tryDeal(shop.buyDeal(sword, 60)).ok);
    check("a free gift is fine", tryDeal({ cost: { coins: 0, items: [] }, rewards: [{ kind: "item", item: sword }] }).ok);
    check("coins for nothing are not", !tryDeal({ cost: { coins: 0, items: [] }, rewards: [{ kind: "coins", amount: 5 }] }).ok);
    check("coins for coins are not", !tryDeal({ cost: { coins: 5, items: [gold] }, rewards: [{ kind: "coins", amount: 6 }] }).ok);
    check("two coin rewards are not", !tryDeal({ cost: { coins: 0, items: [gold] }, rewards: [{ kind: "coins", amount: 1 }, { kind: "coins", amount: 2 }] }).ok);
    check("a deal with no reward is not", !tryDeal({ cost: { coins: 5, items: [] }, rewards: [] }).ok);
    check("too many rewards are not", !tryDeal({ cost: { coins: 5, items: [] }, rewards: Array.from({ length: SHOP.maxRewards + 1 }, () => ({ kind: "item", item: sword })) }).ok);
    check("a negative price is not", !tryDeal(shop.buyDeal(sword, -1)).ok);
    check("a fractional price is not", !tryDeal(shop.buyDeal(sword, 2.5)).ok);
    check("a price over the cap is not", !tryDeal(shop.buyDeal(sword, SHOP.maxCoins + 1)).ok);
    check("the highest price is", tryDeal(shop.buyDeal(sword, SHOP.maxCoins)).ok);
    check("an amount of zero is not", !tryDeal(shop.buyDeal({ ...sword, amount: 0 }, 5)).ok);
    check("an amount over the cap is not", !tryDeal(shop.buyDeal({ ...sword, amount: SHOP.maxAmount + 1 }, 5)).ok);
    check("a bad item id is not", !tryDeal(shop.buyDeal({ type: "iron sword", amount: 1 }, 5)).ok);
    check("asking for the same item twice is not", !tryDeal(shop.swapDeal(diamond, [gold, { ...gold, amount: 1 }])).ok);
    check("asking for gold and a named gold is fine", tryDeal(shop.swapDeal(diamond, [gold, { ...gold, name: "Fool's Gold" }])).ok);
    check("too many kinds of item are not", !tryDeal(shop.swapDeal(diamond, Array.from({ length: SHOP.maxCostItems + 1 }, (_, i) => ({ type: `minecraft:item_${i}`, amount: 1 })))).ok);
    done();
});

test("an item may carry a name, lore, enchantments and a potion, within limits", () => {
    const { check, done } = checks();
    const base = made();
    const fancy = {
        type: "minecraft:bow", amount: 1, name: "Billy's Bow", lore: ["Fast", "Loud"],
        enchants: [["flame", 1], ["minecraft:power", 3]]
    };
    check("a fancy reward is fine", shop.addTrade(base, shop.buyDeal(fancy, 100)).ok);
    check("lore of too many lines is not", !shop.addTrade(base, shop.buyDeal({ ...fancy, lore: Array.from({ length: SHOP.maxLoreLines + 1 }, () => "x") }, 5)).ok);
    check("a too-long lore line is not", !shop.addTrade(base, shop.buyDeal({ ...fancy, lore: ["x".repeat(SHOP.maxLoreLength + 1)] }, 5)).ok);
    check("a too-long name is not", !shop.addTrade(base, shop.buyDeal({ ...fancy, name: "n".repeat(SHOP.maxItemNameLength + 1) }, 5)).ok);
    check("an enchantment at level zero is not", !shop.addTrade(base, shop.buyDeal({ ...fancy, enchants: [["flame", 0]] }, 5)).ok);
    check("too many enchantments are not", !shop.addTrade(base, shop.buyDeal({ ...fancy, enchants: Array.from({ length: SHOP.maxEnchants + 1 }, (_, i) => [`e${i}`, 1]) }, 5)).ok);
    check("a potion is an effect and a delivery", shop.addTrade(base, shop.buyDeal({ type: "minecraft:potion", amount: 1, potion: ["Swiftness", "Consume"] }, 25)).ok);
    check("a potion with one part is not", !shop.addTrade(base, shop.buyDeal({ type: "minecraft:potion", amount: 1, potion: ["Swiftness"] }, 25)).ok);
    done();
});

test("a cost never asks for enchantments or lore, only the kind, the amount, the name and the potion", () => {
    const spec = shop.costSpec({ type: "minecraft:bow", amount: 2, name: "Billy's Bow", lore: ["x"], enchants: [["flame", 1]], potion: ["A", "B"] });
    assert.deepEqual(spec, { type: "minecraft:bow", amount: 2, name: "Billy's Bow", potion: ["A", "B"] });
    assert.deepEqual(shop.costSpec(sword), { type: "minecraft:iron_sword", amount: 1 });
});

test("which stacks a spec accepts", () => {
    const { check, done } = checks();
    check("the same kind matches", shop.specMatches(gold, { type: "minecraft:gold_ingot" }));
    check("another kind does not", !shop.specMatches(gold, { type: "minecraft:iron_ingot" }));
    check("a spec without a name takes a named stack too", shop.specMatches(gold, { type: "minecraft:gold_ingot", name: "Shiny" }));
    check("a spec with a name needs that name", !shop.specMatches({ ...gold, name: "Shiny" }, { type: "minecraft:gold_ingot" }) && shop.specMatches({ ...gold, name: "Shiny" }, { type: "minecraft:gold_ingot", name: "Shiny" }));
    const swiftness = { type: "minecraft:potion", amount: 1, potion: ["Swiftness", "Consume"] };
    check("a potion spec needs the same potion", shop.specMatches(swiftness, { type: "minecraft:potion", potion: ["Swiftness", "Consume"] }) && !shop.specMatches(swiftness, { type: "minecraft:potion", potion: ["Healing", "Consume"] }) && !shop.specMatches(swiftness, { type: "minecraft:potion" }));
    check("a plain potion spec takes any potion", shop.specMatches({ type: "minecraft:potion", amount: 1 }, { type: "minecraft:potion", potion: ["Healing", "Consume"] }));
    done();
});

test("a shop is saved and read back exactly, with every kind of item in it", () => {
    const fancy = { type: "minecraft:bow", amount: 1, name: "Billy's Bow", lore: ["Fast"], enchants: [["flame", 1]] };
    const potion = { type: "minecraft:splash_potion", amount: 2, potion: ["Swiftness", "ThrowSplash"] };
    let current = made("habiti", "Habiti");
    current = shop.setGreeting(current, "  Howdy, stranger.  ").shop;
    for (const deal of [shop.buyDeal(fancy, 100), shop.sellDeal(arrows, 15), shop.swapDeal(potion, [gold, diamond], 5)]) current = shop.addTrade(current, deal).shop;

    const text = shop.serialize(current);
    const back = shop.parse(text);

    assert.ok(back.ok, back.reason);
    assert.deepEqual(back.value, current, "what is read is what was saved");
    assert.equal(shop.serialize(back.value), text, "and saving it again gives the same text");
    assert.equal(current.greeting, "Howdy, stranger.");
});

test("a typical shop is far smaller than a world property, and a saved text uses short keys", () => {
    let current = made();
    for (let i = 0; i < SHOP.maxTrades; i++) current = shop.addTrade(current, shop.buyDeal({ type: `minecraft:item_${i}`, amount: 16 }, 10 + i)).shop;
    const text = shop.serialize(current);
    assert.ok(text.length < SHOP.maxSavedChars / 2, `${SHOP.maxTrades} plain deals take ${text.length} characters`);
    assert.ok(!text.includes("rewards") && !text.includes("amount"), "long key names are not stored");
});

test("parse never throws, and says why a save cannot be read", () => {
    const junk = [undefined, "", "not json", "null", "42", "[]", "{}", '{"v":1}', '{"v":99,"id":"a1","nm":"x","n":1,"t":[]}',
        '{"v":1,"id":"A","nm":"x","n":1,"t":[]}', '{"v":1,"id":"habiti","nm":"x","n":1,"t":"no"}',
        '{"v":1,"id":"habiti","nm":"x","n":1,"t":[5]}', '{"v":1,"id":"habiti","nm":"x","n":1,"t":[{"i":"t1","r":[]}]}',
        '{"v":1,"id":"habiti","nm":"x","n":1,"t":[{"i":"t1","r":[{"c":5}]}]}', '{"v":1,"id":"habiti","nm":"x","n":1,"t":[{"i":"t1","r":[{"i":{"t":"bad","a":1}}]}]}',
        '{"v":1,"id":"habiti","nm":"x","n":1,"t":[{"i":"t5","r":[{"i":{"t":"minecraft:bread","a":1}}]}]}'];

    for (const text of junk) {
        let result;
        assert.doesNotThrow(() => { result = shop.parse(text); }, `parse threw for ${String(text)}`);
        assert.equal(result.ok, false, `parse accepted ${String(text)}`);
        assert.ok(typeof result.reason === "string" && result.reason.length > 0, `no reason for ${String(text)}`);
    }
});

test("a save with two deals of the same id, or a counter behind its deals, is damaged", () => {
    const one = '{"i":"t1","r":[{"i":{"t":"minecraft:bread","a":1}}]}';
    assert.equal(shop.parse(`{"v":1,"id":"habiti","nm":"x","n":2,"t":[${one},${one}]}`).ok, false);
    assert.equal(shop.parse(`{"v":1,"id":"habiti","nm":"x","n":1,"t":[${one}]}`).ok, false);
    assert.equal(shop.parse(`{"v":1,"id":"habiti","nm":"x","n":2,"t":[${one}]}`).ok, true);
});

test("a shop holds at most SHOP.maxTrades deals", () => {
    let current = made();
    for (let i = 0; i < SHOP.maxTrades; i++) {
        const next = shop.addTrade(current, shop.buyDeal(sword, i + 1));
        assert.ok(next.ok, next.reason);
        current = next.shop;
    }
    const over = shop.addTrade(current, shop.buyDeal(sword, 1));
    assert.equal(over.ok, false);
    assert.match(over.reason, new RegExp(String(SHOP.maxTrades)));
});

test("editing a deal, moving it, renaming and the greeting", () => {
    const { check, done } = checks();
    let current = withDeals(shop.buyDeal(sword, 60), shop.buyDeal(arrows, 15), shop.sellDeal(gold, 20));

    const priced = shop.updateTrade(current, "t1", { cost: { coins: 75, items: [] } });
    check("a price can change", priced.ok && priced.shop.trades[0].cost.coins === 75 && priced.shop.trades[0].id === "t1");
    check("the reward is untouched by a price change", priced.ok && shop.describeRewards(priced.shop.trades[0].rewards) === "Iron Sword");
    check("an illegal change is refused and changes nothing", !shop.updateTrade(current, "t1", { cost: { coins: -5, items: [] } }).ok);
    check("a deal that is not there is refused", !shop.updateTrade(current, "t9", {}).ok);

    const down = shop.moveTrade(current, "t1", 1);
    check("a deal moves down", down.ok && down.shop.trades.map((t) => t.id).join() === "t2,t1,t3", down.shop?.trades.map((t) => t.id).join());
    const up = shop.moveTrade(current, "t3", -1);
    check("and up", up.ok && up.shop.trades.map((t) => t.id).join() === "t1,t3,t2");
    check("the top one cannot go higher", shop.moveTrade(current, "t1", -1).shop.trades.map((t) => t.id).join() === "t1,t2,t3");
    check("the bottom one cannot go lower", shop.moveTrade(current, "t3", 1).shop.trades.map((t) => t.id).join() === "t1,t2,t3");

    check("renaming tidies the name", shop.renameShop(current, "  New   Name ").shop.name === "New Name");
    check("an empty rename is refused", !shop.renameShop(current, "  ").ok);
    check("a greeting can be set and cleared", shop.setGreeting(shop.setGreeting(current, "Hi").shop, "").shop.greeting === "");
    check("a too-long greeting is refused", !shop.setGreeting(current, "g".repeat(SHOP.maxGreetingLength + 1)).ok);
    done();
});

test("copying a shop keeps the deals under a new identity", () => {
    const original = shop.setGreeting(withDeals(shop.buyDeal(sword, 60), shop.sellDeal(gold, 20)), "Welcome").shop;
    const copy = shop.copyShop(original, "second", "Second Shop");

    assert.ok(copy.ok, copy.reason);
    assert.equal(copy.shop.id, "second");
    assert.equal(copy.shop.name, "Second Shop");
    assert.equal(copy.shop.greeting, "Welcome");
    assert.deepEqual(copy.shop.trades, original.trades);
    assert.equal(copy.shop.nextTrade, original.nextTrade);
    assert.equal(shop.copyShop(original, "Bad Id", "x").ok, false);
});

test("a deal's signature changes when the deal does", () => {
    const { check, done } = checks();
    const current = withDeals(shop.buyDeal(sword, 60));
    const before = shop.signature(current.trades[0]);
    const after = shop.signature(shop.updateTrade(current, "t1", { cost: { coins: 61, items: [] } }).shop.trades[0]);
    check("a new price is a new signature", before !== after);
    check("the same deal is the same signature", before === shop.signature(shop.parse(shop.serialize(current)).value.trades[0]));
    done();
});

test("a shop with no deals is not worth opening", () => {
    assert.match(shop.whyNotOpen(made()), /nothing to sell/);
    assert.equal(shop.whyNotOpen(withDeals(shop.buyDeal(sword, 60))), undefined);
});

test("describeShop lists the deals under the name", () => {
    const lines = shop.describeShop(shop.setGreeting(withDeals(shop.buyDeal(sword, 60)), "Howdy").shop);
    assert.equal(lines[0], "Habiti (habiti): 1 deal");
    assert.ok(lines.includes("Greeting: Howdy"));
    assert.ok(lines.some((l) => l.includes("t1") && l.includes("Iron Sword for 60 coins")));
    assert.match(shop.describeShop(made())[0], /no deals yet/);
});
