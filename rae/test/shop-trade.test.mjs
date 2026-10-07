import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks } from "./helpers.mjs";

// core/shopitems.ts and core/shoptrade.ts: reading what a builder holds, making a customer's goods, and carrying a deal out
// all or nothing against a real (fake) inventory. The fake's player inventory answers COPIES of stacks, as the engine does, so
// code that forgets to put a changed stack back with setItem fails here as it would in the game.

const { ItemStack } = fakeApi;
const items = await load("core/shopitems.js");
const trade = await load("core/shoptrade.js");
const L = await load("logic/shop.js");

const base = L.newShop("habiti", "Habiti").shop;

/** A deal with an id, from a NewTrade. */
const deal = (spec) => {
    const added = L.addTrade(base, spec);
    assert.ok(added.ok, added.reason);
    return added.trade;
};

function setup(coins = 100) {
    fake.reset();
    fake.addObjective("coins");
    const player = fake.makePlayer("Ada", { inventory: true });
    fake.setScore("coins", player, coins);
    return player;
}

const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player);
const stack = (type, amount = 1, decorate) => { const s = new ItemStack(type, amount); decorate?.(s); return s; };

function give(player, s) {
    assert.equal(player.container.addItem(s), undefined, "the stack fitted");
    return s;
}

function countIn(player, type) {
    let total = 0;
    for (let i = 0; i < 36; i++) {
        const s = player.container.getItem(i);
        if (s?.typeId === type) total += s.amount;
    }
    return total;
}

const bagText = (player) => Array.from({ length: 36 }, (_, i) => player.container.getItem(i)).map((s) => (s ? `${s.typeId}x${s.amount}${s.nameTag ? `"${s.nameTag}"` : ""}` : "-")).join(" ");

const quietly = (fn) => {
    const original = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = original; }
};

// ---------------------------------------------------------------------------------------------------------
// Reading and making items
// ---------------------------------------------------------------------------------------------------------

test("what a builder holds is read as a spec: kind, amount, name, lore, enchantments, potion", () => {
    setup();
    const { check, done } = checks();

    const plain = items.specOf(stack("minecraft:arrow", 6));
    check("a plain item is just a kind and an amount", JSON.stringify(plain) === JSON.stringify({ type: "minecraft:arrow", amount: 6 }), JSON.stringify(plain));

    const fancy = stack("minecraft:bow", 1, (s) => {
        s.nameTag = "Billy's Bow"; s.setLore(["Fast"]);
        s.getComponent("minecraft:enchantable").addEnchantment({ type: fakeApi.EnchantmentTypes.get("minecraft:flame"), level: 1 });
    });
    const read = items.specOf(fancy);
    check("a bow keeps its name, lore and enchantment", read.name === "Billy's Bow" && read.lore[0] === "Fast" && read.enchants[0][0] === "minecraft:flame" && read.enchants[0][1] === 1, JSON.stringify(read));

    const potion = items.specOf(fakeApi.Potions.resolve("Swiftness", "ThrowSplash"));
    check("a potion keeps which one it is", potion.type === "minecraft:splash_potion" && potion.potion[0] === "Swiftness" && potion.potion[1] === "ThrowSplash", JSON.stringify(potion));
    done();
});

test("a spec makes the item it came from, enchantments and potions included", () => {
    setup();
    const { check, done } = checks();

    const fancy = { type: "minecraft:bow", amount: 1, name: "Billy's Bow", lore: ["Fast"], enchants: [["minecraft:flame", 1], ["minecraft:power", 3]] };
    const [bow] = items.makeStacks(fancy);
    const again = items.specOf(bow);
    check("reading what was made gives the spec back", JSON.stringify(again) === JSON.stringify(fancy), JSON.stringify(again));

    const [potion] = items.makeStacks({ type: "minecraft:potion", amount: 1, potion: ["Swiftness", "Consume"] });
    check("a potion is made as that potion", potion.typeId === "minecraft:potion" && potion.potion.effect === "Swiftness");
    done();
});

test("goods are made in as many stacks as the item holds at once", () => {
    setup();
    const { check, done } = checks();
    check("a sword is one at a time", items.makeStacks({ type: "minecraft:iron_sword", amount: 3 }).map((s) => s.amount).join() === "1,1,1");
    check("ender pearls hold sixteen", items.makeStacks({ type: "minecraft:ender_pearl", amount: 20 }).map((s) => s.amount).join() === "16,4");
    check("arrows hold sixty-four", items.makeStacks({ type: "minecraft:arrow", amount: 64 }).map((s) => s.amount).join() === "64");
    check("potions are one each", items.makeStacks({ type: "minecraft:potion", amount: 2, potion: ["Healing", "Consume"] }).length === 2);
    done();
});

