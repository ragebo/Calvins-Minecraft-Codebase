import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, system, world, load, checks, strip } from "./helpers.mjs";
import { ui, problems, close, press, script, buttonsOf, titleOf } from "./robbery-ui.mjs";

// What a builder types and presses to move an NPC and to name a shop: /rae:shop_move (and its list), /rae:shop_place's new care not
// to make a second NPC, shops found by the name they were given in every command, /rae:shop_list showing where each NPC is,
// the click that teaches where an NPC stands, and the editor's "Bring its NPC here". The machinery under them is in
// shop-npc-reach.test.mjs.

const { ItemStack, PlayerPermissionLevel, CustomCommandStatus } = fakeApi;
const store = await load("core/shopstore.js");
const npcs = await load("core/shopnpc.js");
const forms = await load("core/shopforms.js");
const edit = await load("core/shopedit.js");
const L = await load("logic/shop.js");
await load("systems/shopbuilder.js");
await load("systems/shoptalk.js");
const { SHOP, ROBBERY } = await load("config/balance.js");

const FAR = { x: 900, y: 70, z: 900 };

function setup() {
    fake.reset();
    fake.advance(1);
    store.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    return fake.makePlayer("Op", { inventory: true, permission: PlayerPermissionLevel.Operator });
}

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** Lets game time pass while the promises it starts get to run. */
const pass = async (ticks) => { for (let i = 0; i < ticks; i++) { fake.advance(1); await settle(); } };
const said = (player) => player.messages.map(strip).join(" | ");
const fromPlayer = (player) => ({ sourceEntity: player });
const succeeded = (result) => result?.status === CustomCommandStatus.Success;
const failed = (result) => result?.status === CustomCommandStatus.Failure;
const npcCount = () => fake.entities.filter((e) => e.typeId === SHOP.npcType).length;

function commands() {
    const started = fake.startUp();
    return { as: (origin, name, ...args) => started.run(name, origin, ...args) };
}

function shopFor(op, name, withDeal = false) {
    const made = edit.createShop(op, name);
    assert.ok(made.ok, made.reason);
    if (withDeal) assert.ok(edit.addDeal(made.shop.id, L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)).ok);
    return store.getShop(made.shop.id);
}

/** The shop's NPC: made in front of the builder, carried to a far corner nobody is near, remembered there, and out of sight. */
function strand(op, shop, at = FAR) {
    const npc = npcs.spawnShopNpc(op, shop);
    npc.teleport(at);
    npcs.rememberSpot(shop.id, npc);
    fake.setUnloaded("overworld", [{ from: { x: at.x - 20, y: -64, z: at.z - 20 }, to: { x: at.x + 20, y: 320, z: at.z + 20 } }]);
    fake.hideUnloadedEntities = true;
    return npc;
}

const near = (npc, op) => Math.hypot(npc.location.x - op.location.x, npc.location.z - op.location.z) < 5;

// ---------------------------------------------------------------------------------------------------------
// /rae:shop_move
// ---------------------------------------------------------------------------------------------------------

test("move brings an NPC from out of sight by the name it was given, and says where it came from", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const shop = shopFor(op, "Habiti the Horseman");
    const npc = strand(op, shop);

    const result = as(fromPlayer(op), "rae:shop_move", "Habiti the Horseman");
    check("the command succeeds at once", succeeded(result), JSON.stringify(result));

    await pass(5);

    check("the same NPC is in front of the builder", npc.isValid && near(npc, op) && npcCount() === 1);
    check("the builder was told it was loading, then where from", /Loading the area where Habiti the Horseman's NPC was last seen/.test(said(op)) && /came from 900, 70, 900 in the overworld and is in front of you/.test(said(op)), said(op));
    check("the good news is green", op.messages.some((m) => m.startsWith("§a") && /came from/.test(m)), op.messages.join(" | "));

    npc.teleport(FAR);
    npcs.rememberSpot(shop.id, npc);
    as(fromPlayer(op), "rae:shop_move", "habiti-the-horseman");
    await pass(5);
    check("the name works in lower case with hyphens too", near(npc, op));
    done();
});

test("move never makes an NPC: when it is gone it says where it was and how to make one", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const shop = shopFor(op, "Habiti");
    strand(op, shop).remove();

    as(fromPlayer(op), "rae:shop_move", "habiti");
    await pass(40);

    check("nothing was made", npcCount() === 0);
    check("it says it is not there any more, and what makes a new one", /not at 900, 70, 900 in the overworld any more\. \/rae:shop_place habiti makes a new one here/.test(said(op)), said(op));
    check("the bad news is yellow, not green", op.messages.some((m) => m.startsWith("§e") && /any more/.test(m)) && !op.messages.some((m) => m.startsWith("§a") && /any more/.test(m)), op.messages.join(" | "));
    check("an unknown shop is a Failure naming what was typed", failed(as(fromPlayer(op), "rae:shop_move", "nobody")) && /there is no shop "nobody"/.test(as(fromPlayer(op), "rae:shop_move", "nobody").message));
    done();
});

