import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks } from "./helpers.mjs";

// core/jailstore.ts: where the jails live. One world property each on core/recordstore.ts. A world that has never saved one has the two the old config named
// (config/world.ts's JAIL_SITES); the first save makes both real. There is always a jail on: the last one that is on cannot be deleted or switched off. A block
// is one jail's button and never another's, and the click handler finds a jail by its button through an index that is rebuilt when a jail is saved.

const store = await load("core/jailstore.js");
const L = await load("logic/jails.js");
const { JAIL_SITES } = await load("config/world.js");
const { JAILS } = await load("config/balance.js");
const state = await load("core/state.js");

const realWarn = console.warn;
const said = [];
console.warn = (...args) => said.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const at = (n, y = 70) => ({ x: n, y, z: 5 });

function fresh() {
    fake.reset();
    store.forgetJails();
    said.length = 0;
}

/** A jail built the way the screens do, saved. */
function add(name, patch = {}) {
    const first = L.newJail(store.newJailId(name), name, { x: 1.5, y: 64, z: 2.5 });
    assert.ok(first.ok, first.reason);
    const edited = L.edit(first.value, patch);
    assert.ok(edited.ok, edited.reason);
    const saved = store.saveJail(edited.value);
    assert.ok(saved.ok, saved.reason);
    return edited.value;
}

const ids = () => store.listJails().map((entry) => entry.id).join(",");
const edited = (jail, patch) => { const r = L.edit(jail, patch); assert.ok(r.ok, r.reason); return r.value; };

test("a world that has saved nothing has the config's two jails, in the config's order, with their doors and no buttons", () => {
    const { check, done } = checks();
    fresh();

    const jails = store.allJails();

    check("two, named jail_1 and jail_2", ids() === "jail_1,jail_2", ids());
    check("named Jail 1 and Jail 2, on", jails[0].name === "Jail 1" && jails[1].name === "Jail 2" && jails.every((jail) => jail.enabled));
    check("each at the config's spot and door", jails.every((jail, i) => L.samePlace(jail.jail, JAIL_SITES[i].jail) && L.samePlace(jail.doorTrigger, JAIL_SITES[i].doorTrigger)));
    check("no buttons", jails.every((jail) => jail.buttons.length === 0));
    check("it says it is the default", store.jailsAreDefault() === true);
    check("nothing was written just by looking", world.getDynamicPropertyIds().length === 0, world.getDynamicPropertyIds().join(","));
    check("both are usable", store.usableJails().length === 2);
    done();
});

test("while the jails are the default, the live config still moves them", () => {
    const { check, done } = checks();
    fresh();
    const x = JAIL_SITES[0].jail.x;

    try {
        JAIL_SITES[0].jail.x = x + 7;
        check("the default follows the config", store.getJail("jail_1").jail.x === x + 7);
    } finally {
        JAIL_SITES[0].jail.x = x;
    }
    done();
});

test("the first save of anything makes both default jails real records, and from then on the config is not read for them", () => {
    const { check, done } = checks();
    fresh();
    const x = JAIL_SITES[0].jail.x;

    store.saveJail(edited(store.getJail("jail_1"), { name: "Town jail" }));

    check("both are saved as properties", world.getDynamicProperty("rae:jail:jail_1") !== undefined && world.getDynamicProperty("rae:jail:jail_2") !== undefined);
    check("the marker is set, and it is not one of the jails", world.getDynamicProperty("rae:jails-seeded") === true && ids() === "jail_1,jail_2", ids());
    check("the default is over", store.jailsAreDefault() === false);
    check("the edit is what is read", store.getJail("jail_1").name === "Town jail");

    try {
        JAIL_SITES[0].jail.x = x + 50;
        check("a config change no longer reaches the saved jail", store.getJail("jail_1").jail.x === x);
    } finally {
        JAIL_SITES[0].jail.x = x;
    }

    store.forgetJails();
    check("and it is still that way after a reload", ids() === "jail_1,jail_2" && store.getJail("jail_1").name === "Town jail" && store.jailsAreDefault() === false);
    done();
});

test("a jail can be added with an id made from its name, up to the most there may be, and the one after that is refused", () => {
    const { check, done } = checks();
    fresh();

    const town = add("Town Jail");
    check("a legal id from the name", town.id === "town_jail" && store.getJail("town_jail") !== undefined);
    check("the same name again is numbered", add("Town Jail").id === "town_jail_2");

    while (store.listJails().length < JAILS.maxJails) add(`Extra ${store.listJails().length}`);
    check(`${JAILS.maxJails} jails`, store.listJails().length === JAILS.maxJails);

    const over = L.newJail("one_too_many", "One too many", at(1));
    const result = store.saveJail(over.value);
    check("one more is refused, with the reason", result.ok === false && /too many|at most|room/i.test(result.reason), JSON.stringify(result));
    done();
});

