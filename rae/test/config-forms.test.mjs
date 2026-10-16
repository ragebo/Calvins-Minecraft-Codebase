import { test } from "node:test";
import { fake, fakeApi, load, checks, strip } from "./helpers.mjs";
import { buttonsOf, close, fill, press, problems, script, titleOf, ui } from "./robbery-ui.mjs";

// core/configforms.ts: the live config editor as screens. The contract: it offers exactly what core/configoverrides.ts registers, in
// groups (a long group split by what its labels start with), a search, and the list of what was changed; a setting is changed with
// the control its kind needs; the result is told at the TOP of the next screen (not in chat behind the form); a refused value shows
// the same form again with what was typed and the reason; a changed setting has a switch that puts it back; closing a form
// changes nothing.

const { PlayerPermissionLevel } = fakeApi;
const C = await load("core/configforms.js");
const O = await load("core/configoverrides.js");
const { ECONOMY, ROBBERY } = await load("config/balance.js");
const { GUNS } = await load("config/guns.js");
const { TRAIN_VAULT_CHEST } = await load("config/world.js");

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, location: { x: 10.7, y: 70.2, z: -3.2 } });
const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const titleText = (form) => strip(titleOf(form));
const buttons = (form) => buttonsOf(form).map(strip);
const controls = (form, kind) => form.calls.filter((c) => c[0] === kind);

function setup() {
    fake.reset();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
}

/** Puts every setting this file touched back, so the shared config objects are as the next test expects them. */
function cleanUp(player) {
    for (const field of O.changedFields()) O.resetOverride(player, field.id);
}

test("the editor opens on the groups, a search and a close, and says how many settings there are", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();

    script(close);
    await C.openConfigEditor(op);

    const main = ui.shown[0];
    const shown = buttons(main);

    check("it is the live config", titleText(main) === "Live config");
    check("the search is first", shown[0] === "Find a setting by name...", shown.join(" | "));
    check("every group is a button with its size", O.listCategories().every((group) => shown.includes(`${group} (${O.listFields(group).length})`)), shown.join(" | "));
    check("Close is last", shown.at(-1) === "Close");
    check("no 'changed' button while nothing is", !shown.some((b) => /^Changed from the default/.test(b)));
    check("the body counts the settings", new RegExp(`${O.listFields().length} settings in ${O.listCategories().length} groups, none changed from the default`).test(bodyOf(main)), bodyOf(main));
    check("nothing is left open afterwards", C.hasConfigMenuOpen(op) === false);
    done();
});

test("changing a number: the right box, saved, and the result at the top of the next screen with the value marked changed", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const before = ECONOMY.goldIngotValue;

    script(press("Economy"), press("coins per gold ingot"), fill({ "coins per gold ingot": String(before + 2) }), close);
    await C.openConfigEditor(op);

    const modal = ui.shown[2];
    check("the form is a box for a number, labelled with what it takes and started at the current value", controls(modal, "textField").length === 1 && /coins per gold ingot \(a whole number, at least 0\)/.test(strip(String(controls(modal, "textField")[0][1]))) && controls(modal, "textField")[0][3].defaultValue === String(before), JSON.stringify(controls(modal, "textField")));
    check("an unchanged setting has no 'put it back' switch", controls(modal, "toggle").length === 0);
    check("it was saved", ECONOMY.goldIngotValue === before + 2, String(ECONOMY.goldIngotValue));

    const next = ui.shown[3];
    check("the next screen starts with what happened, from what to what", bodyOf(next).startsWith(`Economy: coins per gold ingot: ${before} -> ${before + 2}.`), bodyOf(next));
    check("and shows the new value, marked changed", buttons(next).some((b) => b === `Economy: coins per gold ingot  =  ${before + 2}  (changed)`), buttons(next).join(" | "));
    check("nothing was said in chat behind the form", op.messages.length === 0, op.messages.join("|"));

    cleanUp(op);
    check("(the test put it back)", ECONOMY.goldIngotValue === before);
    done();
});

