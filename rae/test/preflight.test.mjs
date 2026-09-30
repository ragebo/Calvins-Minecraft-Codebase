import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, load, checks } from "./helpers.mjs";

// core/preflight.ts: the real preflight system. It replaces core/economy.ts's old lone
// verifyScoreboards() call at load with checks for the two scoreboards, the train structure,
// every gun/ammo item id (config/guns.ts), and every hardcoded coordinate (config/world.ts),
// reported through ONE combined core/log.ts error() call. See rae/src/main.ts's load hook.

const { checkCoordinateBounds, runPreflightChecks } = await load("core/preflight.js");
const { AMMO, GUNS } = await load("config/guns.js");
const { TRAIN_STRUCTURE, OVERWORLD_Y_BOUNDS } = await load("config/world.js");

// Read from config/guns.ts itself, not hardcoded: the gun roster has grown before and will again.
const ALL_ITEM_IDS = [...Object.values(AMMO).map((a) => a.itemId), ...Object.values(GUNS).map((g) => g.itemId)];

// fake.itemTypes is not cleared by fake.reset() (it models what item types the world's data
// defines, not round state), so fresh() below rebuilds it from this captured default every time
// instead of only ever adding to it -- otherwise an id one test needs absent could already be
// there, left behind by an earlier test in this file.
const DEFAULT_ITEM_TYPES = [...fake.itemTypes];

const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.error = realError; });

/**
 * A world where runPreflightChecks() finds nothing wrong, unless told to leave something out.
 * `scoreboards` lists which of the two objectives to create; `structure` toggles TRAIN_STRUCTURE;
 * `missingItemIds` lists which of config/guns.ts's ids to leave unregistered.
 */
function fresh({ scoreboards = ["coins", "bounty"], structure = true, missingItemIds = [] } = {}) {
    fake.reset();
    errors.length = 0;

    for (const id of scoreboards) fake.addObjective(id);
    if (structure) fake.structures.add(TRAIN_STRUCTURE);

    fake.itemTypes.clear();
    for (const id of DEFAULT_ITEM_TYPES) fake.itemTypes.add(id);
    for (const id of ALL_ITEM_IDS) {
        if (!missingItemIds.includes(id)) fake.itemTypes.add(id);
    }
}

// ---------------------------------------------------------------------------------------------
// runPreflightChecks()
// ---------------------------------------------------------------------------------------------

test("everything present: ok, no problems, and nothing logged (this also proves today's real config/world.ts coordinates all pass)", () => {
    const { check, done } = checks();
    fresh();

    const result = runPreflightChecks();

    check("ok is true", result.ok === true, JSON.stringify(result));
    check("no problems", result.problems.length === 0, JSON.stringify(result.problems));
    check("nothing logged", errors.length === 0, JSON.stringify(errors));
    done();
});

test("a missing scoreboard objective is the only problem reported", () => {
    const { check, done } = checks();
    fresh({ scoreboards: ["coins"] }); // bounty missing

    const result = runPreflightChecks();

    check("not ok", result.ok === false);
    check("exactly one problem", result.problems.length === 1, JSON.stringify(result.problems));
    check("names the missing objective", result.problems[0]?.includes("bounty"), result.problems[0]);
    check("logs exactly once", errors.length === 1, JSON.stringify(errors));
    done();
});

test("a missing structure is the only problem reported", () => {
    const { check, done } = checks();
    fresh({ structure: false });

    const result = runPreflightChecks();

    check("not ok", result.ok === false);
    check("exactly one problem", result.problems.length === 1, JSON.stringify(result.problems));
    check("names the structure", result.problems[0]?.includes(TRAIN_STRUCTURE), result.problems[0]);
    check("logs exactly once", errors.length === 1, JSON.stringify(errors));
    done();
});

test("a missing item identifier is the only problem reported", () => {
    const { check, done } = checks();
    const missingId = ALL_ITEM_IDS[0];
    fresh({ missingItemIds: [missingId] });

    const result = runPreflightChecks();

    check("not ok", result.ok === false);
    check("exactly one problem", result.problems.length === 1, JSON.stringify(result.problems));
    check("names the missing item", result.problems[0]?.includes(missingId), result.problems[0]);
    check("logs exactly once", errors.length === 1, JSON.stringify(errors));
    done();
});

