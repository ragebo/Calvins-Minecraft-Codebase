import { test } from "node:test";
import { fake, fakeApi, world, load, checks, strip, useBlock } from "./helpers.mjs";
import { L, SITE, at, bank, buildSite, ok } from "./robbery-fixtures.mjs";
import { buttonsOf, close, fill, press, problems, script, titleOf, ui } from "./robbery-ui.mjs";

// systems/robberybuilder.ts: the wand, the commands, the builder view. The contract: every command is operator-only and
// registers under the real registry's rules; a command callback runs RESTRICTED, so it answers honestly from what it can read
// (a Failure the player sees) and defers only the part that changes the world; a command block (no player) can start, stop,
// reset and activate by id; the wand is cancelled at once and opens its screen a tick later; a click in the air is the menu but
// a click on a block is not also one; and the view costs nothing when nobody has it on.

const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
await load("systems/robberybuilder.js");
const { ROBBERY: R } = await load("config/balance.js");
const { PlayerPermissionLevel, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } = fakeApi;

const IN_AREA = { x: 100, y: 65, z: 170 };

const originalRandom = Math.random;
Math.random = () => 0.4;

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    R.pickGuessCooldownTicks = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);
    buildSite();
}

const operator = (name = "Op", where = IN_AREA) => fake.makePlayer(name, { location: { ...where }, permission: PlayerPermissionLevel.Operator });
const member = (name = "Mem", where = IN_AREA) => fake.makePlayer(name, { location: { ...where }, permission: PlayerPermissionLevel.Member });
const said = (player) => player.messages.map(strip);
const lastSaid = (player) => said(player).at(-1) ?? "";
const bar = (player) => player.actionBar.map(strip);
const save = (robbery) => { const saved = S.saveRobbery(robbery); if (!saved.ok) throw new Error(saved.reason); return saved.robbery; };
const openBit = (pos) => fake.blockAt("overworld", at(pos)).permutation.getState("open_bit");

const fromPlayer = (player) => ({ sourceEntity: player });
const fromCommandBlock = () => ({ sourceEntity: undefined, sourceBlock: { typeId: "minecraft:command_block" } });
const fromNpc = (player) => ({ sourceEntity: fake.makeEntity({ typeId: "minecraft:npc" }), initiator: player });

/** Registers the commands through the validating registry and answers a function that runs one as a player would. */
function commands() {
    const started = fake.startUp();
    return { ...started, as: (origin, name, ...args) => started.run(name, origin, ...args) };
}

// ---------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------

test("every command registers under the real registry's rules, operator-only, with the right parameters", () => {
    setup();
    const { check, done } = checks();
    const { commands: registered, enums } = commands();

    const names = [...registered.keys()].filter((n) => n.startsWith("rae:robbery_") && n !== "rae:robbery_probe_ctx").sort();
    check("exactly these fifteen", names.join(",") === [
        "list", "info", "new", "select", "delete", "start", "stop", "reset", "activate", "wand", "edit", "view", "undo", "area", "set"
    ].map((n) => `rae:robbery_${n}`).sort().join(","), names.join(","));

    check("all operator-only", names.every((n) => registered.get(n).def.permissionLevel === CommandPermissionLevel.GameDirectors));
    check("the setting enum is registered and namespaced, with every setting", enums.get("rae:robbery_setting")?.join() === L.SETTING_KEYS.join(), String(enums.get("rae:robbery_setting")));

    const set = registered.get("rae:robbery_set").def;
    check("set takes the setting enum then a value", set.mandatoryParameters[0].name === "rae:robbery_setting" && set.mandatoryParameters[0].type === CustomCommandParamType.Enum && set.mandatoryParameters[1].type === CustomCommandParamType.String);
    check("start takes a robbery and an optional test flag", registered.get("rae:robbery_start").def.mandatoryParameters.length === 1 && registered.get("rae:robbery_start").def.optionalParameters[0].type === CustomCommandParamType.Boolean);
    check("area takes two locations", registered.get("rae:robbery_area").def.mandatoryParameters.every((p) => p.type === CustomCommandParamType.Location));
    check("every command has a description", names.every((n) => registered.get(n).def.description.length > 10));
    done();
});