test("goods the game cannot make are refused with its own words, before anything is taken", () => {
    setup();
    const { check, done } = checks();
    const fails = (spec) => { try { items.makeStacks(spec); return undefined; } catch (err) { return String(err.message); } };

    check("an unknown potion effect", /InvalidPotionEffectType/.test(fails({ type: "minecraft:potion", amount: 1, potion: ["Nonsense", "Consume"] }) ?? ""));
    check("an unknown enchantment", /does not know the enchantment/.test(fails({ type: "minecraft:bow", amount: 1, enchants: [["minecraft:nonsense", 1]] }) ?? ""));
    check("enchantments on an item that cannot take them", /cannot be enchanted/.test(fails({ type: "minecraft:arrow", amount: 1, enchants: [["minecraft:flame", 1]] }) ?? ""));
    check("an enchantment that does not fit the item", /NotCompatible/.test(fails({ type: "minecraft:iron_sword", amount: 1, enchants: [["minecraft:flame", 1]] }) ?? ""));
    check("a level that is too high", /OutOfBounds/.test(fails({ type: "minecraft:bow", amount: 1, enchants: [["minecraft:flame", 9]] }) ?? ""));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Counting, taking, handing over
// ---------------------------------------------------------------------------------------------------------

test("counting and taking work across stacks, partial stacks and a named stack", () => {
    const p = setup();
    const { check, done } = checks();
    const bag = items.bagOf(p);

    give(p, stack("minecraft:gold_ingot", 2));
    give(p, stack("minecraft:iron_ingot", 5));
    p.container.setItem(5, stack("minecraft:gold_ingot", 40));                  // a second stack, far from the first
    p.container.setItem(6, stack("minecraft:gold_ingot", 3, (s) => { s.nameTag = "Shiny"; }));

    const gold = { type: "minecraft:gold_ingot", amount: 1 };
    check("a plain spec counts every gold ingot, named or not", items.countOf(bag, gold) === 45, String(items.countOf(bag, gold)));
    check("a named spec counts only the named", items.countOf(bag, { ...gold, name: "Shiny" }) === 3);

    check("taking more than there is takes nothing", items.takeFrom(bag, { ...gold, amount: 46 }) === false && items.countOf(bag, gold) === 45);
    check("taking part of a stack puts the smaller stack back", items.takeFrom(bag, { ...gold, amount: 41 }) === true && items.countOf(bag, gold) === 4, bagText(p));
    check("what else was in the bag is untouched", countIn(p, "minecraft:iron_ingot") === 5);
    check("taking exactly everything empties the slots", items.takeFrom(bag, { ...gold, amount: 4 }) === true && countIn(p, "minecraft:gold_ingot") === 0);
    done();
});

test("handing over goods stacks into the bag, and what does not fit is dropped at the player's feet", () => {
    const p = setup();
    const { check, done } = checks();

    give(p, stack("minecraft:arrow", 60));
    check("nothing dropped while there is room", items.giveStacks(p, [stack("minecraft:arrow", 10)]) === 0 && countIn(p, "minecraft:arrow") === 70);

    for (let i = 0; i < 36; i++) if (p.container.getItem(i) === undefined) p.container.setItem(i, stack("minecraft:stone", 64));
    const dropped = items.giveStacks(p, [stack("minecraft:iron_sword", 1)]);
    const world_ = fake.dimension("overworld");
    check("a full bag drops the item", dropped === 1 && world_.spawnedItems.length === 1 && world_.spawnedItems[0].stack.typeId === "minecraft:iron_sword", `${dropped} ${world_.spawnedItems.length}`);
    check("at the player's feet", JSON.stringify(world_.spawnedItems[0].location) === JSON.stringify(p.location));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------------------------------------

test("buying: the coins go, the goods arrive, and the player is told what happened", () => {
    const p = setup(100);
    const { check, done } = checks();
    const buy = deal(L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60));

    check("an affordable deal has no reason against it", trade.whyCannotTrade(p, buy) === undefined);
    const result = trade.carryOutTrade(p, buy);
    check("it goes through", result.ok === true && result.summary === "Bought Iron Sword for 60 coins." && result.dropped === 0, JSON.stringify(result));
    check("60 coins left the account", coinsOf(p) === 40);
    check("the sword is in the bag", countIn(p, "minecraft:iron_sword") === 1);
    done();
});

test("buying more than you can afford changes nothing, and says what is missing", () => {
    const p = setup(20);
    const { check, done } = checks();
    const buy = deal(L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60));

    check("the reason is plain", trade.whyCannotTrade(p, buy) === "you need 60 coins (you have 20)", trade.whyCannotTrade(p, buy));
    const result = trade.carryOutTrade(p, buy);
    check("refused", result.ok === false && /Not yet: you need 60 coins/.test(result.reason), JSON.stringify(result));
    check("no coins taken, nothing given", coinsOf(p) === 20 && countIn(p, "minecraft:iron_sword") === 0);
    done();
});

test("selling: the items go, the coins arrive", () => {
    const p = setup(5);
    const { check, done } = checks();
    const sell = deal(L.sellDeal({ type: "minecraft:feather", amount: 3 }, 8));

    give(p, stack("minecraft:feather", 2));
    check("two feathers are not enough", trade.carryOutTrade(p, sell).ok === false && countIn(p, "minecraft:feather") === 2 && coinsOf(p) === 5);

    give(p, stack("minecraft:feather", 5));
    const result = trade.carryOutTrade(p, sell);
    check("with seven it goes through", result.ok === true && result.summary === "Sold Feather x3 for 8 coins.", JSON.stringify(result));
    check("three feathers left, eight coins arrived", countIn(p, "minecraft:feather") === 4 && coinsOf(p) === 13);
    done();
});

test("a sale that names no custom name takes the kind however it is named, and one that names it wants exactly that", () => {
    const p = setup(0);
    const { check, done } = checks();
    const anyGold = deal(L.sellDeal({ type: "minecraft:gold_ingot", amount: 1 }, 10));
    const shinyGold = deal(L.sellDeal({ type: "minecraft:gold_ingot", amount: 1, name: "Shiny" }, 50));

    give(p, stack("minecraft:gold_ingot", 1, (s) => { s.nameTag = "Renamed"; }));
    check("the plain deal takes the renamed ingot", trade.carryOutTrade(p, anyGold).ok === true && coinsOf(p) === 10);

    give(p, stack("minecraft:gold_ingot", 1));
    check("the Shiny deal does not take a plain one", trade.carryOutTrade(p, shinyGold).ok === false && coinsOf(p) === 10);

    give(p, stack("minecraft:gold_ingot", 1, (s) => { s.nameTag = "Shiny"; }));
    check("it takes a Shiny one", trade.carryOutTrade(p, shinyGold).ok === true && coinsOf(p) === 60 && countIn(p, "minecraft:gold_ingot") === 1);
    done();
});

test("trading item for item, with coins on top", () => {
    const p = setup(50);
    const { check, done } = checks();
    const swap = deal(L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 3 }], 10));

    give(p, stack("minecraft:gold_ingot", 3));
    const result = trade.carryOutTrade(p, swap);
    check("it goes through", result.ok === true && result.summary === "Traded Gold Ingot x3 + 10 coins for Diamond.", JSON.stringify(result));
    check("gold and coins went, the diamond came", countIn(p, "minecraft:gold_ingot") === 0 && coinsOf(p) === 40 && countIn(p, "minecraft:diamond") === 1);

    check("without the gold it is refused and nothing moves", trade.carryOutTrade(p, swap).ok === false && coinsOf(p) === 40 && countIn(p, "minecraft:diamond") === 1);
    done();
});

