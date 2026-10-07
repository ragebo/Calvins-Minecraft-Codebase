import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks } from "./helpers.mjs";

// core/shopservices.ts and core/shoptrade.ts, the second half: a deal that does something TO the customer (a potion effect, an
// enchantment on the item they hold, a tame mount, a teleport) and a deal only one side or only a wanted man may take. The
// contract is the same as for goods: nothing is charged unless the game can do all of it, and if it throws part-way every
// coin, every slot and every service already done is put back.

const { ItemStack, EnchantmentTypes } = fakeApi;
const trade = await load("core/shoptrade.js");
const services = await load("core/shopservices.js");
const state = await load("core/state.js");
const L = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

const base = L.newShop("habiti", "Habiti").shop;

const deal = (spec) => {
    const added = L.addTrade(base, spec);
    assert.ok(added.ok, added.reason);
    return added.trade;
};

function setup({ coins = 100, bounty = 0, role = null } = {}) {
    fake.reset();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    const player = fake.makePlayer("Ada", { inventory: true });
    fake.setScore("coins", player, coins);
    fake.setScore("bounty", player, bounty);
    state.clearRecords();
    if (role) state.update(player, { role });
    return player;
}

const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player);
const stack = (type, amount = 1, decorate) => { const s = new ItemStack(type, amount); decorate?.(s); return s; };
const hold = (player, s) => player.container.setItem(player.selectedSlotIndex, s);
const heldEnchants = (player) => (player.container.getItem(player.selectedSlotIndex)?.getComponent("minecraft:enchantable")?.getEnchantments() ?? []).map((e) => `${e.type.id}:${e.level}`);
const flame = () => EnchantmentTypes.get("minecraft:flame");
const bagText = (player) => Array.from({ length: 36 }, (_, i) => player.container.getItem(i)).map((s) => (s ? `${s.typeId}x${s.amount}${s.enchantments?.length ? "*" : ""}` : "-")).join(" ");
const quietly = (fn) => { const original = console.error; console.error = () => {}; try { return fn(); } finally { console.error = original; } };
const spawned = () => fake.dimension("overworld").spawned.filter((e) => e.isValid);

const place = { x: -251.5, y: 63, z: 186.5, dimension: "overworld", name: "Angeles" };

// ---------------------------------------------------------------------------------------------------------
// Each service
// ---------------------------------------------------------------------------------------------------------

test("an effect is bought: the coins go and the effect lands on the customer for the seconds paid for", () => {
    const p = setup();
    const { check, done } = checks();
    const heal = deal(L.effectDeal("regeneration", 10, 2, 20));

    check("nothing in the way", trade.whyCannotTrade(p, heal) === undefined);
    const result = trade.carryOutTrade(p, heal);

    check("it goes through and says what was bought", result.ok === true && result.summary === "Bought Regeneration 3 (10s) for 20 coins.", JSON.stringify(result));
    check("20 coins gone", coinsOf(p) === 80);
    check("the effect: right kind, in ticks, at the right strength", p.effects.length === 1 && p.effects[0].id === "regeneration" && p.effects[0].duration === 200 && p.effects[0].amplifier === 2, JSON.stringify(p.effects));
    done();
});

test("an effect the game does not know is refused before a coin moves, and says what to type instead", () => {
    const p = setup();
    const { check, done } = checks();
    const typo = deal(L.effectDeal("regen", 10, 0, 20));

    check("the reason names the effect", /does not know the effect regen/.test(trade.whyCannotTrade(p, typo)), trade.whyCannotTrade(p, typo));
    const result = trade.carryOutTrade(p, typo);
    check("refused", result.ok === false && /Not yet: the game does not know the effect regen/.test(result.reason), JSON.stringify(result));
    check("no coins taken, no effect", coinsOf(p) === 100 && p.effects.length === 0);
    done();
});

