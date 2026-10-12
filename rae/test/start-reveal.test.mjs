import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, close, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// The end of a start (core/startsequence.ts's startPlacement, after the intro or straight after the start commands): roles are revealed,
// outlaws are put at a random outlaw spawn and fly down to it, law choose a spawn from a screen (two may choose the same one; no choice, or a
// closed screen, means a random one), and play begins when every law player has chosen AND the outlaws' fly-down is over, or when the
// countdown runs out. Everyone is locked from the reveal until play begins. Whatever happens, play begins exactly once, and a reset or another
// Start cancels it. A script cannot close a form, so an answer that comes after the countdown is ignored.

const { InputPermissionCategory } = fakeApi;
const game = await load("core/game.js");
const store = await load("core/startstore.js");
const round = await load("core/round.js");
const S = await load("core/startsequence.js");
const L = await load("logic/start.js");
const { START } = await load("config/balance.js");
const { LAW_SPAWNS, OUTLAW_SPAWNS } = await load("config/world.js");

const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const at = (list, p) => list.findIndex((s) => sameSpot(s, p.location));
const moving = (p) => p.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement);
const titlesOf = (p) => p.titles.map((t) => strip(String(t)));
const calls = (p) => p.camera.calls.map((c) => (c.method === "clear" ? "clear" : `${c.options.location.x}${c.options.easeOptions ? `~${c.options.easeOptions.easeTime}` : ""}`));

const FLY_DOWN_TICKS = START.flyDownSeconds * 20;
const PICK_TICKS = START.pickSeconds * 20;

/** Lets every promise a form is waiting on settle. */
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** How many times play began since the last call, counted from the round's own phase changes. */
function activations() {
    let count = 0;
    const stop = round.onPhase("ACTIVE", () => { count++; });
    return { count: () => count, stop };
}

/** Names the players and starts a world with them; the start commands are emptied and no shot is saved unless asked. */
function scene(names, { shots = 0 } = {}) {
    fake.reset();
    store.forgetLoaded();
    S.forgetIntro();
    round.resetRound();
    ui.shown.length = 0;
    problems.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");

    const made = names.map((n) => fake.makePlayer(n));
    fake.advance(1);
    for (const p of made) p.camera.calls.length = 0;

    store.saveStartCommands([]);

    for (let n = 1; n <= shots; n++) {
        const shot = L.makeShot(`s${n}`, `Shot ${n}`, { x: n * 100, y: 70, z: 0, pitch: 10, yaw: 0 }, { x: n * 100 + 50, y: 80, z: 20, pitch: -5, yaw: 90 });
        assert.equal(store.saveShot(shot.value).ok, true);
    }

    return made;
}

const start = (roles) => game.startChosenRound(new Map(roles));

/** Presses a spawn for whoever is named, and closes the screen for everyone else. */
const choose = (who, text) => (form) => (form.player.name === who ? press(text)(form) : close());

// ---------------------------------------------------------------------------------------------------------

test("roles are revealed the moment the stage begins, and there is no Rolling... any more", async () => {
    const { check, done } = checks();
    const [ada, bob, sid] = scene(["Ada", "Bob", "Sid"]);
    script(() => new Promise(() => {}));

    start([[ada, "law"], [bob, "outlaw"], [sid, "sit_out"]]);

    check("Ada is told LAWMAN at once", titlesOf(ada).includes("LAWMAN"), titlesOf(ada).join());
    check("Bob is told OUTLAW at once", titlesOf(bob).includes("OUTLAW"), titlesOf(bob).join());
    check("the one sitting out is told nothing", titlesOf(sid).length === 0);
    check("everyone hears it", fake.chat.some((c) => strip(c).includes("Roles Assigned!")));
    check("and nobody is ever shown Rolling...", [ada, bob, sid].every((p) => !titlesOf(p).some((t) => t.includes("Rolling"))));

    fake.advance(PICK_TICKS + 10);
    done();
});

test("an outlaw lands at one of the outlaw spawns and flies down to it, locked until play begins", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    script(() => new Promise(() => {}));

    start([[ada, "law"], [bob, "outlaw"]]);

    const x = bob.location.x;

    check("at an outlaw spawn", at(OUTLAW_SPAWNS, bob) >= 0, JSON.stringify(bob.location));
    check("the camera comes down from above it and eases to eye level over 3 seconds", calls(bob).join() === `${x},${x}~${START.flyDownSeconds}`, calls(bob).join());
    check("locked", !moving(bob));

    fake.advance(FLY_DOWN_TICKS - 1);
    check("still locked a tick before the fly-down ends (play waits for law)", !moving(bob) && round.getPhase() === "SETUP");
    fake.advance(PICK_TICKS + 5);
    done();
});

