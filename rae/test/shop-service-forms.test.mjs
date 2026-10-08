import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks, strip } from "./helpers.mjs";
import { ui, problems, close, fill, press, script, buttonsOf, titleOf } from "./robbery-ui.mjs";

// The builder's side of services and requirements (core/shopedit.ts, core/shopforms.ts, the /rae:shop_service command) and what
// a customer sees of them. A typo in an effect, an enchantment or an animal is caught when the builder types it, with what to
// try, because the game is asked; a teleport goes where the builder stands; who may take a deal is one small form.

const { ItemStack, PlayerPermissionLevel } = fakeApi;
const forms = await load("core/shopforms.js");
const edit = await load("core/shopedit.js");
const store = await load("core/shopstore.js");
const state = await load("core/state.js");
const L = await load("logic/shop.js");
await load("systems/shopbuilder.js");
const { SHOP } = await load("config/balance.js");

const must = (result) => { assert.ok(result.ok, result.reason); return result.shop ?? result.value; };

function setup({ deals = [] } = {}) {
    fake.reset();
    store.forgetLoaded();
    state.clearRecords();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    const ada = fake.makePlayer("Ada", { inventory: true, permission: PlayerPermissionLevel.Operator });
    fake.setScore("coins", ada, 100);
    let shop = must(L.newShop("habiti", "Habiti"));
    for (const deal of deals) shop = must(L.addTrade(shop, deal));
    must(store.saveShop(shop));
    return ada;
}

const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player);
const chatOf = (player) => player.messages.map(strip).join(" | ");
const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const deals = () => store.getShop("habiti").trades.map(L.describeTrade);
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------------------------------------
// What a builder types becomes a deal the game can do
// ---------------------------------------------------------------------------------------------------------

