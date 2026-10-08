import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks } from "./helpers.mjs";

// core/shopnpc.ts: where a shop's NPC is, and bringing it to the builder from wherever that is. The point of it all: an NPC in an
// area nobody is near is not loaded, so a script cannot see it, and "bring it here" used to make a SECOND NPC whenever it could not
// find the first. Now the world remembers where each NPC was last put or seen; bringing one loads that area for a moment (a
// temporary ticking area), moves the NPC and lets the area go; and a new NPC is made only when the remembered place was loaded
// and held none. When it cannot tell (the area will not load) it makes nothing and says so.

const { PlayerPermissionLevel } = fakeApi;
const store = await load("core/shopstore.js");
const npcs = await load("core/shopnpc.js");
const edit = await load("core/shopedit.js");
const { SHOP } = await load("config/balance.js");

const FAR = { x: 900, y: 70, z: 900 };

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Lets game time pass while the promises it starts get to run, until `promise` settles (or `ticks` have passed), then answers it. */
async function finish(promise, ticks = 60) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < ticks && !settled; i++) { fake.advance(1); await settle(); }
    return promise;
}

function setup() {
    fake.reset();
    fake.advance(1);
    store.forgetLoaded();
    const op = fake.makePlayer("Op", { inventory: true, permission: PlayerPermissionLevel.Operator });
    const made = edit.createShop(op, "Habiti");
    assert.ok(made.ok, made.reason);
    return { op, shop: made.shop };
}

/** The shop's NPC: made in front of the builder, carried to a far corner nobody is near, remembered there, and out of sight. */
function strand(op, shop, at = FAR, dimension = "overworld") {
    const npc = npcs.spawnShopNpc(op, shop);
    npc.teleport(at, { dimension: fake.dimension(dimension) });
    npcs.rememberSpot(shop.id, npc);
    fake.setUnloaded(dimension, [{ from: { x: at.x - 20, y: -64, z: at.z - 20 }, to: { x: at.x + 20, y: 320, z: at.z + 20 } }]);
    fake.hideUnloadedEntities = true;
    return npc;
}

/** Records every ticking area the code asks for. */
function watchAreas() {
    const manager = world.tickingAreaManager;
    const asked = [];
    const real = manager.createTickingArea;
    manager.createTickingArea = (id, options) => { asked.push({ id, from: { ...options.from }, to: { ...options.to }, dimension: options.dimension }); return real.call(manager, id, options); };
    return { asked, stop() { manager.createTickingArea = real; } };
}

const near = (npc, op) => Math.hypot(npc.location.x - op.location.x, npc.location.z - op.location.z) < 5;

// ---------------------------------------------------------------------------------------------------------
// Remembering where an NPC is
// ---------------------------------------------------------------------------------------------------------

test("an NPC's place is remembered when it is made, moved or bound, in whole blocks, and let go when its shop is retired", () => {
    const { op, shop } = setup();
    const { check, done } = checks();

    check("nothing is remembered before there is an NPC", npcs.recallSpot("habiti") === undefined);

    const npc = npcs.spawnShopNpc(op, shop);
    check("making one remembers where, rounded to whole blocks", JSON.stringify(npcs.recallSpot("habiti")) === JSON.stringify({ x: 0, y: 64, z: 2, dimension: "overworld" }), JSON.stringify(npcs.recallSpot("habiti")));

    npc._location = { x: -10.4, y: 70.6, z: 33.5 };
    npcs.rememberSpot("habiti", npc);
    check("seeing it somewhere else remembers that instead", JSON.stringify(npcs.recallSpot("habiti")) === JSON.stringify({ x: -10, y: 71, z: 34, dimension: "overworld" }), JSON.stringify(npcs.recallSpot("habiti")));

    const stray = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 5, y: 65, z: 6 }, dimension: fake.dimension("nether") });
    npcs.bindNpc(stray, { id: "other", name: "Other" });
    check("binding a plain NPC remembers it too, in its dimension", JSON.stringify(npcs.recallSpot("other")) === JSON.stringify({ x: 5, y: 65, z: 6, dimension: "nether" }));

    npcs.retireNpcs("habiti");
    check("retiring the shop's NPCs lets go of the memory", npcs.recallSpot("habiti") === undefined);
    done();
});