test("a refused value shows the same form again, with what was typed and the reason, and a good one is then saved", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const before = ECONOMY.goldIngotValue;

    script(press("Economy"), press("coins per gold ingot"), fill({ "coins per gold ingot": "-5" }), fill({ "coins per gold ingot": "7" }), close);
    await C.openConfigEditor(op);

    const again = ui.shown[3];
    check("the second form is the same box", controls(again, "textField").length === 1);
    check("its title says why the first was not saved", /^Not saved: must be at least 0/.test(titleText(again)), titleText(again));
    check("and it still holds what was typed", controls(again, "textField")[0][3].defaultValue === "-5", JSON.stringify(controls(again, "textField")[0]));
    check("the second answer was saved", ECONOMY.goldIngotValue === 7, String(ECONOMY.goldIngotValue));
    check("no 'put it back' switch was offered while nothing was saved yet", controls(ui.shown[2], "toggle").length === 0);

    cleanUp(op);
    check("(the test put it back)", ECONOMY.goldIngotValue === before);
    done();
});

test("text that is not a number is refused in words, and the form comes back", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const before = ECONOMY.goldIngotValue;

    script(press("Economy"), press("coins per gold ingot"), fill({ "coins per gold ingot": "lots" }), close);
    await C.openConfigEditor(op);

    check("the form came back saying what is wanted", /^Not saved: type a whole number, at least 0/.test(titleText(ui.shown[3])), titleText(ui.shown[3]));
    check("and nothing changed", ECONOMY.goldIngotValue === before);
    done();
});

test("an on/off setting is a switch, and a changed setting offers to put it back to the default", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const before = ROBBERY.holdUpNeedsAim;

    script(press("Robbery"), press("a hold-up needs the gun aimed"), fill({ "a hold-up needs the gun aimed": !before }), close);
    await C.openConfigEditor(op);

    check("the form is one switch", controls(ui.shown[2], "toggle").length === 1 && controls(ui.shown[2], "textField").length === 0);
    check("it started at the current value", controls(ui.shown[2], "toggle")[0][2].defaultValue === before);
    check("it was flipped", ROBBERY.holdUpNeedsAim === !before);

    // Open it again: now it is changed, so there is a second switch to put it back.
    ui.shown.length = 0;
    script(press("Changed from the default"), press("a hold-up needs the gun aimed"), fill({ "Put it back": true }), close);
    await C.openConfigEditor(op);

    const modal = ui.shown[2];
    check("the changed list is offered, with a count", buttons(ui.shown[0]).some((b) => b === "Changed from the default (1)"), buttons(ui.shown[0]).join(" | "));
    check("a changed setting has the extra switch, naming the default", controls(modal, "toggle").length === 2 && /Put it back to the default \(/.test(strip(String(controls(modal, "toggle")[1][1]))), JSON.stringify(controls(modal, "toggle")));
    check("pressing it restored the default", ROBBERY.holdUpNeedsAim === before);
    check("and the next screen says so", bodyOf(ui.shown[3]).includes("is back to its default"), bodyOf(ui.shown[3]));

    cleanUp(op);
    done();
});

test("a position is three boxes and a switch to use the block she is standing on", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const before = { ...TRAIN_VAULT_CHEST };

    script(press("World"), press("Train vault chest"), fill({ "X": "5", "Y": "66", "Z": "7" }), close);
    await C.openConfigEditor(op);

    check("three boxes then the switch", controls(ui.shown[2], "textField").length === 3 && controls(ui.shown[2], "toggle").length === 1);
    check("the position was saved", TRAIN_VAULT_CHEST.x === 5 && TRAIN_VAULT_CHEST.y === 66 && TRAIN_VAULT_CHEST.z === 7, JSON.stringify(TRAIN_VAULT_CHEST));
    check("and the next screen says from where to where", /Train vault chest: .* -> 5, 66, 7\./.test(bodyOf(ui.shown[3])), bodyOf(ui.shown[3]));

    ui.shown.length = 0;
    script(press("World"), press("Train vault chest"), fill({ "Use the block": true }), close);
    await C.openConfigEditor(op);
    check("the switch takes the middle of her block", TRAIN_VAULT_CHEST.x === 10.5 && TRAIN_VAULT_CHEST.y === 70 && TRAIN_VAULT_CHEST.z === -3.5, JSON.stringify(TRAIN_VAULT_CHEST));

    ui.shown.length = 0;
    script(press("World"), press("Train vault chest"), fill({ "X": "oops" }), close);
    await C.openConfigEditor(op);
    check("a position that is not three numbers is refused with what it takes", /^Not saved: type x, y, z/.test(titleText(ui.shown[3])), titleText(ui.shown[3]));
    check("with what was typed kept", controls(ui.shown[3], "textField")[0][3].defaultValue === "oops");

    cleanUp(op);
    check("(the test put it back)", TRAIN_VAULT_CHEST.x === before.x && TRAIN_VAULT_CHEST.y === before.y && TRAIN_VAULT_CHEST.z === before.z);
    done();
});