test("a trade asking for two kinds takes both or neither", () => {
    const p = setup(0);
    const { check, done } = checks();
    const swap = deal(L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 3 }, { type: "minecraft:emerald", amount: 2 }]));

    give(p, stack("minecraft:gold_ingot", 3));
    give(p, stack("minecraft:emerald", 1));
    check("one kind short: refused, and the gold stays", trade.carryOutTrade(p, swap).ok === false && countIn(p, "minecraft:gold_ingot") === 3 && countIn(p, "minecraft:emerald") === 1);

    give(p, stack("minecraft:emerald", 1));
    check("both there: it goes through", trade.carryOutTrade(p, swap).ok === true && countIn(p, "minecraft:gold_ingot") === 0 && countIn(p, "minecraft:emerald") === 0 && countIn(p, "minecraft:diamond") === 1);
    done();
});

test("a free gift costs nothing", () => {
    const p = setup(0);
    const gift = deal({ cost: { coins: 0, items: [] }, rewards: [{ kind: "item", item: { type: "minecraft:bread", amount: 2 } }] });
    const result = trade.carryOutTrade(p, gift);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Took Bread x2.");
    assert.equal(countIn(p, "minecraft:bread"), 2);
});

test("goods that cannot be made are refused before the coins move", () => {
    const p = setup(100);
    const { check, done } = checks();
    const broken = deal(L.buyDeal({ type: "minecraft:potion", amount: 1, potion: ["Nonsense", "Consume"] }, 25));

    const result = quietly(() => trade.carryOutTrade(p, broken));
    check("refused with a plain reason", result.ok === false && /cannot be made right now, so nothing was charged/.test(result.reason), JSON.stringify(result));
    check("no coins moved", coinsOf(p) === 100);
    done();
});

