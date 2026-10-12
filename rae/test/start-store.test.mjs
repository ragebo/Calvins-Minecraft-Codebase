import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks } from "./helpers.mjs";

// core/startstore.ts (through core/recordstore.ts): where the start sequence's authored parts live: the camera shots, one world property
// each, and the operator's list of start commands, one. The contract is the one every authored thing here has: written at once, an edit
// that does not fit is refused before anything changes, an unreadable save is listed and never overwritten, and a reload finds it all again.
// What is particular to the commands: a list never saved means the defaults, a list saved empty means "run nothing", and a list that cannot
// be read also runs nothing (a damaged list must never quietly become the defaults, which empty bags and zero coins).

const store = await load("core/startstore.js");
const L = await load("logic/start.js");
const { START } = await load("config/balance.js");

const SHOT_PREFIX = "rae:start:shot:";
const COMMANDS_PROPERTY = "rae:start:commands:list";

function fresh() {
    fake.reset();
    store.forgetLoaded();
}

const mark = (x, z = 0) => ({ x, y: 70, z, pitch: 0, yaw: 0 });

const shot = (id, name = id) => {
    const made = L.makeShot(id, name, mark(1), mark(20, 5));
    assert.ok(made.ok, made.reason);
    return made.value;
};

const save = (s) => {
    const result = store.saveShot(s);
    assert.equal(result.ok, true, result.reason);
    return result.value;
};

// ---------------------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------------------

test("an empty world has no shots and the default commands, and says they are the defaults", () => {
    fresh();
    const { check, done } = checks();

    check("no shots", store.allShots().length === 0 && store.listStoredShots().length === 0);
    check("none by id", store.getShot("s1") === undefined);
    check("the commands are the defaults", store.startCommands().join("|") === START.defaultCommands.join("|"));
    check("and they say so", store.commandsAreDefault() === true && store.commandsProblem() === undefined);

    const given = store.startCommands();
    given.push("tell @a hello");
    check("the list handed out is a copy: changing it leaves the config alone", START.defaultCommands.length === 7 && store.startCommands().length === 7);
    done();
});

test("a saved shot is written to the world at once, and a reload finds exactly what was saved", () => {
    fresh();
    const { check, done } = checks();

    const first = save(shot("s1", "Bridge"));

    check("a world property under the shot's own name holds its saved text", world.getDynamicProperty(`${SHOT_PREFIX}s1`) === L.serializeShot(first));

    store.forgetLoaded();

    check("after a reload it is listed and readable", store.allShots().length === 1 && store.getShot("s1")?.name === "Bridge");
    check("with the marks it went in with", JSON.stringify(store.getShot("s1")?.end) === JSON.stringify(first.end));
    done();
});

test("shots come back in the order they were made, not in the order of their text (s2 before s10)", () => {
    fresh();

    save(shot("s10"));
    save(shot("s2"));
    save(shot("s1"));

    assert.equal(store.allShots().map((s) => s.id).join(), "s1,s2,s10");
});

test("deleting a shot removes its property, and undo brings it back", () => {
    fresh();
    const { check, done } = checks();

    save(shot("s1"));

    const removed = store.deleteShot("s1");
    check("it is deleted", removed.ok === true && store.getShot("s1") === undefined && world.getDynamicProperty(`${SHOT_PREFIX}s1`) === undefined);
    check("undo is on offer", store.shotUndoAvailable("s1") === true);

    const undone = store.undoShot("s1");
    check("undo brings it back", undone.ok === true && store.getShot("s1") !== undefined && typeof world.getDynamicProperty(`${SHOT_PREFIX}s1`) === "string");
    check("deleting one that is not there says so", store.deleteShot("nope").ok === false);
    done();
});

test("a thirteenth shot is refused with the cap, changes nothing, and an existing one can still be edited", () => {
    fresh();
    const { check, done } = checks();

    for (let i = 1; i <= START.maxShots; i++) save(shot(`s${i}`));

    const over = store.saveShot(shot(`s${START.maxShots + 1}`));
    check("refused, and says the cap", over.ok === false && over.reason.includes(String(START.maxShots)), JSON.stringify(over));
    check("nothing was written", store.allShots().length === START.maxShots && world.getDynamicProperty(`${SHOT_PREFIX}s${START.maxShots + 1}`) === undefined);

    const renamed = store.saveShot(shot("s1", "Renamed"));
    check("an existing one can be renamed at the cap", renamed.ok === true && store.getShot("s1")?.name === "Renamed");
    done();
});

test("the longest shot the rules allow still fits a save, so the cap can only ever be a safety net", () => {
    fresh();

    // A name of 40 control characters is written as 6 characters each, and the marks sit at the very edge of the world.
    const edge = { x: -29999999.99, y: -63.99, z: -29999999.99, pitch: -89.99, yaw: -179.99 };
    const made = L.makeShot("s123456789012345", "\u0001".repeat(START.maxNameChars), edge, edge);

    assert.ok(made.ok, made.reason);
    assert.ok(L.serializeShot(made.value).length <= START.maxShotChars, `${L.serializeShot(made.value).length} characters against a cap of ${START.maxShotChars}`);
    assert.equal(store.saveShot(made.value).ok, true);
});

