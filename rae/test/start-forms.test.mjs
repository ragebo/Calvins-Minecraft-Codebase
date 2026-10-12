import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, fill, close, yes, no, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// core/startforms.ts, the start-commands half: the operator's screens, opened from a "Start sequence" button in the RAE menu that only operators
// see. A numbered list of the commands run first at every Start, Add (a text box), Edit one (the box filled in; an empty box deletes it), Put the
// defaults back, Back. A refused line brings the same box back with the reason in its title and what was typed kept, and a success shows at the
// top of the next screen. A stand-in plays the operator, as in the other screen tests; what it cannot say is how the screens look in the game.

const { PlayerPermissionLevel } = fakeApi;
const F = await load("core/startforms.js");
const store = await load("core/startstore.js");
await load("systems/menu.js");
const { START } = await load("config/balance.js");

const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
/** The commands screen as it was last shown: closing it walks back to the main screen, which is then shown again, so "the last form" is not it. */
const lastCommands = () => [...ui.shown].reverse().find((f) => strip(titleOf(f)) === "Start commands");
const labels = (form) => buttonsOf(form).map(strip);

function scene() {
    fake.reset();
    store.forgetLoaded();
    ui.shown.length = 0;
    problems.length = 0;

    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    const member = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });
    fake.advance(1);

    return { op, member };
}

/** Opens the editor for a player and runs it to the end of the script. */
const open = (player) => F.openStartEditor(player);

test("the editor opens on a screen that says how many start commands there are, and whether they are the defaults", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(close);

    await open(op);

    const form = ui.shown[0];
    check("one screen", ui.shown.length === 1);
    check("titled Start sequence", strip(titleOf(form)) === "Start sequence", titleOf(form));
    check("a button for the commands, with how many", labels(form).includes(`Start commands (${START.defaultCommands.length})`), labels(form).join(" | "));
    check("it says they are the defaults while nothing is saved", /defaults/i.test(bodyOf(form)), bodyOf(form));
    done();
});

test("a member cannot open it by any route: no screen, and a word about why", async () => {
    const { check, done } = checks();
    const { member } = scene();
    script(close);

    await open(member);

    check("no screen was shown", ui.shown.length === 0);
    check("they were told only operators can", member.messages.some((m) => /operator/i.test(m)), member.messages.join(" | "));
    done();
});

test("the RAE menu shows the Start sequence button to an operator and not to anyone else", async () => {
    const { check, done } = checks();
    const { op, member } = scene();

    script(close);
    system.afterEvents.scriptEventReceive.emit({ id: "rae:menu", sourceEntity: op, message: "" });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    check("the operator sees it", labels(ui.shown[0]).includes("Start sequence"), labels(ui.shown[0]).join(" | "));

    ui.shown.length = 0;
    script(close);
    system.afterEvents.scriptEventReceive.emit({ id: "rae:menu", sourceEntity: member, message: "" });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    check("a member does not", !labels(ui.shown[0]).includes("Start sequence") && labels(ui.shown[0]).length === 5, labels(ui.shown[0]).join(" | "));
    done();
});

test("the commands screen numbers every command, and offers Add and Back, but not Put the defaults back while they are the defaults", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Start commands"), close);

    await open(op);

    const form = lastCommands();
    const buttons = labels(form);
    check("titled Start commands", strip(titleOf(form)) === "Start commands", titleOf(form));
    check("each default is a numbered button", START.defaultCommands.every((c, i) => buttons[i].startsWith(`${i + 1}. `) && buttons[i].includes(c.slice(0, 20))), buttons.join(" | "));
    check("then Add a command and Back", buttons.slice(-2).join("|") === "Add a command|Back", buttons.join(" | "));
    check("nothing to put back", !buttons.includes("Put the defaults back"));
    done();
});

test("adding a command saves it last, cleaned, and the next screen says so and shows it", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Start commands"), press("Add a command"), fill({ Command: "  /say hello  " }), close);

    await open(op);

    const saved = store.startCommands();
    check("the defaults and the new one, last, without its slash", saved.length === START.defaultCommands.length + 1 && saved.at(-1) === "say hello", saved.join(" | "));
    check("it is saved now, so no longer the defaults", store.commandsAreDefault() === false);

    const after = lastCommands();
    check("the screen after it says it was added", /Added/.test(bodyOf(after)) && bodyOf(after).includes("say hello"), bodyOf(after));
    check("and lists it as the last button", labels(after).some((l) => l.startsWith(`${saved.length}. say hello`)), labels(after).join(" | "));
    check("Put the defaults back is on offer now", labels(after).includes("Put the defaults back"));
    done();
});