test("remembering writes only when the place is new, and never throws", () => {
    const { op, shop } = setup();
    const npc = npcs.spawnShopNpc(op, shop);

    let writes = 0;
    const real = world.setDynamicProperty;
    world.setDynamicProperty = (...args) => { writes++; return real.apply(world, args); };
    try {
        npcs.rememberSpot("habiti", npc);
        npcs.rememberSpot("habiti", npc);
        assert.equal(writes, 0, "the same place again is not written again");

        npc._location = { x: 40, y: 64, z: 40 };
        npcs.rememberSpot("habiti", npc);
        assert.equal(writes, 1, "a new place is written once");

        npc.remove();
        assert.doesNotThrow(() => npcs.rememberSpot("habiti", npc), "an NPC that is gone cannot be read, and that is not an error");
        assert.doesNotThrow(() => npcs.forgetSpot("nobody"));
    } finally {
        world.setDynamicProperty = real;
    }
});

test("what is remembered but cannot be read is ignored, not trusted", () => {
    const { check, done } = checks();
    setup();

    for (const [label, text] of [["not text of the right shape", "garbage"], ["an unknown dimension", "mars|1|2|3"], ["a word for a number", "overworld|a|b|c"], ["a missing part", "overworld|1|2"]]) {
        world.setDynamicProperty("rae:shop:at:habiti", text);
        check(label, npcs.recallSpot("habiti") === undefined, JSON.stringify(npcs.recallSpot("habiti")));
    }

    world.setDynamicProperty("rae:shop:at:habiti", 42);
    check("a number where text should be", npcs.recallSpot("habiti") === undefined);
    done();
});

test("where an NPC is reads in a few words: loaded here, several loaded, not loaded but remembered, or unknown", () => {
    const { op, shop } = setup();
    const { check, done } = checks();

    check("never made: none found", npcs.whereIsNpc("habiti", []) === "none found loaded");

    const npc = npcs.spawnShopNpc(op, shop);
    check("loaded: where it stands", npcs.whereIsNpc("habiti", [npc]) === "at 0, 64, 2 in the overworld", npcs.whereIsNpc("habiti", [npc]));

    const second = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 9, y: 64, z: 9 } });
    check("two loaded: says how many and the first", npcs.whereIsNpc("habiti", [npc, second]) === "2 loaded, the first at 0, 64, 2 in the overworld", npcs.whereIsNpc("habiti", [npc, second]));

    check("none loaded but one remembered: says where it was last", npcs.whereIsNpc("habiti", []) === "not loaded, last at 0, 64, 2 in the overworld", npcs.whereIsNpc("habiti", []));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Bringing an NPC that is loaded
// ---------------------------------------------------------------------------------------------------------

test("a loaded NPC is brought at once: no area is loaded, its name is refreshed, and its new place is remembered", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    const watch = watchAreas();

    try {
        const npc = npcs.spawnShopNpc(op, shop);
        npc._location = { x: 300, y: 64, z: 300 };
        npc.nameTag = "Old name";

        const brought = await finish(npcs.bringShopNpc(op, { id: "habiti", name: "Habiti the Horseman" }, false));

        check("it says it was here", brought.how === "here", JSON.stringify(brought));
        check("it came to the builder", near(npc, op));
        check("with the shop's current name", npc.nameTag === "Habiti the Horseman");
        check("and that place is what is remembered now", npcs.recallSpot("habiti").x === Math.round(npc.location.x) && npcs.recallSpot("habiti").z === Math.round(npc.location.z));
        check("no ticking area was asked for", watch.asked.length === 0);
        check("still the one NPC", npcs.npcsOf("habiti").length === 1);
    } finally {
        watch.stop();
    }
    done();
});

