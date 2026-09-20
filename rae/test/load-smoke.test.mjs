import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, system, world, load, checks, strip } from "./helpers.mjs";

// Loading main.js registers every system, exactly as the game does at world load.
await load("main.js");
const { listSystems } = await load("core/registry.js");
const { listScriptEvents } = await load("core/events.js");

// These ids are wired to command blocks in the world. They are a PUBLIC API:
// a refactor may add ids but must never rename or drop one without approval.
const PUBLIC_SCRIPT_EVENTS = [
    "bounty:escape", "bounty:fort", "bounty:lockpick", "bounty:ranch", "bounty:start_round",
    "bounty:teleport", "bounty:test_capture", "bounty:train", "rae:adopt", "rae:aim_spike", "rae:debug", "rae:probe_damage", "rae:reset",
    "rae:train_clear", "rae:train_info", "rae:train_loop", "rae:train_mark", "rae:train_show", "rae:train_spike", "rae:train_station", "rae:train_undo"
];

test("main.js loads under the fake game API and registers every system", () => {
    const { check, done } = checks();
    const systems = listSystems();
    const names = systems.map((s) => s.name);
    check("system names are unique", new Set(names).size === names.length, names.join(","));
    check("every system can reset", systems.every((s) => typeof s.reset === "function"));
    check("core systems are registered", ["roles", "jail", "jailbreak", "raids", "train", "transit", "aimprobe", "boat", "guns", "compass", "endgame"].every((n) => names.includes(n)), names.join(","));
    done();
});

test("the public script-event ids are all still registered", () => {
    const registered = listScriptEvents();
    const missing = PUBLIC_SCRIPT_EVENTS.filter((id) => !registered.includes(id));
    assert.deepEqual(missing, [], `missing public script events: ${missing.join(", ")}`);
});

test("startup announces itself and reports no errors when the scoreboards exist", () => {
    fake.reset();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.advance(1);                                   // main.ts schedules its startup message with system.run
    const chat = fake.chat.map(strip);
    assert.ok(chat.some((m) => m.includes("RAE loaded")), `chat was: ${chat.join(" | ")}`);
    assert.ok(!fake.chat.some((m) => m.includes("§c[")), `unexpected error in chat: ${fake.chat.join(" | ")}`);
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
    system.afterEvents.scriptEventReceive.emit({ id: "rae:debug", sourceEntity: undefined, message: "" });
    assert.ok(fake.chat.map(strip).some((m) => m.includes("Missing scoreboard objectives") && m.includes("coins")));
});
