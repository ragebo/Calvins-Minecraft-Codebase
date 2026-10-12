import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fake, world, fakeApi, load, checks } from "./helpers.mjs";

// The camera intro (core/startsequence.ts, started by core/game.ts's begin() right after the start commands): the players who are playing are
// locked in place and watch 2 shots picked at random from the ones saved, 10 seconds in all, then everything carries on as it did. It is cut
// short, cleanly, by a round reset or another Start; it is skipped when nothing is saved or it is switched off; and whoever it leaves locked,
// by a reload or a disconnect, is let go at the next load or join. Time is the fake's: `fake.advance(n)` moves n ticks.

const { InputPermissionCategory } = fakeApi;
const game = await load("core/game.js");
const store = await load("core/startstore.js");
const round = await load("core/round.js");
const S = await load("core/startsequence.js");
const L = await load("logic/start.js");
const { START } = await load("config/balance.js");
const { LAW_SPAWNS } = await load("config/world.js");

const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

/** A shot whose start is at x = n * 100 and whose end is 50 further on, so a camera call says which shot it belongs to. */
function saveShot(n) {
    const made = L.makeShot(`s${n}`, `Shot ${n}`, { x: n * 100, y: 70, z: 0, pitch: 10, yaw: 0 }, { x: n * 100 + 50, y: 80, z: 20, pitch: -5, yaw: 90 });
    assert.ok(made.ok, made.reason);
    assert.equal(store.saveShot(made.value).ok, true);
}

/** What a player's camera was told, short enough to compare: a place is its x, an ease adds ~ and the seconds, a clear is "clear". */
const calls = (player) => player.camera.calls.map((c) => (c.method === "clear" ? "clear" : `${c.options.location.x}${c.options.easeOptions ? `~${c.options.easeOptions.easeTime}` : ""}`));

const moving = (player) => player.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement);

/** A world with Ada (law), Bob (outlaw) and Sid (sitting out), the start commands emptied, and `shots` shots saved (1 to n). */
function scene(shots) {
    fake.reset();
    store.forgetLoaded();
    S.forgetIntro();
    round.resetRound();
    fake.addObjective("coins");
    fake.addObjective("bounty");

    const [ada, bob, sid] = ["Ada", "Bob", "Sid"].map((n) => fake.makePlayer(n));
    fake.advance(1);

    // The safety net clears every camera on the first tick of a module's life; what these tests read is what the intro does after that.
    for (const p of [ada, bob, sid]) p.camera.calls.length = 0;

    store.saveStartCommands([]);
    for (let n = 1; n <= shots; n++) saveShot(n);

    return { ada, bob, sid };
}

const start = ({ ada, bob, sid }) => game.startChosenRound(new Map([[ada, "law"], [bob, "outlaw"], [sid, "sit_out"]]));

/** Runs `body` with Math.random answering 0, which for three shots picks s2 then s3 (the order b, c, a), and puts it back. */
function withRandomZero(body) {
    const real = Math.random;
    Math.random = () => 0;
    try { body(); } finally { Math.random = real; }
}

/** Runs `body` with one of START's numbers changed, and puts it back. */
function withConfig(name, value, body) {
    const before = START[name];
    START[name] = value;
    try { body(); } finally { START[name] = before; }
}

