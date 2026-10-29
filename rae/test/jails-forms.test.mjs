import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, fakeApi, checks, strip, useBlock } from "./helpers.mjs";
import { ui, problems, press, fill, close, yes, no, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// core/jailforms.ts: the operator's screens for the jails (the RAE menu's Jails button): the list, Add (a name), and a screen per jail to turn it on or off, rename it,
// move its spot to where the operator stands, bind blocks to it as buttons or as its door trigger by right-clicking them, send the operator there, undo and delete.
// A stand-in plays the operator, as in the other screen tests; what it cannot say is how the screens look in the game.

const { PlayerPermissionLevel } = fakeApi;
await load("main.js");
const F = await load("core/jailforms.js");
const store = await load("core/jailstore.js");
const bind = await load("core/jailbind.js");
const J = await load("logic/jails.js");
const { resetAllSystems } = await load("core/registry.js");
const { JAILS } = await load("config/balance.js");

const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const labels = (form) => buttonsOf(form).map(strip);
const named = (title) => [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith(title));
const said = (player) => player.messages.map(strip);
const edited = (jail, patch) => { const r = J.edit(jail, patch); assert.ok(r.ok, r.reason); return r.value; };
const open = (player) => F.openJailsEditor(player);

function scene() {
    fake.reset();
    resetAllSystems();
    store.forgetJails();
    bind.forgetBinds();
    ui.shown.length = 0;
    problems.length = 0;

    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, inventory: true, location: { x: 10.7, y: 64, z: -20.2 } });
    const member = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });
    fake.advance(1);

    return { op, member };
}

function add(name, patch = {}) {
    const made = J.newJail(store.newJailId(name), name, { x: 300.5, y: 70, z: 300.5 });
    assert.ok(made.ok, made.reason);
    const next = edited(made.value, patch);
    assert.ok(store.saveJail(next).ok);
    return next;
}

