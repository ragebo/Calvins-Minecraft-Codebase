import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks } from "./helpers.mjs";

// core/shopedit.ts: what a builder does to shops, below the screens and commands that ask for it. Which shop they are working
// on, making and copying one, and putting a deal on one made from what they hold. Every change is validated as a whole by the
// store and the model, so a refusal is a sentence and nothing is saved.

const { ItemStack } = fakeApi;
const edit = await load("core/shopedit.js");
const store = await load("core/shopstore.js");
const L = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

function setup() {
    fake.reset();
    store.forgetLoaded();
    fake.addObjective("coins");
    return fake.makePlayer("Ada", { inventory: true });
}

const hold = (player, stack) => player.container.setItem(player.selectedSlotIndex, stack);
const stack = (type, amount = 1) => new ItemStack(type, amount);

test("a builder works on the shop they chose, else the only one there is, else none", () => {
    const p = setup();
    const { check, done } = checks();

    check("no shops: none", edit.selectedShop(p) === undefined);

    const first = edit.createShop(p, "First");
    check("making one selects it", first.ok && edit.selectedId(p) === "first" && edit.selectedShop(p)?.id === "first");

    edit.createShop(p, "Second");
    edit.select(p, undefined);
    check("two shops and no choice: none (it cannot know which)", edit.selectedShop(p) === undefined);

    edit.select(p, "first");
    check("choosing one selects it", edit.selectedShop(p)?.id === "first");

    edit.select(p, "nobody");
    check("a choice that is not a shop falls back (two shops: none)", edit.selectedShop(p) === undefined);

    store.deleteShop("second");
    check("one shop left: it is the one meant", edit.selectedShop(p)?.id === "first");
    done();
});

test("making a shop gives it a free id, a tidy name, and says no to an empty name or a full world", () => {
    const p = setup();
    const { check, done } = checks();

    check("an id from the name", edit.createShop(p, "  Habiti   the Horseman ").shop?.id === "habiti_the_horseman");
    const second = edit.createShop(p, "Habiti the Horseman").shop?.id ?? "";
    check("the second of the same name is numbered, trimmed to keep the id inside its length limit", /^habiti_the_horse.*_2$/.test(second) && second.length <= SHOP.maxIdLength, second);
    check("a short name is simply numbered", edit.createShop(p, "Mule").shop?.id === "mule" && edit.createShop(p, "Mule").shop?.id === "mule_2");
    check("a name with nothing to make an id from still gets one", edit.createShop(p, "123 !!!").shop?.id === "shop");
    const empty = edit.createShop(p, "   ");
    check("an empty name is refused with the reason", !empty.ok && /name cannot be empty/.test(empty.reason), JSON.stringify(empty));

    for (let i = store.listStored().length; i < SHOP.maxShops; i++) edit.createShop(p, `Shop ${String.fromCharCode(97 + (i % 26))}${i}`);
    const full = edit.createShop(p, "One too many");
    check("when every place is taken it is refused, and says how many", !full.ok && new RegExp(String(SHOP.maxShops)).test(full.reason), JSON.stringify(full));
    check("and nothing was saved for it", store.getShop("one_too_many") === undefined);
    done();
});

test("copying keeps the deals, picks a free id, selects the copy, and refuses a shop that is not there", () => {
    const p = setup();
    const { check, done } = checks();

    edit.createShop(p, "Habiti");
    hold(p, stack("minecraft:iron_sword"));
    edit.addHeldDeal(p, "habiti", "sells", 60);

    const copy = edit.copyShopAs(p, "habiti", "Habiti");
    check("a copy under the same name gets a numbered id", copy.ok && copy.shop.id === "habiti_2", JSON.stringify(copy));
    check("with the same deals", copy.ok && copy.shop.trades.length === 1 && L.describeTrade(copy.shop.trades[0]) === "Iron Sword for 60 coins");
    check("and is the one selected", edit.selectedId(p) === "habiti_2");
    check("a shop that is not there cannot be copied", !edit.copyShopAs(p, "nobody", "X").ok);
    done();
});

