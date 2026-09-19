import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, system, load, checks, strip } from "./helpers.mjs";

// Tags typed by hand reach the records. Nothing tells the script when a tag changes (there is no
// event for it), so core/state polls: every STATE_SYNC.reconcileIntervalTicks it compares each
// player's tags with what it last wrote or saw, and adopts the difference. `/scriptevent rae:adopt`
// does the same check on demand, and lists what the records say.
//
// Only core modules are loaded, so nothing but core/state can be responsible for what happens here.

const state = await load("core/state.js");
const roster = await load("core/players.js");
const { resetAllSystems } = await load("core/registry.js");
const { listScriptEvents } = await load("core/events.js");
const { STATE_SYNC } = await load("config/balance.js");

const tagsOf = (p) => [...p.tags].sort().join(",");
const names = (list) => list.map((p) => p.name).sort().join(",");
const role = (p) => state.findRecord(p.id)?.role;

/** One poll goes by: it runs once per interval, so an interval's worth of ticks always contains exactly one. */
const poll = () => fake.advance(STATE_SYNC.reconcileIntervalTicks);

/** Delivers `/scriptevent rae:adopt` from a player, or from a command block (no argument). */
const adopt = (source) => system.afterEvents.scriptEventReceive.emit({ id: "rae:adopt", sourceEntity: source, message: "" });

/** Counts the engine calls made on a player, so a test can say what a poll costs and what it doesn't touch. */
function spyOn(player) {
    const calls = { getTags: 0, hasTag: 0, addTag: 0, removeTag: 0 };
    for (const method of Object.keys(calls)) {
        const original = player[method];
        player[method] = (...args) => { calls[method]++; return original.apply(player, args); };
    }
    return calls;
}

/** An empty world with fresh module state, players added, and one poll gone by so each has a record. */
function scene(...specs) {
    fake.reset();
    resetAllSystems();
    const players = specs.map(([name, options]) => fake.makePlayer(name, options));
    poll();
    return players;
}

// ---------------------------------------------------------------------------
// A hand-typed tag reaches the record
// ---------------------------------------------------------------------------

test("a hand-typed role tag reaches the record on the next poll, and nothing is written back", () => {
    const { check, done } = checks();
    const [p] = scene(["P"]);
    check("(setup) recorded, with no role yet", state.findRecord(p.id) !== undefined && role(p) === null);

    p.addTag("law");                                     // /tag @s add law
    const calls = spyOn(p);
    check("between polls the record has not moved", role(p) === null);

    poll();
    check("the record follows", role(p) === "law", String(role(p)));
    check("the tags are exactly what was typed", tagsOf(p) === "law", tagsOf(p));
    check("the poll only read", calls.addTag === 0 && calls.removeTag === 0, JSON.stringify(calls));
    done();
});

test("adding the other role's tag switches the role, in both directions, and takes the old tag off", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["law"] }]);
    check("(setup) law", role(p) === "law");

    p.addTag("outlaw");                                  // /tag @s add outlaw, without removing law
    poll();
    check("law to outlaw", role(p) === "outlaw", String(role(p)));
    check("one role tag, the new one", tagsOf(p) === "outlaw", tagsOf(p));

    p.addTag("law");
    poll();
    check("outlaw to law", role(p) === "law", String(role(p)));
    check("again one role tag, the new one", tagsOf(p) === "law", tagsOf(p));
    done();
});

test("removing the role tag clears the role", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw"] }]);
    check("(setup) outlaw", role(p) === "outlaw");

    p.removeTag("outlaw");
    poll();
    check("no role", role(p) === null, String(role(p)));
    check("and no tag came back", tagsOf(p) === "", tagsOf(p));
    done();
});