test("an enchantment goes on the item in hand: the item comes back changed, and the coins go", () => {
    const p = setup();
    const { check, done } = checks();
    const flameBow = deal(L.enchantDeal("minecraft:flame", 1, 100));

    hold(p, stack("minecraft:bow"));
    const result = trade.carryOutTrade(p, flameBow);

    check("it goes through", result.ok === true && result.summary === "Bought Flame 1 on the item you hold for 100 coins.", JSON.stringify(result));
    check("the held bow has the enchantment (put back with setItem, since the bag answers copies)", heldEnchants(p).join() === "minecraft:flame:1", heldEnchants(p).join());
    check("100 coins gone", coinsOf(p) === 0);
    done();
});

test("an enchantment is refused, with nothing charged, when there is nothing to put it on", () => {
    const p = setup();
    const { check, done } = checks();
    const flameBow = deal(L.enchantDeal("minecraft:flame", 1, 100));

    check("an empty hand", /hold the item you want enchanted/.test(trade.whyCannotTrade(p, flameBow)));

    hold(p, stack("minecraft:arrow", 5));
    check("an item that cannot be enchanted at all", /arrow cannot be enchanted/.test(trade.whyCannotTrade(p, flameBow)), trade.whyCannotTrade(p, flameBow));

    hold(p, stack("minecraft:iron_sword"));
    check("an item the enchantment does not fit", /Flame 1 does not fit the iron sword you hold/.test(trade.whyCannotTrade(p, flameBow)), trade.whyCannotTrade(p, flameBow));

    const tooHigh = deal(L.enchantDeal("minecraft:flame", 9, 100));
    hold(p, stack("minecraft:bow"));
    check("a level the game refuses", /cannot go on the bow you hold/.test(trade.whyCannotTrade(p, tooHigh)), trade.whyCannotTrade(p, tooHigh));

    const nonsense = deal(L.enchantDeal("minecraft:nonsense", 1, 100));
    check("an enchantment the game does not know", /does not know the enchantment minecraft:nonsense/.test(trade.whyCannotTrade(p, nonsense)));

    check("through all of that no coin moved", coinsOf(p) === 100 && trade.carryOutTrade(p, nonsense).ok === false && coinsOf(p) === 100);
    done();
});

test("a bare enchantment id works as well as a namespaced one", () => {
    const p = setup();
    hold(p, stack("minecraft:bow"));
    assert.equal(trade.carryOutTrade(p, deal(L.enchantDeal("power", 3, 50))).ok, true);
    assert.equal(heldEnchants(p).join(), "minecraft:power:3");
});

test("a mount appears in front of the customer, tamed to them, and the coins go", () => {
    const p = setup();
    const { check, done } = checks();

    const result = trade.carryOutTrade(p, deal(L.mountDeal("minecraft:horse", 35)));
    const [horse] = spawned();

    check("it goes through", result.ok === true && result.summary === "Bought Tame Horse for 35 coins.", JSON.stringify(result));
    check("one horse, and nothing else, was spawned", spawned().length === 1 && horse?.typeId === "minecraft:horse");
    check("it is tamed to the buyer", horse?.tamed === true && horse.tamedBy === p);
    check("it stands in front of the buyer", Math.abs(horse.location.z - (p.location.z + SHOP.mountSpawnDistance)) < 0.01 && Math.abs(horse.location.x - p.location.x) < 0.01, JSON.stringify(horse.location));
    check("35 coins gone", coinsOf(p) === 65);
    done();
});

test("a bare animal name works, and one the game does not know is refused with the usual ones named", () => {
    const p = setup();
    const { check, done } = checks();

    check("mule without a namespace", trade.carryOutTrade(p, deal(L.mountDeal("minecraft:mule", 15))).ok === true);

    const unknown = deal(L.mountDeal("minecraft:unicorn", 15));
    check("an unknown animal is refused and says what to try", /does not know the animal minecraft:unicorn \(try horse, mule, donkey\)/.test(trade.whyCannotTrade(p, unknown)), trade.whyCannotTrade(p, unknown));
    done();
});