test("the editor opens on the list, with the default jails, Add, and how many of how many", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(close);

    await open(op);

    const form = ui.shown[0];
    check("one screen, titled Jails", ui.shown.length === 1 && strip(titleOf(form)) === "Jails", titleOf(form));
    check("both default jails, with their buttons counted", labels(form).includes("Jail 1 (on, 0 buttons)") && labels(form).includes("Jail 2 (on, 0 buttons)"), labels(form).join(" | "));
    check("an Add button", labels(form).includes("Add a jail"));
    check("it says how many of how many", new RegExp(`2 of ${JAILS.maxJails} jails`).test(bodyOf(form)), bodyOf(form));
    check("nothing was saved by looking", store.jailsAreDefault());
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("a member cannot open it: no screen, and a word about why", async () => {
    const { check, done } = checks();
    const { member } = scene();
    script(close);

    await open(member);

    check("no screen", ui.shown.length === 0);
    check("told only operators can", said(member).some((m) => /operator/i.test(m)), said(member).join(" | "));
    done();
});

test("Add makes a jail where the operator stands, with no door trigger and no buttons, and a name that cannot be used comes back with the reason and what was typed", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Add a jail"), fill({ Name: "   " }), fill({ Name: "Town Jail" }), close);

    await open(op);

    const refused = ui.shown.find((f) => /^Not saved: a name cannot be empty/.test(strip(titleOf(f))));
    check("an empty name came back with the reason", refused !== undefined, ui.shown.map((f) => strip(titleOf(f))).join(" | "));

    const jail = store.getJail("town_jail");
    check("then the jail was made, with an id from its name", jail?.name === "Town Jail" && jail.enabled === true, JSON.stringify(jail));
    check("its spot is the middle of the block the operator stands on", jail?.jail.x === 10.5 && jail.jail.y === 64 && jail.jail.z === -20.5, JSON.stringify(jail?.jail));
    check("no door trigger and no buttons yet", jail?.doorTrigger === undefined && jail.buttons.length === 0);
    check("the two default jails are still there, now saved", store.listJails().length === 3 && !store.jailsAreDefault());
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("a jail's screen says where it is, what its door is and its buttons, and turning it off is refused for the last one that is on", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveJail(edited(store.getJail("jail_2"), { buttons: [{ x: 7, y: 70, z: 8 }] }));
    script(press("Jail 2"), close, close);

    await open(op);

    const screen = named("Jail 2");
    check("the spot, the door trigger and the button", /Prisoners are put at/.test(bodyOf(screen)) && /Door trigger: 85, 70, 217/.test(bodyOf(screen)) && /Buttons: 7, 70, 8/.test(bodyOf(screen)), bodyOf(screen));
    check("its buttons are offered: remove, bind, door, send, delete", ["Turn it off", "Name", "Move the jail spot to where I stand", "Bind a button: click the block", "Set the door trigger: click the block", "Clear the door trigger", "Remove button 1 (7, 70, 8)", "Send me to the jail spot", "Delete", "Back"].every((l) => labels(screen).includes(l)), labels(screen).join(" | "));

    ui.shown.length = 0;
    script(press("Jail 2"), press("Turn it off"), close, press("Jail 1"), press("Turn it off"), close, close, close);
    await open(op);

    check("one can be switched off", store.getJail("jail_2").enabled === false);
    check("the list says so", ui.shown.some((f) => labels(f).includes("Jail 2 (off, 1 button)")), ui.shown.map((f) => labels(f).join(",")).join(" | "));
    check("the last one that is on refuses, with the reason, and stays on", store.getJail("jail_1").enabled === true && ui.shown.some((f) => /at least one jail has to stay on/.test(bodyOf(f))), ui.shown.map((f) => bodyOf(f)).join(" | "));
    done();
});

test("renaming, moving the spot, and going there", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const move = (to, step) => (form) => { op.location = to; return step(form); };

    script(press("Jail 1"), press("Name"), fill({ Name: "Old Town Jail" }), move({ x: -5.2, y: 80.9, z: 12.7 }, press("Move the jail spot")), press("Send me to the jail spot"), close, close);
    await open(op);

    const jail = store.getJail("jail_1");
    check("renamed", jail.name === "Old Town Jail");
    check("the spot is the middle of the block they stood on", jail.jail.x === -5.5 && jail.jail.y === 80 && jail.jail.z === 12.5, JSON.stringify(jail.jail));
    check("and the operator was sent there", op.teleports.at(-1)?.x === -5.5 && op.teleports.at(-1)?.z === 12.5, JSON.stringify(op.teleports));
    check("the id did not change with the name", jail.id === "jail_1");
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("a name that cannot be used is refused with the reason and what was typed, and nothing is saved", async () => {
    const { check, done } = checks();
    const { op } = scene();

    script(press("Jail 1"), press("Name"), fill({ Name: "x".repeat(JAILS.maxName + 1) }), close, close, close);
    await open(op);

    const again = ui.shown.find((f) => new RegExp(`^Not saved: a name is at most ${JAILS.maxName}`).test(strip(titleOf(f))));
    check("it came back with the reason", again !== undefined, ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    check("with what was typed", again?.calls.find((c) => c[0] === "textField")?.[3]?.defaultValue === "x".repeat(JAILS.maxName + 1));
    check("nothing was saved", store.getJail("jail_1").name === "Jail 1" && store.jailsAreDefault());
    done();
});

test("'bind a button' closes the screens, asks for a click, and the next right-click on any block becomes the button", async () => {
    const { check, done } = checks();
    const { op } = scene();
    fake.placeBlock("overworld", { x: 40, y: 70, z: 5 }, "minecraft:lever");

    script(press("Jail 1"), press("Bind a button"));
    await open(op);

    check("the editor closed (it does not stay over the click)", ui.shown.length === 2, ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    check("a bind is waiting", bind.hasPendingBind(op) === true);
    check("the operator was told what to do and for how long", said(op).some((m) => new RegExp(`Right-click the block that should start the lockpick for Jail 1 within ${JAILS.bindSeconds} seconds`).test(m)), said(op).join(" | "));

    useBlock(op, [40, 70, 5]);
    fake.advance(1);
    check("the lever is now a button of Jail 1", store.getJail("jail_1").buttons.length === 1 && store.getJail("jail_1").buttons[0].x === 40);
    done();
});

test("'set the door trigger' waits for a click the same way, and 'clear the door trigger' takes it away", async () => {
    const { check, done } = checks();
    const { op } = scene();

    script(press("Jail 1"), press("Set the door trigger"));
    await open(op);
    useBlock(op, [60, 61, 9]);
    fake.advance(1);
    check("the door trigger is the clicked block", store.getJail("jail_1").doorTrigger?.x === 60 && store.getJail("jail_1").doorTrigger?.y === 61);

    ui.shown.length = 0;
    script(press("Jail 1"), press("Clear the door trigger"), close, close);
    await open(op);
    check("cleared", store.getJail("jail_1").doorTrigger === undefined);
    check("and the screen says nothing is placed now", ui.shown.some((f) => /Door trigger: none/.test(bodyOf(f))));
    done();
});

test("a jail already at its most buttons is not asked for another click", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveJail(edited(store.getJail("jail_1"), { buttons: Array.from({ length: JAILS.maxButtons }, (_, i) => ({ x: i, y: 70, z: 5 })) }));

    script(press("Jail 1"), press("Bind a button"), close, close);
    await open(op);

    check("no bind is waiting", bind.hasPendingBind(op) === false);
    check("the operator is told to remove one first", ui.shown.some((f) => new RegExp(`at most ${JAILS.maxButtons} buttons: remove one first`).test(bodyOf(f))), ui.shown.map((f) => bodyOf(f)).join(" | "));
    done();
});

test("a button can be removed by its number, and the others stay", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveJail(edited(store.getJail("jail_1"), { buttons: [{ x: 1, y: 70, z: 5 }, { x: 2, y: 70, z: 5 }, { x: 3, y: 70, z: 5 }] }));

    script(press("Jail 1"), press("Remove button 2"), close, close);
    await open(op);

    check("button 2 went", store.getJail("jail_1").buttons.map((b) => b.x).join() === "1,3", JSON.stringify(store.getJail("jail_1").buttons));
    check("the screen listed the remaining ones, renumbered", ui.shown.some((f) => labels(f).includes("Remove button 2 (3, 70, 5)")), ui.shown.map((f) => labels(f).join(",")).join(" | "));
    done();
});

test("delete asks first, the last jail that is on cannot be deleted, and what was deleted can be brought back", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("Yard");

    script(press("Yard"), press("Delete"), no, close, close);
    await open(op);
    check("saying no keeps it", store.getJail("yard") !== undefined);

    ui.shown.length = 0;
    script(press("Yard"), press("Delete"), yes, close);
    await open(op);
    check("saying yes deletes it", store.getJail("yard") === undefined);
    check("the list offers to bring it back", ui.shown.some((f) => labels(f).includes("Bring back yard")), ui.shown.map((f) => labels(f).join(",")).join(" | "));

    ui.shown.length = 0;
    script(press("Bring back yard"), close);
    await open(op);
    check("and it comes back as it was", store.getJail("yard")?.name === "Yard");

    // the last one that is on
    store.saveJail(edited(store.getJail("yard"), { enabled: false }));
    store.saveJail(edited(store.getJail("jail_2"), { enabled: false }));
    ui.shown.length = 0;
    script(press("Jail 1"), press("Delete"), yes, close, close);
    await open(op);
    check("the last jail that is on is refused, with the reason", store.getJail("jail_1") !== undefined && ui.shown.some((f) => /at least one jail has to stay on/.test(bodyOf(f))), ui.shown.map((f) => bodyOf(f)).join(" | "));
    done();
});

test("undo is offered only when there is something to undo, and undoes the last change", async () => {
    const { check, done } = checks();
    const { op } = scene();

    script(press("Jail 1"), close, close);
    await open(op);
    check("before any change there is no Undo", !labels(named("Jail 1")).includes("Undo my last change"), labels(named("Jail 1")).join(" | "));

    ui.shown.length = 0;
    script(press("Jail 1"), press("Name"), fill({ Name: "Changed" }), press("Undo my last change"), close, close);
    await open(op);
    check("after an edit Undo puts the old name back", store.getJail("jail_1").name === "Jail 1");
    done();
});

test("a jail that cannot be read is listed with why and offers only Delete", async () => {
    const { check, done } = checks();
    const { op } = scene();
    world.setDynamicProperty("rae:jail:bad", "{nope");
    store.forgetJails();
    script(press("bad (cannot be read)"), close, close);

    await open(op);

    const broken = ui.shown[1];
    check("listed", labels(ui.shown[0]).includes("bad (cannot be read)"));
    check("its screen says it cannot be read and offers Delete and Back only", /cannot be read/.test(bodyOf(broken)) && labels(broken).join("|") === "Delete|Back", `${bodyOf(broken)} / ${labels(broken).join("|")}`);
    done();
});

test("closing a box half way saves nothing, and a box submitted after someone else deleted the jail does not bring it back", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("Yard");
    const before = JSON.stringify(store.getJail("yard"));

    script(press("Yard"), press("Name"), close, close, close);
    await open(op);
    check("closing the Name box changed nothing", JSON.stringify(store.getJail("yard")) === before);

    ui.shown.length = 0;
    script(press("Yard"), press("Name"), (form) => { store.removeJail("yard"); return fill({ Name: "Ghost" })(form); }, close, close);
    await open(op);
    check("still gone", store.getJail("yard") === undefined);
    check("the operator was told why nothing was saved", ui.shown.some((f) => /deleted while the box was open/.test(bodyOf(f))));
    done();
});