test("a loaded NPC in another dimension comes across to the builder's", async () => {
    const { op, shop } = setup();
    const npc = npcs.spawnShopNpc(op, shop);
    npc.teleport({ x: 10, y: 70, z: 10 }, { dimension: fake.dimension("nether") });

    const brought = await finish(npcs.bringShopNpc(op, shop, false));

    assert.equal(brought.how, "here");
    assert.equal(npc.dimension.id, "minecraft:overworld");
    assert.ok(near(npc, op));
});

// ---------------------------------------------------------------------------------------------------------
// Bringing an NPC from an area that is not loaded
// ---------------------------------------------------------------------------------------------------------

test("an NPC out of sight is fetched: its area is loaded for a moment, the NPC comes, and the area is let go", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    const npc = strand(op, shop);
    const watch = watchAreas();

    try {
        check("before: it cannot be seen", npcs.npcsOf("habiti").length === 0);
        check("and the shop says so", npcs.needsFetch("habiti") === true);

        const brought = await finish(npcs.bringShopNpc(op, shop, false));

        check("it was fetched, from where it was last seen", brought.how === "fetched" && JSON.stringify(brought.from) === JSON.stringify({ x: 900, y: 70, z: 900, dimension: "overworld" }), JSON.stringify(brought));
        check("the same NPC is now in front of the builder", npc.isValid && near(npc, op) && npcs.npcsOf("habiti")[0] === npc);
        check("exactly one area was asked for, around where it was", watch.asked.length === 1 && watch.asked[0].id === SHOP.fetchAreaId && watch.asked[0].from.x === 899 && watch.asked[0].to.z === 901, JSON.stringify(watch.asked.map(({ id, from, to }) => ({ id, from, to }))));
        check("it is let go afterwards", fake.tickingAreas.size === 0);
        check("it is loaded now, so there is nothing left to fetch", npcs.needsFetch("habiti") === false);
        check("no second NPC was made", fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 1);
        check("the new place is what is remembered", Math.abs(npcs.recallSpot("habiti").x - Math.round(npc.location.x)) <= 1);
    } finally {
        watch.stop();
    }
    done();
});

test("only the shop's own NPC is taken, even with another shop's NPC standing right beside it", async () => {
    const { op, shop } = setup();
    const other = edit.createShop(op, "Mule Dealer").shop;

    // The neighbour is made first, so it is first in any list the world gives: taking "the first NPC found" would take the wrong one.
    const neighbour = npcs.spawnShopNpc(op, other);
    neighbour.teleport({ x: FAR.x + 1, y: FAR.y, z: FAR.z });
    npcs.rememberSpot(other.id, neighbour);
    const wanted = strand(op, shop);

    const brought = await finish(npcs.bringShopNpc(op, shop, false));

    assert.equal(brought.how, "fetched");
    assert.ok(near(wanted, op), "the shop's own NPC came");
    assert.ok(!near(neighbour, op), "the neighbour stayed where it was");
    assert.equal(npcs.shopOf(neighbour), "mule_dealer");
});

test("an NPC far away in another dimension is fetched into the builder's", async () => {
    const { op, shop } = setup();
    const npc = strand(op, shop, { x: 100, y: 70, z: 100 }, "nether");
    const watch = watchAreas();

    try {
        const brought = await finish(npcs.bringShopNpc(op, shop, false));

        assert.equal(brought.how, "fetched");
        assert.equal(brought.from.dimension, "nether");
        assert.equal(watch.asked[0].dimension, fake.dimension("nether"), "the nether's area was the one loaded");
        assert.equal(npc.dimension.id, "minecraft:overworld");
        assert.ok(near(npc, op));
    } finally {
        watch.stop();
    }
});

