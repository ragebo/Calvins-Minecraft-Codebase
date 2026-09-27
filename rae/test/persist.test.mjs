import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, load, checks } from "./helpers.mjs";

const persist = await load("core/persist.js");
const state = await load("core/state.js");
const round = await load("core/round.js");
const { PERSIST } = await load("config/balance.js");

/** Clean slate for every test: no players, no records, an IDLE round, no saved dynamic
 *  properties, and persist's own dirty-check cache cleared (via the real reset event, which
 *  exercises it at the same time). */
function scene() {
    fake.reset();
    state.clearRecords();
    round.resetRound();
    system.afterEvents.scriptEventReceive.emit({ id: "rae:persist_reset" });
}

const scriptEvent = (id) => system.afterEvents.scriptEventReceive.emit({ id });

let nextKey = 0;
/** A fresh, never-before-registered key. registerPersistable() has no unregister, so every test
 *  that needs its own dummy Persistable asks for one of these instead of reusing a literal. */
function freshKey(label) {
    return `test.persist.${label}.${nextKey++}`;
}

// ---------------------------------------------------------------------------
// save/restore round-trip through the real engine
// ---------------------------------------------------------------------------

test("persist: saveAll writes {version, data} as one dynamic property per key, and restoreAll hands it back", () => {
    scene();
    const key = freshKey("roundtrip");
    const data = { n: 5, label: "x" };
    let restoredWith = null;
    persist.registerPersistable({
        key, version: 3,
        save: () => data,
        restore(restoredData, savedVersion) { restoredWith = { data: restoredData, savedVersion }; }
    });

    persist.saveAll();

    const raw = world.getDynamicProperty(`rae:persist:${key}`);
    const { check, done } = checks();
    check("the property is a string", typeof raw === "string", typeof raw);
    check("it round-trips through JSON as {version, data}", JSON.stringify(JSON.parse(raw)) === JSON.stringify({ version: 3, data }));

    persist.restoreAll();
    check("restore() was called with the saved data and version", JSON.stringify(restoredWith) === JSON.stringify({ data, savedVersion: 3 }));
    done();
});

test("persist: a key with nothing saved yet is left alone by restoreAll", () => {
    scene();
    const key = freshKey("nothing-saved");
    let called = false;
    persist.registerPersistable({ key, version: 1, save: () => ({}), restore() { called = true; } });
    persist.restoreAll();
    assert.equal(called, false, "restore() must not run when the property was never written");
});

// ---------------------------------------------------------------------------
// dirty-check: saveAll only calls into the engine when the serialized text changed
// ---------------------------------------------------------------------------

test("persist: saveAll only writes a key whose serialized data actually changed", () => {
    scene();
    const key = freshKey("dirty");
    let n = 0;
    persist.registerPersistable({ key, version: 1, save: () => ({ n }), restore() {} });

    let writes = 0;
    const original = world.setDynamicProperty;
    world.setDynamicProperty = (k, v) => { if (k === `rae:persist:${key}`) writes++; return original.call(world, k, v); };

    try {
        persist.saveAll();
        assert.equal(writes, 1, "the first save always writes");
        persist.saveAll();
        assert.equal(writes, 1, "unchanged data must not be rewritten");
        persist.saveAll();
        assert.equal(writes, 1, "still unchanged on a third call");
        n = 1;
        persist.saveAll();
        assert.equal(writes, 2, "changed data is written again");
    } finally {
        world.setDynamicProperty = original;
    }
});

// ---------------------------------------------------------------------------
// size guard: one oversized key is skipped and reported, everything else still saves
// ---------------------------------------------------------------------------

test("persist: a key over PERSIST.maxSavedCharsPerKey is skipped and reported, other keys still save", () => {
    scene();
    const bigKey = freshKey("big");
    const smallKey = freshKey("small");
    persist.registerPersistable({ key: bigKey, version: 1, save: () => "x".repeat(PERSIST.maxSavedCharsPerKey + 500), restore() {} });
    persist.registerPersistable({ key: smallKey, version: 1, save: () => "ok", restore() {} });

    const errors = [];
    const originalError = console.error;
    console.error = (m) => errors.push(String(m));
    try {
        persist.saveAll();
    } finally {
        console.error = originalError;
    }

    const { check, done } = checks();
    check("the oversized key was not written", world.getDynamicProperty(`rae:persist:${bigKey}`) === undefined);
    check("the small key was still written", typeof world.getDynamicProperty(`rae:persist:${smallKey}`) === "string");
    check("the oversized key was reported, not thrown", errors.some((e) => e.includes(bigKey)), errors.join(" | "));
    done();
});