test("one command that fails to register does not take the others down", () => {
    setup();
    const { check, done } = checks();
    const seen = new Set();
    const registry = {
        registerEnum() {},
        registerCommand(def) {
            if (def.name === "rae:robbery_info") throw new Error("NamespaceNameError (pretend)");
            seen.add(def.name);
        }
    };

    fake.reset();
    const { system } = fakeApi;
    system.beforeEvents.startup.emit({ customCommandRegistry: registry });

    check("info failed, and every other one still registered", !seen.has("rae:robbery_info") && seen.has("rae:robbery_list") && seen.has("rae:robbery_set"), [...seen].join());
    done();
});

test("a member is turned away from every command by the engine, before any callback runs", () => {
    setup();
    const { check, done } = checks();
    const { as, commands: registered } = commands();
    const mem = member();

    const refused = [...registered.keys()].filter((n) => n.startsWith("rae:robbery_") && n !== "rae:robbery_probe_ctx")
        .map((n) => as(fromPlayer(mem), n, ...Array(registered.get(n).def.mandatoryParameters?.length ?? 0).fill("x")).refused);

    check("all refused for permission", refused.every((r) => r === "permission"), refused.join());
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Looking and choosing
// ---------------------------------------------------------------------------------------------------------

test("list tells empty from ready from not ready from running from unreadable", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    check("nothing yet: how to start", /No robberies yet/.test(as(fromPlayer(op), "rae:robbery_list").message));

    save(bank("bank").r);
    save(ok(L.newRobbery("empty", "Empty", "overworld")));
    world.setDynamicProperty("rae:robbery:def:broken", "{ no");
    S.forgetLoaded();

    const text = strip(as(fromPlayer(op), "rae:robbery_list").message);
    check("a ready one", /bank: Saint Diego Bank, 3 elements, ready/.test(text), text);
    check("a not-ready one says how much is missing", /empty: Empty, 0 elements, not ready \(\d things? missing\)/.test(text), text);
    check("an unreadable one says why, in red", /broken: cannot be read/.test(text), text);

    Run.startRobbery("bank", { test: true });
    check("a running one", /bank: .*running/.test(strip(as(fromPlayer(op), "rae:robbery_list").message)));
    done();
});

test("info shows the robbery and its elements; raw writes a backup to the log", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(bank("bank").r);

    const info = strip(as(fromPlayer(op), "rae:robbery_info", "bank").message);
    check("the robbery and each element", /Saint Diego Bank \(bank, overworld\)/.test(info) && /Keypad \(switch, e1\)/.test(info) && /Vault door \(door, e2\)/.test(info) && /Lockbox \(chest, e3\)/.test(info), info);
    check("an unknown id", as(fromPlayer(op), "rae:robbery_info", "ghost").status === CustomCommandStatus.Failure);

    const logged = [];
    const warn = console.warn;
    console.warn = (...args) => logged.push(args.join(" "));
    let raw;
    try { raw = as(fromPlayer(op), "rae:robbery_info", "bank", true); } finally { console.warn = warn; }
    check("raw says how much it wrote", /Written to the content log \(\d+ characters\)/.test(raw.message), raw.message);
    check("and the log holds the saved text exactly", logged.some((l) => l.includes(`bank saved as: ${S.rawText("bank")}`)));
    done();
});

test("new makes a robbery where the player stands and selects it; from a command block it says why not", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();

    const made = as(fromPlayer(op), "rae:robbery_new", "bank", "Saint Diego Bank");
    check("made", made.status === CustomCommandStatus.Success && S.getRobbery("bank")?.name === "Saint Diego Bank", JSON.stringify(made));
    check("and selected for her", E.selectedRobbery(op)?.id === "bank");
    check("a clash is refused with the reason", as(fromPlayer(op), "rae:robbery_new", "bank", "Again").status === CustomCommandStatus.Failure);
    check("a command block cannot, because there is no dimension to take", /run this as a player/.test(as(fromCommandBlock(), "rae:robbery_new", "x1", "X").message));
    done();
});