test("move when the area will not load makes nothing and says what to do", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const shop = shopFor(op, "Habiti");
    const npc = strand(op, shop);
    fake.tickingAreaFails = "TickingAreaError: not today";

    as(fromPlayer(op), "rae:shop_move", "habiti");
    await pass(5);

    check("nothing was made and the NPC is where it was", npcCount() === 1 && !near(npc, op));
    check("the builder is told why and the way out", /could not be brought \(TickingAreaError: not today\)/.test(said(op)) && /shop_place habiti true/.test(said(op)), said(op));
    done();
});

test("move with no name lists the shops by name with where each NPC is, and pressing one brings it", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const far = shopFor(op, "Habiti");
    const here = shopFor(op, "Mule Dealer");
    const farNpc = strand(op, far);
    npcs.spawnShopNpc(op, here);

    script(press("Habiti"));
    const result = as(fromPlayer(op), "rae:shop_move");
    check("the command opens the list", succeeded(result) && /Opening the list/.test(result.message), JSON.stringify(result));

    await pass(8);

    const picker = ui.shown.find((form) => strip(titleOf(form)) === "Bring an NPC here");
    const buttons = buttonsOf(picker).map(strip);
    check("the list is by name, with where each NPC is", buttons.includes("Habiti (not loaded, last at 900, 70, 900 in the overworld)") && buttons.includes("Mule Dealer (at 0, 64, 2 in the overworld)") && buttons.at(-1) === "Close", buttons.join(" | "));
    check("pressing a name brings that NPC", farNpc.isValid && near(farNpc, op));
    check("and the list closes after it", ui.shown.filter((form) => strip(titleOf(form)) === "Bring an NPC here").length === 1);
    check("nothing was missing", problems.length === 0, problems.join("; "));
    done();
});

test("pressing a shop in the list whose NPC is gone makes nothing: the list only moves, like the command", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const shop = shopFor(op, "Habiti");
    strand(op, shop).remove();

    script(press("Habiti"));
    as(fromPlayer(op), "rae:shop_move");
    await pass(40);

    check("no NPC was made", npcCount() === 0);
    check("the builder was told it is not there any more", /not at 900, 70, 900 in the overworld any more/.test(said(op)), said(op));
    check("and in the colour for bad news", op.messages.some((m) => m.startsWith("§e") && /any more/.test(m)));
    done();
});

test("the list with no shops says so, and only closes", async () => {
    const op = setup();
    const { as } = commands();

    script(close);
    as(fromPlayer(op), "rae:shop_move");
    await pass(3);

    const picker = ui.shown.find((form) => strip(titleOf(form)) === "Bring an NPC here");
    assert.deepEqual(buttonsOf(picker).map(strip), ["Close"]);
    assert.match(strip(String(picker.calls.find((c) => c[0] === "body")?.[1])), /No shops yet/);
});

// ---------------------------------------------------------------------------------------------------------
// /rae:shop_place
// ---------------------------------------------------------------------------------------------------------

test("place brings a loaded NPC, makes one when it is gone, and with true makes one regardless", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const shop = shopFor(op, "Habiti");
    const npc = npcs.spawnShopNpc(op, shop);
    npc._location = { x: 300, y: 64, z: 300 };

    as(fromPlayer(op), "rae:shop_place", "habiti");
    await pass(3);
    check("a loaded NPC is brought, not copied", npcCount() === 1 && near(npc, op));

    as(fromPlayer(op), "rae:shop_place", "habiti", true);
    await pass(3);
    check("with true a second one is made on purpose", npcCount() === 2 && /Made a new NPC for Habiti in front of you/.test(said(op)), said(op));
    done();
});

test("place never makes a second NPC just because the first is out of sight and its area will not load", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const shop = shopFor(op, "Habiti");
    strand(op, shop);
    fake.tickingAreaFails = "TickingAreaError: not today";

    as(fromPlayer(op), "rae:shop_place", "habiti");
    await pass(5);
    check("no second NPC", npcCount() === 1);
    check("it says so, and offers true", /could not be brought/.test(said(op)) && /shop_place habiti true/.test(said(op)), said(op));

    as(fromPlayer(op), "rae:shop_place", "habiti", true);
    await pass(3);
    check("and true really does make one anyway", npcCount() === 2);
    done();
});