test("persist: a key whose restore() throws does not stop the others from restoring", () => {
    scene();
    const badKey = freshKey("bad-restore");
    const goodKey = freshKey("good-restore");
    persist.registerPersistable({ key: badKey, version: 1, save: () => ({}), restore() { throw new Error("boom"); } });
    let restoredGood = false;
    persist.registerPersistable({ key: goodKey, version: 1, save: () => ({}), restore() { restoredGood = true; } });
    world.setDynamicProperty(`rae:persist:${badKey}`, JSON.stringify({ version: 1, data: {} }));
    world.setDynamicProperty(`rae:persist:${goodKey}`, JSON.stringify({ version: 1, data: {} }));

    const errors = [];
    const originalError = console.error;
    console.error = (m) => errors.push(String(m));
    let threw = null;
    try {
        try { persist.restoreAll(); } catch (e) { threw = e; }
    } finally {
        console.error = originalError;
    }

    const { check, done } = checks();
    check("restoreAll itself never throws", threw === null, String(threw));
    check("the other key still restored", restoredGood === true);
    check("the failure was reported", errors.some((e) => e.includes(badKey)), errors.join(" | "));
    done();
});

// ---------------------------------------------------------------------------
// version mismatch: refused rather than guessed, and never crashes the engine
// ---------------------------------------------------------------------------

test("persist: a savedVersion that doesn't match is passed through as-is, engine never judges it", () => {
    scene();
    const key = freshKey("version-mismatch");
    let seenVersion = null;
    persist.registerPersistable({ key, version: 7, save: () => ({}), restore(_data, savedVersion) { seenVersion = savedVersion; } });
    world.setDynamicProperty(`rae:persist:${key}`, JSON.stringify({ version: 2, data: {} }));
    persist.restoreAll();
    assert.equal(seenVersion, 2, "the engine hands the entry the version that was actually saved, and lets the entry decide");
});

test("round: a version mismatch on the real 'round' persistable is silently ignored, not applied", () => {
    scene();
    world.setDynamicProperty("rae:persist:round", JSON.stringify({ version: 999, data: { lastEndReason: "law_win" } }));
    assert.doesNotThrow(() => persist.restoreAll());
    assert.equal(round.lastEnd(), null, "a savedVersion that doesn't match ROUND_SCHEMA_VERSION must be refused, not applied");
});

test("round: phase is never restored, even when the saved version matches", () => {
    scene();
    round.startRound(); // -> SETUP, just so we're not looking at the default by coincidence
    world.setDynamicProperty("rae:persist:round", JSON.stringify({ version: 1, data: { phase: "ACTIVE", lastEndReason: "outlaw_win" } }));
    round.resetRound(); // back to the module's own default, IDLE, as a real reload would start
    persist.restoreAll();
    const { check, done } = checks();
    check("phase stays at the module's own default, never resumed from a save", round.getPhase() === "IDLE", round.getPhase());
    check("lastEndReason is the one field that does come back", round.lastEnd() === "outlaw_win");
    done();
});

// ---------------------------------------------------------------------------
// rae:persist_reset: clears saved data, never touches anything live
// ---------------------------------------------------------------------------

test("persist: rae:persist_reset clears every rae:persist:* property but touches no live state", () => {
    scene();
    const p = fake.makePlayer("A", { tags: ["law"] });
    state.getRecord(p);
    state.setAmmo(p, "revolver", 4);
    persist.saveAll();

    const before = world.getDynamicPropertyIds().filter((id) => id.startsWith("rae:persist:"));
    assert.ok(before.length > 0, "sanity: saveAll actually wrote something");

    scriptEvent("rae:persist_reset");

    const { check, done } = checks();
    check("every rae:persist:* property is gone", world.getDynamicPropertyIds().every((id) => !id.startsWith("rae:persist:")), world.getDynamicPropertyIds().join(","));
    check("the live record is untouched", state.getRecord(p).role === "law" && state.getRecord(p).ammo.revolver === 4);
    check("the player's tags are untouched", p.tags.has("law"));
    done();
});