test("editing a command replaces it where it stands, with the box filled in with what it was", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Start commands"), press("1. "), fill({ Command: "effect @a regeneration 5 1" }), close);

    await open(op);

    const edit = ui.shown.find((f) => f.kind === "modal");
    const field = edit.calls.find((c) => c[0] === "textField");
    check("the box starts with the command it edits", field?.[3]?.defaultValue === START.defaultCommands[0], JSON.stringify(field));

    const saved = store.startCommands();
    check("the first command is the new one", saved[0] === "effect @a regeneration 5 1", saved.join(" | "));
    check("the rest are as they were, in order", saved.slice(1).join("|") === START.defaultCommands.slice(1).join("|"));
    check("the next screen says which", /Command 1/.test(bodyOf(lastCommands())), bodyOf(lastCommands()));
    done();
});

test("an empty box deletes the command, and the ones after it move up", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Start commands"), press("2. "), fill({ Command: "" }), close);

    await open(op);

    const saved = store.startCommands();
    check("one fewer", saved.length === START.defaultCommands.length - 1);
    check("the second one is gone and the third is now second", saved[1] === START.defaultCommands[2] && !saved.includes(START.defaultCommands[1]), saved.join(" | "));
    check("the next screen says it was deleted", /deleted/i.test(bodyOf(lastCommands())), bodyOf(lastCommands()));
    done();
});

test("a line that cannot be saved comes straight back, with the reason in the title and what was typed kept, and nothing changes", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const tooLong = "x".repeat(START.maxCommandChars + 1);
    script(press("Start commands"), press("Add a command"), fill({ Command: tooLong }), fill({ Command: "" }), close, close);

    await open(op);

    const boxes = ui.shown.filter((f) => f.kind === "modal");
    check("the box was shown again after a refusal", boxes.length >= 2, String(boxes.length));
    check("its title says why, with the cap", /Not saved/.test(strip(titleOf(boxes[1]))) && strip(titleOf(boxes[1])).includes(String(START.maxCommandChars)), titleOf(boxes[1]));
    check("with what was typed still in it", boxes[1].calls.find((c) => c[0] === "textField")?.[3]?.defaultValue === tooLong);
    check("an empty line is refused the same way", /Not saved/.test(strip(titleOf(boxes[2] ?? boxes[1]))));
    check("nothing was saved", store.commandsAreDefault() === true);
    done();
});

test("a full list refuses another command and says the most", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveStartCommands(Array.from({ length: START.maxCommands }, (_, i) => `say ${i}`));
    script(press("Start commands"), press("Add a command"), fill({ Command: "say one more" }), close, close);

    await open(op);

    const boxes = ui.shown.filter((f) => f.kind === "modal");
    check("refused with the most", /full/.test(strip(titleOf(boxes[1]))) && strip(titleOf(boxes[1])).includes(String(START.maxCommands)), titleOf(boxes[1] ?? boxes[0]));
    check("nothing was added", store.startCommands().length === START.maxCommands);
    done();
});

test("closing a box with Escape leaves the list exactly as it was", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Start commands"), press("1. "), close, close, close);

    await open(op);

    check("still the defaults", store.commandsAreDefault() === true && store.startCommands().join("|") === START.defaultCommands.join("|"));
    done();
});

test("putting the defaults back asks first, and only the yes does it", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveStartCommands(["say mine"]);

    script(press("Start commands"), press("Put the defaults back"), no, close, close);
    await open(op);
    check("saying no keeps their list", store.startCommands().join("|") === "say mine" && store.commandsAreDefault() === false);

    ui.shown.length = 0;
    script(press("Start commands"), press("Put the defaults back"), yes, close, close);
    await open(op);
    check("saying yes puts the defaults back", store.commandsAreDefault() === true && store.startCommands().join("|") === START.defaultCommands.join("|"));
    check("and the next screen says so", /defaults/i.test(bodyOf(lastCommands())));
    done();
});

test("a list saved empty is shown as running nothing, and can be added to", async () => {
    const { check, done } = checks();
    const { op } = scene();
    store.saveStartCommands([]);
    script(press("Start commands"), close);

    await open(op);

    const form = lastCommands();
    check("it says nothing runs", /nothing runs/i.test(bodyOf(form)), bodyOf(form));
    check("Add and Put the defaults back are there, and no numbered buttons", labels(form).join("|") === "Add a command|Put the defaults back|Back", labels(form).join(" | "));
    done();
});

