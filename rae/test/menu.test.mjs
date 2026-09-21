import { test } from "node:test";
import { fake, system, world, fakeUi, load, checks, strip } from "./helpers.mjs";

// The in-game menu: opened by the game_menu item or /scriptevent rae:menu, it starts a game (random roles, or roles
// picked per player), resets it, teleports the opener, and sends everyone to their spawns. Forms are answered from a
// queue (fakeUi.responses), in the order the menu shows them, so each test acts out what a player would tap.

const { TELEPORT_TARGETS, LAW_SPAWNS, OUTLAW_SPAWNS } = await load("config/world.js");
const { MENU } = await load("config/balance.js");
await load("main.js");                                          // every system, as in the game (roles, menu, the rest)
const { resetAllSystems } = await load("core/registry.js");
const { getRecord } = await load("core/state.js");

const ITEM = "bountysys:game_menu";
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Lets the menu's promises run, advancing the game `ticks` ticks one at a time (a retry waits for ticks). */
async function drain(ticks = 0) {
    await tick();
    for (let i = 0; i < ticks; i++) { fake.advance(1); await tick(); }
    await tick();
}

const use = (p) => world.afterEvents.itemUse.emit({ itemStack: { typeId: ITEM }, source: p });
const scriptEvent = (id, player) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity: player, message: "" });
const { uiFake } = fakeUi;

/**
 * What the next forms answer, in the order the menu shows them. A form beyond the queue is closed, so a menu that goes
 * somewhere a test did not expect ends instead of looping. BREAK makes show() itself fail, as the game can.
 */
const queue = [];
const BREAK = Symbol("the form broke");
uiFake.responses = Object.assign([], {
    shift: () => {
        const next = queue.shift();
        if (next === BREAK) throw new Error("the form broke");
        return next ?? { canceled: true };
    }
});
const answer = (...responses) => queue.push(...responses);
const pick = (selection) => ({ canceled: false, selection });
const closed = { canceled: true };
const text = (p) => p.messages.map(strip).join("\n");
const buttons = (form) => form.calls.filter((c) => c[0] === "button").map((c) => c[1]);

/** A clean world with the named players, the first of them holding the menu item. */
function world3(names = ["Ada", "Ben", "Cy"]) {
    fake.reset();
    resetAllSystems();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    queue.length = 0;
    uiFake.shown.length = 0;
    warnings.length = 0;
    const list = names.map((name, i) => fake.makePlayer(name, { location: { x: i, y: 64, z: 0 }, holding: i === 0 ? ITEM : null }));
    fake.advance(1);
    return list;
}

// ---------------------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------------------

test("using the menu item opens the main menu with its four buttons; another item does not", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    answer(closed);

    use(ada);
    await drain();
    check("one form was shown", uiFake.shown.length === 1, String(uiFake.shown.length));
    check("an action form for Ada", uiFake.shown[0]?.kind === "action" && uiFake.shown[0]?.player === ada);
    check("with the four choices", buttons(uiFake.shown[0]).join("|") === "Start game|Reset game|Teleport|Send everyone to their spawns", buttons(uiFake.shown[0]).join("|"));

    uiFake.shown.length = 0;
    world.afterEvents.itemUse.emit({ itemStack: { typeId: "minecraft:stick" }, source: ada });
    world.afterEvents.itemUse.emit({ itemStack: { typeId: "bountysys:law_compass" }, source: ada });
    await drain();
    check("another item opens nothing", uiFake.shown.length === 0);
    done();
});

test("/scriptevent rae:menu opens it too, and needs a player", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    answer(closed);

    scriptEvent("rae:menu", ada);
    await drain();
    check("opened without holding the item", uiFake.shown.length === 1 && uiFake.shown[0].player === ada);

    warnings.length = 0;
    uiFake.shown.length = 0;
    scriptEvent("rae:menu", undefined);
    await drain();
    check("run with no player: no form, and one log line saying why", uiFake.shown.length === 0 && warnings.some((w) => /rae:menu has to be run by a player/.test(w)), warnings.join("|"));
    done();
});

