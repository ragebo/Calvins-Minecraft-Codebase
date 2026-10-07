import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, fill, close, yes, no, script, buttonsOf, titleOf } from "./robbery-ui.mjs";

// core/shopforms.ts: the customer's screen (buy, sell, trade, the guard against a deal that changed while the form was open)
// and the builder's (deals, prices, greeting, copy, place, delete, undo), driven by a stand-in player who presses buttons by label.

const { ItemStack } = fakeApi;
const forms = await load("core/shopforms.js");
const store = await load("core/shopstore.js");
const npcs = await load("core/shopnpc.js");
const L = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

const sword = { type: "minecraft:iron_sword", amount: 1 };
const arrows = { type: "minecraft:arrow", amount: 6 };
const feathers = { type: "minecraft:feather", amount: 3 };

const must = (result) => { assert.ok(result.ok, result.reason); return result.shop ?? result.value; };

function setup({ coins = 100, deals = [L.buyDeal(sword, 60)], name = "Habiti" } = {}) {
    fake.reset();
    store.forgetLoaded();
    problems.length = 0;
    ui.shown.length = 0;
    fake.addObjective("coins");
    const ada = fake.makePlayer("Ada", { inventory: true, permission: 2 });
    fake.setScore("coins", ada, coins);
    let shop = must(L.newShop("habiti", name));
    for (const deal of deals) shop = must(L.addTrade(shop, deal));
    must(store.saveShop(shop));
    return ada;
}

const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player);
const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const countIn = (player, type) => {
    let total = 0;
    for (let i = 0; i < 36; i++) { const s = player.container.getItem(i); if (s?.typeId === type) total += s.amount; }
    return total;
};
const chatOf = (player) => player.messages.map(strip).join(" | ");
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------------------------------------
// The customer's screen
// ---------------------------------------------------------------------------------------------------------

test("a customer buys: the deal is carried out, said at the top of the next screen, and the shop stays open", async () => {
    const ada = setup();
    const { check, done } = checks();

    script(press("Iron Sword for 60 coins"), press("Close"));
    await forms.openShop(ada, "habiti");

    check("two screens were shown: the shop, then the shop again", ui.shown.length === 2, String(ui.shown.length));
    check("the first lists the deal and a Close button", buttonsOf(ui.shown[0]).map(strip).join("|") === "Iron Sword for 60 coins|Close", buttonsOf(ui.shown[0]).join("|"));
    check("the title is the shop's name", strip(titleOf(ui.shown[0])) === "Habiti");
    check("the purse is shown", /You have 100 coins/.test(bodyOf(ui.shown[0])), bodyOf(ui.shown[0]));
    check("the second says what happened", /Bought Iron Sword for 60 coins\./.test(bodyOf(ui.shown[1])) && /You have 40 coins/.test(bodyOf(ui.shown[1])), bodyOf(ui.shown[1]));
    check("the coins went and the sword came", coinsOf(ada) === 40 && countIn(ada, "minecraft:iron_sword") === 1);
    check("a purchase sounds", ada.privateSounds.some((s) => s.id === SHOP.cues.bought.id));
    check("the stand-in found every button", problems.length === 0, problems.join("; "));
    done();
});

test("a customer who cannot afford a deal is told what is missing and nothing changes", async () => {
    const ada = setup({ coins: 20 });
    const { check, done } = checks();

    script(press("Iron Sword"), press("Close"));
    await forms.openShop(ada, "habiti");

    check("the deal is greyed, since it cannot be afforded", ui.shown[0].calls.find((c) => c[0] === "button")[1].startsWith("§7"));
    check("the answer says what is needed", /Not yet: you need 60 coins \(you have 20\)/.test(bodyOf(ui.shown[1])), bodyOf(ui.shown[1]));
    check("no coins taken, no sword", coinsOf(ada) === 20 && countIn(ada, "minecraft:iron_sword") === 0);
    check("a refusal sounds differently", ada.privateSounds.some((s) => s.id === SHOP.cues.denied.id) && !ada.privateSounds.some((s) => s.id === SHOP.cues.bought.id));
    done();
});

test("an affordable deal is not greyed", async () => {
    const ada = setup({ coins: 100 });
    script(close);
    await forms.openShop(ada, "habiti");
    assert.equal(ui.shown[0].calls.find((c) => c[0] === "button")[1], "Iron Sword for 60 coins");
});

