import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, load, checks } from "./helpers.mjs";

// Loading core/telemetry.js pulls in core/round.js, core/state.js, core/persist.js,
// core/economy.js and core/players.js transitively (it imports from all of them), but none of
// systems/*.ts: no economy-rules death penalty, no jail capture, nothing else reacting to a
// death. Only telemetry's own onDeath handler runs, which is exactly the isolation these tests want.
const telemetry = await load("core/telemetry.js");
const round = await load("core/round.js");
const state = await load("core/state.js");
const persist = await load("core/persist.js");
const economy = await load("core/economy.js");
const { TELEMETRY } = await load("config/balance.js");

const kill = (victim, killer) => world.afterEvents.entityDie.emit({ deadEntity: victim, damageSource: { damagingEntity: killer } });

/** Clean slate: no players, no records, an IDLE round, and no saved telemetry/round/state data.
 *
 * telemetry has no reset()/clear export, on purpose: a real round reset must never erase the
 * history of the round that just finished. Tests instead force a known-empty state through
 * telemetry's own real restore() path (a synthetic "nothing saved yet" snapshot), the same engine
 * exercised elsewhere in this file, rather than reaching into its module state some other way. */
function scene() {
    fake.reset();
    state.clearRecords();
    round.resetRound();
    system.afterEvents.scriptEventReceive.emit({ id: "rae:persist_reset" });
    world.setDynamicProperty("rae:persist:telemetry", JSON.stringify({ version: 1, data: { rounds: [], totals: { kills: 0, deaths: 0 } } }));
    persist.restoreAll();
}

// ---------------------------------------------------------------------------
// A normal round: ACTIVE -> ENDING -> ENDED
// ---------------------------------------------------------------------------

test("telemetry: a normal round (ACTIVE -> ENDING -> ENDED) is recorded with duration, reason, coins and kill/death counts", () => {
    scene();
    const law = fake.makePlayer("L", { tags: ["law"] });
    const outlaw = fake.makePlayer("O", { tags: ["outlaw"] });
    fake.setScore("coins", law, 100);
    fake.setScore("coins", outlaw, 50);

    round.startRound();
    const startTick = system.currentTick;
    round.beginActive();      // fake.tick is a monotonic counter never reset between tests
    fake.advance(10);         // (fake.reset() deliberately leaves it alone -- resetting it would
    kill(outlaw, law);        // desync core/tick.ts's own persistent scheduler job), so every
    fake.advance(5);          // tick this test cares about is captured relative to "now", never
    const endTick = system.currentTick; // assumed to start at 0.
    round.endRound("law_win");

    const expectedCoins = economy.getCoins(law) + economy.getCoins(outlaw);
    const records = telemetry.recentRounds();
    const { check, done } = checks();
    check("exactly one record was pushed", records.length === 1, records.length);
    const r = records[0];
    check("startedAtTick is when ACTIVE began", r.startedAtTick === startTick, `${r.startedAtTick} vs ${startTick}`);
    check("endedAtTick is when ENDED fired", r.endedAtTick === endTick, `${r.endedAtTick} vs ${endTick}`);
    check("durationTicks is the difference", r.durationTicks === 15, r.durationTicks);
    check("reason comes from endRound()", r.reason === "law_win", r.reason);
    check("kills = 1", r.kills === 1, r.kills);
    check("deaths = 1", r.deaths === 1, r.deaths);
    check("lawKills = 1", r.lawKills === 1, r.lawKills);
    check("outlawKills = 0", r.outlawKills === 0, r.outlawKills);
    check("totalCoinsAtEnd is a snapshot summed over players()", r.totalCoinsAtEnd === expectedCoins, `${r.totalCoinsAtEnd} vs ${expectedCoins}`);
    check("totalKills/totalDeaths accumulate the same round", telemetry.totalKills() === 1 && telemetry.totalDeaths() === 1);
    done();
});

// ---------------------------------------------------------------------------
// An abort: ACTIVE -> IDLE directly (resetRound() mid-round)
// ---------------------------------------------------------------------------

