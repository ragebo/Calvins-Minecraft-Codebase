import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, system, world, load, checks, strip } from "./helpers.mjs";
import { ui, problems, close, buttonsOf, script, titleOf } from "./robbery-ui.mjs";

// systems/shoptalk.ts: a click on a shop NPC becomes the shop. Two ways in, since how the real game treats a click on a vanilla
// NPC is what the probe measures: the "before" event is cancelled and the shop opens (interception), or the NPC's dialogue
// scene runs `/scriptevent rae:npc shop` from its one button. The "before" callback is restricted, so it decides and the
// screens open a tick later. The wand EDITS, anything else PLAYS.

const { PlayerPermissionLevel } = fakeApi;
const store = await load("core/shopstore.js");
const npcs = await load("core/shopnpc.js");
const L = await load("logic/shop.js");
await load("systems/shoptalk.js");
const { resetAllSystems } = await load("core/registry.js");
const { SHOP, ROBBERY } = await load("config/balance.js");

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    fake.strictBefore = true;                  // the "before" event runs restricted, as in the game
    store.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    const shop = L.addTrade(L.newShop("habiti", "Habiti").shop, L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)).shop;
    assert.ok(store.saveShop(shop).ok);
    const op = fake.makePlayer("Op", { inventory: true, permission: PlayerPermissionLevel.Operator });
    const ada = fake.makePlayer("Ada", { inventory: true, permission: PlayerPermissionLevel.Member });
    const npc = fake.makeEntity({ typeId: SHOP.npcType });
    npcs.bindNpc(npc, shop);
    return { op, ada, npc };
}

const click = (player, target, held) => {
    const event = { player, target, itemStack: held === undefined ? undefined : { typeId: held }, cancel: false };
    world.beforeEvents.playerInteractWithEntity.emit(event);
    return event;
};
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** Lets the tick that opens the screen pass, and the screen run to its first form. */
const afterClick = async () => { fake.advance(1); await settle(); };
const titles = () => ui.shown.map((form) => strip(titleOf(form)));

test("a click on a shop NPC is cancelled at once and opens the shop a tick later", async () => {
    const { ada, npc } = setup();
    const { check, done } = checks();
    script(close);

    const event = click(ada, npc);
    check("cancelled, so the game's own dialogue does not open", event.cancel === true);
    check("no screen yet: a before-event cannot show a form", ui.shown.length === 0);

    await afterClick();
    check("the shop is open for the one who clicked", ui.shown.length === 1 && titles()[0] === "Habiti" && ui.shown[0].player === ada, titles().join());
    check("it lists the deal", buttonsOf(ui.shown[0]).map(strip)[0] === "Iron Sword for 60 coins");
    done();
});

test("a click on something that is not an NPC, or an NPC that is not a shop, is left alone", async () => {
    const { ada } = setup();
    const { check, done } = checks();

    const cow = fake.makeEntity({ typeId: "minecraft:cow" });
    check("a cow is not cancelled", click(ada, cow).cancel === false);

    const plain = fake.makeEntity({ typeId: SHOP.npcType });
    check("a plain NPC is not cancelled", click(ada, plain).cancel === false);

    await afterClick();
    check("and nothing opened", ui.shown.length === 0);
    done();
});

test("with interception off the game's own dialogue is left to run: its scene's button carries the click", async () => {
    const { ada, npc } = setup();
    const { check, done } = checks();
    SHOP.interceptClicks = false;

    try {
        check("not cancelled", click(ada, npc).cancel === false);
        await afterClick();
        check("nothing opened by the click", ui.shown.length === 0);
    } finally {
        SHOP.interceptClicks = true;
    }
    done();
});

test("an operator who sneaks gets the game's own NPC screen, and one who does not gets the shop", async () => {
    const { op, npc } = setup();
    const { check, done } = checks();
    script(close);

    op.isSneaking = true;
    check("sneaking: not cancelled (the skin screen opens)", click(op, npc).cancel === false);
    await afterClick();
    check("and no shop opened", ui.shown.length === 0);

    op.isSneaking = false;
    check("standing: cancelled, as for anyone", click(op, npc).cancel === true);
    await afterClick();
    check("and the shop opens", titles()[0] === "Habiti" && buttonsOf(ui.shown[0]).map(strip)[0] === "Iron Sword for 60 coins");
    done();
});

test("a member who sneaks is still a customer: only operators get the game's own screen", async () => {
    const { ada, npc } = setup();
    script(close);
    ada.isSneaking = true;
    assert.equal(click(ada, npc).cancel, true);
    await afterClick();
    assert.equal(titles()[0], "Habiti");
});

test("the wand EDITS: an operator holding it gets the builder's screen", async () => {
    const { op, npc } = setup();
    const { check, done } = checks();
    script(close);

    const event = click(op, npc, ROBBERY.wandItemId);
    check("cancelled", event.cancel === true);
    await afterClick();
    check("the builder's screen opened, not the customer's", titles()[0] === "Habiti" && buttonsOf(ui.shown[0]).map(strip).includes("Add a deal"), buttonsOf(ui.shown[0]).join("|"));
    done();
});

test("anyone else holding the wand is simply a customer", async () => {
    const { ada, npc } = setup();
    script(close);
    click(ada, npc, ROBBERY.wandItemId);
    await afterClick();
    assert.ok(!buttonsOf(ui.shown[0]).map(strip).includes("Add a deal"));
    assert.equal(buttonsOf(ui.shown[0]).map(strip)[0], "Iron Sword for 60 coins");
});

