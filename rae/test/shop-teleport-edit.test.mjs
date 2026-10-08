import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, close, fill, press, script, buttonsOf, titleOf } from "./robbery-ui.mjs";

// Where a teleport goes, typed in. A builder cannot be expected to stand at the far end of a trip and click the NPC from there, so
// the teleport form has boxes for X, Y, Z and the dimension (starting as the spot the builder stands on), and a teleport deal that
// already exists can be pointed somewhere else from its own screen. Also the same through core/shopedit.ts.

const { PlayerPermissionLevel } = fakeApi;
const forms = await load("core/shopforms.js");
const edit = await load("core/shopedit.js");
const store = await load("core/shopstore.js");
const state = await load("core/state.js");
const L = await load("logic/shop.js");

const must = (result) => { assert.ok(result.ok, result.reason); return result.shop ?? result.value; };

const angeles = { x: -251.5, y: 63, z: 186.5, dimension: "overworld", name: "Angeles" };

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
    ada.location = { x: -251.4567, y: 63, z: 186.5 };
    let shop = must(L.newShop("habiti", "Habiti"));
    for (const deal of deals) shop = must(L.addTrade(shop, deal));
    must(store.saveShop(shop));
    return ada;
}

const chatOf = (player) => player.messages.map(strip).join(" | ");
const deals = () => store.getShop("habiti").trades.map(L.describeTrade);
const teleportOfFirst = () => L.teleportOf(store.getShop("habiti").trades[0]);
const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const formTitled = (title) => ui.shown.find((form) => strip(titleOf(form)) === title);

/** What a control of a shown form started as: a box's text, a switch's position, a dropdown's chosen index. */
function startedAs(form, label) {
    const control = form.calls.filter((c) => ["textField", "toggle", "dropdown"].includes(c[0])).find((c) => strip(String(c[1])).includes(label));
    if (!control) return undefined;
    if (control[0] === "textField") return control[3]?.defaultValue;
    if (control[0] === "toggle") return control[2]?.defaultValue;
    return control[3]?.defaultValueIndex;
}

const addTeleport = (answers) => [press("Add a deal"), press("A SERVICE"), press("A TELEPORT"), fill(answers), press("Back"), press("Back"), press("Close")];
const changeIt = (answers) => [press("Deals"), press("t1"), press("Change where it goes"), fill(answers), press("Back"), press("Back"), press("Close")];

// ---------------------------------------------------------------------------------------------------------
// Adding a teleport
// ---------------------------------------------------------------------------------------------------------

test("a new teleport's boxes start as the spot the builder stands on, and leaving them sends customers there", async () => {
    const ada = setup();
    const { check, done } = checks();

    script(...addTeleport({ "Name of this place": "Angeles", "Coins": "25" }));
    await forms.openShopEditor(ada, "habiti");

    const form = formTitled("A teleport");
    check("the form is there", form !== undefined);
    check("X, Y and Z start as where the builder stands, to a hundredth", startedAs(form, "X") === "-251.46" && startedAs(form, "Y") === "63" && startedAs(form, "Z") === "186.5", [startedAs(form, "X"), startedAs(form, "Y"), startedAs(form, "Z")].join(" "));
    check("the dimension starts as theirs", startedAs(form, "Dimension") === 0);
    check("no switch on a new teleport: the boxes are all there is", startedAs(form, "Use where I am") === undefined);

    check("the deal goes where they stood", JSON.stringify(teleportOfFirst()) === JSON.stringify({ kind: "teleport", x: -251.46, y: 63, z: 186.5, dimension: "overworld", name: "Angeles" }), JSON.stringify(teleportOfFirst()));
    check("it read in words", deals()[0] === "Teleport to Angeles for 25 coins", deals()[0]);
    check("nothing was missing", problems.length === 0, problems.join("; "));
    done();
});

test("a builder standing in the nether starts with the nether chosen", async () => {
    const ada = setup();
    ada.teleport({ x: 10, y: 70, z: 10 }, { dimension: fake.dimension("nether") });

    script(...addTeleport({ "Coins": "5" }));
    await forms.openShopEditor(ada, "habiti");

    assert.equal(startedAs(formTitled("A teleport"), "Dimension"), 1, "The nether is the second choice");
    assert.equal(teleportOfFirst()?.dimension, "nether");
});

test("typed coordinates send customers anywhere, however far the builder is from them", async () => {
    const ada = setup();
    const { check, done } = checks();
    const before = { ...ada.location };

    script(...addTeleport({ "X (": "5000", "Y (": "70.5", "Z (": "-3200", "Dimension": "The nether", "Name of this place": "The Far Fort", "Coins": "40" }));
    await forms.openShopEditor(ada, "habiti");

    check("the deal goes where it was typed", JSON.stringify(teleportOfFirst()) === JSON.stringify({ kind: "teleport", x: 5000, y: 70.5, z: -3200, dimension: "nether", name: "The Far Fort" }), JSON.stringify(teleportOfFirst()));
    check("the builder did not go anywhere", ada.location.x === before.x && ada.location.z === before.z && ada.dimension.id === "minecraft:overworld");
    check("it reads in words", deals()[0] === "Teleport to The Far Fort for 40 coins", deals()[0]);
    done();
});

