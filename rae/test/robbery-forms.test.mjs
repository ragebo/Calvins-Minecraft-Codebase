import { test } from "node:test";
import { fake, fakeUi, world, load, checks, strip } from "./helpers.mjs";
import { L, SITE, buildSite, ok } from "./robbery-fixtures.mjs";

// core/robberyforms.ts: every screen the builder sees. Driven by a stand-in player (below) who presses buttons by their
// label and fills forms by theirs, so a reorder of a menu does not silently break a test. The contract: what a screen
// says comes from what is saved NOW, a refusal is a sentence in chat and changes nothing, closing a form walks back one
// screen and never throws, an action that needs a click in the world closes the whole stack, and a robbery built entirely by
// clicking through these screens is a robbery that plays.

const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const F = await load("core/robberyforms.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

const ui = fakeUi.uiFake;
const problems = [];

// ---------------------------------------------------------------------------------------------------------
// A stand-in player
// ---------------------------------------------------------------------------------------------------------

const buttonsOf = (form) => form.calls.filter((c) => c[0] === "button").map((c) => String(c[1]));
const titleOf = (form) => String(form.calls.find((c) => c[0] === "title")?.[1] ?? "");

/** Presses the first button whose label contains `text`. */
const press = (text) => (form) => {
    const buttons = buttonsOf(form);
    const index = buttons.findIndex((b) => strip(b).includes(text));
    if (index < 0) {
        problems.push(`no button "${text}" on "${strip(titleOf(form))}": ${buttons.map(strip).join(" | ")}`);
        return { canceled: true, cancelationReason: "UserClosed" };
    }
    return { canceled: false, selection: index };
};

const close = () => ({ canceled: true, cancelationReason: "UserClosed" });

/** Fills a form in: `answers` maps a fragment of a control's label to its value; anything not mentioned keeps its default. */
const fill = (answers = {}) => (form) => {
    const controls = form.calls.filter((c) => ["textField", "toggle", "dropdown", "slider"].includes(c[0]));
    const used = new Set();

    const values = controls.map((control) => {
        const [kind, label] = control;
        const key = Object.keys(answers).find((k) => strip(String(label)).includes(k));
        if (key !== undefined) used.add(key);

        if (kind === "textField") return key !== undefined ? String(answers[key]) : control[3]?.defaultValue ?? "";
        if (kind === "toggle") return key !== undefined ? answers[key] : control[2]?.defaultValue ?? false;
        if (kind === "slider") return key !== undefined ? answers[key] : control[4]?.defaultValue ?? control[2];

        const items = control[2];
        if (key === undefined) return control[3]?.defaultValueIndex ?? 0;
        const wanted = answers[key];
        const exact = items.findIndex((item) => strip(String(item)) === wanted);
        const index = typeof wanted === "number" ? wanted : exact >= 0 ? exact : items.findIndex((item) => strip(String(item)).includes(wanted));
        if (index < 0) problems.push(`no choice "${wanted}" in "${strip(String(label))}": ${items.join(" | ")}`);
        return Math.max(0, index);
    });

    for (const key of Object.keys(answers)) if (!used.has(key)) problems.push(`no control matching "${key}" on "${strip(titleOf(form))}"`);

    return { canceled: false, formValues: values };
};

/** Answers a yes/no question: pressing "yes" is the second button. */
const yes = () => ({ canceled: false, selection: 1 });
const no = () => ({ canceled: false, selection: 0 });

/**
 * Queues what the stand-in does, replacing whatever an earlier script left unused, and follows it with enough closes that any
 * screen left open unwinds instead of looping.
 */
function script(...steps) {
    ui.responses.length = 0;
    ui.responses.push(...steps, ...Array.from({ length: 40 }, () => close));
}

async function settle() {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------------------

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);
    buildSite();
}

const builder = (name = "Builder", where = { x: 100, y: 65, z: 170 }) => fake.makePlayer(name, { location: { ...where }, permission: 2 });
const said = (player) => player.messages.map(strip);
const robbery = (id = "bank") => S.getRobbery(id);
const element = (name, id = "bank") => robbery(id)?.elements.find((e) => e.name === name);
const titles = () => ui.shown.map((s) => strip(titleOf(s)));
const lastSaid = (player) => said(player).at(-1) ?? "";