test("a spot is only taken in the overworld", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const nether = fake.makePlayer("Nope", { permission: PlayerPermissionLevel.Operator, inventory: true, dimension: fake.dimension("the_nether") });
    fake.advance(1);

    script(press("Add a jail"), fill({ Name: "Hot jail" }), close);
    await open(nether);
    check("an Add in the nether is refused with the reason, and nothing is saved", ui.shown.some((f) => /^Not saved: jails are in the overworld/.test(strip(titleOf(f)))) && store.getJail("hot_jail") === undefined);

    ui.shown.length = 0;
    script(press("Jail 1"), press("Move the jail spot"), close, close);
    await open(nether);
    check("so is moving a spot", ui.shown.some((f) => /Not changed: jails are in the overworld/.test(bodyOf(f))) && store.getJail("jail_1").jail.x === -254);
    assert.ok(op);
    done();
});

test("a screen that shows a jail another operator has since changed does not undo their change, and one it shows a button of that is gone is refused", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveJail(edited(store.getJail("jail_1"), { buttons: [{ x: 1, y: 70, z: 5 }, { x: 2, y: 70, z: 5 }] }));

    // The screen is drawn with two buttons; before the operator presses anything, another operator renames the jail and removes button 1.
    script(
        press("Jail 1"),
        (form) => { store.saveJail(edited(store.getJail("jail_1"), { name: "Renamed by Ann", buttons: [{ x: 2, y: 70, z: 5 }] })); return press("Turn it off")(form); },
        close, close
    );
    await open(op);

    check("their rename was kept when the jail was turned off", store.getJail("jail_1").name === "Renamed by Ann" && store.getJail("jail_1").enabled === false, JSON.stringify(store.getJail("jail_1")));

    ui.shown.length = 0;
    store.saveJail(edited(store.getJail("jail_1"), { enabled: true, buttons: [{ x: 1, y: 70, z: 5 }, { x: 2, y: 70, z: 5 }] }));
    script(
        press("Renamed by Ann"),
        (form) => { store.saveJail(edited(store.getJail("jail_1"), { buttons: [{ x: 2, y: 70, z: 5 }] })); return press("Remove button 1")(form); },
        close, close
    );
    await open(op);
    check("removing a button another operator already removed says so, and the other is untouched", store.getJail("jail_1").buttons.length === 1 && store.getJail("jail_1").buttons[0].x === 2 && ui.shown.some((f) => /that button is already gone/.test(bodyOf(f))), ui.shown.map((f) => bodyOf(f)).join(" | "));
    done();
});