test("telemetry: an abort (ACTIVE -> IDLE directly) is recorded with reason 'aborted'", () => {
    scene();
    round.startRound();
    const startTick = system.currentTick;
    round.beginActive();
    fake.advance(7);
    const endTick = system.currentTick;
    round.resetRound();        // ACTIVE -> IDLE directly, skipping ENDING/ENDED

    const records = telemetry.recentRounds();
    const { check, done } = checks();
    check("exactly one record was pushed", records.length === 1, records.length);
    const r = records[0];
    check("reason is 'aborted', assigned by telemetry itself", r.reason === "aborted", r.reason);
    check("startedAtTick/endedAtTick/duration are still tracked", r.startedAtTick === startTick && r.endedAtTick === endTick && r.durationTicks === 7, `${r.startedAtTick}/${r.endedAtTick}/${r.durationTicks}`);
    done();
});

// ---------------------------------------------------------------------------
// A cancellation that never reached ACTIVE must not be recorded at all
// ---------------------------------------------------------------------------

test("telemetry: a SETUP -> IDLE cancellation (never reached ACTIVE) produces no record", () => {
    scene();
    round.startRound();       // IDLE -> SETUP
    fake.advance(3);
    round.resetRound();       // SETUP -> IDLE: never reached ACTIVE

    assert.equal(telemetry.recentRounds().length, 0, "a cancellation before ACTIVE must not be recorded as a round");
});

test("telemetry: resetting after a round already ended does not record it a second time", () => {
    scene();
    round.startRound();
    round.beginActive();
    fake.advance(4);
    round.endRound("outlaw_win"); // ACTIVE -> ENDING -> ENDED: records once
    round.resetRound();           // ENDED -> IDLE: from is "ENDED", not "ACTIVE" -- must not double-record

    const records = telemetry.recentRounds();
    const { check, done } = checks();
    check("still exactly one record", records.length === 1, records.length);
    check("it's the real ended one, not a spurious aborted one", records[0].reason === "outlaw_win", records[0].reason);
    done();
});

test("telemetry: a resetRound() nested inside an ENDING subscriber never produces a spurious 'aborted' record", () => {
    // round.ts can drop straight to IDLE from ANY phase, including ENDING itself, if some
    // subscriber calls resetRound() before the ENDED transition it's already mid-way through gets
    // a chance to run. When that happens, phase is "IDLE" by the time endRound() tries its own
    // transition("ENDED", ...), which round.ts's own legality table refuses (IDLE only legally
    // goes to SETUP) -- so the real result is never recorded. That's an accepted, pre-existing
    // consequence of resetRound()'s "back to IDLE from anywhere" design, not something telemetry
    // can fix. What telemetry MUST NOT do is compound it by recording a spurious "aborted" round
    // for the nested from:"ENDING" -> IDLE step, since startedAtTick is still set at that instant
    // (the real ENDED handler hasn't run yet to clear it) -- exactly the case the guard being
    // `change.from !== "ACTIVE"`, rather than just relying on pushRecord's own null check, exists
    // to catch. A quick mutation check (removing the guard, reverted) confirmed this test does
    // fail without it, where the SETUP->IDLE and ENDED->IDLE tests above do not.
    scene();
    round.startRound();
    round.beginActive();
    fake.advance(2);
    const offNested = round.onPhase("ENDING", () => round.resetRound());
    round.endRound("law_win");
    offNested();

    assert.equal(telemetry.recentRounds().length, 0, "no spurious 'aborted' record from the nested from:\"ENDING\" step");
});

// ---------------------------------------------------------------------------
// Ring buffer: caps at TELEMETRY.maxStoredRounds, oldest dropped, newest first
// ---------------------------------------------------------------------------