test("a deal that changed while the form was open is not bought at the new price", async () => {
    const ada = setup({ coins: 100 });
    const { check, done } = checks();

    // While the form is on screen the builder makes the sword dearer.
    script((form) => {
        must(store.saveShop(must(L.updateTrade(store.getShop("habiti"), "t1", { cost: { coins: 90, items: [] } }))));
        return press("Iron Sword")(form);
    }, press("Close"));

    await forms.openShop(ada, "habiti");

    check("nothing was bought", coinsOf(ada) === 100 && countIn(ada, "minecraft:iron_sword") === 0);
    check("the player is told the deal changed", /That deal has just changed/.test(bodyOf(ui.shown[1])), bodyOf(ui.shown[1]));
    check("and the list now shows the new price", buttonsOf(ui.shown[1]).map(strip)[0] === "Iron Sword for 90 coins", buttonsOf(ui.shown[1]).join("|"));
    done();
});

test("a deal removed while the form was open is not bought either", async () => {
    const ada = setup({ deals: [L.buyDeal(sword, 60), L.buyDeal(arrows, 15)] });

    script((form) => {
        must(store.saveShop(must(L.removeTrade(store.getShop("habiti"), "t1"))));
        return press("Iron Sword")(form);
    }, close);

    await forms.openShop(ada, "habiti");

    assert.equal(coinsOf(ada), 100);
    assert.equal(countIn(ada, "minecraft:iron_sword"), 0);
    assert.match(bodyOf(ui.shown[1]), /That deal has just changed/);
});

test("selling and trading go through the same screen", async () => {
    const ada = setup({ coins: 0, deals: [L.sellDeal(feathers, 8), L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 2 }])] });
    const { check, done } = checks();

    ada.container.addItem(new ItemStack("minecraft:feather", 5));
    ada.container.addItem(new ItemStack("minecraft:gold_ingot", 2));

    script(press("Sell Feather x3"), press("Diamond for Gold Ingot x2"), close);
    await forms.openShop(ada, "habiti");

    check("the sale paid", coinsOf(ada) === 8 && countIn(ada, "minecraft:feather") === 2);
    check("the trade swapped", countIn(ada, "minecraft:gold_ingot") === 0 && countIn(ada, "minecraft:diamond") === 1);
    check("a sale has its own sound", ada.privateSounds.some((s) => s.id === SHOP.cues.sold.id));
    done();
});

test("a shop with nothing in it says so instead of showing an empty list", async () => {
    const ada = setup({ deals: [] });
    script(close);
    await forms.openShop(ada, "habiti");
    assert.equal(ui.shown.length, 0);
    assert.match(chatOf(ada), /Habiti: it has nothing to sell, buy or trade yet/);
});

test("a shop that no longer exists closes politely, also while open", async () => {
    const ada = setup({ deals: [L.buyDeal(sword, 60), L.buyDeal(arrows, 15)] });
    const { check, done } = checks();

    await forms.openShop(ada, "nobody");
    check("an unknown shop shows no form", ui.shown.length === 0 && /That shop has closed/.test(chatOf(ada)));

    ada.messages.length = 0;
    script((form) => { store.deleteShop("habiti"); return press("Iron Sword")(form); });
    await forms.openShop(ada, "habiti");
    check("a shop deleted from under the screen closes it without a purchase", /That shop has closed/.test(chatOf(ada)) && coinsOf(ada) === 100);
    done();
});

test("a second request for a shop while one is open does nothing", async () => {
    const ada = setup();
    const { check, done } = checks();

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    script(() => held);

    const first = forms.openShop(ada, "habiti");
    await settle();
    check("the first shop is on screen", ui.shown.length === 1 && forms.hasShopOpen(ada));

    await forms.openShop(ada, "habiti");
    check("a second request shows nothing more", ui.shown.length === 1);

    release(close());
    await first;
    check("closed, the player has none open", !forms.hasShopOpen(ada));
    done();
});

test("a player who leaves while the form is open ends the screen quietly, and nothing is charged", async () => {
    const ada = setup();
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
        script((form) => { const answer = press("Iron Sword")(form); ada.remove(); return answer; });
        await assert.doesNotReject(forms.openShop(ada, "habiti"));
    } finally {
        console.error = original;
    }
    assert.equal(forms.hasShopOpen(ada), false);
    assert.equal(world.scoreboard.getObjective("coins").getScore("Ada"), 100, "no coins were taken from a player who was gone");
    assert.deepEqual(errors, [], "and nothing was reported as a failure");
});

