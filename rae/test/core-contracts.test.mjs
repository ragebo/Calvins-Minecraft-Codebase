import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, load, checks } from "./helpers.mjs";

const state = await load("core/state.js");
const round = await load("core/round.js");
const roster = await load("core/players.js");
const persist = await load("core/persist.js");
const { resetAllSystems } = await load("core/registry.js");

const tagsOf = (p) => [...p.tags].sort();

// ---------------------------------------------------------------------------
// core/state: one record per player.id, tags written through as output
// ---------------------------------------------------------------------------

test("state: a record is created from the tags a player already carries", () => {
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A", { tags: ["outlaw", "jailed", "in_jail"] });
    const r = state.getRecord(p);
    const { check, done } = checks();
    check("role read from tag", r.role === "outlaw");
    check("jailed tag means one capture", r.captures === 1);
    check("in_jail read", r.inJail === true);
    check("others default off", !r.eliminated && !r.pendingJail && !r.escortVulnerable && !r.winner);
    done();
});

test("state: update() changes the record and writes matching tags through", () => {
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A");
    state.update(p, { role: "law" });
    state.update(p, { role: "outlaw", inJail: true, captures: 1 });
    const { check, done } = checks();
    check("record reflects the update", state.getRecord(p).role === "outlaw" && state.getRecord(p).inJail);
    check("old role tag removed, new tags added", tagsOf(p).join() === ["in_jail", "jailed", "outlaw"].join(), tagsOf(p).join());
    state.update(p, { inJail: false, eliminated: true });
    check("clearing a field removes its tag", !p.tags.has("in_jail") && p.tags.has("eliminated"), tagsOf(p).join());
    done();
});

test("state: an unchanged sync touches no tags", () => {
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A");
    state.update(p, { role: "law" });
    let writes = 0;
    const addTag = p.addTag, removeTag = p.removeTag;
    p.addTag = (t) => { writes++; return addTag.call(p, t); };
    p.removeTag = (t) => { writes++; return removeTag.call(p, t); };
    state.update(p, { role: "law" });
    assert.equal(writes, 0, "re-applying the same state should not call addTag/removeTag");
});

test("state: two players with the same name have separate records (keyed by id)", () => {
    fake.reset(); state.clearRecords();
    const a = fake.makePlayer("Dup", { id: "a" });
    const b = fake.makePlayer("Dup", { id: "b" });
    state.update(a, { role: "law" });
    const { check, done } = checks();
    check("a is law", state.getRecord(a).role === "law");
    check("b is untouched", state.getRecord(b).role === null);
    check("two records exist", state.allRecords().length === 2);
    check("findRecord by id", state.findRecord("a")?.role === "law" && state.findRecord("zzz") === undefined);
    done();
});

test("state: adoptTags re-reads tags that were changed from outside", () => {
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A");
    state.update(p, { role: "law" });
    p.tags.delete("law"); p.tags.add("outlaw");          // a command block did this
    assert.equal(state.getRecord(p).role, "law", "reads are cheap and don't re-check tags");
    state.adoptTags(p);
    assert.equal(state.getRecord(p).role, "outlaw");
    state.update(p, { role: "law" });
    assert.deepEqual(tagsOf(p), ["law"], "and the mirror stays consistent afterwards");
});

test("state: ammo and flags live on the record and survive adoptTags", () => {
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A");
    state.setAmmo(p, "revolver", 4);
    state.setFlag(p, "tutorialSeen", true);
    state.adoptTags(p);
    const r = state.getRecord(p);
    assert.equal(r.ammo.revolver, 4);
    assert.equal(r.flags.tutorialSeen, true);
});

test("state: stateVersion changes on every write, and a round reset clears the records", () => {
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A");
    const v0 = state.stateVersion();
    state.update(p, { role: "law" });
    const v1 = state.stateVersion();
    state.setAmmo(p, "g", 1);
    const { check, done } = checks();
    check("version rises on update", v1 > v0);
    check("version rises on ammo", state.stateVersion() > v1);
    resetAllSystems();
    check("reset forgets the records", state.allRecords().length === 0);
    check("and reset removed the owned tags", !p.tags.has("law"));
    done();
});

// ---------------------------------------------------------------------------
// core/round: one lifecycle
// ---------------------------------------------------------------------------

test("round: the legal path and the illegal shortcuts", () => {
    round.resetRound();
    const { check, done } = checks();
    check("starts IDLE", round.getPhase() === "IDLE");
    check("cannot go ACTIVE from IDLE", round.beginActive() === false && round.getPhase() === "IDLE");
    check("cannot end an idle round", round.endRound("law_win") === false);
    check("IDLE -> SETUP", round.startRound() === true && round.getPhase() === "SETUP");
    check("cannot start twice", round.startRound() === false);
    check("SETUP -> ACTIVE", round.beginActive() === true && round.isPhase("ACTIVE"));
    check("ACTIVE -> ENDED via ENDING", round.endRound("outlaw_win") === true && round.getPhase() === "ENDED");
    check("remembers why it ended", round.lastEnd() === "outlaw_win");
    check("a second 'someone won' in the same tick is ignored", round.endRound("law_win") === false && round.lastEnd() === "outlaw_win");
    check("ENDED -> SETUP starts the next round and clears the reason", round.startRound() === true && round.lastEnd() === null);
    done();
});

