import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, fill, close, yes, no, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// core/endingforms.ts: the operator's screens for the endings, opened from an "Endings" button in the RAE menu that only operators see. A list, Add (a name and
// a type), and one screen per ending for every field: on or off, the place and win spot (where the operator STANDS), radius, price, the item (from the hand), whether
// it is consumed, the four messages, delete. A refused value brings the box back with the reason in its title and what was typed kept. A stand-in plays the operator,
// as in the other screen tests; what it cannot say is how the screens look in the game.

const { PlayerPermissionLevel, ItemStack } = fakeApi;
await load("main.js");
const F = await load("core/endingforms.js");
const store = await load("core/endingstore.js");
const L = await load("logic/endings.js");
const round = await load("core/round.js");

const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const labels = (form) => buttonsOf(form).map(strip);
const named = (title) => [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith(title));
const scriptEvent = (id, sourceEntity, message = "") => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message });

const PIER = { x: 200, y: 64, z: 300 };

function scene() {
    fake.reset();
    round.resetRound();
    store.forgetEndings();
    ui.shown.length = 0;
    problems.length = 0;

    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, inventory: true, location: { x: 10.7, y: 64, z: -20.2 } });
    const member = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });
    fake.advance(1);

    return { op, member };
}

/** Saves an ending the way an earlier session of the editor would have. */
function add(kind, id, patch = {}) {
    const made = L.newEnding(kind, id, id[0].toUpperCase() + id.slice(1), PIER);
    assert.ok(made.ok, made.reason);
    const edited = L.edit(made.value, patch);
    assert.ok(edited.ok, edited.reason);
    assert.equal(store.saveEnding(edited.value).ok, true);
}

const open = (player) => F.openEndingsEditor(player);