test("the intro plays the shots one after the other for the players who are playing, 10 seconds in all, then everything carries on", () => {
    const { check, done } = checks();
    const world3 = scene(3);
    const { ada, bob, sid } = world3;

    withRandomZero(() => {
        check("a start went ahead", start(world3).ok === true);

        check("playing players are locked", !moving(ada) && !moving(bob));
        check("the one sitting out is not", moving(sid) && calls(sid).length === 0);
        check("both players see the first shot: it appears at x 200 and eases to 250 over 5 seconds", calls(ada).join() === "200,250~5" && calls(bob).join() === "200,250~5", `${calls(ada)} / ${calls(bob)}`);
        check("nobody has been moved or shown a title yet", round.getPhase() === "SETUP" && !LAW_SPAWNS.some((s) => sameSpot(s, ada.location)));

        fake.advance(99);
        check("one tick before the cut it is still the first shot", calls(ada).join() === "200,250~5");

        fake.advance(1);
        check("at 5 seconds the second shot takes over, for both", calls(ada).join() === "200,250~5,300,350~5" && calls(bob).join() === "200,250~5,300,350~5", `${calls(ada)}`);
        check("still locked", !moving(ada) && !moving(bob));

        fake.advance(99);
        check("one tick before the end nothing has finished", !moving(ada) && calls(ada).length === 4 && !LAW_SPAWNS.some((s) => sameSpot(s, ada.location)));

        fake.advance(1);
        check("at 10 seconds everyone is let go and has their own camera back", moving(ada) && moving(bob) && calls(ada).join() === "200,250~5,300,350~5,clear" && calls(bob).at(-1) === "clear");
        check("and the start carries on: law is sent to a law spawn", LAW_SPAWNS.some((s) => sameSpot(s, ada.location)));

        fake.advance(60);
        check("play begins after the old reveal delay", round.getPhase() === "ACTIVE");
    });
    done();
});

test("with one shot saved the whole intro is that shot", () => {
    const { check, done } = checks();
    const world1 = scene(1);

    start(world1);

    check("one shot, eased over all 10 seconds", calls(world1.ada).join() === "100,150~10", calls(world1.ada).join());

    fake.advance(200);
    check("and it ends at 10 seconds", moving(world1.ada) && calls(world1.ada).at(-1) === "clear");
    done();
});

test("it is shared evenly however many shots a start plays", () => {
    const { check, done } = checks();

    withConfig("shotsPerStart", 3, () => {
        const world3 = scene(3);

        withRandomZero(() => {
            start(world3);
            fake.advance(1);
            check("three shots: each eases over 10 / 3 seconds", calls(world3.ada).join() === `200,250~${10 / 3}`, calls(world3.ada).join());
        });
    });
    done();
});

test("a start never opens with the shot it opened with last time, when there is another", () => {
    const { check, done } = checks();
    const world3 = scene(3);

    withRandomZero(() => {
        start(world3);
        check("the first start opens with s2 (x 200)", calls(world3.ada)[0] === "200", calls(world3.ada).join());

        fake.advance(400);
        world3.ada.camera.calls.length = 0;

        start(world3);
        check("the next one is told s2 opened last time, so it opens with s3 (x 300)", calls(world3.ada)[0] === "300", calls(world3.ada).join());
    });
    fake.advance(400);
    done();
});

test("a round reset in the middle lets everyone go at once and nothing after it runs", () => {
    const { check, done } = checks();
    const world3 = scene(3);
    const { ada, bob } = world3;

    withRandomZero(() => {
        start(world3);
        fake.advance(50);
        game.resetGame();

        check("everyone can move again and has their own camera", moving(ada) && moving(bob) && calls(ada).at(-1) === "clear" && calls(bob).at(-1) === "clear", `${calls(ada)}`);

        const seen = calls(ada).length;
        fake.advance(400);

        check("no later shot, no teleport, no play", calls(ada).length === seen && !LAW_SPAWNS.some((s) => sameSpot(s, ada.location)) && round.getPhase() === "IDLE", `${calls(ada)} ${round.getPhase()}`);
    });
    done();
});

test("a second Start in the middle takes over cleanly: one intro at a time, the old one's timers do nothing", () => {
    const { check, done } = checks();
    const world3 = scene(3);
    const { ada } = world3;

    withRandomZero(() => {
        start(world3);
        fake.advance(50);
        start(world3);

        // The first intro was cancelled (cleared), then the second began: s3 opens because s2 opened last time.
        check("cleared, then the new intro starts at once", calls(ada).join() === "200,250~5,clear,300,350~5", calls(ada).join());

        fake.advance(50);
        check("the old intro's cut at 100 ticks did not happen (this is only tick 50 of the new one)", calls(ada).length === 5, calls(ada).join());

        fake.advance(50);
        check("the new intro's own cut, at 100 ticks after it began", calls(ada).length === 7 && calls(ada).at(-2) === "200", calls(ada).join());

        fake.advance(400);
        check("it ends once, with play beginning once", round.getPhase() === "ACTIVE" && moving(ada));
    });
    done();
});

