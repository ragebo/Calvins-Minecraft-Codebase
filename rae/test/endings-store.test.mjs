import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks } from "./helpers.mjs";

// core/endingstore.ts (tasks/endings, Task 2): where the endings live. They are records an operator saves in game, on the same record store the shops
// and the start sequence's shots use. A world that has never saved one has the boat ending, made from the old boat config; the first save makes it a
// real record, and from then on the config is no longer read for it. Deleting every ending leaves none, and stays that way after a reload.

const store = await load("core/endingstore.js");
const L = await load("logic/endings.js");
const { BOAT, ECONOMY, ENDINGS } = await load("config/balance.js");
const { BOAT_NPC, BOAT_WIN_TELEPORT } = await load("config/world.js");

const PLACE = { x: 100.5, y: 64, z: -20.5 };

function fresh() {
    fake.reset();
    store.forgetEndings();
}

const group = (id, name = id) => {
    const made = L.newEnding("group", id, name, PLACE);
    assert.ok(made.ok, made.reason);
    return made.value;
};

const save = (ending) => {
    const result = store.saveEnding(ending);
    assert.equal(result.ok, true, result.reason);
    return result.value;
};

const savedKeys = () => world.getDynamicPropertyIds().filter((id) => id.startsWith("rae:ending:")).sort();

test("a world that never saved an ending has the boat, made from the old boat config, and nothing is written to the world to say so", () => {
    fresh();
    const { check, done } = checks();
    const all = store.allEndings();
    const boat = all[0];

    check("exactly one ending", all.length === 1 && store.listEndings().length === 1, String(all.length));
    check("it is the boat, a group ending, on", boat?.id === "boat" && boat.kind === "group" && boat.enabled === true && boat.name === "Escape boat");
    check("its place is the boat NPC", boat?.place.x === BOAT_NPC.x && boat.place.y === BOAT_NPC.y && boat.place.z === BOAT_NPC.z, JSON.stringify(boat?.place));
    check("its radius is the gather radius", boat?.radius === BOAT.escapeRadius);
    check("its price is the old per-outlaw price", boat?.price === ECONOMY.boatEscapePerOutlaw);
    check("its win spot is the old win teleport", boat?.winSpot?.x === BOAT_WIN_TELEPORT.x && boat.winSpot.y === BOAT_WIN_TELEPORT.y && boat.winSpot.z === BOAT_WIN_TELEPORT.z, JSON.stringify(boat?.winSpot));
    check("its words are the boat's own", JSON.stringify(boat?.texts) === JSON.stringify(ENDINGS.texts.boat));
    check("it is valid", boat !== undefined && L.whyNotUsable(boat) === undefined);
    check("found by id", store.getEnding("boat")?.id === "boat" && store.getEnding("nothing") === undefined);
    check("it says the defaults are in use", store.endingsAreDefault() === true);
    check("reading it wrote nothing", savedKeys().length === 0, savedKeys().join());
    done();
});

test("until the first save the boat follows the old config, so the live editor still works on it", () => {
    fresh();
    const { check, done } = checks();
    const x = BOAT_NPC.x;
    const radius = BOAT.escapeRadius;
    const price = ECONOMY.boatEscapePerOutlaw;

    try {
        BOAT_NPC.x = x + 7;
        BOAT.escapeRadius = 30;
        ECONOMY.boatEscapePerOutlaw = 400;
        const boat = store.getEnding("boat");
        check("the place follows", boat.place.x === x + 7);
        check("the radius follows", boat.radius === 30);
        check("the price follows", boat.price === 400);
    } finally {
        BOAT_NPC.x = x; BOAT.escapeRadius = radius; ECONOMY.boatEscapePerOutlaw = price;
    }
    done();
});

test("the first save makes the boat a real record, and from then on the config is not read for it", () => {
    fresh();
    const { check, done } = checks();
    const x = BOAT_NPC.x;

    save(group("pier"));
    check("two endings now: the boat and the pier", store.allEndings().map((e) => e.id).join() === "boat,pier", store.allEndings().map((e) => e.id).join());
    check("both are saved in the world", savedKeys().join() === "rae:ending:boat,rae:ending:pier", savedKeys().join());
    check("the defaults are no longer in use", store.endingsAreDefault() === false);

    try {
        BOAT_NPC.x = x + 50;
        check("the saved boat does not follow the config", store.getEnding("boat").place.x === x);
    } finally { BOAT_NPC.x = x; }

    store.forgetEndings();
    check("a reload finds both", store.allEndings().map((e) => e.id).join() === "boat,pier");
    done();
});

test("editing the boat saves the edit, and one undo brings back what it was", () => {
    fresh();
    const { check, done } = checks();
    const boat = store.getEnding("boat");
    const edited = L.edit(boat, { price: 999, name: "Ferry" });
    assert.ok(edited.ok);

    save(edited.value);
    check("the edit is what is read", store.getEnding("boat").price === 999 && store.getEnding("boat").name === "Ferry");
    check("an undo is offered", store.undoAvailable("boat") === true);

    const undone = store.undoEnding("boat");
    check("undo works", undone.ok === true, JSON.stringify(undone));
    check("the boat is as it was, from the config", store.getEnding("boat").price === ECONOMY.boatEscapePerOutlaw && store.getEnding("boat").name === "Escape boat");
    done();
});