test("applyEdit saves a valid change, and refuses an invalid one or a shop that is not there, changing nothing", () => {
    const p = setup();
    const { check, done } = checks();
    edit.createShop(p, "Habiti");

    const named = edit.applyEdit("habiti", (shop) => L.renameShop(shop, "Renamed"));
    check("a valid change is saved", named.ok && store.getShop("habiti").name === "Renamed");

    const bad = edit.applyEdit("habiti", (shop) => L.renameShop(shop, "  "));
    check("an invalid one is refused with the reason", !bad.ok && /name cannot be empty/.test(bad.reason));
    check("and the saved shop is as it was", store.getShop("habiti").name === "Renamed");

    check("a shop that is not there is refused", !edit.applyEdit("nobody", (shop) => ({ ok: true, shop })).ok);
    done();
});

test("a deal from the hand: the NPC sells the whole stack, or buys it, and an empty hand or a missing shop is refused", () => {
    const p = setup();
    const { check, done } = checks();
    edit.createShop(p, "Habiti");

    check("an empty hand is refused", !edit.addHeldDeal(p, "habiti", "sells", 10).ok && /hold the item first/.test(edit.addHeldDeal(p, "habiti", "sells", 10).reason));

    hold(p, stack("minecraft:arrow", 6));
    const sells = edit.addHeldDeal(p, "habiti", "sells", 15);
    check("sells: the whole stack for the price", sells.ok && L.describeTrade(sells.trade) === "Arrow x6 for 15 coins", JSON.stringify(sells));

    const buys = edit.addHeldDeal(p, "habiti", "buys", 4);
    check("buys: the stack for coins", buys.ok && L.describeTrade(buys.trade) === "Sell Arrow x6 for 4 coins");

    check("a shop that is not there is refused", !edit.addHeldDeal(p, "nobody", "sells", 10).ok);
    check("a price the rules refuse is refused and nothing is added", !edit.addHeldDeal(p, "habiti", "sells", -5).ok && store.getShop("habiti").trades.length === 2);
    done();
});

test("what the bag offers for a trade: every occupied slot except the one in hand", () => {
    const p = setup();
    hold(p, stack("minecraft:diamond"));
    p.container.setItem(3, stack("minecraft:gold_ingot", 9));
    p.container.setItem(7, stack("minecraft:emerald", 2));

    const choices = edit.bagChoices(p);
    assert.deepEqual(choices.map((c) => [c.slot, c.spec.type, c.spec.amount]), [[3, "minecraft:gold_ingot", 9], [7, "minecraft:emerald", 2]]);
});

test("a trade: players hand over an item from the bag (and coins) for the held one, and it cannot ask for what it gives", () => {
    const p = setup();
    const { check, done } = checks();
    edit.createShop(p, "Habiti");

    check("an empty hand is refused", !edit.addSwapDeal(p, "habiti", 3, 1, 0).ok && /hold the item players will get/.test(edit.addSwapDeal(p, "habiti", 3, 1, 0).reason));

    hold(p, stack("minecraft:diamond"));
    p.container.setItem(3, stack("minecraft:gold_ingot", 9));

    const same = edit.addSwapDeal(p, "habiti", p.selectedSlotIndex, 1, 0);
    check("asking for the item in hand is refused", !same.ok && /cannot be the one they get/.test(same.reason), JSON.stringify(same));

    check("an empty slot is refused", !edit.addSwapDeal(p, "habiti", 20, 1, 0).ok && /slot is empty/.test(edit.addSwapDeal(p, "habiti", 20, 1, 0).reason));

    const made = edit.addSwapDeal(p, "habiti", 3, 3, 10);
    check("a good one is added with the amount chosen, not the stack's", made.ok && L.describeTrade(made.trade) === "Diamond for Gold Ingot x3 + 10 coins", JSON.stringify(made));
    check("an amount the rules refuse is refused", !edit.addSwapDeal(p, "habiti", 3, 0, 0).ok);
    check("only the one good deal was saved", store.getShop("habiti").trades.length === 1);
    done();
});