test("law players get a screen of the law spawns, and choosing sends them there", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    script(press("Law spawn 2"));
    const played = activations();

    start([[ada, "law"], [bob, "outlaw"]]);

    const shown = ui.shown.filter((s) => s.player === ada);
    check("one screen, for the law player only", ui.shown.length === 1 && shown.length === 1);
    check("a title that says what to do", strip(titleOf(shown[0])).includes("Choose your spawn"), titleOf(shown[0]));
    check("one button per law spawn, named as the menu names them", buttonsOf(shown[0]).map(strip).join(" | ") === LAW_SPAWNS.map((_, i) => `Law spawn ${i + 1}`).join(" | "), buttonsOf(shown[0]).join(" | "));
    check("it says how long there is", strip(shown[0].calls.find((c) => c[0] === "body")?.[1] ?? "").includes(`${START.pickSeconds} seconds`));

    check("before the answer Ada has not been moved", at(LAW_SPAWNS, ada) < 0);
    await settle();
    check("after it she is at the second law spawn", at(LAW_SPAWNS, ada) === 1, JSON.stringify(ada.location));

    check("play waits for the outlaw's fly-down: not yet", round.getPhase() === "SETUP" && played.count() === 0);
    fake.advance(FLY_DOWN_TICKS - 1);
    check("one tick before the end of the fly-down, still not", round.getPhase() === "SETUP");
    fake.advance(1);
    check("at the end of the fly-down play begins, once", round.getPhase() === "ACTIVE" && played.count() === 1);
    check("everyone is let go and has their own camera", moving(ada) && moving(bob) && calls(bob).at(-1) === "clear" && calls(ada).at(-1) === "clear");
    played.stop();
    done();
});

test("two law players may choose the same spawn", async () => {
    const { check, done } = checks();
    const [ada, ann, bob] = scene(["Ada", "Ann", "Bob"]);
    script(press("Law spawn 1"), press("Law spawn 1"));

    start([[ada, "law"], [ann, "law"], [bob, "outlaw"]]);
    await settle();

    check("both are at the first law spawn", at(LAW_SPAWNS, ada) === 0 && at(LAW_SPAWNS, ann) === 0, `${JSON.stringify(ada.location)} ${JSON.stringify(ann.location)}`);
    fake.advance(FLY_DOWN_TICKS);
    check("play began", round.getPhase() === "ACTIVE");
    done();
});

test("a law player who never answers is given a random spawn when the countdown ends, and play begins then and not before", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    let release;
    script(() => new Promise((resolve) => { release = resolve; }));
    const played = activations();

    start([[ada, "law"], [bob, "outlaw"]]);
    await settle();

    fake.advance(PICK_TICKS - 1);
    check("one tick before the countdown ends: not moved, still setting up, still locked", at(LAW_SPAWNS, ada) < 0 && round.getPhase() === "SETUP" && !moving(ada) && !moving(bob));

    fake.advance(1);
    check("at the end: placed at a law spawn", at(LAW_SPAWNS, ada) >= 0, JSON.stringify(ada.location));
    check("play begins, once", round.getPhase() === "ACTIVE" && played.count() === 1);
    check("everyone is let go", moving(ada) && moving(bob));

    const where = JSON.stringify(ada.location);
    release({ canceled: false, selection: 1 });
    await settle();
    fake.advance(10);
    check("an answer that comes after the countdown does nothing: she is not moved, and play does not begin again", JSON.stringify(ada.location) === where && played.count() === 1);
    played.stop();
    done();
});

test("closing the screen means a random spawn at once, and does not wait for the countdown", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    script(close);

    start([[ada, "law"], [bob, "outlaw"]]);
    await settle();

    check("placed at once at a law spawn", at(LAW_SPAWNS, ada) >= 0);
    fake.advance(FLY_DOWN_TICKS);
    check("play begins when the fly-down is over, not at 20 seconds", round.getPhase() === "ACTIVE");
    done();
});

