import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks } from "./helpers.mjs";

// What ARCH-03 added to core/state and core/players: the jail-site slot, prisoners(), recordOf(), and
// adopting every player early (at load, and at every spawn) so a record exists before any death.
//
// Only core modules are loaded here, deliberately: a system's own spawn handler (jail:spawn reads a
// record too) would mask a missing "state:adopt". The jail systems' use of all this is in jail-flow.test.mjs.

// A player who is already in the world when the addon loads: nobody fires a spawn event for them, so only
// the load-time adoption can have given them a record. Created BEFORE core/state is imported.
const veteran = fake.makePlayer("Veteran", { id: "veteran-1", tags: ["outlaw", "jailed", "in_jail"] });

const state = await load("core/state.js");
const roster = await load("core/players.js");
const { JAIL_SITES } = await load("config/world.js");
const { resetAllSystems, listSystems } = await load("core/registry.js");

const names = (list) => list.map((p) => p.name).sort().join(",");
const tagsOf = (p) => [...p.tags].sort().join(",");
const spawn = (player, initialSpawn = false) => world.afterEvents.playerSpawn.emit({ player, initialSpawn });

/** An empty world with fresh module state, and a tick gone by so the per-tick player list starts over. */
function scene(...specs) {
    fake.reset();
    resetAllSystems();
    const players = specs.map(([name, options]) => fake.makePlayer(name, options));
    fake.advance(1);
    return players;
}

// ---------------------------------------------------------------------------
// Adopt at load
// ---------------------------------------------------------------------------

test("adopt at load: a player already in the world gets a record on the first tick, read from their tags", () => {
    const { check, done } = checks();
    check("nothing is recorded before a tick passes", state.findRecord("veteran-1") === undefined);

    fake.advance(1);

    const record = state.findRecord("veteran-1");
    check("a record exists", record !== undefined);
    check("the role comes from the tags", record?.role === "outlaw", String(record?.role));
    check("so does the jail status", record?.captures === 1 && record?.inJail === true, JSON.stringify(record));
    check("and nothing is pending", record?.pendingJail === false && record?.eliminated === false);
    check("adopting reads tags and writes none", tagsOf(veteran) === "in_jail,jailed,outlaw", tagsOf(veteran));
    done();
});

// ---------------------------------------------------------------------------
// Adopt at spawn
// ---------------------------------------------------------------------------

test("adopt at spawn: a joining player gets a record from the tags they carry, before anything else can ask", () => {
    const { check, done } = checks();
    scene();
    const late = fake.makePlayer("Late", { tags: ["law"] });
    check("(setup) not recorded yet", state.findRecord(late.id) === undefined);

    spawn(late, true);

    const record = state.findRecord(late.id);
    check("recorded by the spawn", record?.role === "law", JSON.stringify(record));
    check("their tags are untouched", tagsOf(late) === "law", tagsOf(late));
    done();
});

test("adopt at spawn: an existing record is kept, not re-read from the tags", () => {
    const { check, done } = checks();
    scene();
    const p = fake.makePlayer("P", { tags: ["outlaw"] });
    state.update(p, { role: "law" });                    // the record says law, and the tag now does too
    p.tags.delete("law"); p.tags.add("outlaw");          // something outside the game rewrote the tags

    spawn(p);

    // Spawning doesn't look at the tags. It is the poll, up to a second later, that adopts a tag typed by hand (state-adopt.test.mjs).
    check("the record is the truth", state.findRecord(p.id)?.role === "law", String(state.findRecord(p.id)?.role));
    done();
});

test("adopt at spawn: what changed by id while the player was dead is written to their tags now", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw"] }]);
    spawn(p, true);

    p.isValid = false;                                   // the death handler's view of them
    state.updateById(p.id, { winner: true, escortVulnerable: true });
    check("(setup) nothing was written while the handle was invalid", tagsOf(p) === "outlaw", tagsOf(p));

    p.isValid = true;
    spawn(p);
    check("the respawn writes it", tagsOf(p) === "escort_vulnerable,outlaw,winner", tagsOf(p));
    done();
});

// ---------------------------------------------------------------------------
// recordOf: for handlers that may hold an invalid entity
// ---------------------------------------------------------------------------

test("recordOf: an existing record is returned without touching the entity", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw"] }]);
    state.getRecord(p);
    p.isValid = false;
    const touched = [];
    for (const method of ["hasTag", "addTag", "removeTag", "getTags"]) {
        const original = p[method];
        p[method] = (...args) => { touched.push(method); return original.apply(p, args); };
    }
    check("the record comes back", state.recordOf(p)?.role === "outlaw");
    check("no entity method was called", touched.length === 0, touched.join());
    done();
});

test("recordOf: a player the game never saw is read from their tags while the handle is valid", () => {
    const { check, done } = checks();
    scene();
    const stranger = fake.makePlayer("Stranger", { tags: ["law", "eliminated"] });
    const record = state.recordOf(stranger);
    check("read from the tags", record?.role === "law" && record?.eliminated === true, JSON.stringify(record));
    check("and remembered", state.findRecord(stranger.id) === record);
    done();
});