test("select chooses what the builder works on; delete needs the confirmation, shuts the site by the janitor, and can be undone", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(bank("bank").r);
    save(ok(L.newRobbery("mine", "The Mine", "overworld")));

    check("select works", as(fromPlayer(op), "rae:robbery_select", "mine").status === CustomCommandStatus.Success && E.selectedRobbery(op).id === "mine");
    check("an unknown one does not", as(fromPlayer(op), "rae:robbery_select", "ghost").status === CustomCommandStatus.Failure);

    Run.activateElement("bank", "Keypad");
    check("the keypad's door is open", openBit(SITE.doorLow) === true);

    check("delete without true is refused", as(fromPlayer(op), "rae:robbery_delete", "bank", false).status === CustomCommandStatus.Failure && S.getRobbery("bank") !== undefined);
    check("delete of an unknown one is refused", as(fromPlayer(op), "rae:robbery_delete", "ghost", true).status === CustomCommandStatus.Failure);

    const gone = as(fromPlayer(op), "rae:robbery_delete", "bank", true);
    check("delete with true works and says the site is put back", gone.status === CustomCommandStatus.Success && /put back|shut/.test(gone.message) && S.getRobbery("bank") === undefined, JSON.stringify(gone));

    fake.advance(R.janitorEvery + R.tickEvery + R.tickEvery);
    check("the janitor shut the open door of the deleted robbery", openBit(SITE.doorLow) === false && S.dirtyCount() === 0);

    check("undo brings it back", as(fromPlayer(op), "rae:robbery_undo", "bank").status === CustomCommandStatus.Success && S.getRobbery("bank") !== undefined);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Running it: checked at once, done a tick later
// ---------------------------------------------------------------------------------------------------------

test("start answers honestly at once and does its work a tick later, outside restricted execution", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    const robber = fake.makePlayer("Robber", { location: { ...IN_AREA } });
    state.update(robber, { role: "outlaw" });
    save(bank("bank").r);

    check("an unknown robbery fails now", /there is no robbery ghost/.test(as(fromPlayer(op), "rae:robbery_start", "ghost").message));

    const started = as(fromPlayer(op), "rae:robbery_start", "bank");
    check("it answers success now", started.status === CustomCommandStatus.Success && /Starting bank/.test(started.message), JSON.stringify(started));
    check("but nothing has happened yet: a callback may not change the world", Run.runningIds().length === 0);

    fake.advance(1);
    check("a tick later it is running", Run.runningIds().join() === "bank");
    check("and the engine's restricted mode was never tripped", !said(op).some((m) => /cannot be used in restricted execution/.test(m)));

    const again = as(fromPlayer(op), "rae:robbery_start", "bank");
    check("starting a robbery that is under way fails now, with the reason", again.status === CustomCommandStatus.Failure && /already under way/.test(again.message), JSON.stringify(again));
    done();
});

test("a test run starts for anyone; a refusal in the deferred part (the robbery vanished) is told to the player", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(bank("bank").r);

    as(fromPlayer(op), "rae:robbery_start", "bank", true);
    fake.advance(1);
    check("a test run: marked as one", Run.viewOf("bank")?.test === true && said(op).some((m) => /Test run/.test(m)));

    Run.stopRobbery("bank");
    Run.resetSiteNow("bank");

    as(fromPlayer(op), "rae:robbery_start", "bank");
    S.deleteRobbery("bank");
    fake.advance(1);
    check("it did not start, and she was told why", Run.runningIds().length === 0 && said(op).some((m) => /bank did not start: there is no robbery bank/.test(m)), said(op).join("|"));
    done();
});

test("a command block (no player) can start, activate, stop and reset by id, and its outcomes go to the log", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    save(bank("bank").r);

    const start = as(fromCommandBlock(), "rae:robbery_start", "bank", true);
    check("start from a command block works", start.status === CustomCommandStatus.Success, JSON.stringify(start));
    fake.advance(1);
    check("it is running", Run.runningIds().join() === "bank");

    check("activating an element that waits on another fails now, naming what it waits on", /Vault door waits on Keypad/.test(as(fromCommandBlock(), "rae:robbery_activate", "bank", "Vault door").message));
    check("activate by name", as(fromCommandBlock(), "rae:robbery_activate", "bank", "Keypad").status === CustomCommandStatus.Success);
    fake.advance(1);
    check("the keypad's door opened", openBit(SITE.doorLow) === true);

    check("activating one that is done fails now", /already done/.test(as(fromCommandBlock(), "rae:robbery_activate", "bank", "Keypad").message));

    check("stop works", as(fromCommandBlock(), "rae:robbery_stop", "bank").status === CustomCommandStatus.Success);
    fake.advance(1);
    check("it stopped", Run.runningIds().length === 0);
    check("stopping what is not running fails now", /not under way/.test(as(fromCommandBlock(), "rae:robbery_stop", "bank").message));

    check("reset works", as(fromCommandBlock(), "rae:robbery_reset", "bank").status === CustomCommandStatus.Success);
    fake.advance(1);
    check("the door is shut", openBit(SITE.doorLow) === false && S.dirtyCount() === 0);
    check("reset of an unknown robbery fails", as(fromCommandBlock(), "rae:robbery_reset", "ghost").status === CustomCommandStatus.Failure);

    check("with no player and no id, a command that needs one says so", /name the robbery/.test(as(fromCommandBlock(), "rae:robbery_undo").message));
    done();
});

