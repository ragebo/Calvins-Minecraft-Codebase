import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks, strip } from "./helpers.mjs";
import { buttonsOf, close, fill, press, problems, script, titleOf, ui } from "./robbery-ui.mjs";
import { L, at, ok, added } from "./robbery-fixtures.mjs";

// Guards: the `spawn` effect. Mobs (pillagers on the way through a bank) appear when an element is done, a lock jams, or the robbery
// starts, wins or fails; they come one after another; they carry a tag saying whose they are; and the site being put back takes them
// away again whatever happened to the run (stopped, reset, won and timed out, deleted, a round reset, a crash and a reload).
// What the REAL game does with a spawned pillager is unmeasured: docs/test-cards/ROBBERY-GUARDS.md is what measures it.

const { PlayerPermissionLevel } = fakeApi;
const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const F = await load("core/robberyforms.js");
const Run = await load("core/robberyrun.js");
const World = await load("core/robberyworld.js");
const M = await load("logic/robberymeta.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
await load("systems/robberyrun.js");
const { ROBBERY: R } = await load("config/balance.js");

fake.entityTypes.add("pillager");
fake.entityTypes.add("vindicator");
fake.entityTypes.add("zombie");

const ALARM = [300, 65, 300];
const SAFE = [302, 65, 300];
const SPOT = [310, 65, 305];
const AREA = { min: [290, 60, 290], max: [320, 80, 320] };
const IN_AREA = { x: 301, y: 65, z: 297 };

const overworld = fake.dimension("overworld");

const spawn = (extra = {}) => ({ kind: "spawn", entity: "minecraft:pillager", count: 3, at: SPOT, ...extra });

/** Two switches: the alarm (what the test hangs its effects on) and a safe that ends the robbery with a win. */
function site({ onDone = [], onFail = [], start = [], win = [], locks = [] } = {}) {
    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    r = ok(L.setArea(r, AREA.min, AREA.max));
    r = added(L.addElement(r, { kind: "switch", name: "Alarm", cells: [ALARM], locks, onDone, onFail })).robbery;
    r = added(L.addElement(r, { kind: "switch", name: "Safe", cells: [SAFE], onDone: [{ kind: "end", result: "win" }] })).robbery;
    if (start.length > 0) r = ok(L.setHook(r, "start", start));
    if (win.length > 0) r = ok(L.setHook(r, "win", win));
    return r;
}

function setup(options = {}) {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.placeBlock("overworld", at(ALARM), "minecraft:stone_button");
    fake.placeBlock("overworld", at(SAFE), "minecraft:stone_button");
    const saved = S.saveRobbery(site(options));
    assert.equal(saved.ok, true, saved.reason);
}

const outlaw = (name = "Ada") => {
    const player = fake.makePlayer(name, { location: { ...IN_AREA }, inventory: true });
    state.update(player, { role: "outlaw" });
    return player;
};

const ref = (pos) => S.boundAt("overworld", pos[0], pos[1], pos[2]);
const touch = (player, pos) => Run.touch(player, ref(pos));
const guards = () => fake.entities.filter((e) => e.isValid && e.hasTag(R.guardTag));
const guardsOf = (robbery) => guards().filter((e) => e.hasTag(`${R.guardTagPrefix}${robbery}`));
/** Long enough for every mob of a wave to have come, whatever the loop's rhythm. */
const afterWave = (count = 3) => fake.advance(count * R.spawnGapTicks + R.tickEvery * 2);

// ---------------------------------------------------------------------------------------------------------
// The effect as data
// ---------------------------------------------------------------------------------------------------------

test("a spawn effect is a mob, a count and a block, and is saved and read back exactly", () => {
    const { check, done } = checks();

    const made = ok(L.setHook(ok(L.newRobbery("bank", "The Bank", "overworld")), "start", [spawn({ delaySeconds: 4 }), spawn({ entity: "minecraft:vindicator", count: 1, at: [-250, 70, 12] })]));
    const saved = L.serialize(made);
    const back = L.parse(saved);

    check("it reads back as it was", back.ok === true && JSON.stringify(back.value) === JSON.stringify(made), saved.slice(0, 200));
    check("with its delay, and without one", back.ok && back.value.hooks.start[0].delaySeconds === 4 && back.value.hooks.start[1].delaySeconds === undefined);
    check("a negative coordinate survives", back.ok && back.value.hooks.start[1].at.join() === "-250,70,12");
    check("it is saved in the short form", /"a":"spn"/.test(saved) && /"e":"minecraft:pillager"/.test(saved), saved);
    check("spawn is one of the effect kinds", L.EFFECT_KINDS.includes("spawn"));
    done();
});

test("a spawn effect that makes no sense is refused with a sentence", () => {
    const { check, done } = checks();
    const bad = (extra) => L.validateEffect(spawn(extra));
    const why = (result) => (result.ok ? "" : result.reason);

    check("a good one is fine", bad({}).ok === true);
    check("a mob needs its namespace", /looks like minecraft:pillager/.test(why(bad({ entity: "pillager" }))));
    check("a mob id is lowercase", bad({ entity: "Minecraft:Pillager" }).ok === false);
    check("a mob id is not a sentence", bad({ entity: "a pillager please" }).ok === false);
    check("a mob id is not empty", bad({ entity: "" }).ok === false);
    check("a mob id is not endless", bad({ entity: `minecraft:${"a".repeat(80)}` }).ok === false);
    check("none is refused", /how many mobs/.test(why(bad({ count: 0 }))));
    check("too many is refused", /how many mobs/.test(why(bad({ count: R.maxSpawnCount + 1 }))));
    check("the most is allowed", bad({ count: R.maxSpawnCount }).ok === true);
    check("half a mob is refused", bad({ count: 1.5 }).ok === false);
    check("a position needs three numbers", /where the mobs appear/.test(why(bad({ at: [1, 2] }))));
    check("a position is whole numbers", bad({ at: [1, 2.5, 3] }).ok === false);
    check("a position is on the map", bad({ at: [R.maxCoordinate + 1, 65, 0] }).ok === false);
    check("the overworld has a floor", /outside the overworld build limit/.test(why(bad({ at: [0, -100, 0] }))));
    check("and a nether position is judged by the nether, not the overworld", L.validateEffect(spawn({ at: [0, 200, 0] }), "nether").ok === true);
    check("a delay is checked like any effect's", bad({ delaySeconds: R.maxDelaySeconds + 1 }).ok === false);
    done();
});

test("a robbery can spawn only so many mobs in all, counted over every list", () => {
    const { check, done } = checks();
    const withGuards = (...counts) => {
        let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
        r = added(L.addElement(r, { kind: "switch", name: "Alarm", cells: [ALARM], onDone: counts.slice(0, 2).map((count) => spawn({ count })), onFail: counts.slice(2, 3).map((count) => spawn({ count })) })).robbery;
        return r;
    };

    check("exactly the limit is fine", L.parse(L.serialize(ok(L.setHook(withGuards(10, 10), "win", [spawn({ count: 10 })])))).ok === true);
    const over = L.setHook(withGuards(10, 10), "win", [spawn({ count: 10 }), spawn({ count: 1 })]);
    check("one more is refused, and says how many it would have spawned", over.ok === false && /at most 30 mobs in all \(this one would spawn 31\)/.test(over.reason), over.reason);
    check("the jam effects count too", L.setHook(withGuards(10, 10, 10), "start", [spawn({ count: 1 })]).ok === false);
    check("so do the start and fail hooks", L.setHook(ok(L.setHook(withGuards(10, 10), "start", [spawn({ count: 10 })])), "fail", [spawn({ count: 1 })]).ok === false);
    done();
});

test("a spawn effect has nobody to go to, so it never asks for the area to be set", () => {
    const { check, done } = checks();
    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    r = added(L.addElement(r, { kind: "switch", name: "Alarm", cells: [ALARM], onDone: [spawn(), { kind: "end", result: "win" }] })).robbery;
    r = ok(L.setSettings(r, { failWhenEmptySeconds: 0 }));

    check("only an area-wide effect needs the area", L.whyNotRunnable(r).length === 0, L.whyNotRunnable(r).join("; "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The builder's words
// ---------------------------------------------------------------------------------------------------------

test("the spawn effect is asked for and described in plain words", () => {
    const { check, done } = checks();
    const fields = M.effectFields("spawn");

    check("the fields", fields.map((f) => f.key).join() === "entity,count,x,y,z,delaySeconds", fields.map((f) => f.key).join());
    check("the coordinates take a minus sign", fields.filter((f) => ["x", "y", "z"].includes(f.key)).every((f) => f.signed === true));
    check("it is called Spawn mobs", M.EFFECT_LABELS.spawn === "Spawn mobs");
    check("it reads as a sentence", M.describeEffect(spawn()) === "Spawn 3 pillager at 310, 65, 305", M.describeEffect(spawn()));
    check("with its wait", M.describeEffect(spawn({ delaySeconds: 5 })) === "Spawn 3 pillager at 310, 65, 305 after 5s");

    const answer = (extra) => ({ entity: "minecraft:pillager", count: 3, x: 1, y: 65, z: -2, delaySeconds: 0, ...extra });
    const made = L.validateEffect(M.effectFromAnswers("spawn", answer()));
    check("the answers make an effect", made.ok && made.value.at.join() === "1,65,-2" && made.value.count === 3, JSON.stringify(made));
    check("a bare mob name gets its namespace", L.validateEffect(M.effectFromAnswers("spawn", answer({ entity: "Pillager" }))).value?.entity === "minecraft:pillager");
    check("a namespaced one is left alone", L.validateEffect(M.effectFromAnswers("spawn", answer({ entity: "bountysys:guard" }))).value?.entity === "bountysys:guard");
    check("a blank one is refused by the validator", L.validateEffect(M.effectFromAnswers("spawn", answer({ entity: "  " }))).ok === false);
    done();
});

test("a form's coordinate can be negative, and nothing else about a number changes", () => {
    const { check, done } = checks();
    const signed = { kind: "number", key: "x", label: "X", what: "x", min: -100, max: 100, value: 0, signed: true };
    const plain = { ...signed, signed: undefined };
    const read = (field, text) => M.readAnswers([field], [text]);

    check("minus 12", read(signed, "-12").ok && read(signed, "-12").value.x === -12);
    check("12", read(signed, "12").value?.x === 12);
    check("a plus sign is not a number", read(signed, "+12").ok === false);
    check("a decimal is not a whole number", read(signed, "1.5").ok === false);
    check("words are not numbers", read(signed, "abc").ok === false);
    check("a lone minus is not a number", read(signed, "-").ok === false);
    check("below the least is refused, naming the range", /from -100 to 100/.test(read(signed, "-101").reason ?? ""));
    check("above the most is refused", read(signed, "101").ok === false);
    check("an ordinary number field still refuses a minus", read(plain, "-5").ok === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The world layer
// ---------------------------------------------------------------------------------------------------------

test("the game is asked whether it knows a mob, as typed and then with the namespace", () => {
    const { check, done } = checks();

    check("a mob it knows", World.mobKnown("minecraft:pillager"));
    check("a bare name for one it knows", World.mobKnown("pillager"));
    check("a mob it does not know", World.mobKnown("minecraft:not_a_mob") === false);
    check("nonsense", World.mobKnown("") === false);
    done();
});

test("the game's mob lookup may want the minecraft: namespace or may not: both are tried", () => {
    const { check, done } = checks();
    const { EntityTypes } = fakeApi;
    const real = EntityTypes.get;

    // Narrows what the lookup answers to the ids `accepts` approves, as a game that is strict about the namespace would be.
    const strictly = (accepts, body) => {
        EntityTypes.get = (id) => (accepts(id) ? real(id) : undefined);
        try { body(); } finally { EntityTypes.get = real; }
    };

    strictly((id) => id.startsWith("minecraft:"), () => {
        check("typed bare, for a game that wants the namespace", World.mobKnown("pillager"));
        check("typed with it, for a game that wants it", World.mobKnown("minecraft:pillager"));
    });

    strictly((id) => !id.includes(":"), () => {
        check("typed with the namespace, for a game that wants none", World.mobKnown("minecraft:pillager"));
        check("typed bare, for a game that wants none", World.mobKnown("pillager"));
    });

    strictly(() => true, () => check("a mob the game has never heard of is still not found, either way", !World.mobKnown("not_a_mob") && !World.mobKnown("minecraft:not_a_mob")));
    done();
});

test("a guard is made in the middle of its block, tagged as every guard and as its robbery's", () => {
    fake.reset();
    const { check, done } = checks();

    check("it is made", World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT) === true);

    const [mob] = guards();
    check("one mob, of the right kind, in the middle of the block", guards().length === 1 && mob.typeId === "minecraft:pillager" && mob.location.x === 310.5 && mob.location.y === 65 && mob.location.z === 305.5, JSON.stringify(mob?.location));
    check("tagged as a guard and as the bank's", mob.hasTag("rbg") && mob.hasTag("rbg:bank"));
    check("and it says whose it is", World.guardOf(mob) === "bank");
    check("a mob that is not a guard says nothing", World.guardOf(fake.makeEntity({ typeId: "minecraft:cow", dimension: overworld })) === undefined);
    done();
});

test("a mob the game refuses to make is one line in the log, not a crash", () => {
    fake.reset();
    const { check, done } = checks();
    const original = console.warn;
    const lines = [];
    const spawnEntity = overworld.spawnEntity;

    console.warn = (...args) => lines.push(args.join(" "));
    overworld.spawnEntity = () => { throw new Error("no such entity"); };

    try {
        const first = World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT);
        const second = World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT);
        check("false both times", first === false && second === false);
    } finally {
        overworld.spawnEntity = spawnEntity;
        console.warn = original;
    }

    check("nothing was made", guards().length === 0);
    check("one line says why, once", lines.filter((l) => /could not spawn minecraft:pillager at 310,65,305: no such entity/.test(l)).length === 1, lines.join(" | "));
    done();
});

test("taking guards away takes only that robbery's, in every dimension", () => {
    fake.reset();
    const { check, done } = checks();

    World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT);
    World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT);
    World.spawnGuard("nether", "bank", "minecraft:zombie", [5, 70, 5]);
    World.spawnGuard("overworld", "fort", "minecraft:pillager", SPOT);
    const cow = fake.makeEntity({ typeId: "minecraft:cow", dimension: overworld });

    check("three of the bank's go", World.removeGuards("bank") === 3);
    check("the fort's guard and the cow stay", guards().length === 1 && guardsOf("fort").length === 1 && cow.isValid === true);
    check("nothing left to take", World.removeGuards("bank") === 0);
    done();
});

test("a sweep takes the guards of robberies that are not running, and nobody else's", () => {
    fake.reset();
    const { check, done } = checks();

    World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT);
    World.spawnGuard("overworld", "fort", "minecraft:pillager", SPOT);
    World.spawnGuard("overworld", "fort", "minecraft:pillager", SPOT);
    const orphan = fake.makeEntity({ typeId: "minecraft:zombie", dimension: overworld });
    orphan.addTag("rbg");                                       // a guard that lost the tag that says whose

    const removed = World.removeStrayGuards((robbery) => robbery === "fort");

    check("the bank's and the orphan went", removed === 2 && orphan.isValid === false && guardsOf("bank").length === 0);
    check("the running robbery's stayed", guardsOf("fort").length === 2);
    done();
});

test("a guard that loads is removed if its robbery is not running, and left alone if it is", () => {
    fake.reset();
    const { check, done } = checks();

    World.spawnGuard("overworld", "bank", "minecraft:pillager", SPOT);
    World.spawnGuard("overworld", "fort", "minecraft:pillager", SPOT);
    const [bank, fort] = guards();
    const cow = fake.makeEntity({ typeId: "minecraft:cow", dimension: overworld });

    check("not running: removed", World.removeIfStray(bank, (robbery) => robbery === "fort") === true && bank.isValid === false);
    check("running: left", World.removeIfStray(fort, (robbery) => robbery === "fort") === false && fort.isValid === true);
    check("not a guard at all: left", World.removeIfStray(cow, () => false) === false && cow.isValid === true);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// In a run
// ---------------------------------------------------------------------------------------------------------

test("an element that is done spawns its mobs one after another, where it was told", () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);

    check("the first is there at once", guards().length === 1, String(guards().length));
    check("but not all of them", guardsOf("bank").length < 3);

    fake.advance(R.spawnGapTicks - 1);
    check("and the next is not due yet: they are really spaced out, not just late", guards().length === 1, String(guards().length));

    afterWave();

    check("then all three", guardsOf("bank").length === 3, String(guardsOf("bank").length));
    check("pillagers, at the spot", guards().every((g) => g.typeId === "minecraft:pillager" && g.location.x === 310.5 && g.location.z === 305.5));
    done();
});

test("the effect's own wait is kept", () => {
    setup({ onDone: [spawn({ count: 2, delaySeconds: 2 })] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    fake.advance(30);
    check("nothing yet after a second and a half", guards().length === 0);

    fake.advance(20 + R.tickEvery);
    check("the first has come", guards().length >= 1);

    afterWave(2);
    check("then the second", guards().length === 2);
    done();
});

test("mobs can come when the robbery starts", () => {
    setup({ start: [spawn({ count: 2 })] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SAFE);                                            // starts it
    afterWave(2);
    check("the start hook's two", guardsOf("bank").length === 2 && guards().every((g) => g.typeId === "minecraft:pillager"));
    done();
});

test("mobs appear in the robbery's own dimension", () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    const { check, done } = checks();

    let r = ok(L.newRobbery("vault", "The Nether Vault", "nether"));
    r = added(L.addElement(r, { kind: "switch", name: "Alarm", cells: [[10, 70, 10]], onDone: [spawn({ count: 1, at: [12, 70, 12] }), { kind: "end", result: "win" }] })).robbery;
    r = ok(L.setSettings(r, { failWhenEmptySeconds: 0, outlawsOnly: false }));
    fake.placeBlock("nether", { x: 10, y: 70, z: 10 }, "minecraft:stone_button");
    assert.equal(S.saveRobbery(r).ok, true);

    const ada = fake.makePlayer("Ada", { location: { x: 10, y: 70, z: 8 }, inventory: true });
    Run.touch(ada, S.boundAt("nether", 10, 70, 10));

    check("it came, in the nether, and not in the overworld", fake.dimension("nether").spawned.length === 1 && overworld.spawned.length === 0);
    done();
});

test("a robbery that is stopped before they have all come spawns no more, and loses the ones that came", () => {
    setup({ onDone: [spawn({ count: 5 })] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    check("one so far", guards().length === 1);

    // A site still waiting to be put back keeps the stopped run alive (the janitor deletes a run only once its site is clean), so
    // the mobs still queued fall due while it lingers: only the check in the wave itself stops them. This note can never be put
    // back, and it is made after the start because a dirty site cannot be started.
    fake.setUnloaded("overworld", [{ from: { x: 890, y: 0, z: 890 }, to: { x: 910, y: 100, z: 910 } }]);
    S.markDirty({ robbery: "bank", dimension: "overworld", pos: [900, 65, 900], action: "close" });

    Run.stopRobbery("bank");
    afterWave(5);
    check("the run is still there, which is what lets the queue fall due", Run.viewOf("bank") !== undefined);
    check("no more mobs were MADE after the stop (counted by the game's own spawn calls, so the clean-up cannot hide a late one)", overworld.spawned.length === 1, String(overworld.spawned.length));

    fake.advance(R.janitorEvery * 2);
    check("none are left", guards().length === 0, String(guards().length));
    done();
});

test("after a win the guards stay until the site is put back, and then they go", () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    afterWave();
    touch(ada, SAFE);                                            // the win

    check("won", Run.viewOf("bank")?.phase === "ended");
    check("they are still there, a win does not wipe the floor", guardsOf("bank").length === 3);

    fake.advance(R.janitorEvery * 3);
    check("still there before the reset time", guardsOf("bank").length === 3);

    // A chunk loading in the meantime is not a reload: the run is still waiting to be put back, so its guards are not strays.
    world.afterEvents.entityLoad.emit({ entity: guardsOf("bank")[0] });
    check("a guard that loads while the run waits for its reset stays", guardsOf("bank").length === 3);

    fake.advance(60 * 20 + R.janitorEvery * 2);
    check("gone once the site is put back", guards().length === 0, String(guards().length));
    check("and the robbery can start again", Run.viewOf("bank") === undefined);
    done();
});

test("resetting by hand takes them at once", () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    afterWave();
    check("three", guardsOf("bank").length === 3);

    Run.resetSiteNow("bank");
    check("none, at once", guards().length === 0);
    done();
});

test("a robbery deleted while it runs loses its guards", () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    afterWave();
    check("three", guardsOf("bank").length === 3);

    S.deleteRobbery("bank");
    fake.advance(R.tickEvery * 2);
    check("none", guards().length === 0, String(guards().length));
    done();
});

test("a round reset drops the run, and with it every guard", () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    afterWave();
    check("three", guardsOf("bank").length === 3);

    resetAllSystems();
    check("none", guards().length === 0, String(guards().length));
    done();
});

test("a guard left by a crash is a stray when its chunk loads: nothing is running, so it goes", () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);
    afterWave();

    // A reload loses the run but not the guards (they are saved with their chunk), so a guard that loads belongs to a robbery
    // that is not running. The fake cannot lose the run; it can show the same thing with a guard whose robbery has no run at all.
    const [mob] = guardsOf("bank");
    mob.addTag("rbg:ghost");
    mob.removeTag("rbg:bank");

    world.afterEvents.entityLoad.emit({ entity: mob });
    check("a guard of a robbery with no run goes when it loads", mob.isValid === false);

    const [other] = guardsOf("bank");
    world.afterEvents.entityLoad.emit({ entity: other });
    check("one of the running robbery stays", other.isValid === true);
    done();
});