test("an animal that cannot be tamed is undone: the animal is removed and nothing is charged", () => {
    const p = setup();
    const { check, done } = checks();

    const result = quietly(() => trade.carryOutTrade(p, deal(L.mountDeal("minecraft:cow", 35))));

    check("refused", result.ok === false && /nothing was charged/.test(result.reason), JSON.stringify(result));
    check("the cow that was spawned is gone again", spawned().length === 0);
    check("the coins are back", coinsOf(p) === 100);
    done();
});

test("a teleport takes the customer there, across dimensions too, and the coins go", () => {
    const p = setup();
    const { check, done } = checks();

    const result = trade.carryOutTrade(p, deal(L.teleportDeal(place, 25)));
    check("it goes through and says where", result.ok === true && result.summary === "Bought Teleport to Angeles for 25 coins.", JSON.stringify(result));
    check("the customer is there", p.location.x === -251.5 && p.location.y === 63 && p.location.z === 186.5);
    check("25 coins gone", coinsOf(p) === 75);

    const nether = trade.carryOutTrade(p, deal(L.teleportDeal({ x: 10, y: 70, z: 10, dimension: "nether" }, 0)));
    check("a free one into the nether", nether.ok === true && p.dimension.id === "minecraft:nether" && coinsOf(p) === 75, p.dimension.id);
    done();
});

test("a bought service can be paid for in items instead of coins", () => {
    const p = setup({ coins: 0 });
    const pick = deal({ cost: { coins: 0, items: [{ type: "minecraft:gold_ingot", amount: 2 }] }, rewards: [{ kind: "effect", effect: "strength", seconds: 300, amplifier: 0 }] });

    assert.match(trade.whyCannotTrade(p, pick), /you need Gold Ingot x2 \(you have 0\)/);
    p.container.addItem(stack("minecraft:gold_ingot", 3));
    const result = trade.carryOutTrade(p, pick);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(p.container.getItem(0).amount, 1, "two ingots were taken");
    assert.equal(p.effects[0].id, "strength");
});

// ---------------------------------------------------------------------------------------------------------
// All or nothing, with services
// ---------------------------------------------------------------------------------------------------------

test("goods, an effect and a teleport in one deal: if the teleport fails, the effect is taken off and the goods and coins go back", () => {
    const p = setup();
    const { check, done } = checks();
    const bundle = deal({
        cost: { coins: 50, items: [] },
        rewards: [{ kind: "item", item: { type: "minecraft:bread", amount: 3 } }, { kind: "effect", effect: "speed", seconds: 30, amplifier: 0 }, { kind: "teleport", ...place }]
    });

    const before = bagText(p);
    const realTeleport = p.teleport;
    p.teleport = () => { throw new Error("the destination is not loaded"); };

    let result;
    try {
        result = quietly(() => trade.carryOutTrade(p, bundle));
    } finally {
        p.teleport = realTeleport;
    }

    check("refused with nothing charged", result.ok === false && /nothing was charged/.test(result.reason), JSON.stringify(result));
    check("the effect that had already landed was taken off", p.effects.length === 0, JSON.stringify(p.effects));
    check("the coins are back and the bread is gone", coinsOf(p) === 100 && bagText(p) === before, `${coinsOf(p)} ${bagText(p)}`);
    done();
});

test("a rollback keeps going when the game refuses to put one slot back", () => {
    const p = setup();
    const { check, done } = checks();

    // Slot 0 holds something the deal never touches and the engine will not let be rewritten; the gold and the emeralds sit after it.
    p.container.setItem(0, stack("minecraft:stone", 5));
    p.container.setItem(1, stack("minecraft:gold_ingot", 5));
    p.container.setItem(2, stack("minecraft:emerald", 2));

    const swap = deal(L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 3 }, { type: "minecraft:emerald", amount: 2 }], 10));
    const before = bagText(p);

    const bag = p.container;
    const realSet = bag.setItem.bind(bag);
    let calls = 0;
    bag.setItem = (slot, s) => {
        calls++;
        if (calls === 2) throw new Error("the engine said no");          // taking the emeralds fails: the deal is part-way through
        if (slot === 0) throw new Error("slot 0 cannot be rewritten");   // and the rollback cannot touch slot 0
        return realSet(slot, s);
    };

    let result;
    try {
        result = quietly(() => trade.carryOutTrade(p, swap));
    } finally {
        bag.setItem = realSet;
    }

    check("refused with nothing charged", result.ok === false && /nothing was charged/.test(result.reason), JSON.stringify(result));
    check("the slots after the stubborn one were still put back", bagText(p) === before, `${bagText(p)} vs ${before}`);
    check("and so were the coins", coinsOf(p) === 100);
    done();
});