test("round: subscribers see each phase in order, and a throwing one breaks nothing", () => {
    round.resetRound();
    const seen = [];
    const off = round.onPhase("*", (c) => seen.push(`${c.from}>${c.to}${c.reason ? `:${c.reason}` : ""}`));
    const errors = [];
    const original = console.error; console.error = (m) => errors.push(String(m));
    const offBad = round.onPhase("ENDING", () => { throw new Error("boom"); });
    let endingCount = 0;
    const offGood = round.onPhase("ENDING", () => { endingCount++; });
    try {
        round.startRound(); round.beginActive(); round.endRound("law_win");
    } finally { console.error = original; }
    off(); offBad(); offGood();

    const { check, done } = checks();
    check("every transition announced in order", seen.join(" ") === "IDLE>SETUP SETUP>ACTIVE ACTIVE>ENDING:law_win ENDING>ENDED:law_win", seen.join(" "));
    check("the healthy ENDING subscriber still ran", endingCount === 1);
    check("the failure was reported, not thrown", errors.length === 1 && errors[0].includes("boom"), errors.join("|"));
    round.beginActive();
    check("unsubscribed listeners no longer fire", seen.length === 4);
    done();
});

test("round: resetRound returns to IDLE from anywhere and resets every system", () => {
    round.resetRound();
    fake.reset(); state.clearRecords();
    const p = fake.makePlayer("A");
    state.update(p, { role: "law" });
    round.startRound(); round.beginActive();
    round.resetRound();
    const { check, done } = checks();
    check("back to IDLE", round.getPhase() === "IDLE");
    check("systems were reset (state cleared, tags removed)", state.allRecords().length === 0 && !p.tags.has("law"));
    done();
});

// ---------------------------------------------------------------------------
// core/players: cached queries over the records
// ---------------------------------------------------------------------------

function roster5() {
    fake.reset(); state.clearRecords();
    const sheriff = fake.makePlayer("Sheriff", { tags: ["law"] });
    const deadLaw = fake.makePlayer("DeadLaw", { tags: ["law", "eliminated"] });
    const free = fake.makePlayer("Free", { tags: ["outlaw"] });
    const jailed = fake.makePlayer("Jailed", { tags: ["outlaw", "in_jail"] });
    const out = fake.makePlayer("Out", { tags: ["outlaw", "eliminated"] });
    return { sheriff, deadLaw, free, jailed, out };
}
const names = (list) => list.map((p) => p.name).sort().join(",");

test("players: each query answers from the records", () => {
    const r = roster5();
    fake.advance(1);
    const { check, done } = checks();
    check("everyone", roster.players().length === 5);
    check("law = alive law", names(roster.lawPlayers()) === "Sheriff", names(roster.lawPlayers()));
    check("outlaws = all outlaws", names(roster.outlaws()) === "Free,Jailed,Out");
    check("aliveOutlaws excludes eliminated", names(roster.aliveOutlaws()) === "Free,Jailed");
    check("freeOutlaws excludes jailed too", names(roster.freeOutlaws()) === "Free");
    check("spectators = eliminated", names(roster.spectators()) === "DeadLaw,Out");
    done();
});

test("players: the player list is fetched once per tick, however many queries run", () => {
    roster5();
    fake.advance(1);
    fake.calls.getAllPlayers = 0;
    roster.lawPlayers(); roster.freeOutlaws(); roster.spectators(); roster.aliveOutlaws(); roster.players();
    assert.equal(fake.calls.getAllPlayers, 1);
    fake.advance(1);
    roster.lawPlayers();
    assert.equal(fake.calls.getAllPlayers, 2, "a new tick fetches again");
});

test("players: an answer is recomputed after a state change in the same tick", () => {
    const r = roster5();
    fake.advance(1);
    assert.equal(names(roster.freeOutlaws()), "Free");
    state.update(r.free, { inJail: true });
    assert.equal(names(roster.freeOutlaws()), "", "jailing the free outlaw is visible immediately");
});

// ---------------------------------------------------------------------------
// core/persist: the registration contract
// ---------------------------------------------------------------------------

test("persist: registration rejects duplicates and lists what was registered", () => {
    persist.registerPersistable({ key: "test.a", version: 1, save: () => ({}), restore() {} });
    assert.throws(() => persist.registerPersistable({ key: "test.a", version: 2, save: () => ({}), restore() {} }), /already registered/);
    assert.ok(persist.listPersistables().some((p) => p.key === "test.a"));
});