test("a saved list that cannot be read says why, offers no edits, and the defaults can be put back", async () => {
    const { check, done } = checks();
    const { op } = scene();
    world.setDynamicProperty("rae:start:commands:list", "this is not a list");
    store.forgetLoaded();
    script(press("Start commands"), close);

    await open(op);

    const form = lastCommands();
    check("it says it cannot be read, and that nothing runs", /cannot be read/i.test(bodyOf(form)) && /nothing runs/i.test(bodyOf(form)), bodyOf(form));
    check("no Add and no numbered buttons: only putting the defaults back, and Back", labels(form).join("|") === "Put the defaults back|Back", labels(form).join(" | "));

    ui.shown.length = 0;
    script(press("Start commands"), press("Put the defaults back"), yes, close, close);
    await open(op);
    check("putting them back clears it", store.commandsProblem() === undefined && store.commandsAreDefault() === true);
    done();
});

test("a long command is cut short on its button, and the box still holds the whole of it", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const long = `say ${"a".repeat(150)}`;
    store.saveStartCommands([long]);
    script(press("Start commands"), press("1. "), close, close, close);

    await open(op);

    const button = labels(lastCommands())[0];
    check("the button is short and ends in ...", button.length <= 45 && button.endsWith("..."), `${button.length}: ${button}`);
    check("the box has all of it to edit", ui.shown.find((f) => f.kind === "modal").calls.find((c) => c[0] === "textField")?.[3]?.defaultValue === long);
    done();
});

test("the main screen says where the commands stand: the defaults, your own, none, or unreadable", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const summary = async () => { ui.shown.length = 0; script(close); await open(op); return bodyOf(ui.shown[0]); };

    check("never saved: the defaults", /Start commands: the defaults/.test(await summary()));

    store.saveStartCommands(["say a", "say b"]);
    check("two of your own", /Start commands: 2 of your own/.test(await summary()));

    store.saveStartCommands([]);
    check("saved empty: none, and nothing runs", /Start commands: none \(nothing runs\)/.test(await summary()));

    world.setDynamicProperty("rae:start:commands:list", "not a list");
    store.forgetLoaded();
    check("unreadable", /Start commands: cannot be read/.test(await summary()));
    done();
});

test("the commands screen tells the operator how to aim a command, and that @s cannot be used", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Start commands"), close);

    await open(op);

    check("it says so", /@a\[tag=law\]/.test(bodyOf(lastCommands())) && /@s does not work/.test(bodyOf(lastCommands())), bodyOf(lastCommands()));
    done();
});

test("a command the store cannot hold is refused at the screen with the store's reason, and the box comes back", async () => {
    const { check, done } = checks();
    const { op } = scene();

    // Eleven commands of 200 quotes are written as about 400 characters each: they fit, and one more ordinary line does not.
    const heavy = Array.from({ length: 11 }, () => `say ${'"'.repeat(START.maxCommandChars - 4)}`);
    assert.equal(store.saveStartCommands(heavy).ok, true);

    script(press("Start commands"), press("Add a command"), fill({ Command: `say ${"x".repeat(150)}` }), close, close, close);
    await open(op);

    const boxes = ui.shown.filter((f) => f.kind === "modal");
    check("the box came back with the store's reason in its title", boxes.length >= 2 && /Not saved/.test(strip(titleOf(boxes[1]))) && /characters/.test(strip(titleOf(boxes[1]))), boxes.map((b) => titleOf(b)).join(" || "));
    check("nothing was added", store.startCommands().length === 11);
    done();
});

test("the Start sequence button in the RAE menu opens the editor", async () => {
    const { check, done } = checks();
    const { op } = scene();

    script(press("Start sequence"), close, close);
    system.afterEvents.scriptEventReceive.emit({ id: "rae:menu", sourceEntity: op, message: "" });
    for (let i = 0; i < 60; i++) await Promise.resolve();

    check("the editor's first screen was shown", ui.shown.some((f) => strip(titleOf(f)) === "Start sequence" && labels(f).some((l) => l.startsWith("Start commands"))), ui.shown.map((f) => titleOf(f)).join(" || "));
    done();
});

test("the screen has no problems with the stand-in's choices", () => {
    assert.deepEqual(problems, []);
});
