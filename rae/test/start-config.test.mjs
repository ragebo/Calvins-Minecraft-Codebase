import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks } from "./helpers.mjs";
import { ui, script, close } from "./robbery-ui.mjs";

// The START numbers in the live config editor (core/configoverrides.ts): whether the camera intro plays, how long it lasts, how many shots a Start
// plays, how long law have to choose a spawn, and the outlaws' fly-down. Each is a registered setting with a range, changes the NEXT Start, and
// resets to its default. The point is not only that they register but that a Start reads them: a setting nothing reads would be worse than none.

const { PlayerPermissionLevel, InputPermissionCategory, CustomCommandStatus } = fakeApi;
const O = await load("core/configoverrides.js");
const game = await load("core/game.js");
const store = await load("core/startstore.js");
const round = await load("core/round.js");
const S = await load("core/startsequence.js");
const L = await load("logic/start.js");
const { START } = await load("config/balance.js");
const { OUTLAW_SPAWNS } = await load("config/world.js");
await load("systems/liveconfig.js");

const GROUP = "Start sequence";
const IDS = ["start.introEnabled", "start.introSeconds", "start.shotsPerStart", "start.pickSeconds", "start.flyDownSeconds", "start.flyDownHeight"];

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const moving = (p) => p.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement);
const calls = (p) => p.camera.calls.map((c) => (c.method === "clear" ? "clear" : `${c.options.location.x}${c.options.easeOptions ? `~${c.options.easeOptions.easeTime}` : ""}`));

function scene(shots = 0) {
    fake.reset();
    store.forgetLoaded();
    S.forgetIntro();
    round.resetRound();
    ui.shown.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");

    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    const ada = fake.makePlayer("Ada");
    const bob = fake.makePlayer("Bob");
    fake.advance(1);
    for (const p of [op, ada, bob]) p.camera.calls.length = 0;

    store.saveStartCommands([]);

    for (let n = 1; n <= shots; n++) {
        const shot = L.makeShot(`s${n}`, `Shot ${n}`, { x: n * 100, y: 70, z: 0, pitch: 10, yaw: 0 }, { x: n * 100 + 50, y: 80, z: 20, pitch: -5, yaw: 90 });
        assert.equal(store.saveShot(shot.value).ok, true);
    }

    return { op, ada, bob };
}

const start = ({ ada, bob }) => game.startChosenRound(new Map([[ada, "law"], [bob, "outlaw"]]));

/** Sets a setting the way the editor does, runs `body`, and puts it back whatever happens. */
async function withSetting(op, id, value, body) {
    const set = O.setOverride(op, id, value);
    assert.equal(set.ok, true, set.reason);
    try { await body(); } finally { O.resetOverride(op, id); }
}

test("the six settings are registered, in a group of their own, with a range and a label that says what they do", () => {
    const { check, done } = checks();

    check("all six exist", IDS.every((id) => O.getField(id) !== undefined), IDS.filter((id) => !O.getField(id)).join());
    check("in the group Start sequence, which the editor lists", O.listCategories().includes(GROUP) && IDS.every((id) => O.getField(id)?.category === GROUP));
    check("the right kinds", O.getField("start.introEnabled").kind === "boolean" && ["start.introSeconds", "start.shotsPerStart", "start.pickSeconds", "start.flyDownHeight"].every((id) => O.getField(id).kind === "integer") && O.getField("start.flyDownSeconds").kind === "float");
    check("each label starts with Start: and says more than a name", IDS.every((id) => /^Start: /.test(O.getField(id).label) && O.getField(id).label.length > 30), IDS.map((id) => O.getField(id).label).join(" | "));
    check("the intro length says that 0 skips it", /0/.test(O.getField("start.introSeconds").label) && /skip/i.test(O.getField("start.introSeconds").label));
    check("they start at the START config's values", O.getField("start.introSeconds").get() === START.introSeconds && O.getField("start.pickSeconds").get() === START.pickSeconds && O.getField("start.introEnabled").get() === true);
    done();
});

test("each setting refuses what it cannot take, and says the range", () => {
    const { check, done } = checks();
    const { op } = scene();
    const refused = (label, id, value, mentions) => {
        const before = O.getField(id).get();
        const result = O.setOverride(op, id, value);
        check(label, result.ok === false && result.reason.includes(mentions) && O.getField(id).get() === before, JSON.stringify(result));
    };

    refused("an intro of -1 seconds", "start.introSeconds", -1, "0");
    refused("an intro of 2.5 seconds is not whole", "start.introSeconds", 2.5, "whole");
    refused("an intro of more than two minutes", "start.introSeconds", 121, "120");
    refused("more shots than can be saved", "start.shotsPerStart", START.maxShots + 1, String(START.maxShots));
    refused("no time to choose", "start.pickSeconds", 0, "1");
    refused("a fly-down of 11 seconds", "start.flyDownSeconds", 11, "10");
    refused("a fly-down from no height", "start.flyDownHeight", 0, "1");
    refused("a number is not a switch", "start.introEnabled", 1, "true or false");

    check("a fly-down of 2.5 seconds is fine, it is a decimal", O.setOverride(op, "start.flyDownSeconds", 2.5).ok === true && START.flyDownSeconds === 2.5);
    O.resetOverride(op, "start.flyDownSeconds");

    check("a member cannot change them", O.setOverride(fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member }), "start.pickSeconds", 5).ok === false && START.pickSeconds === 20);
    done();
});