/** A robbery with the three bank elements bound but nothing set on them. */
function bare(player) {
    E.createRobbery(player, "bank", "Saint Diego Bank");
    E.addElementAt("bank", { kind: "switch", name: "Keypad", pos: SITE.keypad, withNeighbour: false });
    E.addElementAt("bank", { kind: "door", name: "Vault door", pos: SITE.doorLow, withNeighbour: false });
    E.addElementAt("bank", { kind: "chest", name: "Lockbox", pos: SITE.box, withNeighbour: false });
    return robbery();
}

// ---------------------------------------------------------------------------------------------------------
// Starting out
// ---------------------------------------------------------------------------------------------------------

test("with no robbery yet, the wand's menu makes the first one, selects it, and shows its menu", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");

    script(fill({ "What it is called": "Saint Diego Bank" }), close);
    await F.openMainMenu(ann);

    check("a robbery exists, named and selected", robbery("saint_diego_bank")?.name === "Saint Diego Bank" && E.selectedRobbery(ann)?.id === "saint_diego_bank");
    check("the first form was the new-robbery form", titles()[0] === "A new robbery", titles().join(" > "));
    check("then its own menu", titles()[1] === "Saint Diego Bank", titles().join(" > "));
    check("the menu said it is not ready, and why", /Not ready: it has no elements/.test(strip(ui.shown[1].calls.find((c) => c[0] === "body")?.[1] ?? "")));
    check("she was told how to go on", said(ann).some((m) => /Point the wand at a door/.test(m)), said(ann).join("|"));
    check("nothing went wrong in the stand-in", problems.length === 0, problems.join("\n"));
    done();
});

test("with robberies but none chosen, the menu asks which; an unreadable one is shown in red and only explained", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    S.saveRobbery(ok(L.newRobbery("bank", "Bank", "overworld")));
    S.saveRobbery(ok(L.newRobbery("mine", "The Mine", "overworld")));
    world.setDynamicProperty("rae:robbery:def:broken", "{ nope");
    S.forgetLoaded();

    script(press("broken"), press("The Mine"), close);
    await F.openMainMenu(ann);

    const list = buttonsOf(ui.shown[0]).map(strip);
    check("both good ones and the broken one are listed", list.some((b) => /^Bank/.test(b)) && list.some((b) => /^The Mine/.test(b)) && list.some((b) => /broken: cannot be read/.test(b)), list.join(" | "));
    check("a new robbery can be started from the list", list.some((b) => /A new robbery/.test(b)));
    check("pressing the broken one only explains, and leaves it alone", said(ann).some((m) => /broken cannot be read: .*left exactly as it is/.test(m)) && world.getDynamicProperty("rae:robbery:def:broken") === "{ nope", said(ann).join("|"));
    check("choosing the mine selects it and opens its menu", E.selectedRobbery(ann)?.id === "mine" && titles().includes("The Mine"), titles().join(" > "));
    done();
});

