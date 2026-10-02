import { test } from "node:test";
import { fake, world, fakeApi, load, checks } from "./helpers.mjs";

// core/configoverrides.ts: a curated registry of GUNS/BALANCE/WORLD leaf fields that can be changed while
// the game is running, mutating the exact object every other system already reads (never replacing it) and
// persisting the change through core/persist.ts. Tests run in their own process per file (node --test's
// default), so mutating the real config/guns.js etc. here cannot leak into another test file — but tests in
// THIS file share one process, so every mutating test resets the field it touches back to its registered
// default BEFORE asserting anything, never relying on what an earlier test in this file left behind.

const { PlayerPermissionLevel } = fakeApi;
const configoverrides = await load("core/configoverrides.js");
const persist = await load("core/persist.js");
const { GUNS } = await load("config/guns.js");
const { BOAT_NPC, OVERWORLD_Y_BOUNDS } = await load("config/world.js");
const { RANCH } = await load("config/balance.js");

function scene() {
    fake.reset();
    world.setDynamicProperty("rae:persist:config-overrides", undefined);
}

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
const member = () => fake.makePlayer("Member", { permission: PlayerPermissionLevel.Member });

/** Known-clean starting point for a field: reset it (as an operator) before a test touches it, so the test
 *  never depends on execution order within this file. */
function clean(id) {
    configoverrides.resetOverride(operator(), id);
}

// ---------------------------------------------------------------------------
// In-place mutation: the load-bearing behavior everything else depends on
// ---------------------------------------------------------------------------

test("setOverride mutates the real GUNS object in place, not a copy", () => {
    scene();
    clean("revolver.fireRateTicks");
    const before = GUNS.revolver.fireRateTicks;

    const result = configoverrides.setOverride(operator(), "revolver.fireRateTicks", 3);

    const { check, done } = checks();
    check("setOverride reports ok", result.ok === true, JSON.stringify(result));
    check("the real config object changed", GUNS.revolver.fireRateTicks === 3, String(GUNS.revolver.fireRateTicks));
    done();

    configoverrides.resetOverride(operator(), "revolver.fireRateTicks");
    if (GUNS.revolver.fireRateTicks !== before) throw new Error("cleanup failed to restore revolver.fireRateTicks");
});

test("a vector3 field's set keeps the same object identity, only x/y/z change", () => {
    scene();
    clean("world.boatNpc");
    const before = { ...BOAT_NPC };

    const result = configoverrides.setOverride(operator(), "world.boatNpc", { x: 1, y: 65, z: 2 });

    const { check, done } = checks();
    check("setOverride reports ok", result.ok === true, JSON.stringify(result));
    check("BOAT_NPC itself was mutated (same export, new coordinates)", BOAT_NPC.x === 1 && BOAT_NPC.y === 65 && BOAT_NPC.z === 2, JSON.stringify(BOAT_NPC));
    done();

    configoverrides.resetOverride(operator(), "world.boatNpc");
    if (BOAT_NPC.x !== before.x || BOAT_NPC.y !== before.y || BOAT_NPC.z !== before.z) {
        throw new Error("cleanup failed to restore world.boatNpc");
    }
});

// ---------------------------------------------------------------------------
// Validation: bad input is refused, loudly, and changes nothing
// ---------------------------------------------------------------------------

test("validation rejects a non-finite or wrong-type number, value unchanged", () => {
    scene();
    clean("revolver.fireRateTicks");
    const before = GUNS.revolver.fireRateTicks;

    const notFinite = configoverrides.setOverride(operator(), "revolver.fireRateTicks", Infinity);
    const wrongType = configoverrides.setOverride(operator(), "revolver.fireRateTicks", "5");

    const { check, done } = checks();
    check("Infinity is refused", notFinite.ok === false, JSON.stringify(notFinite));
    check("a string is refused", wrongType.ok === false, JSON.stringify(wrongType));
    check("the value never changed", GUNS.revolver.fireRateTicks === before, String(GUNS.revolver.fireRateTicks));
    done();
});