test("place makes a new NPC when the remembered place loads and holds none", async () => {
    const op = setup();
    const { as } = commands();
    const shop = shopFor(op, "Habiti");
    strand(op, shop).remove();

    as(fromPlayer(op), "rae:shop_place", "habiti");
    await pass(40);

    assert.equal(npcCount(), 1);
    assert.ok(near(npcs.npcsOf("habiti")[0], op));
    assert.match(said(op), /was not at 900, 70, 900 in the overworld any more, so a new one is in front of you/);
});

// ---------------------------------------------------------------------------------------------------------
// Shops by name
// ---------------------------------------------------------------------------------------------------------

test("every command that takes a shop takes the name it was given, in any case", async () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    shopFor(op, "Mule Dealer", true);
    shopFor(op, "Habiti");

    check("select by name", succeeded(as(fromPlayer(op), "rae:shop_select", "mule dealer")) && op.getDynamicProperty("rae:shop:selected") === "mule_dealer");
    check("select reports the proper name", /Now building Mule Dealer/.test(as(fromPlayer(op), "rae:shop_select", "MULE DEALER").message));
    check("info by name", /Mule Dealer \(mule_dealer\): 1 deal/.test(as(fromPlayer(op), "rae:shop_info", "Mule-Dealer").message));
    check("info by a start of the name", /Mule Dealer \(mule_dealer\)/.test(as(fromPlayer(op), "rae:shop_info", "mule").message));

    script(close);
    check("open by name", succeeded(as(fromPlayer(op), "rae:shop_open", "Mule Dealer")));
    await pass(3);
    check("and the shop is the one shown", strip(titleOf(ui.shown[0])) === "Mule Dealer", ui.shown.map((f) => strip(titleOf(f))).join());

    script(close);
    check("edit by name", succeeded(as(fromPlayer(op), "rae:shop_edit", "Mule Dealer")));
    await pass(3);
    check("and the editor is the one shown", ui.shown.some((f) => strip(titleOf(f)) === "Mule Dealer" && buttonsOf(f).some((b) => /Add a deal/.test(b))));

    const copy = as(fromPlayer(op), "rae:shop_copy", "Mule Dealer", "Second Mule");
    check("copy from a shop by its name", succeeded(copy) && store.getShop("second_mule")?.trades.length === 1, JSON.stringify(copy));
    fake.advance(1);
    check("copy says how to stand it elsewhere", /go there and run \/rae:shop_move second_mule/.test(said(op)), said(op));
    done();
});

test("a start of a name that fits two shops is refused and names them; the id still works", () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    shopFor(op, "Stall One");
    shopFor(op, "Stall Two");

    const refused = as(fromPlayer(op), "rae:shop_info", "Stall");
    check("refused", failed(refused));
    check("names both, with ids", /Stall One \(stall_one\)/.test(refused.message) && /Stall Two \(stall_two\)/.test(refused.message), refused.message);
    check("the id works", succeeded(as(fromPlayer(op), "rae:shop_info", "stall_two")));
    check("so does a whole name", succeeded(as(fromPlayer(op), "rae:shop_info", "Stall One")));
    done();
});