test("status tags typed by hand reach the record, and removing them clears it", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw"] }]);

    for (const tag of ["eliminated", "in_jail", "jailed", "send_to_jail", "escort_vulnerable", "winner"]) p.addTag(tag);
    poll();
    const r = state.findRecord(p.id);
    check("eliminated", r.eliminated === true);
    check("in jail", r.inJail === true);
    check("jailed once", r.captures === 1, String(r.captures));
    check("pending jail", r.pendingJail === true);
    check("escort vulnerable", r.escortVulnerable === true);
    check("winner", r.winner === true);
    check("the role is untouched", r.role === "outlaw");

    for (const tag of ["in_jail", "winner", "jailed"]) p.removeTag(tag);
    poll();
    check("no longer in jail", r.inJail === false);
    check("no longer the winner", r.winner === false);
    check("no longer jailed", r.captures === 0, String(r.captures));
    check("the ones left alone stay", r.eliminated === true && r.pendingJail === true && r.escortVulnerable === true);
    done();
});

test("tags the game doesn't manage are ignored, including near misses of the ones it does", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw"] }]);
    const v = state.stateVersion();

    for (const tag of ["vip", "native", "lawyer", "law_abiding", "outlawed", "Law"]) p.addTag(tag);
    poll();

    check("the record did not change", role(p) === "outlaw" && state.stateVersion() === v, `role ${role(p)}, version ${state.stateVersion()} vs ${v}`);
    check("and their tags were left as they were", tagsOf(p) === "Law,law_abiding,lawyer,native,outlaw,outlawed,vip", tagsOf(p));
    done();
});

test("adopting keeps what tags don't carry: ammo, flags and the number of captures", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw", "jailed"] }]);
    state.update(p, { captures: 2 });                    // a second capture: still just the one `jailed` tag
    state.setAmmo(p, "revolver", 4);
    state.setFlag(p, "tutorialSeen", true);

    p.addTag("winner");
    poll();

    const r = state.findRecord(p.id);
    check("the tag was adopted", r.winner === true);
    check("captures kept", r.captures === 2, String(r.captures));
    check("ammo kept", r.ammo.revolver === 4);
    check("flags kept", r.flags.tutorialSeen === true);
    done();
});

test("the game's own change and a hand-typed tag in the same second both survive", () => {
    const { check, done } = checks();
    const [p] = scene(["P"]);

    state.update(p, { role: "law" });
    p.addTag("eliminated");
    poll();

    check("the game's change", role(p) === "law");
    check("the typed tag", state.findRecord(p.id).eliminated === true);
    check("both tags are there", tagsOf(p) === "eliminated,law", tagsOf(p));
    done();
});

test("core/players follows: the poll bumps the state version, so cached answers are rebuilt", () => {
    const { check, done } = checks();
    const [a, b] = scene(["A", { tags: ["outlaw"] }], ["B"]);
    check("(setup) the answers before", names(roster.lawPlayers()) === "" && names(roster.outlaws()) === "A");

    b.addTag("law");
    a.removeTag("outlaw");
    poll();

    check("law", names(roster.lawPlayers()) === "B", names(roster.lawPlayers()));
    check("no outlaws left", names(roster.outlaws()) === "", names(roster.outlaws()));
    done();
});

test("core/players follows within the same tick too: adopting bumps the state version", () => {
    const { check, done } = checks();
    const [a, b] = scene(["A", { tags: ["outlaw"] }], ["B"]);
    roster.lawPlayers(); roster.outlaws();               // answered, and cached, for this tick

    b.addTag("law");
    a.removeTag("outlaw");
    adopt(undefined);                                    // the same tick: only the version says the cache is stale

    check("law", names(roster.lawPlayers()) === "B", names(roster.lawPlayers()));
    check("no outlaws left", names(roster.outlaws()) === "", names(roster.outlaws()));
    done();
});

// ---------------------------------------------------------------------------
// What the poll must not do
// ---------------------------------------------------------------------------