test("only one menu per builder at a time", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    S.saveRobbery(ok(L.newRobbery("bank", "Bank", "overworld")));

    let second;
    script((form) => { second = F.openMainMenu(ann); return close(); });
    await F.openMainMenu(ann);
    await second;

    check("the second menu said so and showed nothing", said(ann).some((m) => /Finish or close the menu you have open/.test(m)) && ui.shown.length === 1, `${ui.shown.length} forms; ${said(ann).join("|")}`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The whole bank, by clicking
// ---------------------------------------------------------------------------------------------------------

test("a robbery built entirely through the screens is the bank, and it plays", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");

    // 1. The robbery.
    script(fill({ "What it is called": "Saint Diego Bank", "A short id": "bank" }));
    await F.openNewRobbery(ann);
    check("made", robbery()?.name === "Saint Diego Bank", said(ann).join("|"));

    // 2. The keypad: a button, locked with a pick, with a line when it jams.
    script(
        fill({ "Its name": "Keypad" }),                                  // bind the button as a switch (suggested), named
        press("Locks"), press("Add a pick lock"), fill({}), press("Back"),
        press("When its lock jams"), press("Add: say something"), fill({ "What it says": "Too noisy!", "Who sees it": "Everyone in the area" }), press("Back"),
        press("Back")
    );
    await F.openAddElement(ann, "bank", SITE.keypad, "minecraft:stone_button");

    // 3. The vault door: waits on the keypad, no lock.
    script(
        fill({ "Its name": "Vault door" }),                              // the door suggested from an iron door
        press("Waits for"), fill({ "Waits for Keypad": true }),
        press("Back")
    );
    await F.openAddElement(ann, "bank", SITE.doorHigh, "minecraft:iron_door");

    // 4. The lockbox: pick + price, waits on the door, loot, and what happens when it is done.
    script(
        fill({ "Its name": "Lockbox" }),
        press("Locks"), press("Add a pick lock"), fill({}), press("Add a price"), fill({ "Price in coins": "25" }), press("Back"),
        press("Waits for"), fill({ "Waits for Vault door": true }),
        press("Loot"), fill({ "A loot table": "chests/gold_2", "Items to add": "minecraft:diamond 2" }),
        press("When it is done"),
        press("Add: pay out"), fill({ "Coins": "0", "Bounty": "250", "Who gets it": "Everyone in the area" }),
        press("Add: end the robbery"), fill({ "How it ends": "won", "Seconds to wait": "3" }),
        press("Back"),
        press("Back")
    );
    await F.openAddElement(ann, "bank", SITE.box, "minecraft:chest");

    check("nothing went wrong in the stand-in so far", problems.length === 0, problems.join("\n"));

    // 5. The area and the start and win effects, from the main menu.
    script(
        press("Area"), press("A box around where I stand"), fill({ "How far out": 20 }), press("Back"),
        press("Start, win and fail effects"), press("When it starts"), press("Add: say something"), fill({ "What it says": "Alarm! Someone is in the bank.", "Who sees it": "All law" }), press("Back"),
        press("When it is won"), press("Add: pay out"), fill({ "Coins": "100", "Bounty": "0", "Who gets it": "Everyone in the area" }), press("Back"),
        press("Back"),
        press("Close")
    );
    await F.openMainMenu(ann);

    check("nothing went wrong in the stand-in", problems.length === 0, problems.join("\n"));

    const built = robbery();
    const names = built.elements.map((e) => e.name).join();
    check("three elements", names === "Keypad,Vault door,Lockbox", names);

    const keypad = element("Keypad");
    const door = element("Vault door");
    const box = element("Lockbox");

    check("the keypad is a switch with one pick lock and a jam line", keypad.kind === "switch" && keypad.locks.length === 1 && keypad.locks[0].kind === "pick" && keypad.onFail[0]?.text === "Too noisy!", JSON.stringify(keypad));
    check("the pick lock has the defaults", keypad.locks[0].hits === R.pickHits && keypad.locks[0].strikes === R.pickStrikes);
    check("the door waits on the keypad, has no lock, and both halves", door.kind === "door" && door.req.join() === keypad.id && door.locks.length === 0 && door.cells.length === 2, JSON.stringify(door));
    check("the lockbox: pick and a 25-coin price", box.locks.map((l) => l.kind).join() === "pick,pay" && box.locks[1].coins === 25, JSON.stringify(box.locks));
    check("it waits on the door and has the loot", box.req.join() === door.id && box.table === "chests/gold_2" && JSON.stringify(box.items) === JSON.stringify([["minecraft:diamond", 2]]), JSON.stringify(box));
    check("when it is done: a bounty, then the end in 3 seconds", box.onDone.length === 2 && box.onDone[0].kind === "reward" && box.onDone[0].bounty === 250 && box.onDone[1].kind === "end" && box.onDone[1].delaySeconds === 3, JSON.stringify(box.onDone));
    check("an area around her", built.area !== undefined && built.area.min.join() === "80,60,150" && built.area.max.join() === "120,85,190", JSON.stringify(built.area));
    check("the start and win effects", built.hooks.start[0]?.to === "law" && built.hooks.win[0]?.coins === 100, JSON.stringify(built.hooks));
    check("it is ready to run", L.whyNotRunnable(built).length === 0, L.whyNotRunnable(built).join("; "));

    // 6. And it plays: a robber works the authored keypad and the authored door opens, then the lockbox pays out.
    fake.advance(1);
    const ada = fake.makePlayer("Ada", { location: { x: 100, y: 65, z: 170 } });
    state.update(ada, { role: "outlaw" });
    fake.setScore("coins", ada, 100);
    const sheriff = fake.makePlayer("Sheriff", { location: { x: 500, y: 65, z: 500 } });
    state.update(sheriff, { role: "law" });

    check("the authored robbery starts", Run.startRobbery("bank", { by: ada }).ok === true);
    check("the start effect it was given reached the law", said(sheriff).some((m) => /Alarm! Someone is in the bank/.test(m)));
    check("the keypad can be opened", Run.activateElement("bank", "Keypad", ada).ok === true);
    check("so the authored door swung open, both halves", fake.blockAt("overworld", { x: 104, y: 65, z: 170 }).permutation.getState("open_bit") === true && fake.blockAt("overworld", { x: 104, y: 66, z: 170 }).permutation.getState("open_bit") === true);
    check("the lockbox is next", Run.viewOf("bank").elements.find((e) => e.name === "Lockbox").state === "armed");
    Run.activateElement("bank", "Lockbox", ada);
    check("opening it paid the bounty", world.scoreboard.getObjective("bounty").getScore(ada) === 250);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------------------------------------

test("the element screen shows what is there, renames it, and refuses a name that clashes", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Rename"), fill({ "Its name": "Front keypad" }), press("Rename"), fill({ "Its name": "vault door" }), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    const first = ui.shown[0];
    const body = strip(first.calls.find((c) => c[0] === "body")[1]);
    check("it names the element, its kind and where it is", /Keypad \(switch, e1\)/.test(body) && /103, 66, 171/.test(body), body);
    check("a button to change each thing", ["Rename", "Locks", "Waits for", "When it is done", "Change its blocks", "Delete it", "Back"].every((b) => buttonsOf(first).map(strip).some((l) => l.includes(b))));
    check("a chest-only Loot button is not on a switch", !buttonsOf(first).map(strip).some((l) => l === "Loot"));
    check("the jam button only comes with a pick lock", !buttonsOf(first).map(strip).some((l) => /lock jams/.test(l)));

    check("renamed", element("Front keypad") !== undefined);
    check("a name that clashes was refused with the reason, and nothing changed", said(ann).some((m) => /Not changed: .*already an element called vault door/i.test(m)) && element("Front keypad") !== undefined, said(ann).join("|"));
    check("the stand-in did not stumble", problems.length === 0, problems.join("\n"));
    done();
});

test("a chest's screen offers Loot, and a pick lock brings the jam button", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);
    E.applyEdit("bank", (r) => L.updateElement(r, "e3", { locks: [{ kind: "pick", hits: 2, tolerance: 10, strikes: 3, jamSeconds: 20 }] }));

    script(press("Back"));
    await F.openElementMenu(ann, "bank", "e3");

    const labels = buttonsOf(ui.shown[0]).map(strip);
    check("Loot is there", labels.includes("Loot"), labels.join(" | "));
    check("so is the jam button, counting its effects", labels.some((l) => /When its lock jams \(0\)/.test(l)), labels.join(" | "));
    done();
});

