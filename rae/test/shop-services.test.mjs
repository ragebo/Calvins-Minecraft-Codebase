import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, load } from "./helpers.mjs";

// logic/shop.ts, the second half: a deal can do something TO the customer (a potion effect, an enchantment on the item they
// hold, a tame mount, a teleport) as well as hand them goods, and can require them to be law or outlaw or to carry a bounty.
// The existing owner's NPCs are about a fifth services and 14 priced buttons gated by side, so these are the shapes they need.

const L = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

const base = () => {
    const made = L.newShop("habiti", "Habiti");
    assert.ok(made.ok, made.reason);
    return made.shop;
};

const add = (shop, deal) => {
    const result = L.addTrade(shop, deal);
    assert.ok(result.ok, result.reason);
    return result.shop;
};

const reward = (r, cost = { coins: 10, items: [] }) => ({ cost, rewards: [r] });
const place = { x: -251.5, y: 63, z: 186.5, dimension: "overworld", name: "Angeles" };

test("every service is a legal reward within its limits", () => {
    const { check, done } = checks();
    const tryDeal = (deal) => L.addTrade(base(), deal);

    check("an effect", tryDeal(L.effectDeal("regeneration", 10, 2, 20)).ok);
    check("an enchantment", tryDeal(L.enchantDeal("flame", 1, 100)).ok);
    check("a namespaced enchantment", tryDeal(L.enchantDeal("minecraft:power", 3, 75)).ok);
    check("a mount", tryDeal(L.mountDeal("minecraft:horse", 35)).ok);
    check("a teleport with a name", tryDeal(L.teleportDeal(place, 25)).ok);
    check("a teleport without a name", tryDeal(L.teleportDeal({ x: 1, y: 70, z: 2, dimension: "nether" }, 25)).ok);
    check("a free service is fine", tryDeal(L.effectDeal("regeneration", 10, 0, 0)).ok);
    done();
});

test("a service outside its limits is refused with the reason", () => {
    const { check, done } = checks();
    const refusal = (r) => { const result = L.addTrade(base(), reward(r)); return result.ok ? "" : result.reason; };

    check("an effect with a bad id", /effect needs an id/.test(refusal({ kind: "effect", effect: "Regen!", seconds: 10, amplifier: 0 })));
    check("an effect that lasts no time", /seconds from 1 to/.test(refusal({ kind: "effect", effect: "regeneration", seconds: 0, amplifier: 0 })));
    check("an effect that lasts too long", new RegExp(`to ${SHOP.maxEffectSeconds}`).test(refusal({ kind: "effect", effect: "regeneration", seconds: SHOP.maxEffectSeconds + 1, amplifier: 0 })));
    check("an effect too strong", /strength is a whole number/.test(refusal({ kind: "effect", effect: "regeneration", seconds: 10, amplifier: SHOP.maxAmplifier + 1 })));
    check("a negative strength", /strength is a whole number/.test(refusal({ kind: "effect", effect: "regeneration", seconds: 10, amplifier: -1 })));
    check("a fractional duration", /seconds from 1 to/.test(refusal({ kind: "effect", effect: "regeneration", seconds: 2.5, amplifier: 0 })));
    check("an enchantment with no id", /enchantment needs an id/.test(refusal({ kind: "enchant", enchantment: "", level: 1 })));
    check("an enchantment at level zero", /level is a whole number/.test(refusal({ kind: "enchant", enchantment: "flame", level: 0 })));
    check("a mount with a bare name", /animal id like minecraft:horse/.test(refusal({ kind: "mount", entity: "horse" })));
    check("a teleport with a missing coordinate", /needs x, y and z/.test(refusal({ kind: "teleport", x: 1, y: 2, dimension: "overworld" })));
    check("a teleport past the world border", /needs x, y and z/.test(refusal({ kind: "teleport", x: SHOP.maxCoordinate + 1, y: 2, z: 3, dimension: "overworld" })));
    check("a teleport to nowhere", /overworld, the nether or the end/.test(refusal({ kind: "teleport", x: 1, y: 2, z: 3, dimension: "mars" })));
    check("a teleport with a too-long place name", /place name/.test(refusal({ kind: "teleport", x: 1, y: 2, z: 3, dimension: "overworld", name: "n".repeat(SHOP.maxNameLength + 1) })));
    check("a reward of a kind nobody knows", /is an item, coins, an effect/.test(refusal({ kind: "wish" })));
    done();
});

