import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, system, world, load, checks, strip } from "./helpers.mjs";

// Loading main.js registers every system, exactly as the game does at world load.
await load("main.js");
const { listSystems } = await load("core/registry.js");
const { listScriptEvents } = await load("core/events.js");
const { AMMO, GUNS } = await load("config/guns.js");
const { TRAIN_STRUCTURE } = await load("config/world.js");

// Everything main.ts's load hook now checks (core/preflight.ts) beyond the two scoreboards:
// every gun/ammo item id, and the train structure. Kept as a list here (not hardcoded ids) so a
// new gun in config/guns.ts does not silently break this test.
const ALL_GUN_ITEM_IDS = [...Object.values(AMMO).map((a) => a.itemId), ...Object.values(GUNS).map((g) => g.itemId)];

/** A world set up so core/preflight.ts's runPreflightChecks() finds nothing wrong. */
function fakeReadyWorld() {
    fake.reset();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.structures.add(TRAIN_STRUCTURE);
    for (const id of ALL_GUN_ITEM_IDS) fake.itemTypes.add(id);
}

// These ids are wired to command blocks in the world. They are a PUBLIC API:
// a refactor may add ids but must never rename or drop one without approval.
const PUBLIC_SCRIPT_EVENTS = [
    "bounty:escape", "bounty:fort", "bounty:lockpick", "bounty:ranch", "bounty:start_round",
    "bounty:teleport", "bounty:test_capture", "bounty:train", "rae:adopt", "rae:aim_spike", "rae:debug", "rae:menu", "rae:probe_damage", "rae:reset", "rae:robbery_probe", "rae:tumbleweed",
    "rae:train_clear", "rae:train_info", "rae:train_loop", "rae:train_mark", "rae:train_show", "rae:train_spike", "rae:train_station", "rae:train_undo"
];

test("main.js loads under the fake game API and registers every system", () => {
    const { check, done } = checks();
    const systems = listSystems();
    const names = systems.map((s) => s.name);
    check("system names are unique", new Set(names).size === names.length, names.join(","));
    check("every system can reset", systems.every((s) => typeof s.reset === "function"));
    check("core systems are registered", ["roles", "jail", "jailbreak", "raids", "train", "transit", "aimprobe", "menu", "tumbleweed", "boat", "guns", "compass", "endgame"].every((n) => names.includes(n)), names.join(","));
    done();
});

test("the public script-event ids are all still registered", () => {
    const registered = listScriptEvents();
    const missing = PUBLIC_SCRIPT_EVENTS.filter((id) => !registered.includes(id));
    assert.deepEqual(missing, [], `missing public script events: ${missing.join(", ")}`);
});

test("startup announces itself and reports no errors when the scoreboards exist", () => {
    fakeReadyWorld();

    // core/log's error() reports a failure to the console, not to world.sendMessage/fake.chat any
    // more, so "no errors" is checked there too now, alongside the (still valid) chat check.
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
        fake.advance(1);                                // main.ts schedules its startup message with system.run
    } finally {
        console.error = originalError;
    }
    const chat = fake.chat.map(strip);
    assert.ok(chat.some((m) => m.includes("RAE loaded")), `chat was: ${chat.join(" | ")}`);
    assert.ok(!fake.chat.some((m) => m.includes("§c[")), `unexpected error in chat: ${fake.chat.join(" | ")}`);
    assert.ok(errors.length === 0, `unexpected console errors: ${errors.join(" | ")}`);
});

test("rae:debug lists the registered systems", () => {
    fake.reset();
    system.afterEvents.scriptEventReceive.emit({ id: "rae:debug", sourceEntity: undefined, message: "" });
    const chat = fake.chat.map(strip).join("\n");
    assert.match(chat, /RAE DEBUG/);
    assert.match(chat, /Systems:.*compass/);
});

test("missing scoreboards are reported by name", () => {
    fake.reset();

    // verifyScoreboards() now reports through core/log's error() (console, plus an operator), not
    // world.sendMessage/fake.chat.
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
        system.afterEvents.scriptEventReceive.emit({ id: "rae:debug", sourceEntity: undefined, message: "" });
    } finally {
        console.error = originalError;
    }
    assert.ok(errors.some((m) => m.includes("Missing scoreboard objectives") && m.includes("coins")));
});