test("deleting the boat deletes it for good: it stays gone after a reload, and undo brings it back", () => {
    fresh();
    const { check, done } = checks();

    const removed = store.removeEnding("boat");
    check("it is removed", removed.ok === true, JSON.stringify(removed));
    check("no endings are left", store.allEndings().length === 0 && store.listEndings().length === 0);
    check("the defaults are not in use", store.endingsAreDefault() === false);

    const back = store.undoEnding("boat");
    check("undo is offered and brings it back, in the same session", store.undoAvailable("boat") === true || back.ok === true);
    check("the boat is back", back.ok === true && store.getEnding("boat")?.price === ECONOMY.boatEscapePerOutlaw, JSON.stringify(back));

    store.removeEnding("boat");
    store.forgetEndings();
    check("after a reload it is still gone: the default is not offered again", store.allEndings().length === 0 && store.getEnding("boat") === undefined);
    done();
});

test("deleting an ending that is not there says so", () => {
    fresh();
    const { check, done } = checks();
    const result = store.removeEnding("nothing");
    check("refused with a reason", result.ok === false && typeof result.reason === "string");
    check("and the boat is still the default", store.endingsAreDefault() === true && savedKeys().length === 0, savedKeys().join());
    done();
});

test("an ending that is saved but cannot be read is listed with why, never replaced by the default, and never overwritten", () => {
    fresh();
    const { check, done } = checks();
    world.setDynamicProperty("rae:ending:broken", "{this is not an ending");
    store.forgetEndings();

    const listed = store.listEndings();
    check("it is listed", listed.length === 1 && listed[0].id === "broken" && listed[0].ok === false, JSON.stringify(listed));
    check("with a reason", listed[0].ok === false && listed[0].problem.length > 0);
    check("no readable endings", store.allEndings().length === 0);
    check("the boat default is NOT offered beside a damaged save", store.getEnding("boat") === undefined && store.endingsAreDefault() === false);

    const over = store.saveEnding(group("broken"));
    check("saving over it is refused", over.ok === false && /cannot be read/.test(over.reason), JSON.stringify(over));
    check("what was there is untouched", world.getDynamicProperty("rae:ending:broken") === "{this is not an ending");
    done();
});

test("at most twelve endings, and the thirteenth is refused with a reason", () => {
    fresh();
    const { check, done } = checks();

    for (let n = 1; n <= ENDINGS.maxEndings - 1; n++) save(group(`end${n}`));
    check("twelve in all with the boat", store.allEndings().length === ENDINGS.maxEndings, String(store.allEndings().length));

    const over = store.saveEnding(group("one_too_many"));
    check("the next is refused", over.ok === false && /12/.test(over.reason), JSON.stringify(over));
    check("nothing changed", store.allEndings().length === ENDINGS.maxEndings && store.getEnding("one_too_many") === undefined);

    const edit = L.edit(store.getEnding("end1"), { price: 5 });
    check("an existing one can still be edited at the cap", edit.ok && store.saveEnding(edit.value).ok === true);
    done();
});

test("ids made from names avoid every id in use, the default boat and a damaged one included", () => {
    fresh();
    const { check, done } = checks();

    check("a name that matches the default boat is numbered", store.newEndingId("Boat") === "boat_2", store.newEndingId("Boat"));
    check("a free name is plain", store.newEndingId("Lighthouse") === "lighthouse");

    save(group("lighthouse"));
    check("a saved one is avoided", store.newEndingId("Lighthouse") === "lighthouse_2");

    world.setDynamicProperty("rae:ending:wreck", "garbage");
    store.forgetEndings();
    check("a damaged one is avoided too", store.newEndingId("Wreck") === "wreck_2");
    done();
});

test("the version moves when anything is saved, deleted or undone, so what was built from the list knows it is stale", () => {
    fresh();
    const { check, done } = checks();
    const v0 = store.endingsVersion();

    save(group("pier"));
    const v1 = store.endingsVersion();
    store.removeEnding("pier");
    const v2 = store.endingsVersion();

    check("a save moves it", v1 > v0, `${v0} ${v1}`);
    check("a delete moves it", v2 > v1, `${v1} ${v2}`);
    done();
});

// The game can refuse a write or a read; neither may lose an ending or invent one.
function refusing(property, which, body) {
    const real = world[which];
    world[which] = (id, ...rest) => {
        if (id === property) throw new Error("the game refused");
        return real.call(world, id, ...rest);
    };
    try { return body(); } finally { world[which] = real; }
}

test("when the game will not say whether the endings were saved, a world with none saved still has the boat", () => {
    fresh();
    const { check, done } = checks();
    refusing("rae:endings-seeded", "getDynamicProperty", () => {
        check("the default is used", store.endingsAreDefault() === true && store.allEndings().length === 1);
    });
    done();
});

test("when the game will not take the note that the endings were saved, the save still happens", () => {
    fresh();
    const { check, done } = checks();
    refusing("rae:endings-seeded", "setDynamicProperty", () => {
        const result = store.saveEnding(group("pier"));
        check("the ending is saved", result.ok === true, JSON.stringify(result));
        check("and is there beside the boat", store.allEndings().map((e) => e.id).join() === "boat,pier");
    });
    done();
});

test("when the boat cannot be made a real record, the save that needed it fails and nothing else is saved", () => {
    fresh();
    const { check, done } = checks();
    refusing("rae:ending:boat", "setDynamicProperty", () => {
        const result = store.saveEnding(group("pier"));
        check("the save is refused, with the game's reason", result.ok === false && /refused/.test(result.reason), JSON.stringify(result));
        check("the other ending was not saved", store.getEnding("pier") === undefined && savedKeys().length === 0, savedKeys().join());
        check("and the defaults are still in use", store.endingsAreDefault() === true);
    });
    done();
});