test("from an NPC's dialogue button, the player who pressed it is the actor", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(bank("bank").r);

    as(fromNpc(op), "rae:robbery_start", "bank", true);
    fake.advance(1);

    check("it started with her as the one who started it (the test-run line went to her)", Run.runningIds().join() === "bank" && said(op).some((m) => /Test run/.test(m)));
    done();
});

test("reset reports how many blocks it put back, and how many wait for their chunk", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(bank("bank").r);

    Run.activateElement("bank", "Keypad");
    fake.setUnloaded("overworld", [{ from: { x: 107, y: 0, z: 175 }, to: { x: 107, y: 100, z: 175 } }]);
    Run.activateElement("bank", "Lockbox");
    fake.setUnloaded("overworld", []);
    fake.setUnloaded("overworld", [{ from: { x: 107, y: 0, z: 175 }, to: { x: 107, y: 100, z: 175 } }]);

    as(fromPlayer(op), "rae:robbery_reset", "bank");
    fake.advance(1);

    check("she was told both counts", said(op).some((m) => /bank: put back 2 blocks; 1 more wait for their chunk to load/.test(m)), said(op).join("|"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Settings and area by command
// ---------------------------------------------------------------------------------------------------------

test("set changes a setting of the selected robbery: a switch by on/off, a time by seconds, and a wrong value says why", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(bank("bank").r);
    E.select(op, "bank");

    check("a time", as(fromPlayer(op), "rae:robbery_set", "cooldownSeconds", "120").status === CustomCommandStatus.Success && S.getRobbery("bank").settings.cooldownSeconds === 120);
    check("a switch", as(fromPlayer(op), "rae:robbery_set", "protect", "off").status === CustomCommandStatus.Success && S.getRobbery("bank").settings.protect === false);
    check("a switch given a number says so", /protect is on or off/.test(as(fromPlayer(op), "rae:robbery_set", "protect", "30").message));
    check("a time given a word says so", /cooldownSeconds must be a whole number/.test(as(fromPlayer(op), "rae:robbery_set", "cooldownSeconds", "soon").message));
    check("a setting that is not one is refused by the engine's own enum", as(fromPlayer(op), "rae:robbery_set", "colour", "red").refused === "syntax");

    save(ok(L.newRobbery("mine", "The Mine", "overworld")));
    const newcomer = operator("Newcomer");
    check("with several robberies and none selected, it says to select one", /select a robbery first/.test(as(fromPlayer(newcomer), "rae:robbery_set", "protect", "on").message));
    check("from a command block there is no selection to fall back on", /name the robbery/.test(as(fromCommandBlock(), "rae:robbery_set", "protect", "on").message));
    done();
});

test("area takes two corners in any order and normalises them", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    const result = as(fromPlayer(op), "rae:robbery_area", { x: 50.9, y: 80, z: 10 }, { x: 10, y: 60.2, z: 30 });
    check("set", result.status === CustomCommandStatus.Success, JSON.stringify(result));
    check("floored and normalised", JSON.stringify(S.getRobbery("bank").area) === JSON.stringify({ min: [10, 60, 10], max: [50, 80, 30] }), JSON.stringify(S.getRobbery("bank").area));
    check("not a location is refused by the engine", as(fromPlayer(op), "rae:robbery_area", "here", "there").refused === "syntax");
    done();
});

test("undo goes back one change and, run again, forward", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    as(fromPlayer(op), "rae:robbery_set", "cooldownSeconds", "99");
    check("changed", S.getRobbery("bank").settings.cooldownSeconds === 99);
    check("undone", as(fromPlayer(op), "rae:robbery_undo").status === CustomCommandStatus.Success && S.getRobbery("bank").settings.cooldownSeconds === R.defaultCooldownSeconds);
    check("redone", as(fromPlayer(op), "rae:robbery_undo").status === CustomCommandStatus.Success && S.getRobbery("bank").settings.cooldownSeconds === 99);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The wand
// ---------------------------------------------------------------------------------------------------------

test("wand and edit hand a tick later to the player: the item, and the menu", async () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    check("the wand command answers now", as(fromPlayer(op), "rae:robbery_wand").status === CustomCommandStatus.Success);
    check("the item is not in her bag until the next tick", op.container.getItem(0) === undefined);
    fake.advance(1);
    check("then it is", op.container.getItem(0)?.typeId === R.wandItemId);

    as(fromPlayer(op), "rae:robbery_wand");
    fake.advance(1);
    check("a second time she is told she has it", said(op).some((m) => /You already have the wand/.test(m)));

    script(close);
    as(fromPlayer(op), "rae:robbery_edit");
    check("the menu is not open yet", ui.shown.length === 0);
    fake.advance(1);
    await new Promise((resolve) => setImmediate(resolve));
    check("it opens a tick later", ui.shown.length === 1 && strip(titleOf(ui.shown[0])) === "Bank");
    check("from a command block, edit says why not", /run this as a player/.test(as(fromCommandBlock(), "rae:robbery_edit").message));
    done();
});

test("the wand on a block is cancelled at once, and its screen opens a tick later", async () => {
    setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    script(close);
    const event = useBlock(op, SITE.keypad, { held: R.wandItemId });

    check("cancelled: the button is not pressed", event.cancel === true);
    check("the screen is not open yet", ui.shown.length === 0);
    check("and no restricted call was attempted", !said(op).some((m) => /restricted/.test(m)));

    fake.advance(1);
    await new Promise((resolve) => setImmediate(resolve));
    check("a tick later the add screen is open, for that block", ui.shown.length === 1 && /bind a block/.test(strip(titleOf(ui.shown[0]))) && /stone button at 103, 66, 171/.test(strip(String(ui.shown[0].calls.find((c) => c[0] === "dropdown")[1]))), strip(titleOf(ui.shown[0] ?? { calls: [] })));
    done();
});

test("a held click counts once; a member's wand does nothing; a click with another item is left alone", async () => {
    setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const op = operator();
    const mem = member();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    script(close);
    const first = useBlock(op, SITE.keypad, { held: R.wandItemId, first: true });
    const repeats = [1, 2, 3].map(() => useBlock(op, SITE.keypad, { held: R.wandItemId, first: false }));
    fake.advance(1);
    await new Promise((resolve) => setImmediate(resolve));

    check("every event of the held click is cancelled", first.cancel && repeats.every((e) => e.cancel));
    check("but one screen opened", ui.shown.length === 1, String(ui.shown.length));

    ui.shown.length = 0;
    const members = useBlock(mem, SITE.keypad, { held: R.wandItemId });
    fake.advance(2);
    check("a member holding the wand is just a player on an unbound block: nothing cancelled, no screen", members.cancel === false && ui.shown.length === 0);

    const stick = useBlock(op, [1, 70, 1], { held: "minecraft:stick" });
    check("an operator with another item is not building: nothing cancelled", stick.cancel === false);
    done();
});

test("the wand does not mine: an operator holding it cannot break a block with it, anyone else is unaffected", () => {
    setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const op = operator();
    const mem = member();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone");

    const mine = (player, held) => {
        const event = { player, block: fake.dimension("overworld").getBlock({ x: 1, y: 70, z: 1 }), itemStack: held ? { typeId: held } : undefined, cancel: false };
        world.beforeEvents.playerBreakBlock.emit(event);
        return event.cancel;
    };

    check("an operator with the wand: cancelled", mine(op, R.wandItemId) === true);
    check("an operator with a pickaxe: not", mine(op, "minecraft:iron_pickaxe") === false);
    check("with an empty hand: not", mine(op, undefined) === false);
    check("a member with the wand is not building, so the builder does not touch it", mine(mem, R.wandItemId) === false);
    done();
});

test("the wand on a bound block opens that element's screen and selects its robbery", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    save(bank("bank").r);
    save(ok(L.newRobbery("mine", "The Mine", "overworld")));
    E.select(op, "mine");

    script(press("Back"));
    useBlock(op, SITE.doorLow, { held: R.wandItemId });
    fake.advance(1);
    await new Promise((resolve) => setImmediate(resolve));

    check("the vault door's screen", ui.shown.length >= 1 && strip(titleOf(ui.shown[0])) === "Vault door", ui.shown.map((s) => strip(titleOf(s))).join(" > "));
    check("and she is now working on the bank", E.selectedRobbery(op).id === "bank");
    done();
});