// ---------------------------------------------------------------------------------------------------------
// The builder's screens
// ---------------------------------------------------------------------------------------------------------

function hold(player, stack) {
    player.container.setItem(player.selectedSlotIndex, stack);
}

test("the builder's screen adds a deal from the held item: the NPC sells it, and the price comes from the form", async () => {
    const ada = setup({ deals: [] });
    const { check, done } = checks();

    hold(ada, new ItemStack("minecraft:iron_sword", 1));
    script(press("Add a deal"), press("SELLS what I am holding"), fill({ "Coins players pay": "75" }), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    const shop = store.getShop("habiti");
    check("one deal was added", shop.trades.length === 1, JSON.stringify(shop.trades));
    check("it is a sword for 75 coins", L.describeTrade(shop.trades[0]) === "Iron Sword for 75 coins", L.describeTrade(shop.trades[0] ?? { id: "t0", cost: { coins: 0, items: [] }, rewards: [] }));
    check("the builder was told", /Added: Iron Sword for 75 coins/.test(chatOf(ada)), chatOf(ada));
    check("the shop is the one the builder works on now", fake.players[0].getDynamicProperty("rae:shop:selected") === "habiti");
    check("no button was missing", problems.length === 0, problems.join("; "));
    done();
});

test("the NPC buys the held stack from players, and an empty hand is refused with a sentence", async () => {
    const ada = setup({ deals: [] });
    const { check, done } = checks();

    script(press("Add a deal"), press("BUYS what I am holding"), fill({ "Coins players are paid": "8" }), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    check("with an empty hand nothing was added", store.getShop("habiti").trades.length === 0 && /hold the item first/.test(chatOf(ada)), chatOf(ada));

    ada.messages.length = 0;
    hold(ada, new ItemStack("minecraft:feather", 3));
    script(press("Add a deal"), press("BUYS what I am holding"), fill({ "Coins players are paid": "8" }), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    check("holding feathers it is a sale", L.describeTrade(store.getShop("habiti").trades[0]) === "Sell Feather x3 for 8 coins");
    done();
});

test("a price that is not a number is refused and changes nothing", async () => {
    const ada = setup({ deals: [] });
    hold(ada, new ItemStack("minecraft:iron_sword", 1));
    script(press("Add a deal"), press("SELLS what I am holding"), fill({ "Coins players pay": "lots" }), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    assert.equal(store.getShop("habiti").trades.length, 0);
    assert.match(chatOf(ada), /whole number of coins/);
});

test("a trade is made from the bag: what players hand over, how many, and extra coins", async () => {
    const ada = setup({ deals: [] });
    const { check, done } = checks();

    ada.container.setItem(4, new ItemStack("minecraft:gold_ingot", 9));
    hold(ada, new ItemStack("minecraft:diamond", 1));

    script(press("Add a deal"), press("TRADE"), fill({ "Players hand over": "Gold Ingot", "How many": "3", "Extra coins": "10" }), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    const shop = store.getShop("habiti");
    check("the deal is a diamond for 3 gold and 10 coins", shop.trades.length === 1 && L.describeTrade(shop.trades[0]) === "Diamond for Gold Ingot x3 + 10 coins", shop.trades.map(L.describeTrade).join(" | "));
    check("no problems with the form", problems.length === 0, problems.join("; "));
    done();
});

test("a trade needs something else in the bag to ask for", async () => {
    const ada = setup({ deals: [] });
    hold(ada, new ItemStack("minecraft:diamond", 1));
    script(press("Add a deal"), press("TRADE"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    assert.match(chatOf(ada), /Put the item players should hand over in your bag first/);
    assert.equal(store.getShop("habiti").trades.length, 0);
});

test("a deal's price, order and removal can be changed from its own screen", async () => {
    const ada = setup({ deals: [L.buyDeal(sword, 60), L.buyDeal(arrows, 15), L.sellDeal(feathers, 8)] });
    const { check, done } = checks();

    // Each deal's own screen opens the price form from its "Change the price" button; "Move down" and "Remove" act at once.
    script(
        press("Deals"), press("t1"), press("Change the price"), fill({ "Coins players pay": "75" }), press("Back"),
        press("t3"), press("Change the price"), fill({ "Coins players are paid": "9" }), press("Move up"), press("Move up"), press("Back"),
        press("t2"), press("Remove this deal"), yes, press("Back"), press("Close")
    );
    await forms.openShopEditor(ada, "habiti");

    const shop = store.getShop("habiti");
    check("t2 is gone", shop.trades.every((t) => t.id !== "t2"));
    check("the sword is dearer", L.describeTrade(shop.trades.find((t) => t.id === "t1")) === "Iron Sword for 75 coins");
    check("the sale pays more", L.describeTrade(shop.trades.find((t) => t.id === "t3")) === "Sell Feather x3 for 9 coins");
    check("t3 was moved to the top (up twice, before t2 was removed)", shop.trades.map((t) => t.id).join() === "t3,t1", shop.trades.map((t) => t.id).join());
    check("no button was missing", problems.length === 0, problems.join("; "));
    done();
});

test("declining the confirmation leaves a deal alone", async () => {
    const ada = setup({ deals: [L.buyDeal(sword, 60)] });
    script(press("Deals"), press("t1"), press("Remove this deal"), no, press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    assert.equal(store.getShop("habiti").trades.length, 1);
});

test("the greeting and the name are set from their forms, and a rename reaches the NPC's name tag", async () => {
    const ada = setup();
    const { check, done } = checks();

    const npc = npcs.spawnShopNpc(ada, store.getShop("habiti"));
    script(press("Greeting"), fill({ "What the NPC says": "Howdy, stranger." }), press("Rename"), fill({ "The shop's name": "Habiti the Horseman" }), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    check("the greeting is saved", store.getShop("habiti").greeting === "Howdy, stranger.");
    check("the name is saved", store.getShop("habiti").name === "Habiti the Horseman");
    check("the NPC shows the new name", npc.nameTag === "Habiti the Horseman", npc.nameTag);

    script(close);
    await forms.openShop(ada, "habiti");
    check("a customer sees the greeting above the purse", /^Howdy, stranger\./.test(bodyOf(ui.shown.at(-1))), bodyOf(ui.shown.at(-1)));
    done();
});

test("copying a shop makes a second shop with the same deals and its own NPC in front of the builder", async () => {
    const ada = setup({ deals: [L.buyDeal(sword, 60), L.sellDeal(feathers, 8)] });
    const { check, done } = checks();

    script(press("Copy this shop"), fill({ "A name for the new shop": "Second Stall" }), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    const copy = store.getShop("second_stall");
    check("the copy exists with the same deals", copy !== undefined && copy.trades.length === 2 && JSON.stringify(copy.trades) === JSON.stringify(store.getShop("habiti").trades));
    check("it has its own NPC", npcs.npcsOf("second_stall").length === 1);
    check("the original is untouched", store.getShop("habiti").name === "Habiti" && store.getShop("habiti").trades.length === 2);
    done();
});

test("placing brings an existing NPC to the builder, or makes one when none is around", async () => {
    const ada = setup();
    const { check, done } = checks();

    script(press("Place its NPC here"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    check("a new NPC was made", npcs.npcsOf("habiti").length === 1 && /Made a new NPC/.test(chatOf(ada)), chatOf(ada));

    const [npc] = npcs.npcsOf("habiti");
    npc._location = { x: 500, y: 64, z: 500 };
    ada.messages.length = 0;
    script(press("Bring its NPC here"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    check("the same NPC was brought over, not a second made", npcs.npcsOf("habiti").length === 1 && Math.abs(npc.location.x - ada.location.x) < 5, `${npcs.npcsOf("habiti").length} ${npc.location.x}`);
    done();
});

test("deleting a shop removes the NPC this addon made, lets go of one a builder placed, and undo brings the shop back", async () => {
    const ada = setup();
    const { check, done } = checks();

    const made = npcs.spawnShopNpc(ada, store.getShop("habiti"));
    const byHand = fake.makeEntity({ typeId: "minecraft:npc" });
    npcs.bindNpc(byHand, store.getShop("habiti"));

    script(press("Delete this shop"), yes);
    await forms.openShopEditor(ada, "habiti");

    check("the shop is gone", store.getShop("habiti") === undefined);
    check("the NPC made here was removed", made.isValid === false);
    check("the hand-placed one stands, released", byHand.isValid === true && npcs.shopOf(byHand) === undefined);
    check("the builder is told how to undo", /shop_undo habiti/.test(chatOf(ada)), chatOf(ada));
    check("the selection was cleared", ada.getDynamicProperty("rae:shop:selected") === undefined);

    check("undo brings the shop back", store.undoLast("habiti").ok && store.getShop("habiti") !== undefined);
    done();
});

test("declining the delete keeps everything", async () => {
    const ada = setup();
    const npc = npcs.spawnShopNpc(ada, store.getShop("habiti"));
    script(press("Delete this shop"), no, press("Close"));
    await forms.openShopEditor(ada, "habiti");
    assert.ok(store.getShop("habiti"));
    assert.equal(npc.isValid, true);
});

test("the undo button appears once something has changed, and undoes it", async () => {
    const ada = setup({ deals: [] });
    const { check, done } = checks();

    script(press("Greeting"), fill({ "What the NPC says": "Hello" }), press("Undo the last change"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    check("the greeting was set and then undone", store.getShop("habiti").greeting === "");
    check("no problems", problems.length === 0, problems.join("; "));
    done();
});

test("the picker lists every shop (and says which cannot be read), and makes a new one with an NPC", async () => {
    const ada = setup();
    const { check, done } = checks();

    world.setDynamicProperty("rae:shop:def:broken", "{ no");
    store.forgetLoaded();

    script(press("A new shop"), fill({ "The shop's name": "Mule Dealer" }), press("Close"));
    await forms.openShopPicker(ada);

    const first = ui.shown[0];
    check("the shops are listed", buttonsOf(first).map(strip).some((b) => b === "Habiti (habiti)") && buttonsOf(first).map(strip).some((b) => b === "broken (cannot be read)"), buttonsOf(first).join("|"));
    check("the new shop exists, with an NPC in front of the builder", store.getShop("mule_dealer") !== undefined && npcs.npcsOf("mule_dealer").length === 1);
    check("and is the one selected", ada.getDynamicProperty("rae:shop:selected") === "mule_dealer");
    done();
});

test("picking a shop from the picker opens its screen, and Back returns to the list", async () => {
    const ada = setup();
    script(press("Habiti"), press("Back"), press("Close"));
    await forms.openShopPicker(ada);
    assert.equal(ui.shown.length, 3);
    assert.equal(strip(titleOf(ui.shown[1])), "Habiti");
    assert.equal(strip(titleOf(ui.shown[2])), "Shops");
    assert.equal(problems.length, 0, problems.join("; "));
});

test("a second builder menu is refused while one is open", async () => {
    const ada = setup();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    script(() => held);

    const first = forms.openShopEditor(ada, "habiti");
    await settle();
    assert.equal(forms.hasBuilderMenuOpen(ada), true);

    await forms.openShopEditor(ada, "habiti");
    assert.equal(ui.shown.length, 1, "no second form");
    assert.match(chatOf(ada), /Finish or close the menu you have open first/);

    release(close());
    await first;
    assert.equal(forms.hasBuilderMenuOpen(ada), false);
});

test("a shop deleted from under the builder's screen simply closes it", async () => {
    const ada = setup();
    script((form) => { store.deleteShop("habiti"); return press("Greeting")(form); });
    await assert.doesNotReject(forms.openShopEditor(ada, "habiti"));
    assert.equal(ui.shown.length, 1, "nothing was built for a shop that is not there");
});

test("the wand's offer to make a plain NPC a shop turns it into one that can be sold from", async () => {
    const ada = setup({ deals: [] });
    const { check, done } = checks();

    const plain = fake.makeEntity({ typeId: "minecraft:npc" });
    script(yes, fill({ "The shop's name": "Village Smith" }), press("Close"));
    await forms.openAdoptNpc(ada, plain);

    const shop = store.getShop("village_smith");
    check("a shop was made", shop !== undefined);
    check("the NPC carries it", npcs.shopOf(plain) === "village_smith" && plain.hasTag(SHOP.npcTag));
    check("it was not made here, so deleting the shop will not remove it", plain.hasTag(SHOP.npcMadeTag) === false);
    check("its editor opened", ui.shown.some((form) => strip(titleOf(form)) === "Village Smith"));
    done();
});

test("declining the offer leaves a plain NPC alone", async () => {
    const ada = setup({ deals: [] });
    const plain = fake.makeEntity({ typeId: "minecraft:npc" });
    script(no);
    await forms.openAdoptNpc(ada, plain);
    assert.equal(npcs.shopOf(plain), undefined);
    assert.equal(store.listStored().length, 1, "only the shop setup() made");
});