test("the editor opens on a list that holds the boat while nothing is saved, with Add", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(close);

    await open(op);

    const form = ui.shown[0];
    check("one screen, titled Endings", ui.shown.length === 1 && strip(titleOf(form)) === "Endings", titleOf(form));
    check("the boat, with its type and that it is on", labels(form).includes("Escape boat (group, on)"), labels(form).join(" | "));
    check("an Add button", labels(form).includes("Add an ending"));
    check("it says how many of how many", /1 of 12 endings/.test(bodyOf(form)), bodyOf(form));
    check("nothing was saved by looking", store.endingsAreDefault());
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("a member cannot open it by any route, and the RAE menu offers the button to an operator only", async () => {
    const { check, done } = checks();
    const { op, member } = scene();
    script(close);

    await open(member);
    check("no screen was shown to a member", ui.shown.length === 0);
    check("they were told only operators can", member.messages.some((m) => /operator/i.test(m)), member.messages.join(" | "));

    script(close);
    scriptEvent("rae:menu", member);
    await new Promise((resolve) => setImmediate(resolve));
    check("a member's menu has no Endings button", ui.shown.length === 1 && !labels(ui.shown[0]).includes("Endings"), labels(ui.shown[0]).join(" | "));

    ui.shown.length = 0;
    script(press("Endings"), close);
    scriptEvent("rae:menu", op);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    check("an operator's does, and it opens the list", ui.shown.length >= 2 && labels(ui.shown[0]).includes("Endings") && strip(titleOf(ui.shown[1])) === "Endings", ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    done();
});

test("Add makes a group ending and a solo one, placed in the middle of the block the operator stands on", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Add an ending"), fill({ Name: "Harbor", Type: "Group" }), press("Add an ending"), fill({ Name: "Sky Tower", Type: "Solo" }), close);

    await open(op);

    const harbor = store.getEnding("harbor");
    const tower = store.getEnding("sky_tower");
    check("the group ending", harbor?.kind === "group" && harbor.name === "Harbor" && harbor.enabled === true && harbor.price === 0, JSON.stringify(harbor));
    check("its place is the middle of the block they stand on, whole numbers either way", harbor?.place.x === 10.5 && harbor?.place.y === 64 && harbor?.place.z === -20.5, JSON.stringify(harbor?.place));
    check("the solo ending asks for the default price", tower?.kind === "solo" && tower.price === 100, JSON.stringify(tower));
    check("the boat is still there beside them", store.getEnding("boat") !== undefined);
    check("the list shows the last one added", labels(ui.shown[ui.shown.length - 1]).includes("Sky Tower (solo, on)") && labels(ui.shown[ui.shown.length - 1]).includes("Harbor (group, on)"), labels(ui.shown[ui.shown.length - 1]).join(" | "));
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("a name that cannot be used brings the box back with the reason and what was typed, and saves nothing", async () => {
    const { check, done } = checks();
    const { op } = scene();
    let defaultAtRefusal = false;
    script(press("Add an ending"), fill({ Type: "Solo" }), (form) => { defaultAtRefusal = store.endingsAreDefault(); return fill({ Name: "Tower" })(form); }, close);

    await open(op);

    const again = ui.shown.find((f) => /^Not saved: a name cannot be empty/.test(strip(titleOf(f))));
    check("the box came back with the reason", again !== undefined, ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    check("with the type still on Solo", again?.calls.find((c) => c[0] === "dropdown")?.[3]?.defaultValueIndex === 1, JSON.stringify(again?.calls.find((c) => c[0] === "dropdown")));
    check("nothing had been saved at that point", defaultAtRefusal);
    check("and the second try went through", store.getEnding("tower")?.kind === "solo");
    done();
});

test("turning an ending off is what the next attempt reads", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("solo", "tower", { price: 100 });
    script(press("Tower"), press("Turn it off"), close, close);

    await open(op);

    check("saved as off", store.getEnding("tower")?.enabled === false);
    check("the list says so", ui.shown.some((f) => labels(f).includes("Tower (solo, off)")), ui.shown.map((f) => labels(f).join(",")).join(" | "));

    scriptEvent("rae:ending", op, "tower");
    check("an attempt is told it is off", op.messages.some((m) => /switched off/.test(strip(m))), op.messages.join(" | "));

    ui.shown.length = 0;
    script(press("Tower"), press("Turn it on"), close, close);
    await open(op);
    check("and on again", store.getEnding("tower")?.enabled === true);
    done();
});

test("the settings box changes the name, radius and price, and a bad value is refused with the reason, keeping what was typed", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", { price: 50, radius: 10 });
    const before = store.getEnding("pier");

    // Five refusals in a row, each shown again with what was typed, then one that goes through.
    script(
        press("Pier"), press("Name, radius and price"),
        fill({ Price: "-5" }), fill({ Radius: "0", Price: "50" }), fill({ Price: "abc" }), fill({ Radius: "wide", Price: "50" }), fill({ Radius: "", Price: "50" }),
        fill({ Name: "Harbor Two", Radius: "20", Price: "250" }),
        close, close
    );

    await open(op);

    const refusals = ui.shown.map((f) => strip(titleOf(f))).filter((t) => t.startsWith("Not saved:"));
    check("five refusals, each with its reason (an empty box is not a zero)", refusals.length === 5
        && /whole number of coins/.test(refusals[0]) && /radius must be above 0/.test(refusals[1]) && /price must be a number/.test(refusals[2]) && /radius must be a number/.test(refusals[3]) && /radius must be a number/.test(refusals[4]), refusals.join(" | "));

    const typedBack = ui.shown.filter((f) => /^Not saved:/.test(strip(titleOf(f)))).map((f) => f.calls.filter((c) => c[0] === "textField").map((c) => c[3]?.defaultValue));
    check("what was typed came back each time", typedBack[0]?.[2] === "-5" && typedBack[1]?.[1] === "0" && typedBack[2]?.[2] === "abc" && typedBack[3]?.[1] === "wide", JSON.stringify(typedBack));

    const after = store.getEnding("pier");
    check("then the good values were saved", after?.name === "Harbor Two" && after.radius === 20 && after.price === 250, JSON.stringify(after));
    check("the id did not change with the name", after?.id === before?.id);
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("closing a box half way saves nothing", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", { price: 50 });
    const before = JSON.stringify(store.getEnding("pier"));
    script(press("Pier"), press("Name, radius and price"), close, close, close);

    await open(op);

    check("the ending is as it was", JSON.stringify(store.getEnding("pier")) === before);
    check("and the editor can be opened again at once", (() => { ui.shown.length = 0; script(close); return true; })());
    await open(op);
    check("it opened", ui.shown.length === 1);
    done();
});

test("a player who leaves while a box is up leaves nothing behind: no more screens, and the editor opens again for the next operator", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", { price: 50 });
    let shownWhenTheyLeft = -1;
    script(press("Pier"), press("Name, radius and price"), (form) => { op.isValid = false; shownWhenTheyLeft = ui.shown.length; return fill({ Price: "-5" })(form); });

    await open(op);

    const shownBefore = ui.shown.length;
    check("no box was put up for someone who had gone", shownBefore === shownWhenTheyLeft, `${shownBefore} ${shownWhenTheyLeft}`);
    check("nothing was saved", store.getEnding("pier")?.price === 50);

    const second = fake.makePlayer("Op2", { permission: PlayerPermissionLevel.Operator });
    fake.advance(1);
    script(close);
    await open(second);
    check("another operator can open it", ui.shown.length === shownBefore + 1);
    done();
});

test("the place and the win spot are taken from where the operator stands", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", {});
    const move = (to, step) => (form) => { op.location = to; return step(form); };
    script(
        press("Pier"),
        move({ x: 300.9, y: 70.2, z: 400.1 }, press("Move the place")),
        move({ x: -5.2, y: 80, z: 12.7 }, press("Set the win spot")),
        close, close
    );

    await open(op);

    const ending = store.getEnding("pier");
    check("the place moved to the middle of that block", ending?.place.x === 300.5 && ending.place.y === 70 && ending.place.z === 400.5, JSON.stringify(ending?.place));
    check("the win spot is where they stood after", ending?.winSpot?.x === -5.5 && ending.winSpot.y === 80 && ending.winSpot.z === 12.5, JSON.stringify(ending?.winSpot));

    ui.shown.length = 0;
    script(press("Pier"), press("Clear the win spot"), close, close);
    await open(op);
    check("and it can be cleared", store.getEnding("pier")?.winSpot === undefined);
    done();
});

test("the item comes from the hand, an empty hand says so, and a group ending offers no item", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("solo", "tower", { price: 100 });
    add("group", "pier", {});

    script(press("Tower"), press("Take the item from my hand"), close, close);
    await open(op);
    const tower = [...ui.shown].reverse().find((f) => strip(titleOf(f)) === "Tower");
    check("with a bare hand it said so, and nothing was set", /hand is empty/.test(bodyOf(tower)) && store.getEnding("tower")?.item === undefined, bodyOf(tower));

    op.container.setItem(op.selectedSlotIndex, new ItemStack("minecraft:diamond", 5));
    ui.shown.length = 0;
    script(press("Tower"), press("Take the item from my hand"), close, close);
    await open(op);
    check("holding five diamonds, it asks for five", store.getEnding("tower")?.item?.id === "minecraft:diamond" && store.getEnding("tower")?.item?.count === 5, JSON.stringify(store.getEnding("tower")?.item));

    ui.shown.length = 0;
    script(press("Tower"), press("Name, radius and price"), fill({ "Item count": "2", "taken": false }), close, close);
    await open(op);
    check("the count and whether it is taken are editable", store.getEnding("tower")?.item?.count === 2 && store.getEnding("tower")?.consumeItem === false, JSON.stringify(store.getEnding("tower")));

    ui.shown.length = 0;
    script(press("Pier"), close, close);
    await open(op);
    check("a group ending's screen has no item button", !labels(named("Pier")).some((l) => /item/i.test(l)), labels(named("Pier")).join(" | "));

    ui.shown.length = 0;
    script(press("Tower"), press("Ask for no item"), close, close);
    await open(op);
    check("no item again, and the price still holds it up", store.getEnding("tower")?.item === undefined && store.getEnding("tower")?.price === 100);

    // With the price 0 the item is all that stands between an outlaw and the exit: taking it away is refused.
    op.container.setItem(op.selectedSlotIndex, new ItemStack("minecraft:diamond", 1));
    add("solo", "vault", { price: 0, item: { id: "minecraft:emerald", count: 1 } });
    ui.shown.length = 0;
    script(press("Vault"), press("Ask for no item"), close, close);
    await open(op);
    const vault = [...ui.shown].reverse().find((f) => strip(titleOf(f)) === "Vault");
    check("refused with the reason, item kept", /has to ask for coins or an item/.test(bodyOf(vault)) && store.getEnding("vault")?.item?.id === "minecraft:emerald", bodyOf(vault));
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("the messages box saves all four, and a text that is too long is refused", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", {});
    script(
        press("Pier"), press("Messages"),
        fill({ "Announced": "x".repeat(161) }),
        fill({ "Announced": "§bGone!", "line under": "{coins} coins", "not all there": "Wait for the rest", "not an outlaw": "Outlaws only" }),
        close, close
    );

    await open(op);

    check("the long one was refused with the reason", ui.shown.some((f) => /^Not saved: a text is at most 160/.test(strip(titleOf(f)))), ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    const texts = store.getEnding("pier")?.texts;
    check("then all four were saved", texts?.headline === "§bGone!" && texts.detail === "{coins} coins" && texts.gather === "Wait for the rest" && texts.outlawsOnly === "Outlaws only", JSON.stringify(texts));
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("delete asks first, and what was deleted can be brought back from the list", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("solo", "tower", { price: 100 });

    script(press("Tower"), press("Delete"), no, close, close);
    await open(op);
    check("saying no keeps it", store.getEnding("tower") !== undefined);

    ui.shown.length = 0;
    script(press("Tower"), press("Delete"), yes, close);
    await open(op);
    check("saying yes deletes it", store.getEnding("tower") === undefined);
    check("the list offers to bring it back", ui.shown.some((f) => labels(f).includes("Bring back tower")), ui.shown.map((f) => labels(f).join(",")).join(" | "));

    ui.shown.length = 0;
    script(press("Bring back tower"), close);
    await open(op);
    check("and it comes back", store.getEnding("tower")?.price === 100);
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("an ending that cannot be read is listed with why, offers only Delete, and is never overwritten by an Add", async () => {
    const { check, done } = checks();
    const { op } = scene();
    world.setDynamicProperty("rae:ending:bad", "{nope");
    store.forgetEndings();

    script(press("bad (cannot be read)"), close, press("Add an ending"), fill({ Name: "Bad", Type: "Group" }), close);
    await open(op);

    const list = ui.shown[0];
    check("the list names it and the boat is not offered in its place", labels(list).includes("bad (cannot be read)") && !labels(list).includes("Escape boat (group, on)"), labels(list).join(" | "));
    const broken = ui.shown[1];
    check("its screen says it cannot be read and offers Delete and Back only", /cannot be read/.test(bodyOf(broken)) && labels(broken).join("|") === "Delete|Back", `${bodyOf(broken)} / ${labels(broken).join("|")}`);
    check("an Add with the same name went to another id and left the damaged one alone", world.getDynamicProperty("rae:ending:bad") === "{nope" && store.getEnding("bad_2") !== undefined, `${world.getDynamicProperty("rae:ending:bad")} ${store.getEnding("bad_2")?.id}`);
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("Bring back is offered only while there is something to bring back", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("solo", "tower", { price: 100 });

    script(press("Tower"), press("Delete"), yes, press("Bring back tower"), close);
    await open(op);
    const last = ui.shown[ui.shown.length - 1];
    check("once it is back the list does not offer it again", store.getEnding("tower") !== undefined && !labels(last).includes("Bring back tower"), labels(last).join(" | "));

    ui.shown.length = 0;
    script(press("Tower"), press("Delete"), yes, close);
    await open(op);
    store.forgetEndings();
    ui.shown.length = 0;
    script(close);
    await open(op);
    check("after the scripts reload there is nothing to undo, so it is not offered", !labels(ui.shown[0]).includes("Bring back tower"), labels(ui.shown[0]).join(" | "));
    done();
});

test("Clear the win spot and Undo are on the screen only when they would do something", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", { price: 50 });

    script(press("Pier"), close, close);
    await open(op);
    check("no win spot, so nothing to clear", !labels(named("Pier")).includes("Clear the win spot"), labels(named("Pier")).join(" | "));

    ui.shown.length = 0;
    script(press("Pier"), press("Name, radius and price"), fill({ Price: "250" }), press("Undo my last change"), close, close);
    await open(op);
    check("an edit can be undone from the screen", store.getEnding("pier")?.price === 50, JSON.stringify(store.getEnding("pier")));

    store.forgetEndings();
    ui.shown.length = 0;
    script(press("Pier"), close, close);
    await open(op);
    check("after the scripts reload there is nothing to undo, so no button", !labels(named("Pier")).includes("Undo my last change"), labels(named("Pier")).join(" | "));

    ui.shown.length = 0;
    script(press("Pier"), press("Set the win spot"), close, close);
    await open(op);
    ui.shown.length = 0;
    script(press("Pier"), close, close);
    await open(op);
    check("with a win spot there is", labels(named("Pier")).includes("Clear the win spot"), labels(named("Pier")).join(" | "));
    done();
});

test("deleting one that cannot be read frees it and returns to the list", async () => {
    const { check, done } = checks();
    const { op } = scene();
    world.setDynamicProperty("rae:ending:bad", "{nope");
    store.forgetEndings();
    script(press("bad (cannot be read)"), press("Delete"), yes, close);

    await open(op);

    check("gone from the world", world.getDynamicProperty("rae:ending:bad") === undefined);
    const after = ui.shown[3];
    check("and the very next screen is the list, without it (not the dead ending's own screen again)", strip(titleOf(after)) === "Endings" && !labels(after).includes("bad (cannot be read)"), `${ui.shown.map((f) => strip(titleOf(f))).join(" | ")}`);
    done();
});

test("a box submitted after the ending was deleted by someone else does not bring it back", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("group", "pier", { price: 50 });
    script(press("Pier"), press("Name, radius and price"), (form) => { store.removeEnding("pier"); return fill({ Price: "250" })(form); }, close, close);

    await open(op);

    check("still gone", store.getEnding("pier") === undefined);
    check("the operator was told why nothing was saved", ui.shown.some((f) => /deleted while the box was open/.test(bodyOf(f))), ui.shown.map((f) => bodyOf(f)).join(" | "));
    done();
});

test("a refused box keeps the switch as it was set, and a number that is not finite is not a number", async () => {
    const { check, done } = checks();
    const { op } = scene();
    add("solo", "tower", { price: 100, item: { id: "minecraft:diamond", count: 3 }, consumeItem: true });
    script(press("Tower"), press("Name, radius and price"), fill({ taken: false, Radius: "Infinity" }), fill({ taken: false, Price: "-1" }), close, close, close);

    await open(op);

    const refused = ui.shown.filter((f) => /^Not saved:/.test(strip(titleOf(f))));
    check("an infinite radius is not a number", /radius must be a number/.test(strip(titleOf(refused[0]))), refused.map((f) => strip(titleOf(f))).join(" | "));
    check("the switch was kept off when the box came back", refused[0]?.calls.find((c) => c[0] === "toggle")?.[2]?.defaultValue === false && refused[1]?.calls.find((c) => c[0] === "toggle")?.[2]?.defaultValue === false, JSON.stringify(refused.map((f) => f.calls.find((c) => c[0] === "toggle"))));
    check("nothing was saved", store.getEnding("tower")?.consumeItem === true);
    done();
});