test("a deal does each thing once: one teleport, one mount, each effect and enchantment a single time", () => {
    const { check, done } = checks();
    const many = (...rewards) => L.addTrade(base(), { cost: { coins: 10, items: [] }, rewards });
    const effect = (id) => ({ kind: "effect", effect: id, seconds: 10, amplifier: 0 });
    const enchant = (id) => ({ kind: "enchant", enchantment: id, level: 1 });

    check("two different effects are fine", many(effect("regeneration"), effect("speed")).ok);
    check("the same effect twice is not", !many(effect("regeneration"), effect("regeneration")).ok);
    check("two different enchantments are fine", many(enchant("flame"), enchant("power")).ok);
    check("the same enchantment twice is not", !many(enchant("flame"), enchant("flame")).ok);
    check("two teleports are not", !many({ kind: "teleport", ...place }, { kind: "teleport", ...place, x: 5 }).ok);
    check("two mounts are not", !many({ kind: "mount", entity: "minecraft:horse" }, { kind: "mount", entity: "minecraft:mule" }).ok);
    check("a mount and an effect together are fine", many({ kind: "mount", entity: "minecraft:horse" }, effect("speed")).ok);
    done();
});

test("who may take a deal: a side, a bounty, or both; an empty requirement is no requirement", () => {
    const { check, done } = checks();
    const deal = (requires) => ({ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires });

    const law = L.addTrade(base(), deal({ role: "law" }));
    check("law only", law.ok && law.trade.requires?.role === "law" && law.trade.requires.bounty === undefined);
    check("outlaw with a bounty", L.addTrade(base(), deal({ role: "outlaw", bounty: 100 })).ok);
    check("a bounty alone", L.addTrade(base(), deal({ bounty: 50 })).ok);
    check("an empty requirement is dropped", L.addTrade(base(), deal({})).trade?.requires === undefined);
    check("a side nobody has is refused", !L.addTrade(base(), deal({ role: "sheriff" })).ok);
    check("a zero bounty is refused (that is no requirement)", !L.addTrade(base(), deal({ bounty: 0 })).ok);
    check("a fractional bounty is refused", !L.addTrade(base(), deal({ bounty: 2.5 })).ok);
    check("a bounty over the cap is refused", !L.addTrade(base(), deal({ bounty: SHOP.maxBounty + 1 })).ok);
    check("a requirement that is not an object is refused", !L.addTrade(base(), deal("law")).ok);
    done();
});

test("services and requirements read as plain sentences", () => {
    const { check, done } = checks();
    const trade = (deal, id = "t1") => ({ id, ...deal });

    check("an effect", L.describeTrade(trade(L.effectDeal("regeneration", 10, 2, 20))) === "Regeneration 3 (10s) for 20 coins", L.describeTrade(trade(L.effectDeal("regeneration", 10, 2, 20))));
    check("an effect with a long name", L.describeTrade(trade(L.effectDeal("minecraft:jump_boost", 60, 0, 30))) === "Jump Boost 1 (60s) for 30 coins");
    check("an enchantment", L.describeTrade(trade(L.enchantDeal("minecraft:flame", 1, 100))) === "Flame 1 on the item you hold for 100 coins", L.describeTrade(trade(L.enchantDeal("minecraft:flame", 1, 100))));
    check("a mount", L.describeTrade(trade(L.mountDeal("minecraft:horse", 35))) === "Tame Horse for 35 coins");
    check("a named teleport", L.describeTrade(trade(L.teleportDeal(place, 25))) === "Teleport to Angeles for 25 coins");
    check("an unnamed teleport shows where", L.describeTrade(trade(L.teleportDeal({ x: 117.7, y: 64, z: 126.2, dimension: "overworld" }, 25))) === "Teleport to 118, 64, 126 for 25 coins");
    check("a free service", L.describeTrade(trade(L.effectDeal("regeneration", 5, 0, 0))) === "Free: Regeneration 1 (5s)");
    check("a requirement is added in brackets", L.describeTrade(trade({ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires: { role: "law" } })) === "Iron Sword for 60 coins (law only)");
    check("both requirements", L.describeRequirement({ role: "outlaw", bounty: 100 }) === "outlaw only, bounty 100+");
    check("a bounty alone", L.describeRequirement({ bounty: 50 }) === "bounty 50+");
    check("a sale with a requirement", L.describeTrade(trade({ ...L.sellDeal({ type: "minecraft:feather", amount: 3 }, 8), requires: { role: "outlaw" } })) === "Sell Feather x3 for 8 coins (outlaw only)");
    done();
});

