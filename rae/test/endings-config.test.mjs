import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fake, world, load, checks } from "./helpers.mjs";

// tasks/endings, Task 9: the boat's four live-config fields are gone (the boat is an ending now, edited on the Endings screens), nothing but the seed reads
// the old constants, and the startup check looks at every ending's places instead, naming the ending.

const configoverrides = await load("core/configoverrides.js");
const preflight = await load("core/preflight.js");
const store = await load("core/endingstore.js");
const L = await load("logic/endings.js");
const { AMMO, GUNS } = await load("config/guns.js");
const { TRAIN_STRUCTURE, OVERWORLD_Y_BOUNDS } = await load("config/world.js");

const SRC = path.resolve(import.meta.dirname, "../src");

function sources(dir = SRC) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));
}

const DEFAULT_ITEM_TYPES = [...fake.itemTypes];

const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.error = realError; });

/** A world where the startup check finds nothing wrong, and no ending has been saved. */
function fresh() {
    fake.reset();
    store.forgetEndings();
    errors.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.structures.add(TRAIN_STRUCTURE);
    fake.itemTypes.clear();
    for (const id of DEFAULT_ITEM_TYPES) fake.itemTypes.add(id);
    for (const ammo of Object.values(AMMO)) fake.itemTypes.add(ammo.itemId);
    for (const gun of Object.values(GUNS)) fake.itemTypes.add(gun.itemId);
}

function save(kind, id, place, patch = {}) {
    const made = L.newEnding(kind, id, id[0].toUpperCase() + id.slice(1), place);
    assert.ok(made.ok, made.reason);
    const edited = L.edit(made.value, patch);
    assert.ok(edited.ok, edited.reason);
    assert.equal(store.saveEnding(edited.value).ok, true);
}

test("the boat's four fields are not in the live config editor any more", () => {
    const { check, done } = checks();
    const ids = configoverrides.listFields().map((field) => field.id);

    for (const gone of ["world.boatNpc", "world.boatWinTeleport", "economy.boatEscapePerOutlaw", "boat.escapeRadius"]) {
        check(`${gone} is gone`, !ids.includes(gone) && configoverrides.getField(gone) === undefined);
    }

    check("so is the Boat Escape group", !configoverrides.listCategories().includes("Boat Escape"), configoverrides.listCategories().join(", "));
    check("the rest of the editor is still there", ids.includes("world.trainVaultChest") && ids.includes("economy.villagerRewardMin"));
    done();
});

test("nothing but the boat's seed reads the old boat constants", () => {
    const { check, done } = checks();
    const OLD = /\bBOAT_NPC\b|\bBOAT_WIN_TELEPORT\b|\bboatEscapePerOutlaw\b|\bBOAT\.escapeRadius\b/;
    const readers = sources()
        .filter((file) => !file.includes(`${path.sep}config${path.sep}`))
        .filter((file) => OLD.test(readFileSync(file, "utf8")))
        .map((file) => path.relative(SRC, file).split(path.sep).join("/"));

    check("only core/endingstore.ts, which builds the default boat from them", readers.join(",") === "core/endingstore.ts", readers.join(", "));
    done();
});

test("the startup check is clean with the default boat and with ordinary endings", () => {
    const { check, done } = checks();
    fresh();
    check("the default boat", preflight.runPreflightChecks().ok === true, preflight.runPreflightChecks().problems.join(" | "));

    save("solo", "tower", { x: 100, y: 70, z: 100 }, { winSpot: { x: 0, y: 80, z: 0 } });
    check("an ending of your own", preflight.runPreflightChecks().ok === true, preflight.runPreflightChecks().problems.join(" | "));
    done();
});

test("an ending whose place or win spot is outside the world is reported by its name", () => {
    const { check, done } = checks();
    fresh();
    save("solo", "tower", { x: 100, y: OVERWORLD_Y_BOUNDS.max + 50, z: 100 }, { winSpot: { x: 0, y: OVERWORLD_Y_BOUNDS.min - 10, z: 0 } });

    const result = preflight.runPreflightChecks();
    const text = result.problems.join(" | ");

    check("not ok", result.ok === false, text);
    check("the place is named with its ending", /Ending Tower \(place\): y=/.test(text), text);
    check("the win spot is named with its ending", /Ending Tower \(win spot\): y=/.test(text), text);
    check("it was reported through the log once", errors.length === 1 && /Ending Tower \(place\)/.test(errors[0]), errors.join(" | "));
    done();
});

test("a switched-off ending is checked too, and an ending that cannot be read is reported with what to do", () => {
    const { check, done } = checks();
    fresh();
    save("group", "dock", { x: 0, y: OVERWORLD_Y_BOUNDS.max + 1, z: 0 }, { enabled: false });
    world.setDynamicProperty("rae:ending:bad", "{nope");

    store.forgetEndings();
    const text = preflight.runPreflightChecks().problems.join(" | ");

    check("the switched-off one is still named", /Ending Dock \(place\)/.test(text), text);
    check("the damaged one is named, with why and what to do", /Ending bad cannot be read \(.+\): delete it from the Endings screen/.test(text), text);
    done();
});