/** A swing, or an item use, as the game reports a click with the wand. */
const swing = (player, swingSource, held = R.wandItemId) => world.afterEvents.playerSwingStart.emit({ player, swingSource, heldItemStack: held ? { typeId: held } : undefined });
const useItem = (player, held = R.wandItemId) => world.afterEvents.itemUse.emit({ itemStack: held ? { typeId: held } : undefined, source: player });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
/** How many times the builder's main menu (titled with the robbery's name) has been shown. */
const menus = () => ui.shown.filter((s) => strip(titleOf(s)) === "Bank").length;
/** Moves past the "same click" window, so the next click is a new one. */
const later = () => fake.advance(R.wandClickGapTicks + 1);

test("a click on nothing opens the menu: a left-click in the air, a right-click swing, or an item use", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    const gestures = [
        ["a left-click in the air (swing Attack)", () => swing(op, "Attack")],
        ["a right-click swing (Interact)", () => swing(op, "Interact")],
        ["a right-click swing (Use)", () => swing(op, "Use")],
        ["an item use", () => useItem(op)]
    ];

    for (const [label, fire] of gestures) {
        ui.shown.length = 0;
        script(close);
        fire();
        await flush();
        check(`${label} opens the menu`, menus() === 1, String(menus()));
        later();
    }
    done();
});