test("each service can be undone on its own: an effect is taken off, a mount is removed, a teleport brings the customer back", () => {
    const p = setup();
    const { check, done } = checks();

    const prepare = (reward) => {
        const preparation = services.prepareService(p, reward);
        assert.ok(preparation.ok, preparation.reason);
        return preparation.prepared;
    };

    const speed = prepare({ kind: "effect", effect: "speed", seconds: 30, amplifier: 0 });
    speed.apply();
    check("an effect lands", p.effects.length === 1, JSON.stringify(p.effects));
    speed.undo();
    check("and is taken off again", p.effects.length === 0, JSON.stringify(p.effects));

    const horse = prepare({ kind: "mount", entity: "minecraft:horse" });
    horse.apply();
    check("a mount appears", spawned().length === 1);
    horse.undo();
    check("and is removed again", spawned().length === 0);

    const start = { ...p.location };
    const trip = prepare({ kind: "teleport", x: 10, y: 70, z: 10, dimension: "nether" });
    trip.apply();
    check("a teleport takes the customer away, into the nether", p.location.x === 10 && p.dimension.id === "minecraft:nether", `${p.location.x} ${p.dimension.id}`);
    trip.undo();
    check("and undoing it brings them back to where they stood, in the dimension they were in", p.location.x === start.x && p.location.y === start.y && p.location.z === start.z && p.dimension.id === "minecraft:overworld", `${JSON.stringify(p.location)} ${p.dimension.id}`);

    check("undoing one that was never done does nothing", (() => { prepare({ kind: "teleport", ...place }).undo(); return p.location.x === start.x; })());
    done();
});

test("the game's lookups may want the minecraft: namespace or may not: both are tried", () => {
    setup();
    const { check, done } = checks();
    const { EffectTypes, EntityTypes } = fakeApi;

    // Narrows what `kind.get` answers to the ids `accepts` approves, as a game that is strict about the namespace would be.
    const strictly = (kind, accepts, body) => {
        const real = kind.get;
        kind.get = (id) => (accepts(id) ? real(id) : undefined);
        try { body(); } finally { kind.get = real; }
    };
    const namespaced = (id) => id.startsWith("minecraft:");
    const bare = (id) => !id.includes(":");

    strictly(EffectTypes, namespaced, () => check("an effect typed bare, for a game that wants the namespace", services.findEffect("speed") !== undefined));
    strictly(EffectTypes, bare, () => check("an effect typed bare, for a game that wants none", services.findEffect("speed") !== undefined));
    strictly(EnchantmentTypes, namespaced, () => check("an enchantment typed bare, for a game that wants the namespace", services.findEnchantment("flame")?.id === "minecraft:flame"));
    strictly(EntityTypes, namespaced, () => check("an animal typed bare, for a game that wants the namespace", services.findAnimal("horse")?.id === "minecraft:horse"));

    strictly(EffectTypes, namespaced, () => {
        const p = setup();
        check("a whole deal for it still goes through", trade.carryOutTrade(p, deal(L.effectDeal("speed", 30, 0, 10))).ok === true && p.effects.length === 1);
    });

    check("an id the game has never heard of is still not found", services.findEffect("nonsense") === undefined && services.findEnchantment("nonsense") === undefined && services.findAnimal("nonsense") === undefined);
    done();
});

