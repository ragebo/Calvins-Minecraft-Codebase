import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks, strip } from "./helpers.mjs";
import { ui, problems, close, press, script, buttonsOf, titleOf } from "./robbery-ui.mjs";

// systems/shopbuilder.ts: the /rae:shop_* commands. The contract: every command is operator-only and registers under the real
// registry's rules; a command callback runs RESTRICTED, so each one saves what it can at once, answers honestly (a Failure the
// player sees) and does the part that changes the world (the NPC) a tick later; which shop a command means is the one named,
// else the NPC being looked at, else the one last worked on.

const { ItemStack, PlayerPermissionLevel, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } = fakeApi;
const store = await load("core/shopstore.js");
const npcs = await load("core/shopnpc.js");
const L = await load("logic/shop.js");
await load("systems/shopbuilder.js");
const { SHOP } = await load("config/balance.js");

const NAMES = ["list", "info", "new", "sell", "buy", "trade", "service", "edit", "open", "select", "copy", "place", "delete", "undo"].map((n) => `rae:shop_${n}`);

function setup() {
    fake.reset();
    fake.advance(1);
    store.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
}

const operator = (name = "Op") => fake.makePlayer(name, { inventory: true, permission: PlayerPermissionLevel.Operator });
const member = (name = "Mem") => fake.makePlayer(name, { inventory: true, permission: PlayerPermissionLevel.Member });
const said = (player) => player.messages.map(strip);
const fromPlayer = (player) => ({ sourceEntity: player });
const fromCommandBlock = () => ({ sourceEntity: undefined, sourceBlock: { typeId: "minecraft:command_block" } });
const fromNpc = (player) => ({ sourceEntity: fake.makeEntity({ typeId: "minecraft:npc" }), initiator: player });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const succeeded = (result) => result?.status === CustomCommandStatus.Success;
const failed = (result) => result?.status === CustomCommandStatus.Failure;

function commands() {
    const started = fake.startUp();
    return { ...started, as: (origin, name, ...args) => started.run(name, origin, ...args) };
}

const hold = (player, stack) => player.container.setItem(player.selectedSlotIndex, stack);

// ---------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------

test("every command registers under the real registry's rules, operator-only, with the right parameters", () => {
    setup();
    const { check, done } = checks();
    const { commands: registered } = commands();

    const names = [...registered.keys()].filter((n) => n.startsWith("rae:shop_")).sort();
    check("exactly these fourteen", names.join(",") === [...NAMES].sort().join(","), names.join(","));
    check("all operator-only", names.every((n) => registered.get(n).def.permissionLevel === CommandPermissionLevel.GameDirectors));
    check("sell and buy take whole coins", ["rae:shop_sell", "rae:shop_buy"].every((n) => registered.get(n).def.mandatoryParameters[0].type === CustomCommandParamType.Integer));
    check("new takes a name", registered.get("rae:shop_new").def.mandatoryParameters[0].type === CustomCommandParamType.String);
    check("delete takes a shop and a confirmation", registered.get("rae:shop_delete").def.mandatoryParameters.map((p) => p.type).join() === `${CustomCommandParamType.String},${CustomCommandParamType.Boolean}`);
    check("every command has a description", names.every((n) => registered.get(n).def.description.length > 10));
    done();
});

test("one command that fails to register does not take the others down", () => {
    setup();
    const seen = new Set();
    const registry = {
        registerEnum() {},
        registerCommand(def) {
            if (def.name === "rae:shop_info") throw new Error("NamespaceNameError (pretend)");
            seen.add(def.name);
        }
    };
    fakeApi.system.beforeEvents.startup.emit({ customCommandRegistry: registry });
    assert.ok(!seen.has("rae:shop_info") && seen.has("rae:shop_list") && seen.has("rae:shop_undo"), [...seen].join());
});

test("a member is turned away from every command by the engine, before any callback runs", () => {
    setup();
    const { as, commands: registered } = commands();
    const mem = member();
    const refused = [...registered.keys()].filter((n) => n.startsWith("rae:shop_"))
        .map((n) => as(fromPlayer(mem), n, ...Array(registered.get(n).def.mandatoryParameters?.length ?? 0).fill("x")).refused);
    assert.ok(refused.every((r) => r === "permission"), refused.join());
});

// ---------------------------------------------------------------------------------------------------------
// Making a shop
// ---------------------------------------------------------------------------------------------------------