test("a full bag still delivers: the goods drop at the player's feet and the payment stands", () => {
    const p = setup(100);
    for (let i = 0; i < 36; i++) p.container.setItem(i, stack("minecraft:stone", 64));
    const buy = deal(L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60));

    const result = trade.carryOutTrade(p, buy);
    assert.equal(result.ok, true);
    assert.equal(result.dropped, 1);
    assert.equal(coinsOf(p), 40);
    assert.equal(fake.dimension("overworld").spawnedItems.length, 1);
});

test("a sale in a full bag works: the sold items make room", () => {
    const p = setup(0);
    for (let i = 0; i < 36; i++) p.container.setItem(i, stack("minecraft:stone", 64));
    p.container.setItem(7, stack("minecraft:feather", 3));
    const sell = deal(L.sellDeal({ type: "minecraft:feather", amount: 3 }, 8));
    const result = trade.carryOutTrade(p, sell);
    assert.equal(result.ok, true);
    assert.equal(coinsOf(p), 8);
    assert.equal(fake.dimension("overworld").spawnedItems.length, 0);
});

test("if the game throws part-way, every slot and the coins go back exactly", () => {
    const p = setup(50);
    const { check, done } = checks();
    const swap = deal(L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 3 }, { type: "minecraft:emerald", amount: 2 }], 10));

    give(p, stack("minecraft:gold_ingot", 5, (s) => { s.nameTag = "Keep my name"; }));
    give(p, stack("minecraft:emerald", 2));
    const before = bagText(p);

    // The second item taken fails: the engine throws on the first setItem after the gold has already been taken.
    const container = p.container;
    const realSet = container.setItem.bind(container);
    let calls = 0;
    container.setItem = (slot, s) => {
        calls++;
        if (calls === 2) throw new Error("the engine said no");
        return realSet(slot, s);
    };

    const result = quietly(() => trade.carryOutTrade(p, swap));
    container.setItem = realSet;

    check("it says nothing was charged", result.ok === false && /nothing was charged/.test(result.reason), JSON.stringify(result));
    check("the coins are back", coinsOf(p) === 50);
    check("every slot is as it was, names included", bagText(p) === before, `${bagText(p)} vs ${before}`);
    done();
});

test("a missing coins scoreboard stops a priced deal rather than charging nothing", () => {
    fake.reset();
    const p = fake.makePlayer("Ada", { inventory: true });
    const buy = deal(L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60));
    const gift = deal({ cost: { coins: 0, items: [] }, rewards: [{ kind: "item", item: { type: "minecraft:bread", amount: 1 } }] });

    assert.match(trade.whyCannotTrade(p, buy), /coins scoreboard/);
    assert.equal(trade.carryOutTrade(p, buy).ok, false);
    assert.equal(countIn(p, "minecraft:iron_sword"), 0);
    assert.equal(trade.carryOutTrade(p, gift).ok, true, "a deal with no coins in it does not need the scoreboard");
});

test("checking a deal only reads: it is safe where the engine forbids changes", () => {
    const p = setup(100);
    give(p, stack("minecraft:gold_ingot", 3));
    const swap = deal(L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 3 }], 10));

    fake.restricted = 1;
    try {
        assert.equal(trade.whyCannotTrade(p, swap), undefined);
        assert.equal(items.countOf(items.bagOf(p), { type: "minecraft:gold_ingot", amount: 1 }), 3);
        assert.equal(items.heldStack(p)?.typeId, "minecraft:gold_ingot");
    } finally {
        fake.restricted = 0;
    }
});

test("changing a bag is refused in restricted execution, as the engine refuses it", () => {
    const p = setup(100);
    give(p, stack("minecraft:gold_ingot", 3));
    fake.restricted = 1;
    try {
        assert.throws(() => items.takeFrom(items.bagOf(p), { type: "minecraft:gold_ingot", amount: 1 }), /restricted execution/);
    } finally {
        fake.restricted = 0;
    }
});

test("the held stack is the one in the selected slot", () => {
    const p = setup();
    p.container.setItem(3, stack("minecraft:diamond", 2));
    p.selectedSlotIndex = 3;
    assert.equal(items.heldStack(p).typeId, "minecraft:diamond");
    p.selectedSlotIndex = 4;
    assert.equal(items.heldStack(p), undefined, "an empty hand is undefined");
});