test("every setting goes back to its default, and says so", () => {
    const { check, done } = checks();
    const { op } = scene();
    const changes = [["start.introEnabled", false], ["start.introSeconds", 30], ["start.shotsPerStart", 4], ["start.pickSeconds", 60], ["start.flyDownSeconds", 5], ["start.flyDownHeight", 90]];
    const defaults = changes.map(([id]) => O.getField(id).get());

    changes.forEach(([id, value]) => O.setOverride(op, id, value));
    check("all six changed", changes.every(([id, value]) => O.getField(id).get() === value));

    changes.forEach(([id]) => O.resetOverride(op, id));
    check("all six are back", changes.every(([id], i) => O.getField(id).get() === defaults[i]), changes.map(([id]) => O.getField(id).get()).join());
    done();
});

test("typed as /rae:config set, the setting changes the next Start", async () => {
    const { check, done } = checks();
    const registry = (fake.reset(), fake.startUp());
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });

    const set = registry.run("rae:config", { sourceEntity: op }, "set", "start.pickSeconds", "5");
    check("it worked and said from what to what", set.status === CustomCommandStatus.Success && /start\.pickSeconds: 20 -> 5/.test(set.message), JSON.stringify(set));
    check("the config now says 5", START.pickSeconds === 5);

    O.resetOverride(op, "start.pickSeconds");
    check("and back", START.pickSeconds === 20);
    done();
});

test("the intro switch: off, saved shots are not played", async () => {
    const { check, done } = checks();
    const world = scene(3);

    await withSetting(world.op, "start.introEnabled", false, async () => {
        start(world);
        await settle();
        check("no camera for law, only the outlaw's fly-down", world.ada.camera.calls.length === 0 && world.bob.camera.calls.length === 2);
    });
    fake.advance(400);
    done();
});

test("the intro length: 4 seconds, one shot, eased over 4 seconds and over at tick 80", async () => {
    const { check, done } = checks();
    const world = scene(1);

    await withSetting(world.op, "start.introSeconds", 4, async () => {
        start(world);
        check("the one shot eases over 4 seconds", calls(world.ada).join() === "100,150~4", calls(world.ada).join());
        fake.advance(79);
        check("still playing a tick before", !moving(world.ada) && calls(world.ada).length === 2);
        fake.advance(1);
        check("over at 80 ticks: the camera is handed back", calls(world.ada).at(-1) === "clear");
    });
    fake.advance(400);
    done();
});

test("the shots per start: one of three saved is played", async () => {
    const { check, done } = checks();
    const world = scene(3);
    const real = Math.random;
    Math.random = () => 0;

    try {
        await withSetting(world.op, "start.shotsPerStart", 1, async () => {
            start(world);
            check("one shot, eased over the whole 10 seconds", calls(world.ada).join() === "200,250~10", calls(world.ada).join());
        });
    } finally {
        Math.random = real;
    }
    fake.advance(600);
    done();
});

test("the time to choose: 5 seconds, and a law player who never answers is placed at tick 100", async () => {
    const { check, done } = checks();
    const world = scene(0);
    script(() => new Promise(() => {}));

    await withSetting(world.op, "start.pickSeconds", 5, async () => {
        start(world);
        await settle();
        fake.advance(99);
        check("a tick before 5 seconds: still waiting", round.getPhase() === "SETUP");
        fake.advance(1);
        check("at 5 seconds play begins", round.getPhase() === "ACTIVE");
    });
    done();
});

test("the outlaws' fly-down: 1 second, from 50 blocks up, and play begins when it is over", async () => {
    const { check, done } = checks();
    const world = scene(0);
    script(() => ({ canceled: false, selection: 0 }));

    await withSetting(world.op, "start.flyDownSeconds", 1, async () => {
        await withSetting(world.op, "start.flyDownHeight", 50, async () => {
            start(world);
            await settle();

            const spawn = world.bob.location;
            check("the camera starts 50 blocks above the eyes and eases for 1 second", world.bob.camera.calls[0].options.location.y === spawn.y + START.eyeHeight + 50 && world.bob.camera.calls[1].options.easeOptions.easeTime === 1, JSON.stringify(world.bob.camera.calls));
            check("the spawn is an outlaw spawn", OUTLAW_SPAWNS.some((s) => s.x === spawn.x && s.z === spawn.z));

            fake.advance(19);
            check("a tick before the second is over, not yet", round.getPhase() === "SETUP");
            fake.advance(1);
            check("play begins when it is", round.getPhase() === "ACTIVE");
        });
    });
    done();
});