test("deleting an element asks first; yes deletes it and says what stopped waiting; closing the question keeps it", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);
    E.applyEdit("bank", (r) => L.updateElement(r, "e2", { req: ["e1"] }));

    script(press("Delete it"), no);
    await F.openElementMenu(ann, "bank", "e1");
    check("saying no keeps it", element("Keypad") !== undefined && robbery().elements.length === 3);
    check("the question was a message form naming it", ui.shown.some((s) => s.kind === "message" && /Delete Keypad/.test(strip(String(s.calls.find((c) => c[0] === "body")?.[1] ?? "")))));

    ui.responses.length = 0;
    script(press("Delete it"), close);
    await F.openElementMenu(ann, "bank", "e1");
    check("closing the question counts as no", element("Keypad") !== undefined);

    ui.responses.length = 0;
    script(press("Delete it"), yes);
    await F.openElementMenu(ann, "bank", "e1");
    check("yes deletes it", element("Keypad") === undefined && robbery().elements.length === 2);
    check("and the door that waited on it no longer does", element("Vault door").req.length === 0);
    check("she was told", said(ann).some((m) => /Deleted Keypad; 1 thing no longer waits for it/.test(m)), said(ann).join("|"));
    done();
});

test("an element screen for an element that is deleted from under it closes quietly", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script((form) => { E.removeElementFrom("bank", "e1"); return press("Rename")(form); });
    await F.openElementMenu(ann, "bank", "e1");

    check("one form was shown and then it ended, without an error", ui.shown.length === 1 && problems.length === 0 && !said(ann).some((m) => /failed/.test(m)), `${ui.shown.length} ${said(ann).join("|")}`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Locks and requirements
// ---------------------------------------------------------------------------------------------------------

test("locks: add each kind, change one, remove one, and the add buttons go when the element has the most it can", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Locks"), press("Add a pick lock"), fill({ "Correct picks needed": 3, "Seconds a jam lasts": "45" }), press("Add a key"), fill({ "The item that opens it": "minecraft:iron_pickaxe", "Used up when it opens": false }), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    let locks = element("Keypad").locks;
    check("a pick lock with the answers, and a key", locks.length === 2 && locks[0].kind === "pick" && locks[0].hits === 3 && locks[0].jamSeconds === 45 && locks[1].kind === "key" && locks[1].item === "minecraft:iron_pickaxe" && locks[1].consume === false, JSON.stringify(locks));

    const afterTwo = ui.shown.filter((s) => strip(titleOf(s)) === "Keypad: locks").at(-1);
    check("with two locks (the most) there is no add button", !buttonsOf(afterTwo).map(strip).some((b) => /^Add a/.test(b)), buttonsOf(afterTwo).map(strip).join(" | "));
    check("each lock has a change and a remove button", buttonsOf(afterTwo).map(strip).filter((b) => /^Change:/.test(b)).length === 2 && buttonsOf(afterTwo).map(strip).filter((b) => /^Remove:/.test(b)).length === 2);

    ui.responses.length = 0;
    script(press("Locks"), press("Change: Pick lock"), fill({ "Correct picks needed": 5 }), press("Remove: Key"), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    locks = element("Keypad").locks;
    check("the pick lock was changed and the key removed", locks.length === 1 && locks[0].kind === "pick" && locks[0].hits === 5, JSON.stringify(locks));
    check("the stand-in did not stumble", problems.length === 0, problems.join("\n"));
    done();
});

test("a key lock with no item typed is refused by the validator, with a sentence, and nothing is added", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Locks"), press("Add a key"), fill({}), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    check("no lock was added", element("Keypad").locks.length === 0);
    check("she was told what an item id looks like", said(ann).some((m) => /Not changed: .*item id looks like/.test(m)), said(ann).join("|"));
    done();
});

test("a price that is not a whole number is refused where it is typed", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Locks"), press("Add a price"), fill({ "Price in coins": "twenty" }), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    check("not added", element("Keypad").locks.length === 0);
    check("told what is wanted", said(ann).some((m) => /the price must be a whole number from 1 to/i.test(m)), said(ann).join("|"));
    done();
});