test("several simultaneous problems are still reported through exactly ONE error() call, naming all of them", () => {
    const { check, done } = checks();
    const missingId = ALL_ITEM_IDS[ALL_ITEM_IDS.length - 1];
    fresh({ scoreboards: [], structure: false, missingItemIds: [missingId] });

    const result = runPreflightChecks();

    check("not ok", result.ok === false);
    // Three problems, one per category: both missing objectives are named in a single combined
    // scoreboard problem, alongside the structure problem and the item problem.
    check("every category's problem is present", result.problems.length === 3, JSON.stringify(result.problems));
    check("names coins and bounty", result.problems.some((p) => p.includes("coins") && p.includes("bounty")), JSON.stringify(result.problems));
    check("names the structure", result.problems.some((p) => p.includes(TRAIN_STRUCTURE)), JSON.stringify(result.problems));
    check("names the item", result.problems.some((p) => p.includes(missingId)), JSON.stringify(result.problems));
    check("exactly one console.error call, not one per problem", errors.length === 1, JSON.stringify(errors));
    check("that one call mentions every problem", result.problems.every((p) => errors[0].includes(p)), errors[0]);
    done();
});

// ---------------------------------------------------------------------------------------------
// checkCoordinateBounds() -- pure, so synthetic points only; the real config is never touched.
// ---------------------------------------------------------------------------------------------

test("checkCoordinateBounds: a point with finite axes and Y inside the build limit is not reported", () => {
    const problems = checkCoordinateBounds([{ label: "fine", at: { x: 10, y: 64, z: -30 } }]);
    assert.deepEqual(problems, []);
});

test("checkCoordinateBounds: an empty list reports nothing", () => {
    assert.deepEqual(checkCoordinateBounds([]), []);
});

test("checkCoordinateBounds: NaN or Infinity on any single axis is reported as not finite, and skips the Y-bounds check", () => {
    const { check, done } = checks();
    const cases = [
        { x: NaN, y: 64, z: 0 },
        { x: 0, y: Infinity, z: 0 },
        { x: 0, y: 64, z: -Infinity },
        { x: 0, y: NaN, z: 0 }
    ];
    for (const at of cases) {
        const problems = checkCoordinateBounds([{ label: "bad", at }]);
        check(`${JSON.stringify(at)} is reported once, as not finite`, problems.length === 1 && /not finite/.test(problems[0]), JSON.stringify(problems));
    }
    done();
});

test("checkCoordinateBounds: Y outside the Overworld build limit is reported; the limits themselves are inside it", () => {
    const { check, done } = checks();

    const below = checkCoordinateBounds([{ label: "too low", at: { x: 0, y: OVERWORLD_Y_BOUNDS.min - 1, z: 0 } }]);
    check("below min is reported", below.length === 1 && /build limit/.test(below[0]), JSON.stringify(below));

    const above = checkCoordinateBounds([{ label: "too high", at: { x: 0, y: OVERWORLD_Y_BOUNDS.max + 1, z: 0 } }]);
    check("above max is reported", above.length === 1 && /build limit/.test(above[0]), JSON.stringify(above));

    const atLimits = checkCoordinateBounds([
        { label: "at min", at: { x: 0, y: OVERWORLD_Y_BOUNDS.min, z: 0 } },
        { label: "at max", at: { x: 0, y: OVERWORLD_Y_BOUNDS.max, z: 0 } }
    ]);
    check("min and max themselves are inclusive, so not reported", atLimits.length === 0, JSON.stringify(atLimits));

    done();
});

test("checkCoordinateBounds: a huge but finite X or Z is not a Y-bounds problem (only Y has a build limit)", () => {
    const problems = checkCoordinateBounds([{ label: "far away", at: { x: 5_000_000, y: 64, z: -5_000_000 } }]);
    assert.deepEqual(problems, []);
});

test("checkCoordinateBounds: every point is checked and labeled independently, good and bad mixed in one call", () => {
    const problems = checkCoordinateBounds([
        { label: "good", at: { x: 0, y: 0, z: 0 } },
        { label: "too high", at: { x: 0, y: OVERWORLD_Y_BOUNDS.max + 100, z: 0 } },
        { label: "not finite", at: { x: NaN, y: 0, z: 0 } }
    ]);
    assert.equal(problems.length, 2, JSON.stringify(problems));
    assert.ok(problems.some((p) => p.startsWith("too high:")), JSON.stringify(problems));
    assert.ok(problems.some((p) => p.startsWith("not finite:")), JSON.stringify(problems));
});
