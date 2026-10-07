import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks } from "./helpers.mjs";

// core/shopstore.ts (through core/recordstore.ts): where shops live. The contract is that authored work is never lost quietly:
// every edit is written at once under its own world property, an edit that does not fit is refused before anything changes, an
// unreadable save is listed and never overwritten, and a reload (forgetting what was read) finds everything again.

const store = await load("core/shopstore.js");
const L = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

const property = (id) => `rae:shop:def:${id}`;

function fresh() {
    fake.reset();
    store.forgetLoaded();
}

const ok = (result) => {
    assert.ok(result.ok, result.reason);
    return result.shop;
};

const save = (shop) => {
    const result = store.saveShop(shop);
    assert.equal(result.ok, true, result.reason);
    return result.value;
};

const sword = { type: "minecraft:iron_sword", amount: 1 };

const habiti = () => {
    let shop = ok(L.newShop("habiti", "Habiti"));
    shop = ok(L.addTrade(shop, L.buyDeal(sword, 60)));
    return shop;
};

test("an empty world has no shops", () => {
    fresh();
    const { check, done } = checks();
    check("none listed", store.listStored().length === 0 && store.allShops().length === 0);
    check("none by id", store.getShop("habiti") === undefined && store.getStored("habiti") === undefined);
    check("nothing to undo", store.undoAvailable("habiti") === false);
    done();
});

test("saving writes a world property at once, and a reload finds exactly what was saved", () => {
    fresh();
    const { check, done } = checks();
    const shop = habiti();

    save(shop);

    const text = world.getDynamicProperty(property("habiti"));
    check("it is a world property named for the id", typeof text === "string" && text.length > 0);
    check("it is the saved text of the shop", text === L.serialize(shop));
    check("raw text is the same", store.rawText("habiti") === text);

    store.forgetLoaded();                                   // what a script reload does
    const back = store.getShop("habiti");
    check("after a reload it is still there", back !== undefined);
    check("and identical", JSON.stringify(back) === JSON.stringify(shop));
    check("listed", store.listStored().map((s) => s.id).join() === "habiti");
    done();
});

test("every change bumps the version, so anything built from the shops knows it is stale", () => {
    fresh();
    const a = store.storeVersion();
    save(habiti());
    const b = store.storeVersion();
    store.undoLast("habiti");
    const c = store.storeVersion();
    store.undoLast("habiti");
    store.deleteShop("habiti");
    const d = store.storeVersion();
    assert.ok(a < b && b < c && c < d, `${a} ${b} ${c} ${d}`);
});

test("an edit that does not fit in a save is refused and changes nothing", () => {
    fresh();
    const { check, done } = checks();
    const shop = habiti();
    save(shop);
    const before = world.getDynamicProperty(property("habiti"));

    // Every deal as heavy as an item can be: each is legal on its own, but together they are over the cap.
    const heavy = (n) => ({
        type: `minecraft:item_${n}`, amount: 1, name: "n".repeat(SHOP.maxItemNameLength),
        lore: Array.from({ length: SHOP.maxLoreLines }, () => "l".repeat(SHOP.maxLoreLength)),
        enchants: Array.from({ length: SHOP.maxEnchants }, (_, i) => [`enchantment_${i}`, SHOP.maxEnchantLevel])
    });
    let fat = ok(L.newShop("habiti", "Habiti"));
    for (let i = 0; i < SHOP.maxTrades; i++) fat = ok(L.addTrade(fat, L.swapDeal(heavy(i), [heavy(1000 + i), heavy(2000 + i), heavy(3000 + i)], 5)));
    check("the fat shop really is over the cap", L.serialize(fat).length > SHOP.maxSavedChars, String(L.serialize(fat).length));

    const refused = store.saveShop(fat);
    check("refused", refused.ok === false && /characters/.test(refused.reason), JSON.stringify(refused).slice(0, 200));
    check("the property is untouched", world.getDynamicProperty(property("habiti")) === before);
    check("and so is what is in memory", JSON.stringify(store.getShop("habiti")) === JSON.stringify(shop));
    done();
});

test("only so many shops fit, and the limit refuses a new one without touching the others", () => {
    fresh();
    const { check, done } = checks();

    for (let i = 0; i < SHOP.maxShops; i++) save(ok(L.newShop(`shop${i}`, `Shop ${i}`)));

    const extra = store.saveShop(ok(L.newShop("one_more", "One more")));
    check("the next new one is refused", extra.ok === false && /room for/.test(extra.reason), JSON.stringify(extra));
    check("an existing one can still be edited", store.saveShop(ok(L.renameShop(store.getShop("shop0"), "Renamed"))).ok === true);
    check("the count is what it was", store.listStored().length === SHOP.maxShops);
    done();
});