test("a damaged shot is listed with its problem, left out of the pool, and never written over", () => {
    fresh();
    const { check, done } = checks();

    save(shot("s1"));
    world.setDynamicProperty(`${SHOT_PREFIX}s3`, "this is not a shot");
    store.forgetLoaded();

    const stored = store.listStoredShots();
    const damaged = stored.find((s) => s.id === "s3");

    check("both are listed", stored.length === 2);
    check("the damaged one says why", damaged?.ok === false && damaged.problem.length > 0, JSON.stringify(damaged));
    check("the pool has only the good one", store.allShots().map((s) => s.id).join() === "s1");

    const over = store.saveShot(shot("s3"));
    check("saving over it is refused and leaves its text alone", over.ok === false && world.getDynamicProperty(`${SHOT_PREFIX}s3`) === "this is not a shot", JSON.stringify(over));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

test("a saved command list is written at once, replaces the defaults, and survives a reload", () => {
    fresh();
    const { check, done } = checks();

    const result = store.saveStartCommands(["gamemode adventure @a", "say go"]);

    check("it saved", result.ok === true, JSON.stringify(result));
    check("a world property holds it", world.getDynamicProperty(COMMANDS_PROPERTY) === L.serializeCommands(["gamemode adventure @a", "say go"]));
    check("the commands are the saved ones, not the defaults", store.startCommands().join("|") === "gamemode adventure @a|say go" && store.commandsAreDefault() === false);
    check("a list that reads fine has no problem to report", store.commandsProblem() === undefined);

    store.forgetLoaded();
    check("after a reload too", store.startCommands().join("|") === "gamemode adventure @a|say go");

    const given = store.startCommands();
    given.push("say changed behind the store's back");
    check("the list handed out is a copy of the saved one too", store.startCommands().join("|") === "gamemode adventure @a|say go");
    done();
});

test("a list saved empty means run nothing, which is not the same as never saved", () => {
    fresh();
    const { check, done } = checks();

    check("saved empty", store.saveStartCommands([]).ok === true);
    check("it runs nothing", store.startCommands().length === 0);
    check("and it is not the defaults", store.commandsAreDefault() === false);

    store.forgetLoaded();
    check("after a reload it is still empty", store.startCommands().length === 0 && store.commandsAreDefault() === false);
    done();
});

test("resetting puts the defaults back by removing the saved list, and is fine when nothing was saved", () => {
    fresh();
    const { check, done } = checks();

    check("with nothing saved it succeeds and changes nothing", store.resetStartCommands().ok === true && store.commandsAreDefault() === true);

    store.saveStartCommands(["say hello"]);
    const reset = store.resetStartCommands();

    check("after a save it succeeds", reset.ok === true);
    check("the property is gone", world.getDynamicProperty(COMMANDS_PROPERTY) === undefined);
    check("the defaults are back", store.commandsAreDefault() === true && store.startCommands().join("|") === START.defaultCommands.join("|"));
    done();
});

test("a full list of the longest plain commands fits a save", () => {
    fresh();

    const longest = Array.from({ length: START.maxCommands }, (_, i) => `say ${String(i).padStart(2, "0")}${"x".repeat(START.maxCommandChars - 6)}`);

    assert.ok(longest.every((c) => c.length === START.maxCommandChars));
    assert.equal(store.saveStartCommands(longest).ok, true);
    assert.equal(store.startCommands().length, START.maxCommands);
});

test("a command list too long for a save (every quote is written as two characters) is refused and the old one stays", () => {
    fresh();
    const { check, done } = checks();

    store.saveStartCommands(["say keep"]);

    const heavy = Array.from({ length: START.maxCommands }, () => `say ${'"'.repeat(START.maxCommandChars - 4)}`);
    const result = store.saveStartCommands(heavy);

    check("refused with the reason", result.ok === false && /characters/.test(result.reason), JSON.stringify(result));
    check("the old list is still the list", store.startCommands().join("|") === "say keep");
    check("and still what is in the world", world.getDynamicProperty(COMMANDS_PROPERTY) === L.serializeCommands(["say keep"]));
    done();
});

test("a list that cannot be read runs nothing, says why, is not overwritten by a save, and a reset clears it", () => {
    fresh();
    const { check, done } = checks();

    world.setDynamicProperty(COMMANDS_PROPERTY, "this is not a list");
    store.forgetLoaded();

    check("it runs nothing: never the defaults", store.startCommands().length === 0);
    check("it says it cannot be read, and why", typeof store.commandsProblem() === "string" && store.commandsProblem().length > 0, String(store.commandsProblem()));
    check("it is not the defaults", store.commandsAreDefault() === false);

    const save = store.saveStartCommands(["say hello"]);
    check("a save over it is refused and leaves its text alone", save.ok === false && world.getDynamicProperty(COMMANDS_PROPERTY) === "this is not a list", JSON.stringify(save));

    check("a reset clears it", store.resetStartCommands().ok === true && world.getDynamicProperty(COMMANDS_PROPERTY) === undefined);
    check("and the defaults come back", store.commandsAreDefault() === true && store.commandsProblem() === undefined && store.startCommands().length === 7);
    done();
});

test("the shots and the command list do not see each other's properties", () => {
    fresh();

    save(shot("s1"));
    store.saveStartCommands(["say hello"]);
    store.forgetLoaded();

    assert.equal(store.allShots().length, 1);
    assert.equal(store.listStoredShots().length, 1);
    assert.equal(store.startCommands().join("|"), "say hello");
});