test("a poll that finds nothing new changes nothing: no version bump, no writes, one read per player", () => {
    const { check, done } = checks();
    const [p] = scene(["P"]);
    state.update(p, { role: "law", inJail: true, captures: 1 });          // the game's own write
    const before = state.findRecord(p.id);
    const snapshot = JSON.stringify(before);
    const v = state.stateVersion();
    const calls = spyOn(p);

    poll();

    check("the version is where it was", state.stateVersion() === v, `${state.stateVersion()} vs ${v}`);
    check("the record is the same object and says the same", state.findRecord(p.id) === before && JSON.stringify(before) === snapshot);
    check("one tag read", calls.getTags === 1, String(calls.getTags));
    check("nothing else was called", calls.hasTag === 0 && calls.addTag === 0 && calls.removeTag === 0, JSON.stringify(calls));
    done();
});

test("a change waiting to be written is not overwritten by the older tags the player still carries", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw"] }]);

    state.updateById(p.id, { pendingJail: true, captures: 1 });           // what a death handler does
    const v = state.stateVersion();

    poll();                                              // the tags don't say so yet; the record must win
    const r = state.findRecord(p.id);
    check("the pending change is still there", r.pendingJail === true && r.captures === 1, JSON.stringify(r));
    check("nothing was read into the record", state.stateVersion() === v, `${state.stateVersion()} vs ${v}`);
    check("nothing was written early", tagsOf(p) === "outlaw", tagsOf(p));

    state.syncTags(p);                                   // the respawn
    check("it is written once the player is valid", tagsOf(p) === "jailed,outlaw,send_to_jail", tagsOf(p));

    poll();
    check("and the poll then finds the tags agree with it, and changes nothing", r.pendingJail === true && r.captures === 1 && state.stateVersion() === v, `version ${state.stateVersion()} vs ${v}`);
    done();
});

test("adoptTags settles a pending change, so the poll goes on watching that player", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["law"] }]);

    state.updateById(p.id, { role: "outlaw" });          // pending: the tags still say law
    state.adoptTags(p);                                  // the tags win, and nothing is pending any more
    check("(setup) the tags won", role(p) === "law", String(role(p)));

    p.addTag("winner");                                  // typed by hand afterwards
    poll();

    check("a pending flag that was left behind would have hidden this from the poll", state.findRecord(p.id).winner === true);
    done();
});

test("a player whose handle has gone invalid is skipped, and the others are still read", () => {
    const { check, done } = checks();
    const [gone, other] = scene(["Gone", { tags: ["outlaw"] }], ["Other"]);

    gone.isValid = false;                                // disconnected since the list was taken, still in it
    other.addTag("law");
    poll();

    check("no error reached chat", fake.chat.length === 0, fake.chat.join(" | "));
    check("the others are still read", role(other) === "law", String(role(other)));
    check("the one who left is left alone", state.findRecord(gone.id)?.role === "outlaw");
    done();
});

test("the poll runs once per interval, reads each player once, and shares one player list", () => {
    const { check, done } = checks();
    const [a, b] = scene(["A"], ["B"]);
    const callsA = spyOn(a);
    const callsB = spyOn(b);
    fake.calls.getAllPlayers = 0;

    fake.advance(STATE_SYNC.reconcileIntervalTicks * 3);

    check("three polls, one read per player each", callsA.getTags === 3 && callsB.getTags === 3, `${callsA.getTags} and ${callsB.getTags}`);
    check("no other engine call", callsA.hasTag + callsA.addTag + callsA.removeTag + callsB.hasTag + callsB.addTag + callsB.removeTag === 0);
    check("one player-list fetch per poll", fake.calls.getAllPlayers === 3, String(fake.calls.getAllPlayers));
    done();
});

// ---------------------------------------------------------------------------
// First sight, and resets
// ---------------------------------------------------------------------------

test("a player with no record yet gets one from their tags, without a spawn event", () => {
    const { check, done } = checks();
    scene();
    const late = fake.makePlayer("Late", { tags: ["outlaw", "jailed", "in_jail"] });
    check("(setup) not recorded", state.findRecord(late.id) === undefined);

    poll();

    const r = state.findRecord(late.id);
    check("recorded from their tags", r?.role === "outlaw" && r.inJail === true && r.captures === 1, JSON.stringify(r));
    check("their tags are untouched", tagsOf(late) === "in_jail,jailed,outlaw", tagsOf(late));
    done();
});