test("an area that takes a few ticks to load is waited for, and an NPC that shows up a few ticks after it is waited for too", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    const npc = strand(op, shop);

    fake.tickingAreaDelay = 12;

    // The area says it is loaded, but its entities come a moment later: the first looks find nobody.
    const dim = fake.dimension("overworld");
    const realQuery = dim.getEntities;
    let looks = 0;
    dim.getEntities = (options) => (fake.tickingAreas.size > 0 && ++looks <= 3 ? [] : realQuery.call(dim, options));

    try {
        const brought = await finish(npcs.bringShopNpc(op, shop, true));

        check("it was still found, not given up on", brought.how === "fetched", JSON.stringify(brought));
        check("so no second NPC was made", fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 1 && npc.isValid && near(npc, op));
        check("it looked more than once", looks > 3, String(looks));
    } finally {
        dim.getEntities = realQuery;
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// An NPC that is truly gone
// ---------------------------------------------------------------------------------------------------------

test("when the remembered place loads and holds no NPC, it is gone: a new one is made if allowed, none if not", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    const old = strand(op, shop);
    old.remove();

    const refused = await finish(npcs.bringShopNpc(op, shop, false));
    check("move-only: nothing to move, nothing made", refused.how === "none" && refused.last?.x === 900 && fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 0, JSON.stringify(refused));
    check("the area was let go", fake.tickingAreas.size === 0);

    const made = await finish(npcs.bringShopNpc(op, shop, true));
    check("place: a new one is made, and it says where the old one was", made.how === "made" && made.last?.x === 900, JSON.stringify(made));
    check("one NPC, in front of the builder, carrying the shop", npcs.npcsOf("habiti").length === 1 && near(npcs.npcsOf("habiti")[0], op));
    check("and now it is the one remembered", npcs.recallSpot("habiti").x !== 900);
    done();
});

test("with nothing remembered and nothing loaded, no area is loaded: it is gone", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    const watch = watchAreas();

    try {
        check("with nothing remembered there is nothing to fetch", npcs.needsFetch("habiti") === false);

        const none = await finish(npcs.bringShopNpc(op, shop, false));
        check("move-only: none, and no place to name", none.how === "none" && none.last === undefined, JSON.stringify(none));

        const made = await finish(npcs.bringShopNpc(op, shop, true));
        check("place: made, with no place to name", made.how === "made" && made.last === undefined && npcs.npcsOf("habiti").length === 1, JSON.stringify(made));
        check("no area was loaded for either", watch.asked.length === 0);
    } finally {
        watch.stop();
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Cannot tell: make nothing
// ---------------------------------------------------------------------------------------------------------

test("when the area will not load, nothing is made and the builder is told where it was last seen", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    const npc = strand(op, shop);

    fake.tickingAreaFails = "TickingAreaError: too many ticking areas";

    const brought = await finish(npcs.bringShopNpc(op, shop, true));

    check("stuck, with the game's own reason and the last place", brought.how === "stuck" && /too many ticking areas/.test(brought.why) && brought.last?.x === 900, JSON.stringify(brought));
    check("NO second NPC, even though a new one was allowed", fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 1 && npc.isValid);
    check("nothing left behind", fake.tickingAreas.size === 0);
    check("the sentence says what to do", /could not be brought \(TickingAreaError: too many ticking areas\)/.test(npcs.broughtText(shop, brought)) && /shop_place habiti true/.test(npcs.broughtText(shop, brought)), npcs.broughtText(shop, brought));
    done();
});

test("no room for another ticking area: stuck, nothing made, nothing loaded", async () => {
    const { op, shop } = setup();
    strand(op, shop);
    fake.tickingAreaCapacity = 0;

    const brought = await finish(npcs.bringShopNpc(op, shop, true));

    assert.equal(brought.how, "stuck");
    assert.match(brought.why, /no room for another ticking area/);
    assert.equal(fake.entities.filter((e) => e.typeId === "minecraft:npc").length, 1);
    assert.equal(fake.tickingAreas.size, 0);
});

test("an area that never finishes loading is given up on after a while, and let go", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    strand(op, shop);
    fake.tickingAreaDelay = SHOP.fetchTimeoutTicks * 10;

    const brought = await finish(npcs.bringShopNpc(op, shop, true), SHOP.fetchTimeoutTicks + 20);

    check("stuck: it did not load in time", brought.how === "stuck" && /did not load in time/.test(brought.why), JSON.stringify(brought));
    check("nothing was made", fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 1);
    check("the area was removed, not left to finish", fake.tickingAreas.size === 0);
    done();
});

test("a ticking area left over from a fetch that never finished is cleared first, and the fetch goes ahead", async () => {
    const { op, shop } = setup();
    const npc = strand(op, shop);
    fake.tickingAreas.set(SHOP.fetchAreaId, { dimension: fake.dimension("overworld"), from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 1 } });

    const brought = await finish(npcs.bringShopNpc(op, shop, false));

    assert.equal(brought.how, "fetched");
    assert.ok(near(npc, op));
    assert.equal(fake.tickingAreas.size, 0);
});