test("new saves the shop at once, selects it, and a tick later puts its NPC in front of the builder", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    const result = as(fromPlayer(op), "rae:shop_new", "Habiti the Horseman");
    check("the command succeeds", succeeded(result), JSON.stringify(result));
    check("the shop is saved under a slug", store.getShop("habiti_the_horseman")?.name === "Habiti the Horseman");
    check("and selected", op.getDynamicProperty("rae:shop:selected") === "habiti_the_horseman");
    check("no NPC yet: a command callback cannot spawn", npcs.npcsOf("habiti_the_horseman").length === 0);

    fake.advance(1);

    const [npc] = npcs.npcsOf("habiti_the_horseman");
    check("a tick later there is one NPC", npc !== undefined);
    check("it is a vanilla NPC carrying the shop", npc?.typeId === SHOP.npcType && npcs.shopOf(npc) === "habiti_the_horseman" && npc.hasTag(SHOP.npcTag));
    check("it was made here, so deleting the shop removes it", npc?.hasTag(SHOP.npcMadeTag));
    check("it wears the shop's name", npc?.nameTag === "Habiti the Horseman", npc?.nameTag);
    check("it is pointed at the dialogue scene", fake.dimension("overworld").commands.includes(`dialogue change @s ${SHOP.dialogueScene}`), fake.dimension("overworld").commands.join(" | "));
    check("the builder was told", said(op).some((m) => /Habiti the Horseman \(habiti_the_horseman\) is in front of you/.test(m)), said(op).join(" | "));
    done();
});

test("two shops with one name get two ids; an empty name or a command block is refused", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    as(fromPlayer(op), "rae:shop_new", "Habiti");
    check("the second is habiti_2", store.getShop("habiti") !== undefined && store.getShop("habiti_2") !== undefined);
    check("an empty name is refused with the reason", failed(as(fromPlayer(op), "rae:shop_new", "   ")) && /name cannot be empty/.test(as(fromPlayer(op), "rae:shop_new", "   ").message));
    check("a command block has no one to put an NPC in front of", failed(as(fromCommandBlock(), "rae:shop_new", "Habiti")));
    check("still two shops", store.listStored().length === 2);
    done();
});

test("an NPC that cannot be placed leaves the shop saved and says how to try again", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    const realSpawn = op.dimension.spawnEntity;
    op.dimension.spawnEntity = () => { throw new Error("the chunk is not loaded"); };

    try {
        as(fromPlayer(op), "rae:shop_new", "Habiti");
        fake.advance(1);
    } finally {
        op.dimension.spawnEntity = realSpawn;
    }

    check("the shop is saved", store.getShop("habiti") !== undefined);
    check("the builder is told what happened and what to do", said(op).some((m) => /saved but its NPC could not be placed/.test(m) && /shop_place/.test(m)), said(op).join(" | "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Stocking from the hand
// ---------------------------------------------------------------------------------------------------------

test("sell and buy make a deal from the held item, and say what was added", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);

    hold(op, new ItemStack("minecraft:iron_sword", 1));
    const sell = as(fromPlayer(op), "rae:shop_sell", 60);
    check("sell succeeds and names the deal", succeeded(sell) && /Added to Habiti: Iron Sword for 60 coins\./.test(sell.message), JSON.stringify(sell));

    hold(op, new ItemStack("minecraft:feather", 3));
    const buy = as(fromPlayer(op), "rae:shop_buy", 8);
    check("buy succeeds and names the deal", succeeded(buy) && /Sell Feather x3 for 8 coins/.test(buy.message), JSON.stringify(buy));

    check("both deals are saved on the shop", store.getShop("habiti").trades.map(L.describeTrade).join(" | ") === "Iron Sword for 60 coins | Sell Feather x3 for 8 coins");
    done();
});

test("with an empty hand, or no shop to mean, or an illegal price, the command answers with the reason", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    check("no shop at all: says how to pick one", failed(as(fromPlayer(op), "rae:shop_sell", 5)) && /choose one with \/rae:shop_select/.test(as(fromPlayer(op), "rae:shop_sell", 5).message));

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);

    check("an empty hand", /hold the item first/.test(as(fromPlayer(op), "rae:shop_sell", 5).message));

    hold(op, new ItemStack("minecraft:iron_sword", 1));
    const dear = as(fromPlayer(op), "rae:shop_sell", SHOP.maxCoins + 1);
    check("a price over the cap is a Failure with the cap in it", failed(dear) && new RegExp(String(SHOP.maxCoins)).test(dear.message), dear.message);
    check("nothing was added by any of these", store.getShop("habiti").trades.length === 0);
    check("a command block cannot hold an item", failed(as(fromCommandBlock(), "rae:shop_sell", 5)));
    done();
});