test("a player first seen carrying both role tags is law, and carries only that one afterwards", () => {
    const { check, done } = checks();
    const [p] = scene(["Both", { tags: ["law", "outlaw"] }]);

    check("law, as adoption always chose", role(p) === "law", String(role(p)));
    check("only the tag that won is left", tagsOf(p) === "law", tagsOf(p));
    done();
});

test("after a round reset the poll starts everyone again from what they carry, which is nothing", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["law", "in_jail"] }]);
    check("(setup) recorded as law", role(p) === "law");

    resetAllSystems();
    check("no records and no tags", state.allRecords().length === 0 && tagsOf(p) === "", tagsOf(p));

    poll();
    const r = state.findRecord(p.id);
    check("a blank record", r?.role === null && r.inJail === false, JSON.stringify(r));
    check("no tag came back", tagsOf(p) === "", tagsOf(p));
    done();
});

// ---------------------------------------------------------------------------
// /scriptevent rae:adopt
// ---------------------------------------------------------------------------

test("rae:adopt is a registered script event", () => {
    assert.ok(listScriptEvents().includes("rae:adopt"), listScriptEvents().join());
});

test("rae:adopt reads the tags right now and tells the player what every record says", () => {
    const { check, done } = checks();
    const [me, other] = scene(["Me"], ["Other", { tags: ["outlaw", "jailed", "in_jail"] }], ["Plain"]);
    me.addTag("law");

    adopt(me);                                           // no time passes

    check("the record changed at once", role(me) === "law", String(role(me)));

    const lines = me.messages.map(strip);
    check("a summary comes first", lines[0] === "Adopt: 3 read, 1 changed", lines[0]);
    check("every record is listed", lines.includes("  Me: law") && lines.includes("  Other: outlaw jailed in_jail") && lines.includes("  Plain: no role"), lines.join(" | "));
    check("only the player who asked is told", other.messages.length === 0 && fake.chat.length === 0);
    done();
});

test("rae:adopt from a command block updates the records and says nothing", () => {
    const { check, done } = checks();
    const [p] = scene(["P"]);
    p.addTag("outlaw");

    adopt(undefined);

    check("the record changed", role(p) === "outlaw", String(role(p)));
    check("nothing was said", fake.chat.length === 0 && p.messages.length === 0, `${fake.chat.join(" | ")} ${p.messages.join(" | ")}`);
    done();
});

test("rae:adopt leaves a record with a change waiting to be written alone, and says so", () => {
    const { check, done } = checks();
    const [me, p] = scene(["Me"], ["P", { tags: ["outlaw"] }]);
    state.updateById(p.id, { pendingJail: true });
    p.addTag("law");                                     // typed while that change is still waiting

    adopt(me);

    check("the summary says what was skipped", strip(me.messages[0]) === "Adopt: 2 read, 0 changed, 1 skipped (change pending)", strip(me.messages[0]));
    check("the pending change survived", state.findRecord(p.id).pendingJail === true && role(p) === "outlaw");
    done();
});

test("rae:adopt skips a player whose handle is invalid, without an error", () => {
    const { check, done } = checks();
    const [me, gone] = scene(["Me"], ["Gone", { tags: ["outlaw"] }]);
    gone.isValid = false;
    me.addTag("law");

    adopt(me);

    check("no error reached chat", fake.chat.length === 0, fake.chat.join(" | "));
    check("the summary counts only who could be read", strip(me.messages[0]) === "Adopt: 1 read, 1 changed", strip(me.messages[0]));
    check("the list has no line for the one who left", !me.messages.some((m) => strip(m).includes("Gone")), me.messages.map(strip).join(" | "));
    check("the others are still read", role(me) === "law");
    done();
});