test("telemetry: recentRounds caps at TELEMETRY.maxStoredRounds, dropping the oldest, newest first", () => {
    scene();
    const startTick = system.currentTick; // fake.tick is never reset between tests; measure relative to "now"
    const total = TELEMETRY.maxStoredRounds + 3;
    for (let i = 0; i < total; i++) {
        round.startRound();
        round.beginActive();
        fake.advance(1);
        round.endRound("law_win");
    }

    const records = telemetry.recentRounds();
    const { check, done } = checks();
    check("length is capped, not total", records.length === TELEMETRY.maxStoredRounds, records.length);
    check("newest first: index 0 ended after the last index", records[0].endedAtTick > records[records.length - 1].endedAtTick);
    const firstRoundEndedAt = startTick + 1; // the very first loop iteration's endedAtTick
    check("the oldest round (first pushed) is gone", !records.some((r) => r.endedAtTick === firstRoundEndedAt), `endedAtTick ${firstRoundEndedAt} should have been dropped`);
    // totalKills/totalDeaths are lifetime counters: they must NOT shrink just because the ring
    // buffer dropped old RoundRecords (same accounting core/economy.ts's coins use).
    check("totalKills/totalDeaths are unaffected by the ring buffer dropping old rounds", telemetry.totalKills() === 0 && telemetry.totalDeaths() === 0);
    done();
});

// ---------------------------------------------------------------------------
// Kill/death attribution
// ---------------------------------------------------------------------------

test("telemetry: kills/deaths are attributed to the correct side, and totals accumulate across rounds", () => {
    scene();
    const law1 = fake.makePlayer("L1", { tags: ["law"] });
    const law2 = fake.makePlayer("L2", { tags: ["law"] });
    const outlaw1 = fake.makePlayer("O1", { tags: ["outlaw"] });
    const outlaw2 = fake.makePlayer("O2", { tags: ["outlaw"] });

    round.startRound();
    round.beginActive();
    kill(outlaw1, law1);   // law kill
    kill(outlaw2, law2);   // law kill
    kill(law1, outlaw1);   // outlaw kill
    round.endRound("law_win");

    const r1 = telemetry.recentRounds()[0];
    const { check, done } = checks();
    check("kills = 3", r1.kills === 3, r1.kills);
    check("deaths = 3", r1.deaths === 3, r1.deaths);
    check("lawKills = 2", r1.lawKills === 2, r1.lawKills);
    check("outlawKills = 1", r1.outlawKills === 1, r1.outlawKills);
    check("totalKills() after round 1", telemetry.totalKills() === 3, telemetry.totalKills());
    check("totalDeaths() after round 1", telemetry.totalDeaths() === 3, telemetry.totalDeaths());
    done();

    // A second round: totals accumulate on top of the first, they don't reset or replace it.
    round.startRound();
    round.beginActive();
    kill(outlaw2, law1);   // one more law kill
    round.endRound("law_win");

    const r2 = telemetry.recentRounds()[0]; // newest first
    const { check: check2, done: done2 } = checks();
    check2("round 2's own counts are just its own", r2.kills === 1 && r2.lawKills === 1 && r2.outlawKills === 0);
    check2("totalKills() accumulates across rounds (3 + 1)", telemetry.totalKills() === 4, telemetry.totalKills());
    check2("totalDeaths() accumulates across rounds (3 + 1)", telemetry.totalDeaths() === 4, telemetry.totalDeaths());
    check2("recentRounds still has both rounds, newest first", telemetry.recentRounds().length === 2 && telemetry.recentRounds()[1].kills === 3);
    done2();
});

test("telemetry: a death with no killer counts toward deaths but not kills", () => {
    scene();
    const outlaw = fake.makePlayer("O", { tags: ["outlaw"] });
    round.startRound();
    round.beginActive();
    kill(outlaw, undefined); // a fall, drowning, or /kill: no killer
    round.endRound("law_win");

    const r = telemetry.recentRounds()[0];
    assert.equal(r.deaths, 1, "a death always counts, whoever (or whatever) caused it");
    assert.equal(r.kills, 0, "with no killer, it cannot be attributed as anyone's kill");
});

