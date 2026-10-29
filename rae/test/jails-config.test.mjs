import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, close, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// Where jails come from now (core/jailstore.ts) and what reads them: the jail a prisoner is sent to, the startup check, the RAE menu's Jails button (operators only)
// and its Teleport list, and the live config editor's two default jails.

const { PlayerPermissionLevel } = fakeApi;
await load("main.js");
const store = await load("core/jailstore.js");
const J = await load("logic/jails.js");
const preflight = await load("core/preflight.js");
const overrides = await load("core/configoverrides.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
const { JAIL_SITES, OVERWORLD_Y_BOUNDS, TELEPORT_TARGETS_BEFORE_JAILS, TELEPORT_TARGETS_AFTER_JAILS } = await load("config/world.js");
const { AMMO, GUNS } = await load("config/guns.js");
const { TRAIN_STRUCTURE } = await load("config/world.js");

const realRandom = Math.random;
let roll = 0;
Math.random = () => roll;
process.on("exit", () => { Math.random = realRandom; });

const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.error = realError; });

const DEFAULT_ITEM_TYPES = [...fake.itemTypes];

function fresh() {
    fake.reset();
    resetAllSystems();
    store.forgetJails();
    errors.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    roll = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.structures.add(TRAIN_STRUCTURE);
    fake.itemTypes.clear();
    for (const id of DEFAULT_ITEM_TYPES) fake.itemTypes.add(id);
    for (const ammo of Object.values(AMMO)) fake.itemTypes.add(ammo.itemId);
    for (const gun of Object.values(GUNS)) fake.itemTypes.add(gun.itemId);
}

const edited = (jail, patch) => { const r = J.edit(jail, patch); assert.ok(r.ok, r.reason); return r.value; };

function addJail(name, patch = {}) {
    const made = J.newJail(store.newJailId(name), name, { x: 300.5, y: 70, z: 300.5 });
    assert.ok(made.ok, made.reason);
    const next = edited(made.value, patch);
    const saved = store.saveJail(next);
    assert.ok(saved.ok, saved.reason);
    return next;
}

const scriptEvent = (id, sourceEntity) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message: "" });
const jailOf = () => state.getJailSite()?.jail;

// ---------------------------------------------------------------------------------------------------------
// The jail a prisoner is sent to
// ---------------------------------------------------------------------------------------------------------

test("a prisoner is sent to one of the jails that are on, rolled among them in id order; a jail that is off is never chosen", () => {
    fresh();
    const { check, done } = checks();
    addJail("Yard");
    store.saveJail(edited(store.getJail("jail_1"), { enabled: false }));

    // on: jail_2, yard (sorted by id: jail_2 < yard)
    const [p, q, r] = ["P", "Q", "R"].map((name) => fake.makePlayer(name, { tags: ["outlaw"] }));
    fake.advance(1);

    roll = 0;
    scriptEvent("bounty:test_capture", p);
    fake.advance(1);
    check("a roll of 0 picks the first that is on (jail_2), not jail_1 which is off", jailOf()?.x === JAIL_SITES[1].jail.x, JSON.stringify(jailOf()));

    state.update(p, { inJail: false });
    resetAllSystems();
    roll = 0.99;
    scriptEvent("bounty:test_capture", q);
    fake.advance(1);
    check("a roll near 1 picks the last (the yard)", jailOf()?.x === 300.5, JSON.stringify(jailOf()));
    check("the prisoner was sent there", q.teleports.at(-1)?.x === 300.5, JSON.stringify(q.teleports));

    roll = 0;
    scriptEvent("bounty:test_capture", r);
    fake.advance(1);
    check("a second prisoner shares the jail that is in use", jailOf()?.x === 300.5 && r.teleports.at(-1)?.x === 300.5);
    done();
});

test("a jail with no door trigger puts no door in the site, and a jail with one carries it", () => {
    fresh();
    const { check, done } = checks();
    addJail("Yard", { doorTrigger: { x: 5, y: 6, z: 7 } });
    store.saveJail(edited(store.getJail("jail_1"), { enabled: false }));
    store.saveJail(edited(store.getJail("jail_2"), { enabled: false }));
    const [p] = [fake.makePlayer("P", { tags: ["outlaw"] })];
    fake.advance(1);

    scriptEvent("bounty:test_capture", p);
    fake.advance(1);
    check("the door is the jail's", state.getJailSite()?.doorTrigger?.x === 5 && state.getJailSite()?.doorTrigger?.y === 6);

    state.update(p, { inJail: false });
    resetAllSystems();
    store.saveJail(edited(store.getJail("yard"), { doorTrigger: null }));
    scriptEvent("bounty:test_capture", p);
    fake.advance(1);
    check("without one there is no door in the site", state.getJailSite() !== null && state.getJailSite().doorTrigger === undefined, JSON.stringify(state.getJailSite()));
    done();
});