test("a random spawn is random: it follows the dice, for a closed screen and for a countdown that ran out", async () => {
    const { check, done } = checks();
    const real = Math.random;

    try {
        for (const [dice, expected] of [[0, 0], [0.99, LAW_SPAWNS.length - 1]]) {
            Math.random = () => dice;

            const [ada, bob] = scene(["Ada", "Bob"]);
            script(close);
            start([[ada, "law"], [bob, "outlaw"]]);
            await settle();
            check(`a closed screen with the dice at ${dice}: spawn ${expected + 1}`, at(LAW_SPAWNS, ada) === expected, JSON.stringify(ada.location));
            fake.advance(PICK_TICKS);

            const [cy, dee] = scene(["Cy", "Dee"]);
            script(() => new Promise(() => {}));
            start([[cy, "law"], [dee, "outlaw"]]);
            await settle();
            fake.advance(PICK_TICKS);
            check(`a countdown that ran out with the dice at ${dice}: spawn ${expected + 1}`, at(LAW_SPAWNS, cy) === expected, JSON.stringify(cy.location));
        }
    } finally {
        Math.random = real;
    }
    done();
});

test("with no law players there is no screen, and play begins when the fly-down is over", async () => {
    const { check, done } = checks();
    const [bob, cy] = scene(["Bob", "Cy"]);

    start([[bob, "outlaw"], [cy, "outlaw"]]);
    await settle();

    check("no screen was shown", ui.shown.length === 0);
    check("both are at outlaw spawns", at(OUTLAW_SPAWNS, bob) >= 0 && at(OUTLAW_SPAWNS, cy) >= 0);

    fake.advance(FLY_DOWN_TICKS - 1);
    check("not a tick early", round.getPhase() === "SETUP");
    fake.advance(1);
    check("then play begins", round.getPhase() === "ACTIVE" && moving(bob) && moving(cy));
    done();
});

test("with only law players, play begins the moment the last one has chosen", async () => {
    const { check, done } = checks();
    const [ada, ann] = scene(["Ada", "Ann"]);
    script(press("Law spawn 1"), press("Law spawn 2"));
    const played = activations();

    start([[ada, "law"], [ann, "law"]]);
    check("not before they have", round.getPhase() === "SETUP");
    await settle();

    check("play began at once, with nothing to wait for", round.getPhase() === "ACTIVE" && played.count() === 1 && moving(ada) && moving(ann));
    check("each where they chose", at(LAW_SPAWNS, ada) === 0 && at(LAW_SPAWNS, ann) === 1);
    played.stop();
    done();
});

test("with no fly-down time there is nothing to wait for: play begins as soon as law have chosen, or at once with no law", async () => {
    const { check, done } = checks();
    const before = START.flyDownSeconds;
    START.flyDownSeconds = 0;

    try {
        const [bob, cy] = scene(["Bob", "Cy"]);
        start([[bob, "outlaw"], [cy, "outlaw"]]);
        check("only outlaws: play began at once", round.getPhase() === "ACTIVE" && moving(bob) && moving(cy));

        const [ada, dee] = scene(["Ada", "Dee"]);
        script(press("Law spawn 1"));
        start([[ada, "law"], [dee, "outlaw"]]);
        check("a law player still choosing: not yet", round.getPhase() === "SETUP");
        await settle();
        check("she chose: play began at once, without waiting for any fly-down", round.getPhase() === "ACTIVE" && moving(ada) && moving(dee));
    } finally {
        START.flyDownSeconds = before;
    }
    done();
});

test("a countdown shorter than the fly-down does not cut the fly-down short", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    script(() => new Promise(() => {}));
    const before = START.pickSeconds;
    START.pickSeconds = 1;

    try {
        start([[ada, "law"], [bob, "outlaw"]]);
        await settle();
        fake.advance(30);
        check("at 1.5 seconds the fly-down is still going: no play, no clear", round.getPhase() === "SETUP" && calls(bob).at(-1) !== "clear");
        fake.advance(30);
        check("when it ends play begins", round.getPhase() === "ACTIVE");
    } finally {
        START.pickSeconds = before;
    }
    done();
});