test("validation rejects a non-integer for an integer-kind field", () => {
    scene();
    clean("revolver.magazineSize");
    const before = GUNS.revolver.magazineSize;

    const result = configoverrides.setOverride(operator(), "revolver.magazineSize", 6.5);

    const { check, done } = checks();
    check("refused", result.ok === false, JSON.stringify(result));
    check("reason mentions a whole number", /whole number/.test(result.reason ?? ""), JSON.stringify(result));
    check("unchanged", GUNS.revolver.magazineSize === before);
    done();
});

test("validation enforces a field's declared min/max", () => {
    scene();
    clean("ranch.wave2Threshold");
    const before = RANCH.wave2Threshold;

    const tooLow = configoverrides.setOverride(operator(), "ranch.wave2Threshold", -0.1);
    const tooHigh = configoverrides.setOverride(operator(), "ranch.wave2Threshold", 1.5);
    const ok = configoverrides.setOverride(operator(), "ranch.wave2Threshold", 0.5);

    const { check, done } = checks();
    check("below min refused", tooLow.ok === false, JSON.stringify(tooLow));
    check("above max refused", tooHigh.ok === false, JSON.stringify(tooHigh));
    check("in range accepted", ok.ok === true, JSON.stringify(ok));
    check("value is exactly what was set", RANCH.wave2Threshold === 0.5, String(RANCH.wave2Threshold));
    done();

    configoverrides.resetOverride(operator(), "ranch.wave2Threshold");
    if (RANCH.wave2Threshold !== before) throw new Error("cleanup failed to restore ranch.wave2Threshold");
});

test("validation rejects a coordinate outside the Overworld build limit, reusing preflight's own check", () => {
    scene();
    clean("world.boatNpc");
    const before = { ...BOAT_NPC };

    const result = configoverrides.setOverride(operator(), "world.boatNpc", { x: 0, y: OVERWORLD_Y_BOUNDS.max + 50, z: 0 });

    const { check, done } = checks();
    check("refused", result.ok === false, JSON.stringify(result));
    check("reason mentions the build limit", /build limit/.test(result.reason ?? ""), JSON.stringify(result));
    check("unchanged", BOAT_NPC.x === before.x && BOAT_NPC.y === before.y && BOAT_NPC.z === before.z);
    done();
});

// ---------------------------------------------------------------------------
// reset(): back to the compiled default, regardless of how many edits came first
// ---------------------------------------------------------------------------

test("resetOverride restores the value captured at registration, after several intervening edits", () => {
    scene();
    clean("pistol.fireRateTicks");
    const original = GUNS.pistol.fireRateTicks;

    configoverrides.setOverride(operator(), "pistol.fireRateTicks", 3);
    configoverrides.setOverride(operator(), "pistol.fireRateTicks", 20);
    configoverrides.setOverride(operator(), "pistol.fireRateTicks", 1);
    const result = configoverrides.resetOverride(operator(), "pistol.fireRateTicks");

    const { check, done } = checks();
    check("reset reports ok", result.ok === true, JSON.stringify(result));
    check("back to the original compiled value", GUNS.pistol.fireRateTicks === original, String(GUNS.pistol.fireRateTicks));
    check("no longer tracked as an active override", configoverrides.hasOverride("pistol.fireRateTicks") === false);
    done();
});

// ---------------------------------------------------------------------------
// Unknown ids and the operator gate: refused cleanly, never thrown
// ---------------------------------------------------------------------------

test("an unknown field id is refused cleanly on get/set/reset, never throws", () => {
    const { check, done } = checks();
    check("getField answers undefined", configoverrides.getField("not.a.real.field") === undefined);
    check("setOverride is refused", configoverrides.setOverride(operator(), "not.a.real.field", 1).ok === false);
    check("resetOverride is refused", configoverrides.resetOverride(operator(), "not.a.real.field").ok === false);
    done();
});