test("a mount and a teleport: if the teleport fails, the mount that was bought is removed", () => {
    const p = setup();
    const both = deal({ cost: { coins: 40, items: [] }, rewards: [{ kind: "mount", entity: "minecraft:horse" }, { kind: "teleport", ...place }] });

    p.teleport = () => { throw new Error("no"); };
    const result = quietly(() => trade.carryOutTrade(p, both));

    assert.equal(result.ok, false);
    assert.equal(spawned().length, 0, "the horse is gone");
    assert.equal(coinsOf(p), 100);
});

test("an enchantment that fails to land leaves the item and the coins exactly as they were", () => {
    const p = setup();
    const { check, done } = checks();

    hold(p, stack("minecraft:bow"));
    const before = bagText(p);
    const flameBow = deal(L.enchantDeal("minecraft:flame", 1, 100));

    // The bag refuses the changed item being put back: the engine says no mid-deal.
    const bag = p.container;
    const realSet = bag.setItem.bind(bag);
    let calls = 0;
    bag.setItem = (slot, s) => {
        calls++;
        if (s?.typeId === "minecraft:bow" && calls <= 2) throw new Error("the engine said no");
        return realSet(slot, s);
    };

    let result;
    try {
        result = quietly(() => trade.carryOutTrade(p, flameBow));
    } finally {
        bag.setItem = realSet;
    }

    check("refused", result.ok === false && /nothing was charged/.test(result.reason), JSON.stringify(result));
    check("the bow is plain again and the coins are back", heldEnchants(p).length === 0 && coinsOf(p) === 100 && bagText(p) === before, `${heldEnchants(p)} ${coinsOf(p)} ${bagText(p)}`);
    done();
});

test("an enchantment the same deal's payment would take away is undone cleanly", () => {
    const p = setup({ coins: 0 });

    // Pay with the very bow that should be enchanted: the item is gone by the time the enchantment lands.
    const silly = deal({ cost: { coins: 0, items: [{ type: "minecraft:bow", amount: 1 }] }, rewards: [{ kind: "enchant", enchantment: "minecraft:flame", level: 1 }] });
    hold(p, stack("minecraft:bow"));

    const result = quietly(() => trade.carryOutTrade(p, silly));

    assert.equal(result.ok, false);
    assert.equal(p.container.getItem(p.selectedSlotIndex)?.typeId, "minecraft:bow", "the bow is still in the bag");
    assert.equal(heldEnchants(p).length, 0);
});

// ---------------------------------------------------------------------------------------------------------
// Who may take it
// ---------------------------------------------------------------------------------------------------------

test("a deal for law is refused to everyone else, with the reason", () => {
    const { check, done } = checks();
    const lawOnly = deal({ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires: { role: "law" } });

    const law = setup({ role: "law" });
    check("a law player may", trade.whyCannotTrade(law, lawOnly) === undefined && trade.carryOutTrade(law, lawOnly).ok === true);

    const outlaw = setup({ role: "outlaw" });
    check("an outlaw may not", trade.whyCannotTrade(outlaw, lawOnly) === "only law players can do this");
    const refused = trade.carryOutTrade(outlaw, lawOnly);
    check("and is told, with nothing charged", refused.ok === false && /Not yet: only law players can do this/.test(refused.reason) && coinsOf(outlaw) === 100);

    const nobody = setup({ role: null });
    check("neither may a player with no side yet (no round has started)", trade.whyCannotTrade(nobody, lawOnly) === "only law players can do this");
    done();
});

test("a deal for outlaws is the mirror of it", () => {
    const outlawsOnly = deal({ ...L.effectDeal("invisibility", 60, 0, 50), requires: { role: "outlaw" } });

    const outlaw = setup({ role: "outlaw" });
    assert.equal(trade.carryOutTrade(outlaw, outlawsOnly).ok, true);
    assert.equal(outlaw.effects[0].id, "invisibility");

    const law = setup({ role: "law" });
    assert.equal(trade.whyCannotTrade(law, outlawsOnly), "only outlaw players can do this");
});