test("one click reported twice opens one menu, and a click that is really a block click opens none", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    script(close);
    swing(op, "Attack");                                   // one left-click, reported as a swing...
    useItem(op);                                           // ...and as an item use
    await flush();
    check("the swing and the item use of one click opened one menu", menus() === 1, String(menus()));

    later();
    ui.shown.length = 0;
    script(close);
    useBlock(op, SITE.keypad, { held: R.wandItemId });     // a right-click on a block...
    swing(op, "Interact");                                 // ...also swings...
    useItem(op);                                           // ...and uses the item
    fake.advance(1);
    await flush();
    check("a block click opened the block's own screen only", ui.shown.length === 1 && /bind a block/.test(strip(titleOf(ui.shown[0]))), ui.shown.map((s) => strip(titleOf(s))).join(" > "));
    done();
});

test("what is not a click on nothing opens nothing: mining, placing, dropping, another item, a member's wand", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const mem = member();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    for (const source of ["Mine", "Build", "Place", "DropItem", "Throw", "Event", "None"]) swing(op, source);
    swing(op, "Attack", "minecraft:stick");
    useItem(op, "minecraft:stick");
    swing(mem, "Attack");
    useItem(mem);
    await flush();

    check("nothing opened", ui.shown.length === 0, String(ui.shown.length));
    done();
});

test("a swing or an item use that points at a block is that block's click, however early or late it arrives", async () => {
    setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    // The first playtest: the game reports a swing with about half of all block clicks (a chest, a button; never an iron door), at no
    // fixed moment after the block event, and the main menu opened on top of the block's own screen whenever it came late.
    op.aimAt = { x: SITE.keypad[0], y: SITE.keypad[1], z: SITE.keypad[2] };

    swing(op, "Interact");
    swing(op, "Attack");
    swing(op, "Use");
    useItem(op);
    await flush();
    check("pointing at a block, no swing or item use is a click on nothing", ui.shown.length === 0, String(ui.shown.length));

    // The swing arrives long AFTER the block event, with the block's screen already closed.
    script(close);
    useBlock(op, SITE.keypad, { held: R.wandItemId });
    fake.advance(1);
    await flush();
    fake.advance(R.wandClickGapTicks * 4);
    swing(op, "Interact");
    useItem(op);
    await flush();
    check("a late swing opens nothing more: only the block's own screen was shown", ui.shown.length === 1 && /bind a block/.test(strip(titleOf(ui.shown[0]))), ui.shown.map((s) => strip(titleOf(s))).join(" > "));
    check("and the builder is not scolded", !said(op).some((m) => /Finish or close the menu/.test(m)), said(op).join("|"));

    // The swing arrives long BEFORE the block event.
    ui.shown.length = 0;
    later();
    script(close);
    swing(op, "Interact");
    fake.advance(R.wandClickGapTicks * 4);
    useBlock(op, SITE.keypad, { held: R.wandItemId });
    fake.advance(1);
    await flush();
    check("an early swing opens nothing either: one screen, the block's own", ui.shown.length === 1 && /bind a block/.test(strip(titleOf(ui.shown[0]))), ui.shown.map((s) => strip(titleOf(s))).join(" > "));

    // Looking at nothing, the same swing is the menu.
    ui.shown.length = 0;
    op.aimAt = undefined;
    later();
    script(close);
    swing(op, "Attack");
    await flush();
    check("looking at nothing, a left-click is the menu", menus() === 1, String(menus()));
    done();
});