test("recordOf: a player the game never saw, with an invalid handle, has no record and gets none", () => {
    const { check, done } = checks();
    scene();
    const ghost = fake.makePlayer("Ghost", { tags: ["outlaw"] });
    ghost.isValid = false;
    let record = "unset";
    let threw = null;
    try { record = state.recordOf(ghost); } catch (e) { threw = e; }
    check("nothing throws", threw === null, String(threw));
    check("there is nothing to go on", record === undefined, JSON.stringify(record));
    check("no blank record is invented", state.findRecord(ghost.id) === undefined);
    done();
});

// ---------------------------------------------------------------------------
// core/players: prisoners(), and queries over a player list that holds a stale handle
// ---------------------------------------------------------------------------

test("prisoners(): everyone whose record says in jail, and only players who are online", () => {
    const { check, done } = checks();
    const [, , prisoner, ghostPrisoner, gone] = scene(
        ["Law", { tags: ["law"] }],
        ["Free", { tags: ["outlaw"] }],
        ["Prisoner", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["GhostPrisoner", { tags: ["outlaw", "jailed", "in_jail", "eliminated"] }],   // eliminated while still in jail
        ["Gone", { tags: ["outlaw", "jailed", "in_jail"] }]);

    check("held or eliminated-in-jail, all who are online", names(roster.prisoners()) === "GhostPrisoner,Gone,Prisoner", names(roster.prisoners()));

    gone.remove();                                       // disconnects
    fake.advance(1);
    check("someone who left is not counted", names(roster.prisoners()) === "GhostPrisoner,Prisoner", names(roster.prisoners()));

    state.update(prisoner, { inJail: false });
    check("freeing a prisoner is visible at once, in the same tick", names(roster.prisoners()) === "GhostPrisoner", names(roster.prisoners()));

    state.update(ghostPrisoner, { inJail: false });
    check("an empty jail is an empty list", roster.prisoners().length === 0);
    done();
});

test("prisoners(): one player-list fetch per tick, like every other query", () => {
    scene(["A", { tags: ["outlaw", "in_jail"] }], ["B", { tags: ["outlaw"] }]);
    fake.calls.getAllPlayers = 0;
    roster.prisoners(); roster.prisoners(); roster.freeOutlaws(); roster.outlaws();
    assert.equal(fake.calls.getAllPlayers, 1);
});

test("queries: a cached player list holding a disconnected player who was never recorded doesn't break them", () => {
    const { check, done } = checks();
    scene();
    const late = fake.makePlayer("Late", { tags: ["outlaw"] });
    const other = fake.makePlayer("Other", { tags: ["outlaw"] });
    state.getRecord(other);
    roster.players();                                    // this tick's list now includes Late, who has no record
    late.isValid = false;                                // and who has just disconnected
    let threw = null;
    let result = null;
    try { result = names(roster.outlaws()); } catch (e) { threw = e; }
    check("no throw", threw === null, String(threw));
    check("the unrecorded invalid player is in no answer, the others are", result === "Other", String(result));
    done();
});

// ---------------------------------------------------------------------------
// The jail-site slot
// ---------------------------------------------------------------------------

test("jail site: empty until chosen, holds what is set, and setting it bumps the version only when it changes", () => {
    const { check, done } = checks();
    scene();
    check("empty to begin with", state.getJailSite() === null);

    const v0 = state.stateVersion();
    state.setJailSite(JAIL_SITES[0]);
    check("holds the site", state.getJailSite() === JAIL_SITES[0]);
    check("the version rose", state.stateVersion() > v0);

    const v1 = state.stateVersion();
    state.setJailSite(JAIL_SITES[0]);
    check("setting the same site again is not a change", state.stateVersion() === v1);

    state.setJailSite(JAIL_SITES[1]);
    check("a different site is", state.getJailSite() === JAIL_SITES[1] && state.stateVersion() > v1);

    const v2 = state.stateVersion();
    state.setJailSite(null);
    check("it can be cleared", state.getJailSite() === null && state.stateVersion() > v2);
    done();
});

test("jail site: a round reset clears it, whether the whole game resets or only state", () => {
    const { check, done } = checks();
    scene();
    state.setJailSite(JAIL_SITES[1]);
    resetAllSystems();
    check("everything reset", state.getJailSite() === null);

    state.setJailSite(JAIL_SITES[1]);
    listSystems().find((s) => s.name === "state").reset();
    check("state's own reset", state.getJailSite() === null);
    done();
});

// ---------------------------------------------------------------------------
// A reset forgets everyone
// ---------------------------------------------------------------------------

test("reset: records are forgotten with the tags, and the next spawn adopts from scratch", () => {
    const { check, done } = checks();
    const [p] = scene(["P", { tags: ["outlaw", "jailed", "in_jail"] }]);
    spawn(p, true);
    check("(setup) recorded", state.findRecord(p.id)?.inJail === true);

    resetAllSystems();
    check("no record", state.findRecord(p.id) === undefined && state.allRecords().length === 0);
    check("no tags", p.tags.size === 0, tagsOf(p));

    spawn(p);
    check("adopted again from what they carry now (nothing)", state.findRecord(p.id)?.role === null && state.findRecord(p.id)?.inJail === false, JSON.stringify(state.findRecord(p.id)));
    done();
});