test("a service deal has its own face, and what a customer is told afterwards says what happened", () => {
    const { check, done } = checks();
    const trade = (deal) => ({ id: "t1", ...deal });

    check("a paid service is a service", L.faceOf(trade(L.effectDeal("speed", 10, 0, 20))) === "service");
    check("a free service is a service", L.faceOf(trade(L.mountDeal("minecraft:horse", 0))) === "service");
    check("buying a service is told as a purchase", L.describeDone(trade(L.mountDeal("minecraft:horse", 35))) === "Bought Tame Horse for 35 coins.", L.describeDone(trade(L.mountDeal("minecraft:horse", 35))));
    check("a free service is told as taken", L.describeDone(trade(L.effectDeal("speed", 10, 0, 0))) === "Took Speed 1 (10s).");
    check("the older shapes are unchanged", L.faceOf(trade(L.buyDeal({ type: "minecraft:stick", amount: 1 }, 5))) === "buy" && L.describeDone(trade(L.buyDeal({ type: "minecraft:stick", amount: 1 }, 5))) === "Bought Stick for 5 coins.");
    done();
});

test("a service paid for with items (not coins) reads and works as one", () => {
    const deal = { cost: { coins: 0, items: [{ type: "minecraft:iron_pickaxe", amount: 1 }, { type: "minecraft:gold_ingot", amount: 2 }] }, rewards: [{ kind: "effect", effect: "strength", seconds: 300, amplifier: 0 }] };
    const added = L.addTrade(base(), deal);
    assert.ok(added.ok, added.reason);
    assert.equal(L.describeTrade(added.trade), "Strength 1 (300s) for Iron Pickaxe + Gold Ingot x2");
    assert.equal(L.faceOf(added.trade), "service");
});

test("a shop with every service and a requirement is saved and read back exactly", () => {
    let shop = base();
    shop = add(shop, L.effectDeal("regeneration", 10, 2, 20));
    shop = add(shop, L.enchantDeal("minecraft:flame", 1, 100));
    shop = add(shop, L.mountDeal("minecraft:mule", 15));
    shop = add(shop, L.teleportDeal(place, 25));
    shop = add(shop, L.teleportDeal({ x: 0, y: 64, z: 0, dimension: "the_end" }, 0));
    shop = add(shop, { ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires: { role: "law", bounty: 5 } });
    shop = add(shop, { ...L.effectDeal("invisibility", 60, 0, 50), requires: { role: "outlaw" } });
    shop = add(shop, { cost: { coins: 0, items: [] }, rewards: [{ kind: "effect", effect: "speed", seconds: 30, amplifier: 1 }, { kind: "mount", entity: "minecraft:donkey" }], requires: { bounty: 10 } });

    const text = L.serialize(shop);
    const back = L.parse(text);

    assert.ok(back.ok, back.reason);
    assert.deepEqual(back.value, shop);
    assert.equal(L.serialize(back.value), text);
    assert.ok(!text.includes("rewards") && !text.includes("requires") && !text.includes("teleport"), "long key names are not stored");
});