test("persist: rae:persist_reset leaves the dirty-check cache clean, so the next save always writes", () => {
    scene();
    const key = freshKey("reset-then-save");
    let n = 0;
    persist.registerPersistable({ key, version: 1, save: () => ({ n }), restore() {} });
    persist.saveAll();

    scriptEvent("rae:persist_reset");

    let writes = 0;
    const original = world.setDynamicProperty;
    world.setDynamicProperty = (k, v) => { if (k === `rae:persist:${key}`) writes++; return original.call(world, k, v); };
    try {
        persist.saveAll(); // same data (n is still 0) as before the reset
        assert.equal(writes, 1, "after a reset, the cache must not think the (now-cleared) property is still up to date");
    } finally {
        world.setDynamicProperty = original;
    }
});

// ---------------------------------------------------------------------------
// core/state merge-ordering: a tag-adopted role/eliminated/inJail must never be clobbered by a
// restore, whichever of the two runs first.
// ---------------------------------------------------------------------------

function savedRecordFor(id) {
    return {
        id, role: "outlaw", eliminated: true, captures: 2, inJail: true,
        pendingJail: false, escortVulnerable: false, winner: false,
        ammo: { revolver: 4 }, flags: { seenTutorial: true }
    };
}

test("state: mergeRecords BEFORE adoption — adoption still wins the role, saved ammo/flags survive it", () => {
    scene();
    const p = fake.makePlayer("A", { tags: ["law"] }); // live tags say law, not outlaw

    state.mergeRecords([savedRecordFor(p.id)]); // "restore" runs first: nothing existed yet, so it seeds
    state.adoptTags(p);                         // "adoption" runs second: live tags must win now

    const r = state.getRecord(p);
    const { check, done } = checks();
    check("role comes from tags, not the stale save", r.role === "law", r.role);
    check("eliminated is from tags (false), not the stale save (true)", r.eliminated === false);
    check("inJail is from tags (false), not the stale save (true)", r.inJail === false);
    check("ammo saved before adoption still survives adoption", r.ammo.revolver === 4);
    check("flags saved before adoption still survive adoption", r.flags.seenTutorial === true);
    done();
});

test("state: mergeRecords AFTER adoption — tags already won, merge only backfills ammo/flags", () => {
    scene();
    const p = fake.makePlayer("A", { tags: ["law"] });

    state.adoptTags(p);                          // "adoption" runs first
    state.mergeRecords([savedRecordFor(p.id)]);  // "restore" runs second: must not clobber role/eliminated/inJail

    const r = state.getRecord(p);
    const { check, done } = checks();
    check("role is unchanged from the tag-adopted value", r.role === "law", r.role);
    check("eliminated is unchanged (tags already decided)", r.eliminated === false);
    check("inJail is unchanged (tags already decided)", r.inJail === false);
    check("ammo is backfilled from the save", r.ammo.revolver === 4);
    check("flags are backfilled from the save", r.flags.seenTutorial === true);
    done();
});

test("state: mergeRecords seeds a whole record for an id nothing has claimed yet", () => {
    scene();
    state.mergeRecords([savedRecordFor("offline-player-id")]);
    const r = state.findRecord("offline-player-id");
    const { check, done } = checks();
    check("a record now exists", r !== undefined);
    check("role came from the save (nothing to conflict with)", r?.role === "outlaw");
    check("eliminated came from the save", r?.eliminated === true);
    check("ammo came from the save", r?.ammo.revolver === 4);
    done();
});

test("persist+state: a full save/restore cycle through the real engine preserves ammo/flags, and adoption afterwards still governs role", () => {
    scene();
    const p = fake.makePlayer("A", { tags: ["outlaw"] });
    state.getRecord(p);
    state.setAmmo(p, "revolver", 3);
    state.setFlag(p, "seenTutorial", true);
    state.setJailSite({ jail: { x: 1, y: 2, z: 3 }, doorTrigger: { x: 4, y: 5, z: 6 } });

    persist.saveAll();

    // Simulate a reload: this module's own maps forget everything, but the player and their
    // real tags (which live on the entity, not in here) are untouched.
    state.clearRecords();
    state.setJailSite(null);

    persist.restoreAll();

    const { check, done } = checks();
    check("ammo survived the round trip", state.findRecord(p.id)?.ammo.revolver === 3);
    check("flags survived the round trip", state.findRecord(p.id)?.flags.seenTutorial === true);
    check("jailSite survived the round trip", state.getJailSite()?.jail.x === 1);

    state.adoptTags(p); // what state:adopt-at-load / a spawn would do next in the real game
    const r = state.getRecord(p);
    check("role after adoption matches the player's real tags", r.role === "outlaw");
    check("ammo/flags are not wiped by the adoption that follows restore", r.ammo.revolver === 3 && r.flags.seenTutorial === true);
    done();
});