test("a click while a menu is already open is ignored without a word; once it is closed the next click opens it again", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    ui.responses.length = 0;
    ui.responses.push(() => held);                         // the menu stays up until it is released

    swing(op, "Attack");
    await flush();
    check("the menu is up", menus() === 1);

    later();
    swing(op, "Attack");
    useItem(op);
    await flush();
    check("a later click while it is up opens nothing more", menus() === 1, String(menus()));
    check("and does not scold the builder in chat", !said(op).some((m) => /Finish or close the menu/.test(m)), said(op).join("|"));

    release(close());
    await flush();
    later();
    script(close);
    swing(op, "Attack");
    await flush();
    check("once it is closed, the next click opens it again", menus() === 2, String(menus()));
    done();
});

test("sneaking and right-clicking a block with the wand opens the menu; standing, it opens the block's own screen", async () => {
    setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    op.isSneaking = true;
    script(close);
    const event = useBlock(op, SITE.keypad, { held: R.wandItemId });
    fake.advance(1);
    await flush();
    check("cancelled, as every wand click is", event.cancel === true);
    check("sneaking: the main menu", menus() === 1 && ui.shown.length === 1, ui.shown.map((s) => strip(titleOf(s))).join(" > "));

    op.isSneaking = false;
    later();
    ui.shown.length = 0;
    script(close);
    useBlock(op, SITE.keypad, { held: R.wandItemId });
    fake.advance(1);
    await flush();
    check("standing: the form for binding that block", ui.shown.length === 1 && /bind a block/.test(strip(titleOf(ui.shown[0]))), ui.shown.map((s) => strip(titleOf(s))).join(" > "));
    done();
});

test("left-clicking the air sets a corner of the area to where the builder stands, when the menu asked for one", async () => {
    setup();
    const { check, done } = checks();
    const op = operator("Op", { x: 10.7, y: 64.2, z: 20.9 });
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    E.setPending(op, { kind: "corner", robbery: "bank", first: [0, 60, 0] });
    swing(op, "Attack");
    await flush();

    check("the area runs from the first corner to the block she stands in", JSON.stringify(S.getRobbery("bank").area) === JSON.stringify({ min: [0, 60, 0], max: [10, 64, 20] }), JSON.stringify(S.getRobbery("bank").area));
    check("she was told", said(op).some((m) => /The area of Bank is now 11 x 5 x 21 blocks/.test(m)), said(op).join("|"));
    check("and no menu opened", ui.shown.length === 0);
    done();
});