test("with no shots saved, nothing changes: no camera, no lock, and the start carries on at once", () => {
    const { check, done } = checks();
    const none = scene(0);
    const { ada, bob } = none;

    start(none);

    check("no camera call", ada.camera.calls.length === 0 && bob.camera.calls.length === 0);
    check("nobody was locked", moving(ada) && moving(bob));
    check("law is sent to a spawn straight away", LAW_SPAWNS.some((s) => sameSpot(s, ada.location)));

    fake.advance(60);
    check("play begins after the old reveal delay", round.getPhase() === "ACTIVE");
    done();
});

test("with the intro switched off, saved shots are not played", () => {
    const { check, done } = checks();

    withConfig("introEnabled", false, () => {
        const off = scene(3);

        start(off);
        check("no camera, no lock", off.ada.camera.calls.length === 0 && moving(off.ada));
        check("on to the spawns at once", LAW_SPAWNS.some((s) => sameSpot(s, off.ada.location)));
    });
    fake.advance(60);
    done();
});

test("an intro of no seconds is no intro", () => {
    const { check, done } = checks();

    withConfig("introSeconds", 0, () => {
        const zero = scene(3);

        start(zero);
        check("no camera, no lock, on to the spawns at once", zero.ada.camera.calls.length === 0 && moving(zero.ada) && LAW_SPAWNS.some((s) => sameSpot(s, zero.ada.location)));
    });
    fake.advance(60);
    done();
});

test("with nobody to show it to the intro does not wait: what comes after it is called at once", () => {
    scene(3);

    let called = 0;
    S.startIntro([], () => { called++; });

    assert.equal(called, 1);
});

test("a player who leaves during the intro does not stop it for the others", () => {
    const { check, done } = checks();
    const world3 = scene(3);
    const { ada, bob } = world3;

    withRandomZero(() => {
        start(world3);
        fake.advance(50);
        bob.isValid = false;
        fake.advance(60);

        check("the shot after the one they left in still reached Ada", calls(ada).join() === "200,250~5,300,350~5", calls(ada).join());

        // The intro ends at tick 200 and play begins 60 ticks later, at 260: this is tick 260.
        fake.advance(150);
        check("Ada was let go at the end and play began", moving(ada) && round.getPhase() === "ACTIVE");
    });
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------------------------------------------

test("a player who joins is let go, unless an intro is holding them", () => {
    const { check, done } = checks();
    const world3 = scene(3);
    const { ada, sid } = world3;

    withRandomZero(() => {
        start(world3);

        // Sid is not in the intro. Locked by something that went wrong earlier; joining lets them go.
        fake.players.find((p) => p === sid).inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false);
        world.afterEvents.playerSpawn.emit({ player: sid, initialSpawn: true });
        fake.advance(1);
        check("Sid is free", moving(sid));

        world.afterEvents.playerSpawn.emit({ player: ada, initialSpawn: false });
        fake.advance(1);
        check("Ada, who is in the intro, stays locked", !moving(ada));
    });
    fake.advance(400);
    done();
});

// This test comes last on purpose: it imports a second copy of the module (what a reload is), and that copy's own spawn handler, with its own
// empty record of who is held, would unlock everyone who spawns in any test after it. In the game there is only ever one copy.
test("a player a reload left locked is let go at the next load, with their camera", async () => {
    const { check, done } = checks();
    fake.reset();

    const ada = fake.makePlayer("Ada");
    const C = await load("core/cinematic.js");
    C.lock(ada);
    ada.camera.calls.length = 0;
    check("locked, as a reload mid-intro would leave them", !moving(ada));

    // A second copy of the module, which is what the scripts loading again amounts to: its first-tick handler replaces the first copy's.
    const url = pathToFileURL(path.resolve(import.meta.dirname, "..", ".test-build", "core", "startsequence.js")).href;
    await import(`${url}?reload=${Date.now()}`);
    fake.advance(1);

    check("free to move", moving(ada));
    check("with their own camera", calls(ada).join() === "clear", calls(ada).join());
    done();
});