test("requirements: toggles for every other element; a loop is refused naming it; nothing to wait for is explained", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Waits for"), fill({ "Waits for Vault door": true, "Waits for Lockbox": false }), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");
    check("the keypad now waits for the door", element("Keypad").req.join() === "e2");

    ui.responses.length = 0;
    script(press("Waits for"), fill({ "Waits for Keypad": true }), press("Back"));
    await F.openElementMenu(ann, "bank", "e2");
    check("making the door wait for the keypad too is a loop, and it is refused", element("Vault door").req.length === 0 && said(ann).some((m) => /go in a loop: Vault door -> Keypad -> Vault door|go in a loop/.test(m)), said(ann).join("|"));

    ui.responses.length = 0;
    E.createRobbery(ann, "solo", "Solo");
    E.addElementAt("solo", { kind: "switch", name: "Only", pos: [1, 70, 1], withNeighbour: false });
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:lever");
    E.addElementAt("solo", { kind: "switch", name: "Only", pos: [1, 70, 1], withNeighbour: false });
    script(press("Waits for"), press("Back"));
    await F.openElementMenu(ann, "solo", "e1");
    check("an only element has nothing to wait for, and says so", said(ann).some((m) => /nothing else for it to wait for/.test(m)), said(ann).join("|"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------------------

test("effects: add, change, delete through the toggle, in order, and an empty message is refused", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(
        press("When it is done"),
        press("Add: say something"), fill({ "What it says": "First", "Who sees it": "Everyone" }),
        press("Add: pay out"), fill({ "Coins": "5", "Bounty": "0" }),
        press("Add: say something"), fill({ "What it says": "" }),
        press("Back"), press("Back")
    );
    await F.openElementMenu(ann, "bank", "e1");

    let list = element("Keypad").onDone;
    check("two effects, in order", list.length === 2 && list[0].text === "First" && list[0].to === "all" && list[1].kind === "reward" && list[1].coins === 5, JSON.stringify(list));
    check("the empty message was refused and said so", said(ann).some((m) => /Not changed: .*a message is 1 to 120 characters/.test(m)), said(ann).join("|"));

    ui.responses.length = 0;
    script(press("When it is done"), press("Say \"First\""), fill({ "What it says": "Changed" }), press("Pay 5 coins"), fill({ "Delete this effect": true }), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    list = element("Keypad").onDone;
    check("the first was changed and the second deleted", list.length === 1 && list[0].text === "Changed", JSON.stringify(list));
    check("the stand-in did not stumble", problems.length === 0, problems.join("\n"));
    done();
});

test("the add buttons go when a list has the most effects", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);
    const many = Array.from({ length: R.maxEffectsPerList }, (_, i) => ({ kind: "say", text: `n${i}`, channel: "chat", to: "all" }));
    E.applyEdit("bank", (r) => L.updateElement(r, "e1", { onDone: many }));

    script(press("When it is done"), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");

    const labels = buttonsOf(ui.shown.find((s) => /when it is done/.test(strip(titleOf(s))))).map(strip);
    check("one button per effect and no Add buttons", labels.filter((l) => /^Say /.test(l)).length === R.maxEffectsPerList && !labels.some((l) => /^Add:/.test(l)), labels.join(" | "));
    done();
});

test("the effects of the whole robbery: start, win and fail", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(
        press("Start, win and fail effects"),
        press("When it fails"), press("Add: end the robbery"), fill({ "How it ends": "fails" }), press("Back"),
        press("Back"), press("Close")
    );
    await F.openMainMenu(ann);

    const effects = robbery().hooks.fail;
    check("a fail effect", effects.length === 1 && effects[0].kind === "end" && effects[0].result === "fail", JSON.stringify(effects));
    check("the other two are untouched", robbery().hooks.start.length === 0 && robbery().hooks.win.length === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Loot, settings, area
// ---------------------------------------------------------------------------------------------------------

test("loot: a table and items are saved; bad item text is refused; a table the game does not have is warned about; blank clears it", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Loot"), fill({ "A loot table": "chests/gold_2", "Items to add": "minecraft:diamond 2, minecraft:emerald" }), press("Back"));
    await F.openElementMenu(ann, "bank", "e3");
    check("saved", element("Lockbox").table === "chests/gold_2" && JSON.stringify(element("Lockbox").items) === JSON.stringify([["minecraft:diamond", 2], ["minecraft:emerald", 1]]), JSON.stringify(element("Lockbox")));
    check("a table that exists got no warning", !said(ann).some((m) => /no loot table/.test(m)));

    ui.responses.length = 0;
    script(press("Loot"), fill({ "Items to add": "minecraft:diamond lots" }), press("Back"));
    await F.openElementMenu(ann, "bank", "e3");
    check("bad item text: told, and the loot is unchanged", said(ann).some((m) => /amount for minecraft:diamond/.test(m)) && element("Lockbox").items.length === 2);

    ui.responses.length = 0;
    script(press("Loot"), fill({ "A loot table": "chests/not_a_table" }), press("Back"));
    await F.openElementMenu(ann, "bank", "e3");
    check("an unknown table is saved but warned about", element("Lockbox").table === "chests/not_a_table" && said(ann).some((m) => /no loot table called chests\/not_a_table/.test(m)), said(ann).join("|"));

    ui.responses.length = 0;
    script(press("Loot"), fill({ "A loot table": "", "Items to add": "" }), press("Back"));
    await F.openElementMenu(ann, "bank", "e3");
    check("blank clears both", element("Lockbox").table === undefined && element("Lockbox").items.length === 0, JSON.stringify(element("Lockbox")));
    done();
});

test("settings: changed through the form; a bad number is refused where it is typed", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Settings"), fill({ "Seconds before it can be robbed again": "30", "Only during a round": true, "Its blocks cannot be broken": false }), press("Close"));
    await F.openMainMenu(ann);

    check("saved", robbery().settings.cooldownSeconds === 30 && robbery().settings.roundOnly === true && robbery().settings.protect === false, JSON.stringify(robbery().settings));
    check("untouched ones kept", robbery().settings.autoStart === true && robbery().settings.timeLimitSeconds === R.defaultTimeLimitSeconds);

    ui.responses.length = 0;
    script(press("Settings"), fill({ "Time limit in seconds": "soon" }), press("Close"));
    await F.openMainMenu(ann);
    check("a bad number is refused and nothing changed", said(ann).some((m) => /the time limit must be a whole number/i.test(m)) && robbery().settings.timeLimitSeconds === R.defaultTimeLimitSeconds);
    done();
});

test("area: a box around where she stands, clearing it, and clicking two corners closes every menu and waits for the clicks", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann", { x: 100.5, y: 65, z: 170.5 });
    bare(ann);

    script(press("Area"), press("A box around where I stand"), fill({ "How far out": 10 }), press("Back"), press("Close"));
    await F.openMainMenu(ann);
    check("a box of that radius, from 5 below to the radius above", JSON.stringify(robbery().area) === JSON.stringify({ min: [90, 60, 160], max: [110, 75, 180] }), JSON.stringify(robbery().area));

    ui.responses.length = 0;
    script(press("Area"), press("Clear it"), press("Back"), press("Close"));
    await F.openMainMenu(ann);
    check("cleared", robbery().area === undefined);

    ui.responses.length = 0;
    ui.shown.length = 0;
    script(press("Area"), press("Set it by clicking two corners"));
    await F.openMainMenu(ann);
    check("the menus closed (area screen, then the main menu does not come back)", titles().join(" > ") === "Saint Diego Bank > Saint Diego Bank: area", titles().join(" > "));
    check("it waits for a corner click", E.pendingFor(ann)?.kind === "corner" && E.pendingFor(ann).robbery === "bank");
    check("she was told what to click", said(ann).some((m) => /Click the first corner/.test(m)));
    done();
});