test("there is always a jail on: the last one that is on cannot be switched off or deleted", () => {
    const { check, done } = checks();
    fresh();

    check("one can be switched off", store.saveJail(edited(store.getJail("jail_2"), { enabled: false })).ok === true);
    const last = store.saveJail(edited(store.getJail("jail_1"), { enabled: false }));
    check("the last one that is on cannot", last.ok === false && /at least one jail has to stay on/.test(last.reason), JSON.stringify(last));
    check("it stayed on", store.getJail("jail_1").enabled === true);

    const gone = store.removeJail("jail_1");
    check("nor can it be deleted", gone.ok === false && /at least one jail has to stay on/.test(gone.reason), JSON.stringify(gone));
    check("a jail that is off can be deleted", store.removeJail("jail_2").ok === true && ids() === "jail_1");
    check("and a jail that is on can be switched off once another is on", (() => { add("Other"); return store.saveJail(edited(store.getJail("jail_1"), { enabled: false })).ok; })());
    done();
});

test("undo cannot leave no jail on either", () => {
    const { check, done } = checks();
    fresh();

    store.saveJail(edited(store.getJail("jail_2"), { enabled: false }));
    store.saveJail(edited(store.getJail("jail_2"), { enabled: true }));       // its undo is now "off"
    check("(setup) jail_1 can go while jail_2 is on", store.removeJail("jail_1").ok === true);

    const undone = store.undoJail("jail_2");
    check("undoing jail_2 to off would leave none on, so it is refused", undone.ok === false && /no jail on/.test(undone.reason), JSON.stringify(undone));
    check("and jail_2 is still on", store.getJail("jail_2").enabled === true);
    done();
});

test("deleting is asked of a world that has saved nothing only for the jails it has, and does not make them real by being refused", () => {
    const { check, done } = checks();
    fresh();

    const refused = store.removeJail("nowhere");
    check("a jail that is not there", refused.ok === false && /there is no jail nowhere/.test(refused.reason));
    check("nothing was written", store.jailsAreDefault() === true && world.getDynamicPropertyIds().length === 0);

    check("a default jail can be deleted (the other stays)", store.removeJail("jail_1").ok === true && ids() === "jail_2");
    store.forgetJails();
    check("and that stays deleted after a reload", ids() === "jail_2");
    done();
});

test("a delete can be undone, and an edit can be undone", () => {
    const { check, done } = checks();
    fresh();

    store.removeJail("jail_1");
    check("(setup) gone", store.getJail("jail_1") === undefined && store.undoAvailable("jail_1"));
    check("undo brings it back", store.undoJail("jail_1").ok === true && store.getJail("jail_1")?.name === "Jail 1");

    store.saveJail(edited(store.getJail("jail_2"), { name: "Renamed" }));
    store.undoJail("jail_2");
    check("an edit is undone", store.getJail("jail_2").name === "Jail 2");
    done();
});

test("a jail that cannot be read is listed, never offered the defaults in its place, and never overwritten", () => {
    const { check, done } = checks();
    fresh();
    world.setDynamicProperty("rae:jail:broken", "{this is not a jail");
    store.forgetJails();

    const listed = store.listJails();
    check("it is listed as damaged", listed.length === 1 && listed[0].ok === false && listed[0].id === "broken", JSON.stringify(listed));
    check("the config's jails are not offered in its place", store.jailsAreDefault() === false);
    check("it is not offered as a readable jail", store.allJails().length === 0);
    check("a new jail named like it gets another id, so the damaged one is left alone", store.newJailId("Broken") === "broken_2");
    check("every capture still has a jail: the config's two", store.usableJails().length === 2 && said.some((line) => /no jail is on and readable/.test(line)), said.join(" | "));

    add("Fixed");
    check("the damaged text is untouched", world.getDynamicProperty("rae:jail:broken") === "{this is not a jail");
    check("and it can be deleted", store.removeJail("broken").ok === true && world.getDynamicProperty("rae:jail:broken") === undefined);
    done();
});