test("a damaged save of a service or a requirement is reported, never half-loaded", () => {
    const wrap = (trade) => `{"v":1,"id":"habiti","nm":"x","n":2,"t":[${trade}]}`;
    const cases = [
        '{"i":"t1","c":5,"r":[{"ef":["regeneration",0,0]}]}',
        '{"i":"t1","c":5,"r":[{"ef":["Regen!",10,0]}]}',
        '{"i":"t1","c":5,"r":[{"en":["flame",0]}]}',
        '{"i":"t1","c":5,"r":[{"mo":"horse"}]}',
        '{"i":"t1","c":5,"r":[{"tp":[1,2,3,"mars"]}]}',
        '{"i":"t1","c":5,"r":[{"tp":[1,2]}]}',
        '{"i":"t1","c":5,"r":[{"zz":1}]}',
        '{"i":"t1","c":5,"r":[{"ef":["speed",10,0]}],"q":{"r":"x"}}',
        '{"i":"t1","c":5,"r":[{"ef":["speed",10,0]}],"q":{"b":0}}',
        '{"i":"t1","c":5,"r":[{"ef":["speed",10,0]}],"q":"law"}',
        '{"i":"t1","c":5,"r":[{"ef":["speed",10,0]},{"ef":["speed",20,1]}]}'
    ];

    for (const trade of cases) {
        let result;
        assert.doesNotThrow(() => { result = L.parse(wrap(trade)); }, trade);
        assert.equal(result.ok, false, `accepted ${trade}`);
        assert.ok(result.reason.length > 0);
    }

    assert.equal(L.parse(wrap('{"i":"t1","c":5,"r":[{"ef":["speed",10,0]}],"q":{"r":"l","b":5}}')).ok, true);
    assert.equal(L.parse(wrap('{"i":"t1","c":5,"r":[{"ef":["speed",10,0]}],"q":{}}')).ok, true, "an empty requirement is simply no requirement");
});

test("a requirement can be set, kept, changed and cleared on a deal that already exists", () => {
    const { check, done } = checks();
    let shop = add(base(), L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60));

    const set = L.updateTrade(shop, "t1", { requires: { role: "law" } });
    check("it can be set", set.ok && set.shop.trades[0].requires?.role === "law");

    const kept = L.updateTrade(set.shop, "t1", { cost: { coins: 70, items: [] } });
    check("a price change keeps it", kept.ok && kept.shop.trades[0].requires?.role === "law" && kept.shop.trades[0].cost.coins === 70);

    const changed = L.updateTrade(kept.shop, "t1", { requires: { role: "outlaw", bounty: 20 } });
    check("it can be changed", changed.ok && changed.shop.trades[0].requires?.role === "outlaw" && changed.shop.trades[0].requires.bounty === 20);

    const cleared = L.updateTrade(changed.shop, "t1", { requires: undefined });
    check("naming it as undefined clears it", cleared.ok && cleared.shop.trades[0].requires === undefined);

    check("an illegal one is refused and changes nothing", !L.updateTrade(cleared.shop, "t1", { requires: { bounty: -5 } }).ok);
    shop = cleared.shop;
    check("its signature moves when the requirement does", L.signature(set.shop.trades[0]) !== L.signature(cleared.shop.trades[0]));
    done();
});

test("a price change reaches a service deal's cost", () => {
    const shop = add(base(), L.effectDeal("regeneration", 10, 2, 20));
    const priced = L.updateTrade(shop, "t1", L.withPrice(shop.trades[0], 35));
    assert.ok(priced.ok, priced.reason);
    assert.equal(L.priceOf(priced.shop.trades[0]), 35);
    assert.equal(priced.shop.trades[0].rewards[0].seconds, 10, "the service itself is untouched");
});

test("a teleport keeps decimal and negative coordinates exactly", () => {
    const shop = add(base(), L.teleportDeal({ x: -251.5, y: 63.25, z: -0.5, dimension: "nether" }, 1));
    const back = L.parse(L.serialize(shop));
    assert.ok(back.ok);
    const [teleport] = back.value.trades[0].rewards;
    assert.deepEqual([teleport.x, teleport.y, teleport.z, teleport.dimension], [-251.5, 63.25, -0.5, "nether"]);
});
