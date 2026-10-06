import { test } from "node:test";
import assert from "node:assert/strict";
import { world, load } from "./helpers.mjs";

// The probe exists to find out what the game offers, so an event the engine does not have must be a finding in the
// log, never an exception while the scripts load: that would take the whole addon down with it. This file loads the
// probe against a world where one event does not exist and one refuses to be subscribed to. It is its own file
// because a module is loaded once per test process.

const logs = [];
const realWarn = console.warn;
console.warn = (...args) => logs.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const realAfterEvents = world.afterEvents;
Object.defineProperty(world, "afterEvents", {
    configurable: true,
    value: new Proxy(realAfterEvents, {
        get(target, name) {
            if (name === "blockContainerOpened") throw new TypeError("no such event in this engine");
            if (name === "leverAction") return { subscribe() { throw new Error("refused: restricted-execution"); } };
            return target[name];
        }
    })
});

test("a missing or refused event is logged as a finding and the rest still load", async () => {
    await assert.doesNotReject(() => load("systems/robberyprobe.js"));

    const lines = logs.filter((l) => l.startsWith("[robbery-probe]")).join("\n");
    assert.match(lines, /RESULT subscribe afterEvents\.blockContainerOpened = THREW TypeError: no such event in this engine/);
    assert.match(lines, /RESULT subscribe afterEvents\.leverAction = THREW Error: refused: restricted-execution/);

    // The other subscriptions went through: a later one still records.
    const { system, fake } = await import("./helpers.mjs");
    const { resetAllSystems } = await load("core/registry.js");
    resetAllSystems();
    fake.reset();
    const player = fake.makePlayer("Ada", { permission: 2 });
    system.afterEvents.scriptEventReceive.emit({ id: "rae:robbery_probe", sourceEntity: player, message: "log on" });
    realAfterEvents.buttonPush.emit({ block: { typeId: "minecraft:stone_button", location: { x: 1, y: 64, z: 1 }, dimension: { id: "minecraft:overworld" } }, source: player });
    assert.match(logs.join("\n"), /buttonPush minecraft:stone_button at 1,64,1/);
});