test("the shop a command means: the NPC being looked at beats the one last worked on", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "First");
    fake.advance(1);
    as(fromPlayer(op), "rae:shop_new", "Second");                      // selected now
    fake.advance(1);

    hold(op, new ItemStack("minecraft:iron_sword", 1));
    as(fromPlayer(op), "rae:shop_sell", 10);
    check("with no aim it goes to the selected shop", store.getShop("second").trades.length === 1 && store.getShop("first").trades.length === 0);

    op.aimEntities = npcs.npcsOf("first");
    as(fromPlayer(op), "rae:shop_sell", 20);
    check("looking at the first NPC sends it there", store.getShop("first").trades.length === 1 && store.getShop("second").trades.length === 1);

    op.aimEntities = [];
    as(fromPlayer(op), "rae:shop_select", "first");
    as(fromPlayer(op), "rae:shop_sell", 30);
    check("select changes where it goes", store.getShop("first").trades.length === 2);
    check("selecting a shop that is not there is refused", failed(as(fromPlayer(op), "rae:shop_select", "nobody")));
    done();
});

test("with only one shop, it is the one meant without choosing", () => {
    setup();
    const { as } = commands();
    const op = operator();
    as(fromPlayer(op), "rae:shop_new", "Only");
    fake.advance(1);
    op.setDynamicProperty("rae:shop:selected", undefined);
    hold(op, new ItemStack("minecraft:iron_sword", 1));
    assert.ok(succeeded(as(fromPlayer(op), "rae:shop_sell", 10)));
    assert.equal(store.getShop("only").trades.length, 1);
});

// ---------------------------------------------------------------------------------------------------------
// Screens from commands
// ---------------------------------------------------------------------------------------------------------

test("trade opens the trade form a tick later, and edit and open open their screens", async () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);
    must(store.saveShop(must(L.addTrade(store.getShop("habiti"), L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)))));

    op.container.setItem(4, new ItemStack("minecraft:gold_ingot", 3));
    hold(op, new ItemStack("minecraft:diamond", 1));
    script(close);
    check("trade answers at once", succeeded(as(fromPlayer(op), "rae:shop_trade")));
    check("and the form is not up until the next tick", ui.shown.length === 0);
    fake.advance(1);
    await settle();
    check("then it is: the trade form", ui.shown.length === 1 && titleOf(ui.shown[0]) === "Trade", ui.shown.map(titleOf).join());

    ui.shown.length = 0;
    script(close);
    check("edit with a name succeeds", succeeded(as(fromPlayer(op), "rae:shop_edit", "habiti")));
    fake.advance(1);
    await settle();
    check("it opens that shop's builder screen", strip(titleOf(ui.shown[0])) === "Habiti" && buttonsOf(ui.shown[0]).map(strip).includes("Add a deal"), ui.shown.map(titleOf).join());

    // Two shops and none selected: there is no one shop to mean, so edit with no name lists them.
    ui.shown.length = 0;
    script(close);
    op.setDynamicProperty("rae:shop:selected", undefined);
    must(store.saveShop(must(L.newShop("other", "Other"))));
    as(fromPlayer(op), "rae:shop_edit");
    fake.advance(1);
    await settle();
    check("with no shop to mean, edit opens the picker", strip(titleOf(ui.shown[0])) === "Shops", ui.shown.map(titleOf).join());

    ui.shown.length = 0;
    script(close);
    check("edit with an unknown name is a Failure", failed(as(fromPlayer(op), "rae:shop_edit", "nobody")));

    check("open succeeds", succeeded(as(fromPlayer(op), "rae:shop_open", "habiti")));
    fake.advance(1);
    await settle();
    check("it shows the shop as a customer sees it", strip(titleOf(ui.shown[0])) === "Habiti" && buttonsOf(ui.shown[0]).map(strip)[0] === "Iron Sword for 60 coins", buttonsOf(ui.shown[0]).join("|"));
    check("open with an unknown shop is a Failure", failed(as(fromPlayer(op), "rae:shop_open", "nobody")));
    done();
});

function must(result) { assert.ok(result.ok, result.reason); return result.shop ?? result.value; }

test("an NPC's button can run a command: the player behind it is the initiator", async () => {
    setup();
    const { as } = commands();
    const op = operator();
    must(store.saveShop(must(L.addTrade(must(L.newShop("habiti", "Habiti")), L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60)))));
    script(close);
    assert.ok(succeeded(as(fromNpc(op), "rae:shop_open", "habiti")));
    fake.advance(1);
    await settle();
    assert.equal(ui.shown.length, 1);
    assert.equal(ui.shown[0].player, op);
});

// ---------------------------------------------------------------------------------------------------------
// Looking, copying, placing, deleting, undoing
// ---------------------------------------------------------------------------------------------------------