test("a bounty requirement needs that bounty, and says what the customer has", () => {
    const { check, done } = checks();
    const wanted = deal({ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires: { bounty: 50 } });

    const small = setup({ bounty: 20 });
    check("too little", trade.whyCannotTrade(small, wanted) === "you need a bounty of 50 (you have 20)");
    check("refused with nothing charged", trade.carryOutTrade(small, wanted).ok === false && coinsOf(small) === 100);

    const big = setup({ bounty: 50 });
    check("exactly enough", trade.carryOutTrade(big, wanted).ok === true);
    done();
});

test("side and bounty together: both must hold", () => {
    const both = deal({ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires: { role: "outlaw", bounty: 100 } });

    assert.equal(trade.whyCannotTrade(setup({ role: "outlaw", bounty: 100 }), both), undefined);
    assert.match(trade.whyCannotTrade(setup({ role: "outlaw", bounty: 10 }), both), /bounty of 100/);
    assert.match(trade.whyCannotTrade(setup({ role: "law", bounty: 500 }), both), /only outlaw players/);
});

test("a requirement is checked before the price, so a customer who may not is not told they are also short", () => {
    const dear = deal({ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 999), requires: { role: "law" } });
    assert.equal(trade.whyCannotTrade(setup({ coins: 5, role: "outlaw" }), dear), "only law players can do this");
});

test("a missing bounty scoreboard stops a bounty requirement rather than failing everyone silently", () => {
    fake.reset();
    fake.addObjective("coins");
    const p = fake.makePlayer("Ada", { inventory: true });
    const wanted = deal({ ...L.buyDeal({ type: "minecraft:stick", amount: 1 }, 1), requires: { bounty: 5 } });
    assert.match(trade.whyCannotTrade(p, wanted), /bounty scoreboard has not been made yet/);
});

// ---------------------------------------------------------------------------------------------------------
// Reads only
// ---------------------------------------------------------------------------------------------------------

test("asking whether a customer can take a deal changes nothing, even for services, and is safe where the engine forbids changes", () => {
    const p = setup({ role: "law", bounty: 100 });
    hold(p, stack("minecraft:bow"));
    const everything = deal({
        cost: { coins: 10, items: [] },
        rewards: [{ kind: "effect", effect: "speed", seconds: 30, amplifier: 0 }, { kind: "enchant", enchantment: "minecraft:flame", level: 1 }, { kind: "mount", entity: "minecraft:horse" }, { kind: "teleport", ...place }],
        requires: { role: "law", bounty: 50 }
    });

    const before = JSON.stringify({ coins: coinsOf(p), bag: bagText(p), effects: p.effects, at: p.location, entities: spawned().length });

    fake.restricted = 1;
    try {
        assert.equal(trade.whyCannotTrade(p, everything), undefined);
    } finally {
        fake.restricted = 0;
    }

    assert.equal(JSON.stringify({ coins: coinsOf(p), bag: bagText(p), effects: p.effects, at: p.location, entities: spawned().length }), before);
});

test("services are done in an order that leaves nothing behind: the enchantment first, the teleport last", () => {
    const order = services.inOrder([
        { kind: "teleport", ...place },
        { kind: "mount", entity: "minecraft:horse" },
        { kind: "effect", effect: "speed", seconds: 1, amplifier: 0 },
        { kind: "enchant", enchantment: "flame", level: 1 }
    ]).map((r) => r.kind);
    assert.deepEqual(order, ["enchant", "effect", "mount", "teleport"]);
});

test("one deal does all four services in order, and a customer ends up where the teleport sent them with everything else done", () => {
    const p = setup({ coins: 300 });
    hold(p, stack("minecraft:bow"));
    const everything = deal({
        cost: { coins: 200, items: [] },
        rewards: [{ kind: "teleport", ...place }, { kind: "mount", entity: "minecraft:horse" }, { kind: "effect", effect: "speed", seconds: 30, amplifier: 1 }, { kind: "enchant", enchantment: "minecraft:flame", level: 1 }]
    });

    const result = trade.carryOutTrade(p, everything);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(coinsOf(p), 100);
    assert.equal(heldEnchants(p).join(), "minecraft:flame:1");
    assert.equal(p.effects[0].id, "speed");
    assert.equal(spawned().length, 1);
    assert.equal(p.location.x, -251.5);
});