test("a seed that cannot finish takes back what it made, so a world is never left with half of the defaults", () => {
    const { check, done } = checks();
    fresh();
    const real = world.setDynamicProperty;

    world.setDynamicProperty = (key, value) => {
        if (key === "rae:jail:jail_2") throw new Error("the game said no");
        return real.call(world, key, value);
    };

    let result;

    try {
        result = store.saveJail(edited(store.getJail("jail_1"), { name: "Will not save" }));
    } finally {
        world.setDynamicProperty = real;
    }

    check("the save was refused", result.ok === false, JSON.stringify(result));
    check("jail_1 was taken back out", world.getDynamicProperty("rae:jail:jail_1") === undefined);
    check("nothing is marked as saved: it is still the default", store.jailsAreDefault() === true && ids() === "jail_1,jail_2");
    check("and no 'undo' or 'bring back' is left behind that could recreate half of the defaults", !store.undoAvailable("jail_1") && !store.undoAvailable("jail_2"));
    done();
});

test("a block is one jail's button only: not another's button, and not another's door", () => {
    const { check, done } = checks();
    fresh();
    store.saveJail(edited(store.getJail("jail_1"), { buttons: [at(1)] }));

    const second = store.getJail("jail_2");
    const dupe = store.saveJail(edited(second, { buttons: [at(1)] }));
    check("a button of another jail is refused, naming it", dupe.ok === false && /already a button of Jail 1/.test(dupe.reason), JSON.stringify(dupe));

    const door = store.saveJail(edited(second, { buttons: [JAIL_SITES[0].doorTrigger] }));
    check("another jail's door trigger is refused as a button", door.ok === false && /door trigger of Jail 1/.test(door.reason), JSON.stringify(door));

    const asDoor = store.saveJail(edited(second, { doorTrigger: at(1) }));
    check("another jail's button is refused as a door trigger", asDoor.ok === false && /is a button of Jail 1/.test(asDoor.reason), JSON.stringify(asDoor));

    check("a block of its own is fine", store.saveJail(edited(second, { buttons: [at(2)] })).ok === true);
    check("and the first jail can keep its own", store.getJail("jail_1").buttons.length === 1);
    done();
});

test("the jail of a clicked block is found by its button, in the overworld, once the world has saved jails (whether the jail is on is decided when the button is pressed)", () => {
    const { check, done } = checks();
    fresh();

    check("a world with no saved jail has no buttons", store.jailAtButton("overworld", 1, 70, 5) === undefined);

    store.saveJail(edited(store.getJail("jail_1"), { buttons: [at(1), at(2)] }));

    check("a bound block finds its jail", store.jailAtButton("overworld", 1, 70, 5)?.id === "jail_1" && store.jailAtButton("overworld", 2, 70, 5)?.id === "jail_1");
    check("with the namespace too", store.jailAtButton("minecraft:overworld", 1, 70, 5)?.id === "jail_1");
    check("another block finds nothing", store.jailAtButton("overworld", 3, 70, 5) === undefined && store.jailAtButton("overworld", 1, 71, 5) === undefined);
    check("another dimension finds nothing", store.jailAtButton("nether", 1, 70, 5) === undefined && store.jailAtButton("minecraft:the_end", 1, 70, 5) === undefined);

    store.saveJail(edited(store.getJail("jail_1"), { buttons: [at(2)] }));
    check("a button taken away stops being one (the index was rebuilt)", store.jailAtButton("overworld", 1, 70, 5) === undefined && store.jailAtButton("overworld", 2, 70, 5)?.id === "jail_1");

    store.saveJail(edited(store.getJail("jail_2"), { buttons: [at(9)] }));
    store.saveJail(edited(store.getJail("jail_1"), { enabled: false }));
    check("a jail that is off is still found by its button: a jail switched off while it holds prisoners has to keep working", store.jailAtButton("overworld", 2, 70, 5)?.id === "jail_1" && store.jailAtButton("overworld", 9, 70, 5)?.id === "jail_2");

    store.removeJail("jail_1");
    store.undoJail("jail_1");
    check("an undone delete is found again", store.jailAtButton("overworld", 9, 70, 5)?.id === "jail_2");
    done();
});

test("jailUses says which jail a block is the door trigger or a button of, whatever its state", () => {
    const { check, done } = checks();
    fresh();
    store.saveJail(edited(store.getJail("jail_2"), { buttons: [at(4)] }));

    check("a door trigger", store.jailUses(JAIL_SITES[0].doorTrigger.x, JAIL_SITES[0].doorTrigger.y, JAIL_SITES[0].doorTrigger.z)?.id === "jail_1");
    check("a button", store.jailUses(4, 70, 5)?.id === "jail_2");
    check("neither", store.jailUses(99, 99, 99) === undefined);
    done();
});

test("seeding the defaults is not an edit: a jail nobody touched has nothing to undo, and the one that was edited undoes to its default", () => {
    const { check, done } = checks();
    fresh();

    store.saveJail(edited(store.getJail("jail_1"), { name: "Town jail" }));

    check("the untouched jail has no 'undo my last change' (which would delete it)", store.undoAvailable("jail_2") === false);
    check("the edited jail does, and it goes back to the default", store.undoAvailable("jail_1") && store.undoJail("jail_1").ok && store.getJail("jail_1").name === "Jail 1");
    check("both jails are still there", ids() === "jail_1,jail_2");
    done();
});