test("a mob the game will not make does not stop the robbery", () => {
    setup({ onDone: [spawn({ entity: "minecraft:pillager" }), { kind: "reward", coins: 0, bounty: 5, to: "actor" }] });
    const { check, done } = checks();
    const ada = outlaw();
    const original = console.warn;
    const spawnEntity = overworld.spawnEntity;

    console.warn = () => {};
    overworld.spawnEntity = () => { throw new Error("no"); };

    try {
        touch(ada, ALARM);
        afterWave();
    } finally {
        overworld.spawnEntity = spawnEntity;
        console.warn = original;
    }

    check("the element is done and the effect after it ran", Run.viewOf("bank")?.elements.find((e) => e.name === "Alarm")?.state === "done" && world.scoreboard.getObjective("bounty").getScore(ada) === 5);
    check("and no mob came", guards().length === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The builder's screens
// ---------------------------------------------------------------------------------------------------------

const builder = (where = { x: 120.7, y: 64, z: -33.2 }) => fake.makePlayer("Builder", { location: where, permission: PlayerPermissionLevel.Operator });
const said = (player) => player.messages.map(strip);
const alarmElement = () => S.getRobbery("bank").elements.find((e) => e.name === "Alarm");
const spawnEffects = () => alarmElement().onDone.filter((e) => e.kind === "spawn");

async function openAlarm(op, ...steps) {
    script(press("When it is done"), ...steps);
    await F.openElementMenu(op, "bank", alarmElement().id);
}

test("every effects screen offers Add: spawn mobs", async () => {
    setup();
    const { check, done } = checks();
    const op = builder();

    script(press("When it is done"), close, close);
    await F.openElementMenu(op, "bank", alarmElement().id);
    const buttons = buttonsOf(ui.shown.find((form) => /when it is done/.test(strip(titleOf(form))))).map(strip);

    check("on an element's screen", buttons.includes("Add: spawn mobs"), buttons.join(" | "));
    check("between paying out and ending", buttons.indexOf("Add: pay out") < buttons.indexOf("Add: spawn mobs") && buttons.indexOf("Add: spawn mobs") < buttons.indexOf("Add: end the robbery"));
    done();
});

test("a new spawn effect starts where the builder stands, and a mob's bare name is enough", async () => {
    setup();
    const { check, done } = checks();
    const op = builder();

    await openAlarm(op, press("Add: spawn mobs"), fill({ "The mob": "Pillager", "How many": "4" }), close, close);

    const form = ui.shown.find((f) => strip(titleOf(f)) === "Spawn mobs");
    const fields = form.calls.filter((c) => c[0] === "textField");
    const defaults = fields.map((c) => c[3]?.defaultValue);

    check("the form started as: pillager, 3, and the builder's own block", defaults.join() === "minecraft:pillager,3,120,64,-34,0", defaults.join());
    check("an effect was saved", spawnEffects().length === 1, JSON.stringify(alarmElement().onDone));
    check("the bare name got its namespace, and the rest are as filled", spawnEffects()[0].entity === "minecraft:pillager" && spawnEffects()[0].count === 4 && spawnEffects()[0].at.join() === "120,64,-34");
    check("the builder was told", said(op).some((m) => /^Added\./.test(m)), said(op).join(" | "));
    check("nothing went wrong in the stand-in", problems.length === 0, problems.join("\n"));
    done();
});

test("a coordinate with a minus sign is typed as it is", async () => {
    setup();
    const { check, done } = checks();
    const op = builder();

    await openAlarm(op, press("Add: spawn mobs"), fill({ "Where: X": "-250", "Where: Z": "-1000" }), close, close);

    check("saved with both", spawnEffects()[0]?.at.join() === "-250,64,-1000", JSON.stringify(spawnEffects()));
    done();
});

test("a mob the game does not know is refused, with what to try", async () => {
    setup();
    const { check, done } = checks();
    const op = builder();

    await openAlarm(op, press("Add: spawn mobs"), fill({ "The mob": "minecraft:dragonn" }), close, close);

    check("nothing was saved", spawnEffects().length === 0);
    check("the builder is told the name and what works", said(op).some((m) => /The game has no mob called minecraft:dragonn\. Try minecraft:pillager/.test(m)), said(op).join(" | "));
    done();
});

test("a count that is too big is refused by the form, and the robbery is left as it was", async () => {
    setup();
    const { check, done } = checks();
    const op = builder();

    await openAlarm(op, press("Add: spawn mobs"), fill({ "How many": "99" }), close, close);

    check("nothing was saved", spawnEffects().length === 0);
    check("the builder is told the range", said(op).some((m) => /how many must be a whole number from 1 to 10/i.test(m)), said(op).join(" | "));
    done();
});

test("an effect more than the robbery may spawn is refused up front", async () => {
    setup({ onDone: [spawn({ count: 10 }), spawn({ count: 10 })], win: [spawn({ count: 10 })] });
    const { check, done } = checks();
    const op = builder();

    await openAlarm(op, press("Add: spawn mobs"), fill({ "How many": "1" }), close, close);

    check("refused, saying why", said(op).some((m) => /Not changed: .*at most 30 mobs in all \(this one would spawn 31\)/.test(m)), said(op).join(" | "));
    check("and the three that were there are", spawnEffects().length === 2);
    done();
});

test("a spawn effect that is there can be changed and deleted", async () => {
    setup({ onDone: [spawn()] });
    const { check, done } = checks();
    const op = builder();

    await openAlarm(op, press("Spawn 3 pillager at 310, 65, 305"), fill({ "How many": "2", "The mob": "vindicator" }), close, close);
    const changed = spawnEffects()[0];
    check("changed", changed?.count === 2 && changed.entity === "minecraft:vindicator" && changed.at.join() === "310,65,305", JSON.stringify(changed));

    ui.shown.length = 0;
    await openAlarm(op, press("Spawn 2 vindicator"), fill({ "Delete this effect": true }), close, close);
    check("deleted", spawnEffects().length === 0, JSON.stringify(alarmElement().onDone));
    check("the stand-in never lost its way", problems.length === 0, problems.join("\n"));
    done();
});