test("a long group is split by what its labels start with, and a short part shows plain names", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();

    script(press("Guns"), press("Revolver"), close);
    await C.openConfigEditor(op);

    const groups = ui.shown[1];
    check("Guns has more settings than one screen should hold", O.listFields("Guns").length > 24);
    check("so it lists the guns", buttons(groups).some((b) => /^Revolver \(\d+\)$/.test(b)) && buttons(groups).some((b) => /^Repeater \(\d+\)$/.test(b)), buttons(groups).join(" | "));

    const revolver = ui.shown[2];
    check("a gun's part is titled with both names", titleText(revolver) === `Guns: ${GUNS.revolver.displayName}`, titleText(revolver));
    check("and shows each setting by its short name with its value", buttons(revolver).includes(`fire rate (ticks)  =  ${GUNS.revolver.fireRateTicks}`), buttons(revolver).join(" | "));

    ui.shown.length = 0;
    script(press("Economy"), close);
    await C.openConfigEditor(op);
    check("a short group is listed straight away, with full names", buttons(ui.shown[1]).some((b) => b.startsWith("Economy: coins per gold ingot")), buttons(ui.shown[1]).join(" | "));
    done();
});

test("the search finds settings by any words of their name and id, and says when nothing matches", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();

    script(press("Find a setting"), fill({ "Part of its name": "revolver fire rate" }), close);
    await C.openConfigEditor(op);

    const results = ui.shown[2];
    check("the results are titled with the words", titleText(results) === 'Settings matching "revolver fire rate"', titleText(results));
    check("they include the one asked for, with its value", buttons(results).includes(`${GUNS.revolver.displayName}: fire rate (ticks)  =  ${GUNS.revolver.fireRateTicks}`), buttons(results).join(" | "));
    check("and only matches", buttons(results).filter((b) => b !== "Back").every((b) => /fire rate/i.test(b)), buttons(results).join(" | "));

    ui.shown.length = 0;
    script(press("Find a setting"), fill({ "Part of its name": "zzzz" }), close);
    await C.openConfigEditor(op);
    check("nothing matching says so at the top of the main screen", bodyOf(ui.shown[2]).startsWith('Nothing is called "zzzz"'), bodyOf(ui.shown[2]));

    ui.shown.length = 0;
    script(press("Find a setting"), fill({ "Part of its name": "e" }), close);
    await C.openConfigEditor(op);
    const many = ui.shown[2];
    check("a search with too many matches shows the first part and says to narrow it", buttons(many).length <= 42 && /Showing 40 of \d+: type more of the name/.test(bodyOf(many)), `${buttons(many).length} ${bodyOf(many)}`);
    done();
});

test("closing a form changes nothing, and a result is not carried into the next time the menu opens", async () => {
    setup();
    const { check, done } = checks();
    const op = operator();
    const before = ECONOMY.goldIngotValue;

    script(press("Economy"), press("coins per gold ingot"), close);
    await C.openConfigEditor(op);
    check("closing the box left the value alone", ECONOMY.goldIngotValue === before);

    ui.shown.length = 0;
    script(press("Economy"), press("coins per gold ingot"), fill({ "coins per gold ingot": String(before + 1) }), press("Back"), close);
    await C.openConfigEditor(op);

    ui.shown.length = 0;
    script(close);
    await C.openConfigEditor(op);
    check("the next time it opens, the first screen carries no leftover result", !/->/.test(bodyOf(ui.shown[0])), bodyOf(ui.shown[0]));
    check("but it does say one thing is changed", /1 changed from the default/.test(bodyOf(ui.shown[0])), bodyOf(ui.shown[0]));

    cleanUp(op);
    done();
});