test("a second right-click while the menu is open shows nothing new; it opens again afterwards", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    answer(closed);

    use(ada);
    use(ada);
    await drain();
    check("one menu, not two", uiFake.shown.length === 1, String(uiFake.shown.length));

    answer(closed);
    use(ada);
    await drain();
    check("after it was closed, the next right-click opens it", uiFake.shown.length === 2, String(uiFake.shown.length));
    done();
});

test("a form the game refuses because the player is busy is tried again, and given up on after a limit", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    const busy = { canceled: true, cancelationReason: "UserBusy" };

    answer(busy, closed);
    use(ada);
    await drain(MENU.busyRetryTicks - 2);
    check("not retried before the wait is over", uiFake.shown.length === 1, String(uiFake.shown.length));
    await drain(4);
    check("retried after it", uiFake.shown.length === 2, String(uiFake.shown.length));

    // Busy for ever: one try, then the retries, and then it stops.
    uiFake.shown.length = 0;
    answer(...Array.from({ length: MENU.busyRetries + 5 }, () => busy));
    use(ada);
    await drain((MENU.busyRetries + 3) * MENU.busyRetryTicks);
    check(`gave up after ${MENU.busyRetries + 1} tries`, uiFake.shown.length === MENU.busyRetries + 1, String(uiFake.shown.length));

    queue.length = 0;
    answer(closed);
    use(ada);
    await drain();
    check("and the menu can be opened again after giving up", uiFake.shown.length === MENU.busyRetries + 2, String(uiFake.shown.length));
    done();
});

test("a player who leaves while the menu is up causes no error, and nothing happens", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    answer(pick(2));                                              // Teleport

    use(ada);
    ada.remove();
    await drain();
    check("no second form for someone who is gone", uiFake.shown.length === 1, String(uiFake.shown.length));
    check("nothing was logged as a failure", warnings.length === 0, warnings.join("|"));
    done();
});