test("a round reset in the middle cancels everything: no teleport, no play, no locks, and a late answer is ignored", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    let release;
    script(() => new Promise((resolve) => { release = resolve; }));
    const played = activations();

    start([[ada, "law"], [bob, "outlaw"]]);
    await settle();
    fake.advance(20);
    game.resetGame();

    check("everyone can move and has their own camera", moving(ada) && moving(bob) && calls(bob).at(-1) === "clear");

    const where = JSON.stringify(ada.location);
    release({ canceled: false, selection: 0 });
    await settle();
    fake.advance(PICK_TICKS + 100);

    check("nothing moved her, and play never began", JSON.stringify(ada.location) === where && played.count() === 0 && round.getPhase() === "IDLE", `${round.getPhase()} ${played.count()}`);
    played.stop();
    done();
});

test("a second Start in the middle takes over: the first one's countdown and answer do nothing", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    const releases = [];
    script(() => new Promise((resolve) => releases.push(resolve)), () => new Promise((resolve) => releases.push(resolve)));
    const played = activations();

    start([[ada, "law"], [bob, "outlaw"]]);
    await settle();
    fake.advance(100);
    start([[ada, "law"], [bob, "outlaw"]]);
    await settle();

    // The first screen's answer arrives now: it belongs to the first Start.
    releases[0]({ canceled: false, selection: 0 });
    await settle();
    check("the first start's answer did not place her", at(LAW_SPAWNS, ada) < 0, JSON.stringify(ada.location));

    fake.advance(PICK_TICKS - 100);
    check("the first start's countdown (which would have ended now) did nothing", round.getPhase() === "SETUP" && played.count() === 0);

    fake.advance(100);
    check("the second start's own countdown ends: she is placed and play begins, once", at(LAW_SPAWNS, ada) >= 0 && round.getPhase() === "ACTIVE" && played.count() === 1, `${round.getPhase()} ${played.count()}`);
    played.stop();
    done();
});

test("a law player who leaves does not hold play up: the others finish it", async () => {
    const { check, done } = checks();
    const [ada, ann, bob] = scene(["Ada", "Ann", "Bob"]);
    let release;
    // One response per screen, in the order the screens are shown: Ada's first (she never answers), then Ann's.
    script(() => new Promise((resolve) => { release = resolve; }), press("Law spawn 1"));

    start([[ada, "law"], [ann, "law"], [bob, "outlaw"]]);
    await settle();
    ada.isValid = false;
    fake.advance(FLY_DOWN_TICKS);

    check("Ann chose and Ada is gone: play begins at the end of the fly-down, not at 20 seconds", round.getPhase() === "ACTIVE" && at(LAW_SPAWNS, ann) === 0);
    release?.({ canceled: true });
    done();
});

test("a player who leaves during the fly-down does not stop play beginning", async () => {
    const { check, done } = checks();
    const [ada, bob] = scene(["Ada", "Bob"]);
    script(press("Law spawn 1"));

    start([[ada, "law"], [bob, "outlaw"]]);
    await settle();
    bob.isValid = false;
    fake.advance(FLY_DOWN_TICKS);

    check("play began", round.getPhase() === "ACTIVE" && moving(ada));
    done();
});

test("the whole of a start: commands, a 10 second intro, the reveal, a pick, the fly-down, then play", async () => {
    const { check, done } = checks();
    const [ada, bob, sid] = scene(["Ada", "Bob", "Sid"], { shots: 3 });
    script(press("Law spawn 2"));
    const played = activations();
    const real = Math.random;
    Math.random = () => 0;

    try {
        start([[ada, "law"], [bob, "outlaw"], [sid, "sit_out"]]);

        check("during the intro nobody has a title and the form has not been shown", titlesOf(ada).length === 0 && ui.shown.length === 0);

        fake.advance(199);
        check("a tick before the intro ends, still no reveal", titlesOf(ada).length === 0 && ui.shown.length === 0);

        fake.advance(1);
        check("at 10 seconds the roles are revealed and the screen appears", titlesOf(ada).includes("LAWMAN") && ui.shown.length === 1);
        await settle();
        check("she chose the second spawn", at(LAW_SPAWNS, ada) === 1);

        fake.advance(FLY_DOWN_TICKS);
        check("play begins 3 seconds after the intro: 13 seconds in all", round.getPhase() === "ACTIVE" && played.count() === 1);
    } finally {
        Math.random = real;
    }
    played.stop();
    done();
});

test("the screens had no problems with the stand-in's choices", () => {
    assert.deepEqual(problems, []);
});