test("the wand on a plain NPC offers to make it a shop; without the wand nothing happens", async () => {
    const { op, ada } = setup();
    const { check, done } = checks();
    const plain = fake.makeEntity({ typeId: SHOP.npcType });
    script(close);

    check("a customer's click on a plain NPC is not touched", click(ada, plain).cancel === false);
    await afterClick();
    check("nothing opened for them", ui.shown.length === 0);

    const event = click(op, plain, ROBBERY.wandItemId);
    check("the wand's click is cancelled", event.cancel === true);
    await afterClick();
    check("the offer is shown", titles()[0] === "Make this NPC a shop?", titles().join());
    done();
});

test("one click reported twice is one screen, and a later click opens it again", async () => {
    const { ada, npc } = setup();
    const { check, done } = checks();
    script(close, close);

    const first = click(ada, npc);
    const second = click(ada, npc);
    check("both are cancelled", first.cancel === true && second.cancel === true);
    await afterClick();
    check("one screen", ui.shown.length === 1, String(ui.shown.length));

    fake.advance(SHOP.clickGapTicks + 1);
    click(ada, npc);
    await afterClick();
    check("a click after the gap opens it again", ui.shown.length === 2, String(ui.shown.length));
    done();
});

test("a wand click reported twice opens the builder once, without telling the builder to close a menu they never opened", async () => {
    const { op, npc } = setup();
    script(close, close);

    click(op, npc, ROBBERY.wandItemId);
    click(op, npc, ROBBERY.wandItemId);
    await afterClick();

    assert.equal(ui.shown.length, 1, String(ui.shown.length));
    assert.ok(!op.messages.map(strip).some((m) => /Finish or close the menu/.test(m)), op.messages.map(strip).join(" | "));
});

test("a click on the NPC of a shop that has been deleted says the shop has closed", async () => {
    const { ada, npc } = setup();
    store.deleteShop("habiti");
    click(ada, npc);
    await afterClick();
    assert.equal(ui.shown.length, 0);
    assert.match(ada.messages.map(strip).join(" | "), /That shop has closed/);
});

test("the before handler touches nothing the engine forbids in restricted execution", async () => {
    const { op, ada, npc } = setup();
    const plain = fake.makeEntity({ typeId: SHOP.npcType });
    script(close);
    // fake.strictBefore is on: any call tagged no-restricted-execution would throw here and fail the test.
    assert.doesNotThrow(() => {
        click(ada, npc);
        click(op, npc, ROBBERY.wandItemId);
        click(op, plain, ROBBERY.wandItemId);
        op.isSneaking = true;
        click(op, npc);
    });
    // Let every screen those clicks scheduled open and close, so none is left running into the next test.
    await afterClick();
    await settle();
});

// ---------------------------------------------------------------------------------------------------------
// The dialogue scene's button
// ---------------------------------------------------------------------------------------------------------

const emit = (event) => system.afterEvents.scriptEventReceive.emit(event);
const buttonFrom = (npc, player, message = "shop") => emit({ id: "rae:npc", message, sourceEntity: npc, initiator: player, sourceType: "NPCDialogue" });

test("the scene's button opens the shop of the NPC that ran it, for the player who pressed it", async () => {
    const { ada, npc } = setup();
    const { check, done } = checks();
    script(close);

    buttonFrom(npc, ada);
    await settle();

    check("the shop is open for the initiator", ui.shown.length === 1 && titles()[0] === "Habiti" && ui.shown[0].player === ada, titles().join());
    done();
});

test("with interception off, the click and then the button make one clean path", async () => {
    const { ada, npc } = setup();
    const { check, done } = checks();
    script(close);
    SHOP.interceptClicks = false;

    try {
        check("the click is left to the game's dialogue", click(ada, npc).cancel === false);
        buttonFrom(npc, ada);                             // the player presses the scene's one button
        await settle();
        check("the shop opened exactly once, from the button", ui.shown.length === 1 && titles()[0] === "Habiti");
    } finally {
        SHOP.interceptClicks = true;
    }
    done();
});

test("the button run by hand, or from an NPC with no shop, or with an action nobody knows, opens nothing", async () => {
    const { op, ada, npc } = setup();
    const { check, done } = checks();

    emit({ id: "rae:npc", message: "shop", sourceEntity: op, sourceType: "Entity" });
    check("typed by an operator: told what it is for", op.messages.map(strip).some((m) => /what a shop NPC's dialogue button runs/.test(m)), op.messages.map(strip).join(" | "));

    const plain = fake.makeEntity({ typeId: SHOP.npcType });
    buttonFrom(plain, ada);
    check("an NPC with no shop: told so", ada.messages.map(strip).some((m) => /This NPC has no shop/.test(m)));

    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        buttonFrom(npc, ada, "frobnicate");
        buttonFrom(npc, undefined);
    } finally {
        console.warn = original;
    }

    await settle();
    check("an unknown action opens nothing and is logged", ui.shown.length === 0 && warnings.some((w) => /does not know: "frobnicate"/.test(w)), warnings.join(" | "));
    check("an NPC button with no player behind it opens nothing and is logged", warnings.some((w) => /no player behind it/.test(w)));
    done();
});

test("a round reset does not break the click path", async () => {
    const { ada, npc } = setup();
    script(close);
    resetAllSystems();
    assert.equal(click(ada, npc).cancel, true);
    await afterClick();
    assert.equal(ui.shown.length, 1);
});