test("a form that fails is reported and does not lock the menu", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    answer(BREAK);

    use(ada);
    await drain();
    check("reported once", warnings.filter((w) => /the form broke/.test(w)).length === 1, warnings.join("|"));

    answer(closed);
    use(ada);
    await drain();
    check("and it opens again", uiFake.shown.length === 2, String(uiFake.shown.length));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------

test("start with random roles: asks first, then gives out roles as the old button does", async () => {
    const { check, done } = checks();
    const [ada, ben, cy] = world3();

    answer(pick(0), pick(0), pick(1));                            // Start game, Random roles, Start the game
    use(ada);
    await drain();

    check("three forms: the menu, the choice, the confirmation", uiFake.shown.length === 3 && uiFake.shown.map((s) => s.kind).join() === "action,action,action", uiFake.shown.map((s) => s.kind).join());
    check("the choice offers random and chosen roles", buttons(uiFake.shown[1]).join("|") === "Random roles|Choose roles");
    check("the confirmation has a cancel and a start, and warns it resets", buttons(uiFake.shown[2]).join("|") === "Cancel|Start the game" && uiFake.shown[2].calls.some((c) => c[0] === "body" && /resets/.test(c[1])));

    const roles = [ada, ben, cy].map((p) => getRecord(p).role);
    check("everyone got a role", roles.every((r) => r === "law" || r === "outlaw"), roles.join());
    check("a quarter, at least one, are law (1 of 3)", roles.filter((r) => r === "law").length === 1, roles.join());
    check("everyone was sent to a spawn", [ada, ben, cy].every((p) => p.teleports.length === 1));
    check("the opener is told", /Game started with random roles/.test(text(ada)), text(ada));
    fake.advance(70);
    check("and the roles are announced a moment later", fake.chat.some((m) => /Roles Assigned/.test(m)) && ada.titles.some((t) => /LAWMAN|OUTLAW/.test(t)), JSON.stringify(ada.titles));
    done();
});

test("cancelling the confirmation, or any form, starts nothing", async () => {
    const { check, done } = checks();
    const [ada, ben] = world3();

    answer(pick(0), pick(0), pick(0));                            // ... Cancel
    use(ada);
    await drain();
    check("Cancel on the confirmation: no roles", getRecord(ada).role === null && getRecord(ben).role === null);

    queue.length = 0;
    answer(pick(0), closed);                                      // closing the choice form
    use(ada);
    await drain();
    check("closing a form: no roles", getRecord(ada).role === null && ada.teleports.length === 0);
    done();
});

test("random start with one player refuses, as the old button did", async () => {
    const { check, done } = checks();
    const [ada] = world3(["Ada"]);

    answer(pick(0), pick(0), pick(1));
    use(ada);
    await drain();
    check("the world is told", fake.chat.some((m) => /Not enough players/.test(m)), JSON.stringify(fake.chat));
    check("no role given, nobody moved", getRecord(ada).role === null && ada.teleports.length === 0);
    check("and the opener is not told it started", !/Game started/.test(text(ada)), text(ada));
    done();
});

test("start with chosen roles: one dropdown per player, and the picks are what everyone gets", async () => {
    const { check, done } = checks();
    const [ada, ben, cy] = world3();

    answer(pick(0), pick(1), { canceled: false, formValues: [undefined, 0, 1, 2] });   // Law, Outlaw, Sit out (the label is a null first)
    use(ada);
    await drain();

    const modal = uiFake.shown[2];
    check("a modal form", modal?.kind === "modal");
    const dropdowns = modal.calls.filter((c) => c[0] === "dropdown");
    check("one dropdown per online player, labelled with the name", dropdowns.map((d) => d[1]).join() === "Ada,Ben,Cy", dropdowns.map((d) => d[1]).join());
    check("each offers Law, Outlaw and Sit out", dropdowns.every((d) => d[2].join("|") === "Law|Outlaw|Sit out"));
    check("nobody is law by default: everyone starts as Outlaw", dropdowns.every((d) => d[3].defaultValueIndex === 1), JSON.stringify(dropdowns.map((d) => d[3])));
    check("it says starting resets the game", modal.calls.some((c) => c[0] === "label" && /resets/.test(c[1])));

    check("Ada is law", getRecord(ada).role === "law");
    check("Ben is an outlaw", getRecord(ben).role === "outlaw");
    check("Cy sits out: no role", getRecord(cy).role === null);
    check("Ada and Ben went to spawns for their side", ada.teleports.length === 1 && LAW_SPAWNS.some((s) => s.x === ada.teleports[0].x && s.z === ada.teleports[0].z) && ben.teleports.length === 1 && OUTLAW_SPAWNS.some((s) => s.x === ben.teleports[0].x && s.z === ben.teleports[0].z));
    check("Cy was not moved", cy.teleports.length === 0);
    check("the opener is told", /Game started with the roles you chose/.test(text(ada)), text(ada));
    fake.advance(70);
    check("Cy gets no title, the others do", cy.titles.length === 0 && ada.titles.some((t) => /LAWMAN/.test(t)) && ben.titles.some((t) => /OUTLAW/.test(t)), JSON.stringify([ada.titles, ben.titles, cy.titles]));
    done();
});

test("choosing roles shows each player's current role as the default", async () => {
    const { check, done } = checks();
    const [ada, ben, cy] = world3();

    answer(pick(0), pick(0), pick(1));                            // start a random game first, to give everyone a role
    use(ada);
    await drain();
    const before = [ada, ben, cy].map((p) => getRecord(p).role);

    uiFake.shown.length = 0;
    answer(pick(0), pick(1), closed);
    use(ada);
    await drain();
    const defaults = uiFake.shown[2].calls.filter((c) => c[0] === "dropdown").map((d) => d[3].defaultValueIndex);
    check("law shows Law, outlaw shows Outlaw", defaults.join() === before.map((r) => (r === "law" ? 0 : 1)).join(), `${defaults.join()} for ${before.join()}`);
    done();
});

test("choosing roles with nobody playing is refused and changes nothing; an empty side only warns", async () => {
    const { check, done } = checks();
    const [ada, ben] = world3();

    // Give Ada a role first, so a wrongly-accepted start would visibly reset it.
    answer(pick(0), pick(1), { canceled: false, formValues: [undefined, 0, 1, 2] });
    use(ada);
    await drain();
    check("(setup) Ada is law", getRecord(ada).role === "law");
    ada.messages.length = 0;

    queue.length = 0;
    answer(pick(0), pick(1), { canceled: false, formValues: [undefined, 2, 2, 2] });
    use(ada);
    await drain();
    check("everyone sitting out is refused, with the reason", /Nobody is playing/.test(text(ada)), text(ada));
    check("and nothing was reset: Ada is still law", getRecord(ada).role === "law");

    ada.messages.length = 0;
    queue.length = 0;
    answer(pick(0), pick(1), { canceled: false, formValues: [undefined, 0, 0, 2] });
    use(ada);
    await drain();
    check("two law and nobody else starts, with a warning", getRecord(ada).role === "law" && getRecord(ben).role === "law" && /Nobody is an outlaw/.test(text(ada)) && /Game started/.test(text(ada)), text(ada));

    ada.messages.length = 0;
    queue.length = 0;
    answer(pick(0), pick(1), { canceled: false, formValues: [undefined, 1, 1, 2] });
    use(ada);
    await drain();
    check("all outlaws starts with the other warning", /Nobody is law/.test(text(ada)), text(ada));
    done();
});

test("a player who leaves while roles are being chosen is skipped, and the round still starts", async () => {
    const { check, done } = checks();
    const [ada, ben, cy] = world3();

    answer(pick(0), pick(1), { get canceled() { return false; }, get formValues() { cy.remove(); return [undefined, 0, 1, 1]; } });
    use(ada);
    await drain();

    check("Ada and Ben got their roles", getRecord(ada).role === "law" && getRecord(ben).role === "outlaw");
    check("nothing was thrown or logged as a failure", warnings.length === 0, warnings.join("|"));
    check("the opener is told it started", /Game started with the roles you chose/.test(text(ada)), text(ada));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Reset, teleport, everyone to spawns
// ---------------------------------------------------------------------------------------------------------

test("reset asks first, then does what /scriptevent rae:reset does", async () => {
    const { check, done } = checks();
    const [ada, ben] = world3();

    answer(pick(0), pick(0), pick(1));
    use(ada);
    await drain();
    check("(setup) roles were given", getRecord(ada).role !== null && getRecord(ben).role !== null);

    uiFake.shown.length = 0;
    answer(pick(1), pick(0));                                     // Reset game, Cancel
    use(ada);
    await drain();
    check("Cancel keeps the game", getRecord(ada).role !== null && getRecord(ben).role !== null);

    fake.chat.length = 0;
    queue.length = 0;
    uiFake.shown.length = 0;
    answer(pick(1), pick(1));                                     // Reset game, Reset the game
    use(ada);
    await drain();
    check("the confirmation warns and has Cancel first", buttons(uiFake.shown[1]).join("|") === "Cancel|Reset the game", buttons(uiFake.shown[1]).join("|"));
    check("everyone's role is gone", getRecord(ada).role === null && getRecord(ben).role === null);
    check("and the same chat line as the command", fake.chat.some((m) => /All systems reset/.test(m)), JSON.stringify(fake.chat));

    // The command itself, unchanged.
    fake.chat.length = 0;
    scriptEvent("rae:reset", undefined);
    check("/scriptevent rae:reset says the same", fake.chat.some((m) => /All systems reset/.test(m)), JSON.stringify(fake.chat));
    done();
});

test("teleport lists every key place and moves the person who opened the menu", async () => {
    const { check, done } = checks();

    for (let index = 0; index < TELEPORT_TARGETS.length; index++) {
        const [ada, ben] = world3();
        answer(pick(2), pick(index));
        use(ada);
        await drain();

        const target = TELEPORT_TARGETS[index];
        const moved = ada.teleports.at(-1);
        check(`${target.name}: Ada lands on it`, ada.teleports.length === 1 && moved.x === target.at.x && moved.y === target.at.y && moved.z === target.at.z, JSON.stringify(ada.teleports));
        check(`${target.name}: nobody else moves`, ben.teleports.length === 0);
        check(`${target.name}: she is told where`, text(ada).includes(`Teleported to ${target.name}`), text(ada));
        if (index === 0) check("the list shows the names in order", buttons(uiFake.shown[1]).join("|") === TELEPORT_TARGETS.map((t) => t.name).join("|"), buttons(uiFake.shown[1]).join("|"));
    }
    done();
});

test("closing the teleport list, or a choice that is not on it, moves nobody", async () => {
    const { check, done } = checks();
    const [ada] = world3();

    answer(pick(2), closed);
    use(ada);
    await drain();
    check("closed", ada.teleports.length === 0);

    queue.length = 0;
    answer(pick(2), pick(TELEPORT_TARGETS.length + 3));
    use(ada);
    await drain();
    check("an index past the end", ada.teleports.length === 0 && warnings.length === 0, warnings.join("|"));
    done();
});

test("a teleport the game refuses is reported to the player, not thrown", async () => {
    const { check, done } = checks();
    const [ada] = world3();
    ada.teleport = () => { throw new Error("chunk not loaded"); };

    answer(pick(2), pick(0));
    use(ada);
    await drain();
    check("told, with the reason", /Could not teleport to .*chunk not loaded/.test(text(ada)), text(ada));
    uiFake.shown.length = 0;
    answer(closed);
    use(ada);
    await drain();
    check("and the menu is free again", uiFake.shown.length === 1, String(uiFake.shown.length));
    done();
});

test("send everyone to their spawns: only players with a role move", async () => {
    const { check, done } = checks();
    const [ada, ben, cy] = world3();

    answer(pick(0), pick(1), { canceled: false, formValues: [undefined, 0, 1, 2] });   // Ada law, Ben outlaw, Cy sits out
    use(ada);
    await drain();
    for (const p of [ada, ben, cy]) p.teleports.length = 0;
    ada.messages.length = 0;

    queue.length = 0;
    answer(pick(3));
    use(ada);
    await drain();
    check("Ada and Ben were sent", ada.teleports.length === 1 && ben.teleports.length === 1);
    check("Cy, with no role, was not", cy.teleports.length === 0);
    check("the opener is told", /sent to their spawns/.test(text(ada)), text(ada));

    // The old script event does the same.
    for (const p of [ada, ben, cy]) p.teleports.length = 0;
    scriptEvent("bounty:teleport", undefined);
    check("/scriptevent bounty:teleport still does it", ada.teleports.length === 1 && ben.teleports.length === 1 && cy.teleports.length === 0);
    done();
});

test("the old button still starts a random game", async () => {
    const { check, done } = checks();
    const [ada, ben, cy] = world3();

    scriptEvent("bounty:start_round", undefined);
    const roles = [ada, ben, cy].map((p) => getRecord(p).role);
    check("everyone got a role, one of them law", roles.every((r) => r !== null) && roles.filter((r) => r === "law").length === 1, roles.join());
    check("no menu was involved", uiFake.shown.length === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------

test("the teleport list has distinct names and real coordinates, built from the world config", () => {
    const { check, done } = checks();
    const names = TELEPORT_TARGETS.map((t) => t.name);

    check("at least the law, outlaw, jail, ranch, fort, train and boat places", TELEPORT_TARGETS.length >= 12, String(TELEPORT_TARGETS.length));
    check("every name is different", new Set(names).size === names.length, names.join(", "));
    check("every name fits a button", names.every((n) => n.length > 0 && n.length <= 40));
    check("every position is three finite numbers", TELEPORT_TARGETS.every((t) => [t.at.x, t.at.y, t.at.z].every((n) => Number.isFinite(n))));
    check("the first entries are the law spawns, from the same coordinates", LAW_SPAWNS.every((s, i) => TELEPORT_TARGETS[i].at === s));
    check("the retry settings are sane", MENU.busyRetryTicks >= 1 && MENU.busyRetries >= 1);
    done();
});
