import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, load, world } from "./helpers.mjs";

// The whole game, loaded the way a world loads it (main.js), writes the telemetry lines it should without anything else wiring them in:
// main.ts imports core/telemetry.ts and that imports the emitter. If a later change drops one of those imports, the boot line and the
// round.end lines would vanish from the real game with every other test still green. This is the test that notices.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

await load("main.js");
const round = await load("core/round.js");
const { BUILD_VERSION } = await load("config/build.js");

const TAG = "[telemetry] ";
const sent = () => lines.filter((text) => text.startsWith(`${TAG}{`)).map((text) => JSON.parse(text.slice(TAG.length)));

test("loading main.js is enough for the boot line to be written on the first tick, with the build the game reports", () => {
    assert.equal(sent().length, 0, "nothing is written while the scripts are still starting");

    fake.advance(1);

    const boots = sent().filter((e) => e.k === "boot");
    assert.equal(boots.length, 1, "one boot line");
    assert.equal(boots[0].bv, BUILD_VERSION);
    assert.equal(world.getDynamicProperty("rae:telemetry:world"), boots[0].w, "and the world's id was saved");
});

test("a round that ends in the whole game is written out as a round.end line", () => {
    const before = sent().length;

    round.startRound();
    round.beginActive();
    fake.advance(5);
    round.endRound("law_win");

    const added = sent().slice(before).filter((e) => e.k === "round.end");
    assert.equal(added.length, 1, "one round.end line");
    assert.equal(added[0].reason, "law_win");
    assert.equal(added[0].dur, 5);
});