test("telemetry: a mob death is not counted (only player deaths are a round-combat stat)", () => {
    scene();
    const law = fake.makePlayer("L", { tags: ["law"] });
    const mob = fake.makeEntity({ typeId: "minecraft:pillager" });
    round.startRound();
    round.beginActive();
    kill(mob, law);
    round.endRound("law_win");

    const r = telemetry.recentRounds()[0];
    assert.equal(r.deaths, 0, "a mob dying is not a player death");
    assert.equal(r.kills, 0, "a mob kill is a reward-handler concern (train/ranch/raid), not a round-combat stat");
});

// ---------------------------------------------------------------------------
// save/restore round-trip through persist.ts's real engine
// ---------------------------------------------------------------------------

test("telemetry: a save/restore round-trip through persist.ts's real engine preserves rounds and totals exactly", () => {
    scene();
    const law = fake.makePlayer("L", { tags: ["law"] });
    const outlaw = fake.makePlayer("O", { tags: ["outlaw"] });
    round.startRound();
    round.beginActive();
    kill(outlaw, law);
    round.endRound("law_win");

    const beforeRounds = JSON.stringify(telemetry.recentRounds());
    const beforeKills = telemetry.totalKills();
    const beforeDeaths = telemetry.totalDeaths();

    persist.saveAll();

    const raw = world.getDynamicProperty("rae:persist:telemetry");
    const { check, done } = checks();
    check("telemetry rides persist's own dynamic property, not a separate one", typeof raw === "string");
    const parsed = JSON.parse(raw);
    check("stored under version 1", parsed.version === 1, parsed.version);
    check("stored data matches recentRounds()", JSON.stringify(parsed.data.rounds) === beforeRounds);
    check("stored totals match totalKills/totalDeaths", parsed.data.totals.kills === beforeKills && parsed.data.totals.deaths === beforeDeaths);

    persist.restoreAll(); // hands the very same saved data straight back

    check("rounds are unchanged after the round trip", JSON.stringify(telemetry.recentRounds()) === beforeRounds);
    check("totalKills is unchanged after the round trip", telemetry.totalKills() === beforeKills);
    check("totalDeaths is unchanged after the round trip", telemetry.totalDeaths() === beforeDeaths);
    done();
});

test("telemetry: restoreAll replaces in-memory rounds/totals with whatever was saved", () => {
    scene();
    const synthetic = {
        rounds: [{ startedAtTick: 1, endedAtTick: 5, durationTicks: 4, reason: "outlaw_win", kills: 2, deaths: 3, lawKills: 1, outlawKills: 1, totalCoinsAtEnd: 77 }],
        totals: { kills: 99, deaths: 42 }
    };
    world.setDynamicProperty("rae:persist:telemetry", JSON.stringify({ version: 1, data: synthetic }));

    persist.restoreAll();

    const { check, done } = checks();
    check("recentRounds reflects the restored data", JSON.stringify(telemetry.recentRounds()) === JSON.stringify(synthetic.rounds));
    check("totalKills reflects the restored totals", telemetry.totalKills() === 99);
    check("totalDeaths reflects the restored totals", telemetry.totalDeaths() === 42);
    done();
});

test("telemetry: a version mismatch on the real 'telemetry' persistable is silently ignored, not applied", () => {
    scene();
    world.setDynamicProperty("rae:persist:telemetry", JSON.stringify({ version: 999, data: { rounds: [{ startedAtTick: 0, endedAtTick: 1, durationTicks: 1, reason: "law_win", kills: 1, deaths: 1, lawKills: 1, outlawKills: 0, totalCoinsAtEnd: 0 }], totals: { kills: 1, deaths: 1 } } }));
    assert.doesNotThrow(() => persist.restoreAll());
    assert.equal(telemetry.recentRounds().length, 0, "a savedVersion that doesn't match must be refused, not applied");
    assert.equal(telemetry.totalKills(), 0);
    assert.equal(telemetry.totalDeaths(), 0);
});