test("delete takes an id or a whole name, never a start of one, and clears a shop too damaged to read", () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    shopFor(op, "Mule Dealer");
    shopFor(op, "Habiti");

    check("a start of a name is refused", failed(as(fromPlayer(op), "rae:shop_delete", "Mule", true)) && store.getShop("mule_dealer") !== undefined);
    check("a whole name deletes", succeeded(as(fromPlayer(op), "rae:shop_delete", "Mule Dealer", true)) && store.getShop("mule_dealer") === undefined);
    check("undo by id brings it back", succeeded(as(fromPlayer(op), "rae:shop_undo", "mule_dealer")) && store.getShop("mule_dealer") !== undefined);
    check("undo by the whole name of a shop that exists undoes its last change", /Undone for mule_dealer/.test(as(fromPlayer(op), "rae:shop_undo", "Mule Dealer").message ?? ""));

    world.setDynamicProperty("rae:shop:def:broken", "{ no");
    store.forgetLoaded();
    check("a shop too damaged to read is deleted by its id", succeeded(as(fromPlayer(op), "rae:shop_delete", "broken", true)));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The list, and how an NPC's place is learned
// ---------------------------------------------------------------------------------------------------------

test("the list says where each NPC is, and looking at it teaches where one stands now", () => {
    const op = setup();
    const { check, done } = checks();
    const { as } = commands();
    const placed = shopFor(op, "Placed");
    const strayed = shopFor(op, "Strayed");
    const never = shopFor(op, "Never");
    const stranded = shopFor(op, "Stranded");

    npcs.spawnShopNpc(op, placed);
    const moved = npcs.spawnShopNpc(op, strayed);
    moved._location = { x: 300, y: 64, z: 300 };           // moved by hand: nothing was told
    check("before the list, the old place is what is remembered", npcs.recallSpot("strayed").x === 0);
    strand(op, stranded);
    void never;

    const list = as(fromPlayer(op), "rae:shop_list").message;
    check("a placed one says where", /placed: Placed, 0 deals, NPC: at 0, 64, 2 in the overworld/.test(list), list);
    check("one moved by hand says where it is NOW", /strayed: Strayed, 0 deals, NPC: at 300, 64, 300 in the overworld/.test(list), list);
    check("one out of sight says where it was last", /stranded: Stranded, 0 deals, NPC: not loaded, last at 900, 70, 900 in the overworld/.test(list), list);
    check("one never placed says none", /never: Never, 0 deals, NPC: none found loaded/.test(list), list);
    check("and the list learned where the moved one is", npcs.recallSpot("strayed").x === 300);
    done();
});

test("a click on a shop NPC teaches where it stands, for a customer and for the wand", async () => {
    const op = setup();
    const { check, done } = checks();
    const ada = fake.makePlayer("Ada", { inventory: true, permission: PlayerPermissionLevel.Member });
    const shop = shopFor(op, "Habiti", true);
    const npc = npcs.spawnShopNpc(op, shop);
    fake.strictBefore = true;

    npc._location = { x: 500, y: 64, z: 500 };
    script(close);
    world.beforeEvents.playerInteractWithEntity.emit({ player: ada, target: npc, itemStack: undefined, cancel: false });
    await pass(2);
    check("a customer's click", npcs.recallSpot("habiti").x === 500, JSON.stringify(npcs.recallSpot("habiti")));

    npc._location = { x: 600, y: 64, z: 600 };
    script(close);
    world.beforeEvents.playerInteractWithEntity.emit({ player: op, target: npc, itemStack: { typeId: ROBBERY.wandItemId }, cancel: false });
    await pass(6);
    check("the wand's click", npcs.recallSpot("habiti").x === 600, JSON.stringify(npcs.recallSpot("habiti")));

    npc._location = { x: 700, y: 64, z: 700 };
    script(close);
    system.afterEvents.scriptEventReceive.emit({ id: "rae:npc", message: "shop", sourceEntity: npc, initiator: ada, sourceType: "NPCDialogue" });
    await pass(2);
    check("the dialogue button's click", npcs.recallSpot("habiti").x === 700, JSON.stringify(npcs.recallSpot("habiti")));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------------------------------------

test("the editor says where the NPC is and fetches it from out of sight with 'Bring its NPC here'", async () => {
    const op = setup();
    const { check, done } = checks();
    const shop = shopFor(op, "Habiti");
    const npc = strand(op, shop);

    script(press("Bring its NPC here"), press("Close"));
    await forms.openShopEditor(op, "habiti");
    await pass(8);

    const editor = ui.shown.find((form) => strip(titleOf(form)) === "Habiti");
    const body = strip(String(editor.calls.find((c) => c[0] === "body")?.[1]));
    check("the editor said where it was last", /NPC: not loaded, last at 900, 70, 900 in the overworld/.test(body), body);
    check("with the button that fits", buttonsOf(editor).some((b) => strip(b) === "Bring its NPC here"));
    check("pressing it fetched the same NPC", npc.isValid && near(npc, op) && npcCount() === 1);
    check("and said so", /came from 900, 70, 900 in the overworld/.test(said(op)), said(op));
    check("nothing was missing", problems.length === 0, problems.join("; "));
    done();
});

test("a shop whose NPC was never placed offers to place one, and one that was offers to bring it", async () => {
    const op = setup();
    const { check, done } = checks();
    shopFor(op, "Habiti");

    script(close);
    await forms.openShopEditor(op, "habiti");
    check("never placed: 'Place its NPC here'", buttonsOf(ui.shown.at(-1)).some((b) => strip(b) === "Place its NPC here") && !buttonsOf(ui.shown.at(-1)).some((b) => strip(b) === "Bring its NPC here"), buttonsOf(ui.shown.at(-1)).map(strip).join(" | "));

    npcs.spawnShopNpc(op, store.getShop("habiti"));
    ui.shown.length = 0;
    script(close);
    await forms.openShopEditor(op, "habiti");
    check("placed: 'Bring its NPC here'", buttonsOf(ui.shown.at(-1)).some((b) => strip(b) === "Bring its NPC here"));
    done();
});

test("copying from the editor says how to stand the copy somewhere else", async () => {
    const op = setup();
    shopFor(op, "Habiti", true);

    script(press("Copy this shop"), (form) => ({ canceled: false, formValues: ["Second Stall"] }), press("Close"));
    await forms.openShopEditor(op, "habiti");

    assert.ok(store.getShop("second_stall"));
    assert.match(said(op), /To stand it somewhere else, go there and run \/rae:shop_move second_stall/);
});