test("a save the game refuses to write is reported, and nothing changes", () => {
    fresh();
    const { check, done } = checks();
    save(ok(L.newShop("habiti", "Old name")));
    const before = world.getDynamicProperty(property("habiti"));

    fake.dynamicStringLimit = 20;
    const result = store.saveShop(habiti());
    fake.dynamicStringLimit = null;

    check("refused with the engine's reason", result.ok === false && /refused the save/.test(result.reason), JSON.stringify(result));
    check("the old save is untouched", world.getDynamicProperty(property("habiti")) === before);
    check("memory still has the old shop", store.getShop("habiti").name === "Old name");
    done();
});

test("an unreadable save is listed with the reason, never overwritten, and can be deleted and undone", () => {
    fresh();
    const { check, done } = checks();

    world.setDynamicProperty(property("broken"), "{ this is not a shop");
    world.setDynamicProperty(property("future"), JSON.stringify({ v: 99, id: "future" }));
    world.setDynamicProperty(property("wrong"), L.serialize(ok(L.newShop("other", "Other"))));
    save(ok(L.newShop("fine", "Fine")));
    store.forgetLoaded();

    const byId = new Map(store.listStored().map((s) => [s.id, s]));
    check("the good one reads", byId.get("fine")?.ok === true);
    check("garbage is listed as unreadable with a reason", byId.get("broken")?.ok === false && /JSON/.test(byId.get("broken").problem), JSON.stringify(byId.get("broken")));
    check("a different version says so", byId.get("future")?.ok === false && /different version/.test(byId.get("future").problem), JSON.stringify(byId.get("future")));
    check("a save under the wrong name is unreadable too", byId.get("wrong")?.ok === false && /other/.test(byId.get("wrong").problem), JSON.stringify(byId.get("wrong")));
    check("unreadable ones are not in the playable list", store.allShops().map((x) => x.id).join() === "fine");

    const overwrite = store.saveShop(ok(L.newShop("broken", "Mine")));
    check("saving over an unreadable one is refused", overwrite.ok === false && /cannot be read/.test(overwrite.reason), JSON.stringify(overwrite));
    check("its text is untouched", world.getDynamicProperty(property("broken")) === "{ this is not a shop");

    check("deleting it is allowed", store.deleteShop("broken").ok === true && world.getDynamicProperty(property("broken")) === undefined);
    check("and undo brings the damaged text back", store.undoLast("broken").ok === true && world.getDynamicProperty(property("broken")) === "{ this is not a shop");
    done();
});

test("one level of undo: an edit, a create, a delete, and undoing again redoes", () => {
    fresh();
    const { check, done } = checks();

    const v1 = save(ok(L.newShop("habiti", "First")));
    check("a shop that was just created can be undone away", store.undoAvailable("habiti"));

    const v2 = save(ok(L.renameShop(v1, "Second")));
    check("edit then undo goes back to the first", store.undoLast("habiti").ok && store.getShop("habiti").name === "First");
    check("the property went back too", world.getDynamicProperty(property("habiti")) === L.serialize(v1));
    check("undo again redoes the edit", store.undoLast("habiti").ok && store.getShop("habiti").name === "Second");
    check("redo wrote the property", world.getDynamicProperty(property("habiti")) === L.serialize(v2));

    check("an edit that changes nothing does not use up the undo", (() => { save(v2); return store.undoLast("habiti").ok && store.getShop("habiti").name === "First"; })());

    store.undoLast("habiti");                               // back to Second
    check("delete removes it", store.deleteShop("habiti").ok && store.getShop("habiti") === undefined && world.getDynamicProperty(property("habiti")) === undefined);
    check("undo of a delete brings it back", store.undoLast("habiti").ok && store.getShop("habiti")?.name === "Second");
    check("deleting what is not there is refused", store.deleteShop("nothing").ok === false);
    check("undoing what never existed is refused", store.undoLast("nothing").ok === false);
    done();
});

test("a script reload loses the undo but not the shops", () => {
    fresh();
    save(ok(L.newShop("habiti", "First")));
    store.forgetLoaded();
    assert.equal(store.getShop("habiti").name, "First");
    assert.equal(world.getDynamicProperty(property("habiti")) !== undefined, true);
});

test("properties that are not shops are left alone", () => {
    fresh();
    world.setDynamicProperty("rae:robbery:def:bank", "robbery text");
    world.setDynamicProperty("rae:shop", "not a definition");        // the NPC's own property name has no :def: part
    save(ok(L.newShop("habiti", "Habiti")));
    store.forgetLoaded();
    assert.deepEqual(store.listStored().map((s) => s.id), ["habiti"]);
});