test("when every saved jail is unreadable a capture still has somewhere to go: the config's jails", () => {
    fresh();
    const { check, done } = checks();
    world.setDynamicProperty("rae:jail:broken", "{nope");
    store.forgetJails();
    const [p] = [fake.makePlayer("P", { tags: ["outlaw"] })];
    fake.advance(1);

    scriptEvent("bounty:test_capture", p);
    fake.advance(1);

    check("the prisoner was sent to a config jail", p.teleports.length === 1 && JAIL_SITES.some((site) => site.jail.x === p.teleports[0].x && site.jail.z === p.teleports[0].z), JSON.stringify(p.teleports));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The startup check
// ---------------------------------------------------------------------------------------------------------

test("the startup check names a jail's spot, door trigger and each button, and reports a jail that cannot be read", () => {
    fresh();
    const { check, done } = checks();

    check("clean with the config's two", preflight.runPreflightChecks().ok === true, preflight.runPreflightChecks().problems.join(" | "));

    const high = OVERWORLD_Y_BOUNDS.max + 50;
    addJail("Tower", { jail: { x: 1, y: high, z: 1 }, doorTrigger: { x: 2, y: high, z: 2 }, buttons: [{ x: 3, y: 70, z: 3 }, { x: 4, y: high, z: 4 }] });
    world.setDynamicProperty("rae:jail:broken", "{nope");
    store.forgetJails();

    const text = preflight.runPreflightChecks().problems.join(" | ");

    check("the spot is named with its jail", /Jail Tower \(jail spot\): y=/.test(text), text);
    check("the door trigger is named", /Jail Tower \(door trigger\): y=/.test(text), text);
    check("the button that is out of bounds is named by its number, and the good one is not", /Jail Tower \(button 2\): y=/.test(text) && !/button 1\)/.test(text), text);
    check("the unreadable jail is reported with what to do", /Jail broken cannot be read \(.+\): delete it from the Jails screen/.test(text), text);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The RAE menu
// ---------------------------------------------------------------------------------------------------------

const people = () => {
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, inventory: true, location: { x: 10.7, y: 64, z: -20.2 } });
    const member = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });
    fake.advance(1);
    return { op, member };
};

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
const labels = (form) => buttonsOf(form).map(strip);

test("the RAE menu has a Jails button for an operator and not for anyone else, and it opens the list", async () => {
    fresh();
    const { check, done } = checks();
    const { op, member } = people();

    script(close);
    scriptEvent("rae:menu", member);
    await settle();
    check("a member sees five buttons and no Jails", ui.shown.length === 1 && labels(ui.shown[0]).length === 5 && !labels(ui.shown[0]).includes("Jails"), labels(ui.shown[0]).join(" | "));

    ui.shown.length = 0;
    script(press("Jails"), close);
    scriptEvent("rae:menu", op);
    await settle();
    await settle();
    check("an operator sees it after Endings", labels(ui.shown[0]).slice(-3).join("|") === "Start sequence|Endings|Jails", labels(ui.shown[0]).join(" | "));
    check("pressing it opens the Jails list, with both default jails", strip(titleOf(ui.shown[1])) === "Jails" && labels(ui.shown[1]).includes("Jail 1 (on, 0 buttons)") && labels(ui.shown[1]).includes("Jail 2 (on, 0 buttons)"), ui.shown.map((f) => labels(f).join(",")).join(" | "));
    check("nothing went wrong", problems.length === 0, problems.join(" | "));
    done();
});

test("the Teleport list shows the jails that are in the world now, in the place the config's jails were, and the other places are as they were", async () => {
    fresh();
    const { check, done } = checks();
    const { op } = people();
    const open = async () => { ui.shown.length = 0; script(press("Teleport"), close); scriptEvent("rae:menu", op); await settle(); await settle(); return labels(ui.shown[1]); };

    const before = await open();
    check("in a world that has saved nothing it is the config's list", before.join("|") === [...TELEPORT_TARGETS_BEFORE_JAILS, ...JAIL_SITES.map((_, i) => ({ name: `Jail ${i + 1}` })), ...TELEPORT_TARGETS_AFTER_JAILS].map((t) => t.name).join("|"), before.join("|"));

    addJail("Yard");
    store.saveJail(edited(store.getJail("jail_1"), { name: "Town jail" }));
    const after = await open();
    const first = TELEPORT_TARGETS_BEFORE_JAILS.length;

    check("the law and outlaw spawns still come first", after.slice(0, first).join("|") === TELEPORT_TARGETS_BEFORE_JAILS.map((t) => t.name).join("|"));
    check("then the jails as they are now: renamed, added", after.slice(first, first + 3).join("|") === "Town jail|Jail 2|Yard", after.slice(first, first + 4).join("|"));
    check("then the rest, as before", after.slice(first + 3).join("|") === TELEPORT_TARGETS_AFTER_JAILS.map((t) => t.name).join("|"));

    // choosing the yard sends the operator to its spot
    ui.shown.length = 0;
    script(press("Teleport"), press("Yard"));
    scriptEvent("rae:menu", op);
    await settle();
    await settle();
    fake.advance(1);
    check("choosing the yard sends the operator to the yard's spot", op.teleports.at(-1)?.x === 300.5 && op.teleports.at(-1)?.z === 300.5, JSON.stringify(op.teleports));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The live config editor
// ---------------------------------------------------------------------------------------------------------

test("the live config editor keeps the two default jails' fields, marked as the defaults, so an edit made there still reaches a world that has not used the Jails screen", () => {
    const { check, done } = checks();
    const ids = overrides.listFields().map((field) => field.id);

    check("both jails' spots and doors", ["world.jail.1", "world.jail.2", "world.jailDoorTrigger.1", "world.jailDoorTrigger.2"].every((id) => ids.includes(id)));
    check("labelled as the defaults", overrides.getField("world.jail.1")?.label === "Jail 1 (default)" && overrides.getField("world.jailDoorTrigger.2")?.label === "Jail 2 door trigger (default)", `${overrides.getField("world.jail.1")?.label} / ${overrides.getField("world.jailDoorTrigger.2")?.label}`);
    done();
});