test("changing an element's blocks: a click is asked for and the menus close; a door cannot take another block", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Change its blocks"), press("Move it"));
    await F.openElementMenu(ann, "bank", "e1");
    check("waiting for a rebind click that replaces", E.pendingFor(ann)?.kind === "rebind" && E.pendingFor(ann).mode === "replace" && E.pendingFor(ann).element === "e1");
    check("the stack closed", titles().join(" > ") === "Keypad > Keypad: blocks", titles().join(" > "));

    E.clearPending(ann);
    ui.responses.length = 0;
    script(press("Change its blocks"), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e1");
    const blocksFor = (id) => buttonsOf(ui.shown.filter((s) => /: blocks$/.test(strip(titleOf(s)))).at(-1)).map(strip);
    check("a switch can take another block", blocksFor("e1").some((b) => /Add another block/.test(b)), blocksFor("e1").join(" | "));

    ui.responses.length = 0;
    ui.shown.length = 0;
    script(press("Change its blocks"), press("Back"), press("Back"));
    await F.openElementMenu(ann, "bank", "e2");
    check("a door cannot", !blocksFor("e2").some((b) => /Add another block/.test(b)), blocksFor("e2").join(" | "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Running it, undo, delete, and what happens around a menu
// ---------------------------------------------------------------------------------------------------------

test("run controls: it will not start until it is finished, then starts, stops, and puts the site back", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Run it"), press("Start it now"), press("Back"), press("Close"));
    await F.openMainMenu(ann);
    check("not finished: refused with why", said(ann).some((m) => /Not changed: it is not finished: .*End: win|nothing ends it/.test(m)), said(ann).join("|"));
    check("nothing running", Run.runningIds().length === 0);

    E.applyEdit("bank", (r) => L.setHook(r, "win", [{ kind: "end", result: "win" }]));
    E.applyEdit("bank", (r) => L.setArea(r, [82, 60, 159], [108, 80, 179]));
    E.applyEdit("bank", (r) => L.updateElement(r, "e3", { table: "chests/gold_2" }));
    script(press("Run it"), press("Start a test run"), press("Back"), press("Close"));
    await F.openMainMenu(ann);
    check("a test run started", Run.runningIds().join() === "bank" && said(ann).some((m) => /Test run started/.test(m)), said(ann).join("|"));

    ui.responses.length = 0;
    script(press("Run it"), press("Stop it"), press("Put the site back now"), press("Back"), press("Close"));
    await F.openMainMenu(ann);
    check("stopped", Run.runningIds().length === 0 && said(ann).some((m) => /Stopped/.test(m)));
    check("and the site was put back", said(ann).some((m) => /Put back \d+ blocks?/.test(m)), said(ann).join("|"));
    done();
});

test("undo appears after a change, and brings the old robbery back", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Rename"), fill({ "Its name": "Better Bank" }), press("Undo the last change"), press("Close"));
    await F.openMainMenu(ann);

    check("the rename was undone", robbery().name === "Saint Diego Bank", robbery().name);
    check("it said so", said(ann).some((m) => /Undone/.test(m)));
    check("the first menu already offered undo (the bare setup was edits)", buttonsOf(ui.shown[0]).map(strip).some((b) => /Undo the last change/.test(b)));
    done();
});

test("deleting a robbery asks first, shuts its doors, removes it, and unselects it", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);
    Run.activateElement("bank", "Keypad");
    E.applyEdit("bank", (r) => L.setHook(r, "win", [{ kind: "end", result: "win" }]));
    E.applyEdit("bank", (r) => L.setArea(r, [82, 60, 159], [108, 80, 179]));

    script(press("Delete this robbery"), no, press("Close"));
    await F.openMainMenu(ann);
    check("no keeps it", robbery() !== undefined);

    ui.responses.length = 0;
    script(press("Delete this robbery"), yes);
    await F.openMainMenu(ann);

    check("yes deletes it", robbery() === undefined && said(ann).some((m) => /Deleted Saint Diego Bank/.test(m)), said(ann).join("|"));
    check("and she has nothing selected", E.selectedId(ann) === undefined);
    done();
});

test("closing a form at any point only walks back; a builder who leaves mid-menu ends it without an error", async () => {
    setup();
    const { check, done } = checks();
    const ann = builder("Ann");
    bare(ann);

    script(press("Locks"), close);
    await F.openElementMenu(ann, "bank", "e1");
    check("closing the locks screen returned to the element screen, which closed on the next close", titles().join(" > ") === "Keypad > Keypad: locks > Keypad", titles().join(" > "));
    check("no error", !said(ann).some((m) => /failed/.test(m)) && problems.length === 0);

    ui.responses.length = 0;
    ui.shown.length = 0;
    script((form) => { ann.remove(); return press("Rename")(form); });
    await F.openElementMenu(ann, "bank", "e1");
    check("a builder who left stopped it after one form", ui.shown.length === 1, String(ui.shown.length));
    done();
});