test("list and info describe shops, and info with true writes the saved text to the log", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    check("no shops yet: how to start", /There are no shops yet/.test(as(fromPlayer(op), "rae:shop_list").message));

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);
    hold(op, new ItemStack("minecraft:iron_sword", 1));
    as(fromPlayer(op), "rae:shop_sell", 60);

    const list = as(fromPlayer(op), "rae:shop_list").message;
    check("the list has the id, name, deal count and NPC", /habiti: Habiti, 1 deal, 1 NPC/.test(list), list);

    world.setDynamicProperty("rae:shop:def:broken", "{ no");
    store.forgetLoaded();
    check("an unreadable shop is listed as such", /broken: cannot be read/.test(as(fromPlayer(op), "rae:shop_list").message));

    const info = as(fromPlayer(op), "rae:shop_info", "habiti").message;
    check("info shows the deals", /Habiti \(habiti\): 1 deal/.test(info) && /Iron Sword for 60 coins/.test(info), info);

    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args.join(" "));
    try {
        const raw = as(fromPlayer(op), "rae:shop_info", "habiti", true);
        check("raw says how long the text is", /Written to the content log \(\d+ characters\)/.test(raw.message), raw.message);
    } finally {
        console.warn = original;
    }
    check("and the log has the saved text", lines.some((l) => l.includes("habiti saved as:") && l.includes('"nm":"Habiti"')), lines.join(" | "));
    check("info for an unknown shop is a Failure", failed(as(fromPlayer(op), "rae:shop_info", "nobody")));
    done();
});

test("copy makes a second shop with the same deals and its own NPC; an unknown source is refused", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);
    hold(op, new ItemStack("minecraft:iron_sword", 1));
    as(fromPlayer(op), "rae:shop_sell", 60);

    const copy = as(fromPlayer(op), "rae:shop_copy", "habiti", "Second Stall");
    check("the command succeeds", succeeded(copy), JSON.stringify(copy));
    check("the copy has the deals at once", store.getShop("second_stall")?.trades.length === 1);
    check("and is selected", op.getDynamicProperty("rae:shop:selected") === "second_stall");
    fake.advance(1);
    check("its NPC appears a tick later, and the first shop's NPC is still one", npcs.npcsOf("second_stall").length === 1 && npcs.npcsOf("habiti").length === 1);
    check("copying what is not there is refused", failed(as(fromPlayer(op), "rae:shop_copy", "nobody", "x")));
    done();
});

test("place brings the NPC to the builder, or makes one when none is around", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);

    const [npc] = npcs.npcsOf("habiti");
    npc._location = { x: 900, y: 70, z: 900 };
    as(fromPlayer(op), "rae:shop_place");
    fake.advance(1);
    check("the same NPC came over", npcs.npcsOf("habiti").length === 1 && Math.abs(npc.location.x - op.location.x) < 5);

    npc.remove();
    as(fromPlayer(op), "rae:shop_place", "habiti");
    fake.advance(1);
    check("with none around, a new one is made", npcs.npcsOf("habiti").length === 1 && npcs.npcsOf("habiti")[0] !== npc);
    check("an unknown shop is refused", failed(as(fromPlayer(op), "rae:shop_place", "nobody")));
    done();
});

test("delete needs true, removes the shop at once and its NPC a tick later; undo brings the shop back", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);
    const [npc] = npcs.npcsOf("habiti");

    check("without true it refuses", failed(as(fromPlayer(op), "rae:shop_delete", "habiti", false)) && store.getShop("habiti") !== undefined);
    check("an unknown shop is refused", failed(as(fromPlayer(op), "rae:shop_delete", "nobody", true)));

    const gone = as(fromPlayer(op), "rae:shop_delete", "habiti", true);
    check("with true it deletes and says how to undo", succeeded(gone) && /shop_undo habiti/.test(gone.message), JSON.stringify(gone));
    check("the shop is gone at once, the NPC is not yet", store.getShop("habiti") === undefined && npc.isValid);
    check("the selection was cleared", op.getDynamicProperty("rae:shop:selected") === undefined);

    fake.advance(1);
    check("a tick later the NPC is gone too", npc.isValid === false && said(op).some((m) => /habiti: 1 NPC removed/.test(m)), said(op).join(" | "));

    const undone = as(fromPlayer(op), "rae:shop_undo", "habiti");
    check("undo with the id brings the shop back (it is no longer there to aim at)", succeeded(undone) && store.getShop("habiti") !== undefined, JSON.stringify(undone));
    check("undo again redoes the delete", succeeded(as(fromPlayer(op), "rae:shop_undo", "habiti")) && store.getShop("habiti") === undefined);
    check("undo with nothing to undo is a Failure", failed(as(fromPlayer(op), "rae:shop_undo", "nobody")));
    done();
});

test("undo without a name undoes the last change to the selected shop", () => {
    setup();
    const { as } = commands();
    const op = operator();
    as(fromPlayer(op), "rae:shop_new", "Habiti");
    fake.advance(1);
    hold(op, new ItemStack("minecraft:iron_sword", 1));
    as(fromPlayer(op), "rae:shop_sell", 60);
    assert.equal(store.getShop("habiti").trades.length, 1);
    assert.ok(succeeded(as(fromPlayer(op), "rae:shop_undo")));
    assert.equal(store.getShop("habiti").trades.length, 0);
});