test("with debug logging on, what the wand receives goes to the log; with it off, nothing does", async () => {
    setup();
    const { check, done } = checks();
    const log = await load("core/log.js");
    const op = operator();
    save(ok(L.newRobbery("bank", "Bank", "overworld")));
    E.select(op, "bank");

    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args.join(" "));

    try {
        script(close, close);
        swing(op, "Attack");
        useBlock(op, SITE.keypad, { held: R.wandItemId });
        fake.advance(1);
        await flush();
        check("off by default: nothing was written", lines.filter((l) => /\[robbery\]/.test(l)).length === 0, lines.join("|"));

        log.setDebugLogging(true);
        later();
        script(close, close);
        swing(op, "Attack");
        swing(op, "Mine");
        later();
        useBlock(op, SITE.keypad, { held: R.wandItemId });
        fake.advance(1);
        await flush();
    } finally {
        log.setDebugLogging(false);
        console.warn = original;
    }

    check("a click on nothing says how it arrived", lines.some((l) => /wand click on nothing: swing Attack/.test(l)), lines.join("|"));
    check("a swing that is not a click says why it was ignored", lines.some((l) => /wand swing ignored: Mine/.test(l)), lines.join("|"));
    check("a click on a block says what, where, and whether she was sneaking", lines.some((l) => /wand click on minecraft:stone_button at 103,66,171 face=Up sneak=false/.test(l)), lines.join("|"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The builder view
// ---------------------------------------------------------------------------------------------------------

test("the view draws the selected robbery near the builder, and reads out what the wand points at", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator("Op", { x: 100, y: 65, z: 170 });
    save(bank("bank").r);
    E.select(op, "bank");

    fake.advance(R.viewEvery * 3);
    check("off: nothing is drawn", op.privateParticles.length === 0);

    check("on", /view is on/.test(as(fromPlayer(op), "rae:robbery_view", true).message));
    fake.advance(R.viewEvery);
    check("it drew particles for the bound blocks and the area's edges", op.privateParticles.length > 4 && op.privateParticles.every((p) => p.id === R.viewParticle), String(op.privateParticles.length));
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const at = (x, y, z) => op.privateParticles.filter((p) => near(p.location.x, x) && near(p.location.y, y) && near(p.location.z, z)).length > 0;
    check("the keypad is marked just OVER its block, not inside it (a marker at the centre of a chest or a button cannot be seen)", at(103.5, 67.3, 171.5) && !at(103.5, 66.5, 171.5));
    check("the lockbox is marked over its top, where it can be seen", at(107.5, 66.3, 175.5) && !at(107.5, 65.5, 175.5));
    check("a door is marked once, over its upper half, and not again over its lower half", at(104.5, 67.3, 170.5) && !at(104.5, 66.3, 170.5) && !at(104.5, 65.5, 170.5));
    check("never more than the cap in one redraw", op.privateParticles.length <= R.viewMaxPoints, String(op.privateParticles.length));

    check("without the wand in hand there is no aim line", op.actionBar.length === 0);

    op.holding = R.wandItemId;
    op.aimAt = { x: SITE.keypad[0], y: SITE.keypad[1], z: SITE.keypad[2] };
    fake.advance(R.viewEvery);
    check("pointing at a bound block names it and its robbery", bar(op).some((m) => /Keypad \(switch\) Saint Diego Bank/.test(m)), bar(op).join("|"));

    op.aimAt = { x: 5, y: 70, z: 5 };
    fake.placeBlock("overworld", { x: 5, y: 70, z: 5 }, "minecraft:iron_door");
    fake.advance(R.viewEvery);
    check("pointing at an unbound block invites binding it", bar(op).some((m) => /iron door - right-click it with the wand to bind it/.test(m)), bar(op).join("|"));

    const drawn = op.privateParticles.length;
    as(fromPlayer(op), "rae:robbery_view");
    fake.advance(R.viewEvery * 3);
    check("run again it toggles off, and drawing stops", op.privateParticles.length === drawn);
    done();
});

test("the view marks nothing beyond its range, and nothing in another dimension", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const far = operator("Far", { x: 100 + R.viewRange + 100, y: 65, z: 170 });
    save(bank("bank").r);
    E.select(far, "bank");

    as(fromPlayer(far), "rae:robbery_view", true);
    fake.advance(R.viewEvery);
    check("too far away: nothing drawn", far.privateParticles.length === 0, String(far.privateParticles.length));

    const nether = fake.makePlayer("Nina", { location: { x: 100, y: 65, z: 170 }, dimension: fake.dimension("nether"), permission: PlayerPermissionLevel.Operator });
    E.select(nether, "bank");
    as(fromPlayer(nether), "rae:robbery_view", true);
    fake.advance(R.viewEvery);
    check("in another dimension: nothing drawn", nether.privateParticles.length === 0);
    done();
});

test("a viewer who loses operator or leaves is dropped; a particle the game rejects is reported once and not tried again", () => {
    setup();
    const { check, done } = checks();
    const { as } = commands();
    const op = operator();
    const logged = [];
    const warn = console.warn;
    save(bank("bank").r);
    E.select(op, "bank");

    as(fromPlayer(op), "rae:robbery_view", true);
    let tries = 0;
    op.spawnParticle = () => { tries++; throw new Error("unknown particle"); };
    console.warn = (...args) => logged.push(args.join(" "));
    try { fake.advance(R.viewEvery * 5); } finally { console.warn = warn; }

    check("tried once, then gave up", tries === 1, String(tries));
    check("and said so once, in the log", logged.filter((l) => /could not draw/.test(l)).length === 1, logged.join("|"));

    const op2 = operator("Op2");
    E.select(op2, "bank");
    as(fromPlayer(op2), "rae:robbery_view", true);
    op2.permission = PlayerPermissionLevel.Member;
    const before = op2.privateParticles.length;
    fake.advance(R.viewEvery * 3);
    check("a viewer who is no longer an operator gets nothing more", op2.privateParticles.length === before);
    done();
});

test.after(() => { Math.random = originalRandom; });