test("a box that is not a number, a height the world lacks, or a price that is not a number adds nothing and says which", async () => {
    const ada = setup();
    const { check, done } = checks();

    script(...addTeleport({ "X (": "far", "Coins": "25" }), ...[]);
    await forms.openShopEditor(ada, "habiti");
    check("a word in X: refused, naming X and what was typed", /Not changed: X is a number like -251\.5 \(you typed "far"\)/.test(chatOf(ada)), chatOf(ada));

    script(...addTeleport({ "Y (": "6300", "Coins": "25" }));
    await forms.openShopEditor(ada, "habiti");
    check("a height of 6300: refused, with the range", /Y is a height from -64 to 320 \(you typed 6300\)/.test(chatOf(ada)), chatOf(ada));

    script(...addTeleport({ "Coins": "lots" }));
    await forms.openShopEditor(ada, "habiti");
    check("a price that is not a number: refused", /the coins are a whole number/.test(chatOf(ada)), chatOf(ada));

    check("through all of that nothing was added", deals().length === 0, deals().join(" | "));
    done();
});

test("closing the teleport form adds nothing", async () => {
    const ada = setup();

    script(press("Add a deal"), press("A SERVICE"), press("A TELEPORT"), close, press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    assert.equal(deals().length, 0);
    assert.equal(problems.length, 0, problems.join("; "));
});

test("a teleport that the model refuses (a price over the limit) is a sentence, not a half-made deal", async () => {
    const ada = setup();

    script(...addTeleport({ "Coins": "999999999" }));
    await forms.openShopEditor(ada, "habiti");

    assert.equal(deals().length, 0);
    assert.match(chatOf(ada), /Not changed:/);
});

// ---------------------------------------------------------------------------------------------------------
// Changing where an existing teleport goes
// ---------------------------------------------------------------------------------------------------------

test("a teleport deal's screen says exactly where it goes and offers to change it; other deals do not", async () => {
    const ada = setup({ deals: [L.teleportDeal(angeles, 25), L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)] });
    const { check, done } = checks();

    script(press("Deals"), press("t1"), press("Back"), press("t2"), press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    const screens = ui.shown.filter((form) => /^Habiti: t\d$/.test(strip(titleOf(form))));
    const [teleportScreen, swordScreen] = screens;

    check("the teleport deal's screen names the exact place", /Goes to -251\.5, 63, 186\.5 in the overworld/.test(bodyOf(teleportScreen)), bodyOf(teleportScreen));
    check("and has the button", buttonsOf(teleportScreen).some((b) => strip(b) === "Change where it goes"));
    check("the sword deal's screen has neither", !/Goes to/.test(bodyOf(swordScreen)) && !buttonsOf(swordScreen).some((b) => /Change where it goes/.test(b)));
    check("nothing was missing", problems.length === 0, problems.join("; "));
    done();
});

test("the boxes for an existing teleport start as where it goes now, and typing others moves it", async () => {
    const ada = setup({ deals: [L.teleportDeal(angeles, 25)] });
    const { check, done } = checks();

    script(...changeIt({ "X (": "100", "Z (": "-200", "Dimension": "The end", "Name of this place": "The Island" }));
    await forms.openShopEditor(ada, "habiti");

    const form = formTitled("Where it goes");
    check("the boxes started as the deal's place", startedAs(form, "X") === "-251.5" && startedAs(form, "Y") === "63" && startedAs(form, "Z") === "186.5" && startedAs(form, "Name of this place") === "Angeles", [startedAs(form, "X"), startedAs(form, "Y"), startedAs(form, "Z"), startedAs(form, "Name of this place")].join(" "));
    check("the switch starts off", startedAs(form, "Use where I am") === false);
    check("no price box here: the price has its own button", startedAs(form, "Coins") === undefined);

    check("the deal now goes where it was typed", JSON.stringify(teleportOfFirst()) === JSON.stringify({ kind: "teleport", x: 100, y: 63, z: -200, dimension: "the_end", name: "The Island" }), JSON.stringify(teleportOfFirst()));
    check("the builder was told where", /It now goes to 100, 63, -200 in the end/.test(chatOf(ada)), chatOf(ada));
    check("its price is as it was", store.getShop("habiti").trades[0].cost.coins === 25);
    check("nothing was missing", problems.length === 0, problems.join("; "));
    done();
});

test("the switch sends an existing teleport to where the builder stands now, and the boxes are ignored", async () => {
    const ada = setup({ deals: [L.teleportDeal(angeles, 25)] });
    const { check, done } = checks();

    ada.teleport({ x: 10.126, y: 70, z: -4 }, { dimension: fake.dimension("nether") });

    script(...changeIt({ "Use where I am": true, "X (": "not even a number" }));
    await forms.openShopEditor(ada, "habiti");

    check("it goes where they stand, in their dimension", JSON.stringify(teleportOfFirst()) === JSON.stringify({ kind: "teleport", x: 10.13, y: 70, z: -4, dimension: "nether", name: "Angeles" }), JSON.stringify(teleportOfFirst()));
    check("the broken box did not matter", !/Not changed/.test(chatOf(ada)), chatOf(ada));
    done();
});

test("a blank name takes the place's name off, and the button then reads the coordinates", async () => {
    const ada = setup({ deals: [L.teleportDeal(angeles, 25)] });

    script(...changeIt({ "Name of this place": "" }));
    await forms.openShopEditor(ada, "habiti");

    assert.equal(teleportOfFirst()?.name, undefined);
    assert.equal(deals()[0], "Teleport to -251, 63, 187 for 25 coins", "a button shows whole blocks; the deal's own screen shows the exact place");
});

test("a bad box leaves the teleport exactly where it was", async () => {
    const ada = setup({ deals: [L.teleportDeal(angeles, 25)] });
    const { check, done } = checks();
    const before = JSON.stringify(store.getShop("habiti"));

    script(...changeIt({ "Y (": "high" }));
    await forms.openShopEditor(ada, "habiti");
    check("a word: refused naming Y", /Not changed: Y is a number/.test(chatOf(ada)), chatOf(ada));

    script(...changeIt({ "Z (": "99999999999" }));
    await forms.openShopEditor(ada, "habiti");
    check("beyond the border: refused", /Z stay within|X and Z stay within/.test(chatOf(ada)), chatOf(ada));

    check("the deal is untouched", JSON.stringify(store.getShop("habiti")) === before);
    done();
});

test("closing the form changes nothing", async () => {
    const ada = setup({ deals: [L.teleportDeal(angeles, 25)] });
    const before = JSON.stringify(store.getShop("habiti"));

    script(press("Deals"), press("t1"), press("Change where it goes"), close, press("Back"), press("Back"), press("Close"));
    await forms.openShopEditor(ada, "habiti");

    assert.equal(JSON.stringify(store.getShop("habiti")), before);
});

test("in a deal with an effect as well, only the teleport moves, and who may take it stays", async () => {
    const both = {
        cost: { coins: 40, items: [] },
        rewards: [{ kind: "effect", effect: "speed", seconds: 30, amplifier: 1 }, { kind: "teleport", ...angeles }],
        requires: { role: "law" }
    };
    const ada = setup({ deals: [both] });

    script(...changeIt({ "X (": "1", "Y (": "2", "Z (": "3" }));
    await forms.openShopEditor(ada, "habiti");

    const [trade] = store.getShop("habiti").trades;
    assert.equal(trade.rewards[0].kind, "effect");
    assert.deepEqual({ ...trade.rewards[0] }, { kind: "effect", effect: "speed", seconds: 30, amplifier: 1 }, "the effect is as it was");
    assert.deepEqual([trade.rewards[1].x, trade.rewards[1].y, trade.rewards[1].z], [1, 2, 3]);
    assert.equal(trade.requires?.role, "law");
    assert.equal(trade.cost.coins, 40);
});

// ---------------------------------------------------------------------------------------------------------
// Underneath: core/shopedit.ts
// ---------------------------------------------------------------------------------------------------------

test("setTeleport says why when it cannot: no such shop, no such deal, a deal that teleports no one", () => {
    setup({ deals: [L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60), L.teleportDeal(angeles, 25)] });
    const { check, done } = checks();
    const to = { x: 0, y: 64, z: 0, dimension: "overworld" };

    check("no such shop", /there is no shop nobody/.test(edit.setTeleport("nobody", "t1", to, "").reason));
    check("no such deal", /there is no deal t9/.test(edit.setTeleport("habiti", "t9", to, "").reason));
    check("a sword teleports no one", /does not teleport anyone/.test(edit.setTeleport("habiti", "t1", to, "").reason));
    check("none of that changed anything", store.getShop("habiti").trades.length === 2 && L.teleportOf(store.getShop("habiti").trades[1]).x === -251.5);

    const moved = edit.setTeleport("habiti", "t2", { x: 7, y: 8, z: 9, dimension: "nether" }, "Seven");
    check("and the real one works, naming the place", moved.ok && L.teleportOf(store.getShop("habiti").trades[1]).name === "Seven" && L.teleportOf(store.getShop("habiti").trades[1]).dimension === "nether");
    check("it can be undone like any edit", store.undoLast("habiti").ok && L.teleportOf(store.getShop("habiti").trades[1]).x === -251.5);
    done();
});

test("whereIStand is the builder's spot to a hundredth, in their dimension", () => {
    const ada = setup();
    assert.deepEqual(edit.whereIStand(ada), { x: -251.46, y: 63, z: 186.5, dimension: "overworld" });

    ada.teleport({ x: 1.005, y: 70, z: 2 }, { dimension: fake.dimension("the_end") });
    assert.equal(edit.whereIStand(ada).dimension, "the_end");
});