test("a builder who leaves while the area loads gets nothing made, and the area is let go", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    strand(op, shop);
    fake.tickingAreaDelay = 10;

    const pending = npcs.bringShopNpc(op, shop, true);
    await settle();
    op.remove();

    const brought = await finish(pending);

    check("stuck: they left before it arrived", brought.how === "stuck" && /you left/.test(brought.why), JSON.stringify(brought));
    check("no second NPC", fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 1);
    check("the area was let go", fake.tickingAreas.size === 0);
    done();
});

test("a second fetch while one is under way is turned away, not run on top of it", async () => {
    const { op, shop } = setup();
    const { check, done } = checks();
    strand(op, shop);
    fake.tickingAreaDelay = 10;

    const first = npcs.bringShopNpc(op, shop, false);
    await settle();
    const second = await npcs.bringShopNpc(op, shop, true);

    check("the second is told to wait", second.how === "stuck" && /another NPC is being brought over/.test(second.why), JSON.stringify(second));
    check("and made nothing", fake.entities.filter((e) => e.typeId === "minecraft:npc").length === 1);

    const brought = await finish(first);
    check("the first still finished", brought.how === "fetched", JSON.stringify(brought));

    const again = await finish(npcs.bringShopNpc(op, shop, false));
    check("and afterwards fetches work again", again.how === "here", JSON.stringify(again));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------------------------

test("every outcome has a sentence that says what happened and, when it did not work, what to do", () => {
    const { check, done } = checks();
    const shop = { id: "habiti", name: "Habiti" };
    const at = { x: 900, y: 70, z: 900, dimension: "nether" };
    const say = (brought) => npcs.broughtText(shop, brought);

    check("here", say({ how: "here" }) === "Habiti's NPC is in front of you.");
    check("fetched", say({ how: "fetched", from: at }) === "Habiti's NPC came from 900, 70, 900 in the nether and is in front of you.");
    check("made where one was remembered", /was not at 900, 70, 900 in the nether any more, so a new one is in front of you/.test(say({ how: "made", last: at })));
    check("made with nothing remembered: warns there may now be two", /Made a new NPC for Habiti/.test(say({ how: "made" })) && /you now have two/.test(say({ how: "made" })));
    check("none where it was remembered: says how to make one", /not at 900, 70, 900 in the nether any more\. \/rae:shop_place habiti makes a new one here/.test(say({ how: "none", last: at })));
    check("none, nothing remembered: says to go near it", /nothing remembers where it was\. Go near it/.test(say({ how: "none" })));
    check("stuck: the reason, the place, the way out", /last at 900, 70, 900 in the nether and could not be brought \(no luck\)\. Go near it and try again, or \/rae:shop_place habiti true/.test(say({ how: "stuck", why: "no luck", last: at })));
    check("stuck with no place known", !/last at/.test(say({ how: "stuck", why: "no luck" })));
    done();
});