test("an undo cannot put back a block another jail has used since", () => {
    const { check, done } = checks();
    fresh();

    store.saveJail(edited(store.getJail("jail_1"), { buttons: [at(1)] }));
    store.saveJail(edited(store.getJail("jail_1"), { buttons: [] }));       // its undo is now "with the button"
    store.saveJail(edited(store.getJail("jail_2"), { buttons: [at(1)] }));  // jail_2 takes the block

    const undone = store.undoJail("jail_1");

    check("the undo is refused, naming the clash", undone.ok === false && /clash/.test(undone.reason) && /already a button of Jail 2/.test(undone.reason), JSON.stringify(undone));
    check("jail_1 is as it was and jail_2 keeps the block", store.getJail("jail_1").buttons.length === 0 && store.getJail("jail_2").buttons.length === 1);
    check("(and the refused undo can be tried again once the block is free)", (() => { store.saveJail(edited(store.getJail("jail_2"), { buttons: [] })); return store.undoJail("jail_1").ok && store.getJail("jail_1").buttons.length === 1; })());
    done();
});

test("a world whose every jail is damaged can still be cleaned up: a damaged jail can always be deleted, and so can one that is switched off", () => {
    const { check, done } = checks();
    fresh();
    world.setDynamicProperty("rae:jail:broken", "{nope");
    store.forgetJails();

    check("(setup) no jail is on and readable", store.allJails().length === 0);
    check("the damaged one can be deleted", store.removeJail("broken").ok === true);
    check("and a world with nothing saved is the default again: the config's two, and a capture has them", store.jailsAreDefault() === true && ids() === "jail_1,jail_2" && store.usableJails().length === 2);

    fresh();
    store.saveJail(edited(store.getJail("jail_2"), { enabled: false }));
    check("a switched-off jail can be deleted while another is on", store.removeJail("jail_2").ok === true);
    check("and a switched-off jail can be renamed", (() => { fresh(); store.saveJail(edited(store.getJail("jail_2"), { enabled: false })); return store.saveJail(edited(store.getJail("jail_2"), { name: "Quiet" })).ok; })());
    done();
});

test("a jail that holds prisoners cannot be deleted, by the id the active site carries or by its spot when the site carries none", () => {
    const { check, done } = checks();
    fresh();
    const bob = fake.makePlayer("Bob", { tags: ["outlaw"] });
    fake.advance(1);
    state.update(bob, { inJail: true });

    const first = store.getJail("jail_1");
    state.setJailSite({ id: "jail_1", jail: first.jail });
    check("held by id: refused, with the way out", store.removeJail("jail_1").ok === false && /prisoners are held there now/.test(store.removeJail("jail_1").reason));
    check("holdsPrisoners says so, and only for that jail", store.holdsPrisoners("jail_1") === true && store.holdsPrisoners("jail_2") === false);
    check("another jail can be deleted", store.removeJail("jail_2").ok === true);

    fresh();
    const again = fake.makePlayer("Bob", { tags: ["outlaw"] });
    fake.advance(1);
    state.update(again, { inJail: true });
    state.setJailSite({ jail: store.getJail("jail_2").jail });
    check("a site with no id is matched by its spot", store.holdsPrisoners("jail_2") === true && store.holdsPrisoners("jail_1") === false && store.removeJail("jail_2").ok === false);

    state.update(again, { inJail: false });
    check("with nobody jailed it holds nothing, and can be deleted", store.holdsPrisoners("jail_2") === false && store.removeJail("jail_2").ok === true);
    done();
});

test("a door trigger the live config editor left in the middle of a block is saved as the block it is in, so the first save of the defaults is not refused", () => {
    const { check, done } = checks();
    fresh();
    const door = JAIL_SITES[0].doorTrigger;
    const keep = { ...door };

    try {
        JAIL_SITES[0].doorTrigger = { x: keep.x + 0.5, y: keep.y, z: keep.z + 0.5 };
        const saved = store.saveJail(edited(store.getJail("jail_2"), { name: "Quiet" }));

        check("the save went through", saved.ok === true, JSON.stringify(saved));
        check("the door is the block that number is in", store.getJail("jail_1").doorTrigger.x === keep.x && store.getJail("jail_1").doorTrigger.z === keep.z, JSON.stringify(store.getJail("jail_1").doorTrigger));
    } finally {
        JAIL_SITES[0].doorTrigger = keep;
    }
    done();
});