test("an effect is typed the way a person writes it, and stored as the game's id with the strength it means", () => {
    const ada = setup();
    const { check, done } = checks();
    const add = (what, level = 1, seconds = 10, coins = 20) => edit.addServiceDeal(ada, "habiti", "effect", { what, level, seconds, coins, name: "" });

    check("a plain id", add("regeneration", 3, 10, 20).ok && store.getShop("habiti").trades[0].rewards[0].amplifier === 2, JSON.stringify(store.getShop("habiti").trades[0]));
    check("capitals and a space become an id", add("Jump Boost").ok && store.getShop("habiti").trades[1].rewards[0].effect === "jump_boost");
    check("a namespaced id loses its namespace", add("minecraft:speed").ok && store.getShop("habiti").trades[2].rewards[0].effect === "speed");
    check("the deal reads in words", deals().join(" | ") === "Regeneration 3 (10s) for 20 coins | Jump Boost 1 (10s) for 20 coins | Speed 1 (10s) for 20 coins", deals().join(" | "));

    const typo = add("regen");
    check("a typo is refused and says what to try", !typo.ok && /does not know the effect "regen" \(try regeneration, speed/.test(typo.reason), JSON.stringify(typo));
    check("an empty name is refused and says what to try", !add("  ").ok && /name the effect \(regeneration/.test(add("  ").reason));
    check("level zero is refused with what a level is", !add("speed", 0).ok && /whole number from 1/.test(add("speed", 0).reason));
    check("too long is refused by the model with its limit", !add("speed", 1, SHOP.maxEffectSeconds + 1).ok && new RegExp(String(SHOP.maxEffectSeconds)).test(add("speed", 1, SHOP.maxEffectSeconds + 1).reason));
    check("nothing refused was saved", store.getShop("habiti").trades.length === 3);
    done();
});

test("an enchantment and an animal take a bare name or a namespaced one, and refuse what the game does not know", () => {
    const ada = setup();
    const { check, done } = checks();

    check("flame", edit.addServiceDeal(ada, "habiti", "enchant", { what: "Flame", level: 1, seconds: 0, coins: 100, name: "" }).ok && store.getShop("habiti").trades[0].rewards[0].enchantment === "minecraft:flame");
    check("namespaced power", edit.addServiceDeal(ada, "habiti", "enchant", { what: "minecraft:power", level: 3, seconds: 0, coins: 75, name: "" }).ok);
    const bad = edit.addServiceDeal(ada, "habiti", "enchant", { what: "fireyness", level: 1, seconds: 0, coins: 5, name: "" });
    check("an unknown enchantment is refused", !bad.ok && /does not know the enchantment "fireyness"/.test(bad.reason), JSON.stringify(bad));
    check("an empty one too", !edit.addServiceDeal(ada, "habiti", "enchant", { what: "", level: 1, seconds: 0, coins: 5, name: "" }).ok);

    check("a horse", edit.addServiceDeal(ada, "habiti", "mount", { what: "horse", level: 1, seconds: 0, coins: 35, name: "" }).ok && store.getShop("habiti").trades[2].rewards[0].entity === "minecraft:horse");
    const unicorn = edit.addServiceDeal(ada, "habiti", "mount", { what: "unicorn", level: 1, seconds: 0, coins: 35, name: "" });
    check("an unknown animal is refused and says what to try", !unicorn.ok && /does not know the animal "unicorn" \(try horse, mule, donkey\)/.test(unicorn.reason), JSON.stringify(unicorn));
    done();
});

test("a teleport goes where the builder stands, in the dimension they are in", () => {
    const ada = setup();
    const { check, done } = checks();

    ada.location = { x: -251.4567, y: 63, z: 186.5 };
    check("with a name", edit.addServiceDeal(ada, "habiti", "teleport", { what: "", level: 1, seconds: 0, coins: 25, name: "  Angeles  " }).ok);
    const [first] = store.getShop("habiti").trades[0].rewards;
    check("the spot is rounded to a hundredth and the name tidied", first.x === -251.46 && first.y === 63 && first.z === 186.5 && first.name === "Angeles" && first.dimension === "overworld", JSON.stringify(first));

    ada.teleport({ x: 10, y: 70, z: 10 }, { dimension: fake.dimension("nether") });
    check("in the nether it says so", edit.addServiceDeal(ada, "habiti", "teleport", { what: "", level: 1, seconds: 0, coins: 0, name: "" }).ok && store.getShop("habiti").trades[1].rewards[0].dimension === "nether");
    check("without a name, the coordinates are what it reads", /^Free: Teleport to 10, 70, 10$/.test(deals()[1]), deals()[1]);
    check("a price the rules refuse is refused", !edit.addServiceDeal(ada, "habiti", "teleport", { what: "", level: 1, seconds: 0, coins: -1, name: "" }).ok);
    check("a shop that is not there is refused", !edit.addServiceDeal(ada, "nobody", "teleport", { what: "", level: 1, seconds: 0, coins: 1, name: "" }).ok);
    done();
});

test("who may take a deal is set and cleared on a deal that exists", () => {
    setup({ deals: [L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)] });
    const { check, done } = checks();

    check("law only", edit.setRequirement("habiti", "t1", { role: "law" }).ok && deals()[0] === "Iron Sword for 60 coins (law only)");
    check("a bounty on top", edit.setRequirement("habiti", "t1", { role: "law", bounty: 20 }).ok && deals()[0] === "Iron Sword for 60 coins (law only, bounty 20+)");
    check("cleared", edit.setRequirement("habiti", "t1", undefined).ok && deals()[0] === "Iron Sword for 60 coins");
    check("a deal that is not there is refused", !edit.setRequirement("habiti", "t9", { role: "law" }).ok);
    check("a requirement the rules refuse is refused", !edit.setRequirement("habiti", "t1", { bounty: -3 }).ok && deals()[0] === "Iron Sword for 60 coins");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The builder's screens
// ---------------------------------------------------------------------------------------------------------

test("the builder adds each kind of service through the screens", async () => {
    const ada = setup();
    const { check, done } = checks();

    ada.location = { x: -251.5, y: 63, z: 186.5 };

    script(
        press("Add a deal"), press("A SERVICE"),
        press("A potion EFFECT"), fill({ "Effect": "regeneration", "Level": "3", "Seconds": "10", "Coins": "20" }),
        press("An ENCHANTMENT"), fill({ "Enchantment": "flame", "Level": "1", "Coins": "100" }),
        press("A tame ANIMAL"), fill({ "Animal": "mule", "Coins": "15" }),
        press("A TELEPORT"), fill({ "Name of this place": "Angeles", "Coins": "25" }),
        press("Back"), press("Back"), press("Close")
    );
    await forms.openShopEditor(ada, "habiti");

    check("all four were added", deals().join(" | ") === "Regeneration 3 (10s) for 20 coins | Flame 1 on the item you hold for 100 coins | Tame Mule for 15 coins | Teleport to Angeles for 25 coins", deals().join(" | "));
    check("each said what it added", /Added: Teleport to Angeles for 25 coins\./.test(chatOf(ada)));
    check("no button or field was missing", problems.length === 0, problems.join("; "));
    done();
});

test("a typo in a service is answered with a sentence in chat and nothing is added", async () => {
    const ada = setup();
    const { check, done } = checks();

    script(press("Add a deal"), press("A SERVICE"), press("A potion EFFECT"), fill({ "Effect": "regen", "Coins": "20" }), press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    check("nothing was added", deals().length === 0);
    check("the builder is told what to try", /does not know the effect "regen" \(try regeneration/.test(chatOf(ada)), chatOf(ada));
    done();
});

test("a number that is not a number is refused in plain words", async () => {
    const ada = setup();

    script(press("Add a deal"), press("A SERVICE"), press("A tame ANIMAL"), fill({ "Animal": "horse", "Coins": "lots" }), press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    assert.equal(deals().length, 0);
    assert.match(chatOf(ada), /whole numbers/);
});

test("closing a service form changes nothing", async () => {
    const ada = setup();
    script(press("Add a deal"), press("A SERVICE"), press("A potion EFFECT"), close, press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");
    assert.equal(deals().length, 0);
});

test("the deal screen sets who can take a deal, and shows it", async () => {
    const ada = setup({ deals: [L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)] });
    const { check, done } = checks();

    script(
        press("Deals"), press("t1"), press("Who can take it"), fill({ "Side": "Law only", "Least bounty": "20" }),
        press("Who can take it"), fill({ "Side": "Anyone", "Least bounty": "0" }),
        press("Back"), press("Back"), press("Close")
    );
    await forms.openShopEditor(ada, "habiti");

    const screens = ui.shown.filter((form) => /t1$/.test(strip(titleOf(form))));
    check("after setting it the deal screen shows it", screens.some((form) => /Iron Sword for 60 coins \(law only, bounty 20\+\)/.test(bodyOf(form))), screens.map(bodyOf).join(" | "));
    check("and after clearing it does not", /Iron Sword for 60 coins$/.test(bodyOf(screens.at(-1))), bodyOf(screens.at(-1)));
    check("it ends cleared", deals()[0] === "Iron Sword for 60 coins");
    check("the builder was told each time", /Now only for: law only, bounty 20\+\./.test(chatOf(ada)) && /Anyone can take it now\./.test(chatOf(ada)), chatOf(ada));
    check("nothing was missing", problems.length === 0, problems.join("; "));
    done();
});

test("outlaws only, and a bounty alone, can be chosen; a bounty that is not a number is refused", async () => {
    const ada = setup({ deals: [L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)] });

    script(
        press("Deals"), press("t1"),
        press("Who can take it"), fill({ "Side": "Outlaws only", "Least bounty": "0" }),
        press("Who can take it"), fill({ "Side": "Anyone", "Least bounty": "50" }),
        press("Who can take it"), fill({ "Side": "Anyone", "Least bounty": "many" }),
        press("Who can take it"), fill({ "Side": "Outlaws only", "Least bounty": "-3" }),
        press("Back"), press("Back"), press("Close")
    );
    await forms.openShopEditor(ada, "habiti");

    assert.match(chatOf(ada), /Now only for: outlaw only\./);
    assert.match(chatOf(ada), /Now only for: bounty 50\+\./);
    assert.equal(chatOf(ada).match(/least bounty is a whole number/g)?.length, 2, "both the word and the negative number were refused");
    assert.equal(deals()[0], "Iron Sword for 60 coins (bounty 50+)", "the refused ones left the last good setting alone");
});

// ---------------------------------------------------------------------------------------------------------
// What a customer sees and gets
// ---------------------------------------------------------------------------------------------------------

test("a customer who may not take a deal sees it greyed, with who it is for, and is told why when they press it", async () => {
    const ada = setup({ deals: [{ ...L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), requires: { role: "law" } }, L.buyDeal({ type: "minecraft:arrow", amount: 6 }, 15)] });
    const { check, done } = checks();

    state.update(ada, { role: "outlaw" });
    script(press("Iron Sword"), close);
    await forms.openShop(ada, "habiti");

    const buttons = buttonsOf(ui.shown[0]);
    check("the law-only deal says who it is for and is greyed", buttons[0] === "§7Iron Sword for 60 coins (law only)", buttons[0]);
    check("the open deal is plain", buttons[1] === "Arrow x6 for 15 coins", buttons[1]);
    check("pressing it says why, and nothing moves", /Not yet: only law players can do this/.test(bodyOf(ui.shown[1])) && coinsOf(ada) === 100);

    state.update(ada, { role: "law" });
    script(press("Iron Sword"), close);
    ui.shown.length = 0;
    await forms.openShop(ada, "habiti");
    check("a law player sees it plain and buys it", buttonsOf(ui.shown[0])[0] === "Iron Sword for 60 coins (law only)" && coinsOf(ada) === 40, `${buttonsOf(ui.shown[0])[0]} ${coinsOf(ada)}`);
    done();
});

test("a customer buys a service through the screen: the effect lands and it is said at the top of the next screen", async () => {
    const ada = setup({ deals: [L.effectDeal("regeneration", 10, 2, 20)] });

    script(press("Regeneration"), close);
    await forms.openShop(ada, "habiti");

    assert.equal(coinsOf(ada), 80);
    assert.equal(ada.effects[0].id, "regeneration");
    assert.match(bodyOf(ui.shown[1]), /Bought Regeneration 3 \(10s\) for 20 coins\./);
});

test("a customer buys an enchantment for the item in hand, or is told to hold one", async () => {
    const ada = setup({ deals: [L.enchantDeal("minecraft:flame", 1, 100)] });
    const { check, done } = checks();

    script(press("Flame"), close);
    await forms.openShop(ada, "habiti");
    check("an empty hand: told what to do, nothing charged", /Not yet: hold the item you want enchanted/.test(bodyOf(ui.shown[1])) && coinsOf(ada) === 100);

    ada.container.setItem(ada.selectedSlotIndex, new ItemStack("minecraft:bow"));
    ui.shown.length = 0;
    script(press("Flame"), close);
    await forms.openShop(ada, "habiti");
    check("holding a bow: it is enchanted and paid for", coinsOf(ada) === 0 && ada.container.getItem(ada.selectedSlotIndex).getComponent("minecraft:enchantable").getEnchantments().length === 1);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------

test("/rae:shop_service opens the service screen for the shop being built", async () => {
    const ada = setup();
    const { check, done } = checks();
    const started = fake.startUp();

    check("it is registered, operator-only", started.commands.has("rae:shop_service") && started.commands.get("rae:shop_service").def.permissionLevel === fakeApi.CommandPermissionLevel.GameDirectors);

    edit.select(ada, "habiti");
    script(close);
    const result = started.run("rae:shop_service", { sourceEntity: ada });
    check("it answers at once", result.status === fakeApi.CustomCommandStatus.Success);
    check("and nothing is up until the next tick", ui.shown.length === 0);

    fake.advance(1);
    await settle();
    check("then the screen is", ui.shown.length === 1 && strip(titleOf(ui.shown[0])) === "Habiti: add a service", ui.shown.map(titleOf).join());
    check("with the four services and Back", buttonsOf(ui.shown[0]).map(strip).join("|") === "A potion EFFECT|An ENCHANTMENT on the item they hold|A tame ANIMAL (horse, mule, donkey)|A TELEPORT (to where I stand, or typed coordinates)|Back", buttonsOf(ui.shown[0]).join("|"));

    edit.select(ada, undefined);
    store.deleteShop("habiti");
    check("with no shop to mean it is a Failure that says so", started.run("rae:shop_service", { sourceEntity: ada }).status === fakeApi.CustomCommandStatus.Failure);
    done();
});