test("a non-operator is refused; an operator is allowed", () => {
    scene();
    clean("revolver.fireRateTicks");
    const before = GUNS.revolver.fireRateTicks;

    const refused = configoverrides.setOverride(member(), "revolver.fireRateTicks", 2);
    const { check, done } = checks();
    check("a member is refused", refused.ok === false, JSON.stringify(refused));
    check("reason says operators only", /operator/i.test(refused.reason ?? ""), JSON.stringify(refused));
    check("value unchanged", GUNS.revolver.fireRateTicks === before);

    const allowed = configoverrides.setOverride(operator(), "revolver.fireRateTicks", 2);
    check("an operator succeeds", allowed.ok === true, JSON.stringify(allowed));
    done();

    configoverrides.resetOverride(operator(), "revolver.fireRateTicks");
});

// ---------------------------------------------------------------------------
// Persistence: a real round-trip through core/persist.ts, not a mock of it
// ---------------------------------------------------------------------------

test("a live edit survives saveAll() + restoreAll(), the real reload path", () => {
    scene();
    clean("bolt_rifle.damage");
    clean("world.fortRewardChest");

    configoverrides.setOverride(operator(), "bolt_rifle.damage", 99);
    configoverrides.setOverride(operator(), "world.fortRewardChest", { x: 5, y: 70, z: 5 });
    persist.saveAll();

    // Simulate a reload: put the live values back to their compiled defaults, as a fresh process would start.
    configoverrides.resetOverride(operator(), "bolt_rifle.damage");
    configoverrides.resetOverride(operator(), "world.fortRewardChest");

    persist.restoreAll();

    const { check, done } = checks();
    check("the numeric override came back", GUNS.bolt_rifle.damage === 99, String(GUNS.bolt_rifle.damage));
    check("the coordinate override came back", configoverrides.getField("world.fortRewardChest").get().x === 5);
    check("hasOverride reflects the restore", configoverrides.hasOverride("bolt_rifle.damage") && configoverrides.hasOverride("world.fortRewardChest"));
    done();

    configoverrides.resetOverride(operator(), "bolt_rifle.damage");
    configoverrides.resetOverride(operator(), "world.fortRewardChest");
});

test("a saved override for a field that no longer exists is skipped and reported, other entries still restore", () => {
    scene();
    clean("pistol.reloadTicks");
    const before = GUNS.pistol.reloadTicks;

    world.setDynamicProperty("rae:persist:config-overrides", JSON.stringify({
        version: 1,
        data: [
            { id: "nonexistent.field.gone", value: 123 },
            { id: "pistol.reloadTicks", value: before + 5 }
        ]
    }));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
        persist.restoreAll();
    } finally {
        console.warn = originalWarn;
    }

    const { check, done } = checks();
    check("the real field still restored", GUNS.pistol.reloadTicks === before + 5, String(GUNS.pistol.reloadTicks));
    check("the unknown one was reported, not thrown", warnings.some((w) => w.includes("nonexistent.field.gone")), warnings.join(" | "));
    done();

    configoverrides.resetOverride(operator(), "pistol.reloadTicks");
});

// ---------------------------------------------------------------------------
// Regression guard: the stale-cache exclusions stay excluded
// ---------------------------------------------------------------------------

test("fields proven stale-cached until reload are never registered", () => {
    const { check, done } = checks();
    check("TRAIN_START is not editable", configoverrides.getField("world.trainStart") === undefined);
    check("TRAIN_END is not editable", configoverrides.getField("world.trainEnd") === undefined);
    check("TRAIN.stepSize is not editable", configoverrides.getField("train.stepSize") === undefined);
    check("no TRANSIT.* field is editable", configoverrides.listFields().every((f) => f.category !== "Transit"));
    check("a sane number of fields are registered overall", configoverrides.listFields().length > 100, String(configoverrides.listFields().length));
    done();
});
