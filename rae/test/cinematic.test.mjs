import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks } from "./helpers.mjs";

// core/cinematic.ts: the one place the start sequence touches a player's camera and input. A pan is two camera calls (appear at the start mark, then
// ease to the end mark, the script twin of `/camera ... set minecraft:free ... ease`), a fly-down is the same from above a spawn, and a lock
// switches off a player's movement. Every call is wrapped: a failure is reported once per kind and never thrown, because a start must not hang on
// a camera. The fake records what the engine would have been told (player.camera.calls, player.inputPermissions).

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

const { InputPermissionCategory } = fakeApi;
const C = await load("core/cinematic.js");
const L = await load("logic/start.js");
const { START } = await load("config/balance.js");

const FREE = "minecraft:free";

const shot = () => {
    const made = L.makeShot("s1", "Bridge", { x: 10, y: 70, z: -20, pitch: 15, yaw: 90 }, { x: 40, y: 90, z: -60, pitch: -10, yaw: 180 });
    assert.ok(made.ok, made.reason);
    return made.value;
};

/** The lines written about the camera and locks since `from`. */
const said = (from) => lines.slice(from).filter((text) => text.startsWith("[cinematic]"));

function fresh() {
    fake.reset();
    C.forgetFailures();
}

test("a pan is two camera calls: appear at the start mark, then ease to the end mark over the seconds given", () => {
    fresh();
    const player = fake.makePlayer("Ada");

    C.playShot(player, shot(), 5);

    assert.deepEqual(player.camera.calls, [
        { method: "setCamera", preset: FREE, options: { location: { x: 10, y: 70, z: -20 }, rotation: { x: 15, y: 90 } } },
        { method: "setCamera", preset: FREE, options: { location: { x: 40, y: 90, z: -60 }, rotation: { x: -10, y: 180 }, easeOptions: { easeTime: 5, easeType: "Linear" } } }
    ]);
});

test("a negative length is a cut, not a negative ease", () => {
    fresh();
    const player = fake.makePlayer("Ada");

    C.playShot(player, shot(), -4);
    C.flyDown(player, { x: 0, y: 70, z: 0 }, -1);

    assert.deepEqual(player.camera.calls.filter((c) => c.options.easeOptions).map((c) => c.options.easeOptions.easeTime), [0, 0]);
});

test("a fly-down starts above the spawn looking straight down and eases to the player's own eyes and view", () => {
    fresh();
    const player = fake.makePlayer("Bob", { location: { x: 100, y: 65, z: 170 } });
    player.rotation = { x: 12, y: 45 };

    C.flyDown(player, { x: 100, y: 65, z: 170 }, 3);

    assert.deepEqual(player.camera.calls, [
        { method: "setCamera", preset: FREE, options: { location: { x: 100, y: 65 + START.eyeHeight + START.flyDownHeight, z: 170 }, rotation: { x: 90, y: 45 } } },
        { method: "setCamera", preset: FREE, options: { location: { x: 100, y: 65 + START.eyeHeight, z: 170 }, rotation: { x: 12, y: 45 }, easeOptions: { easeTime: 3, easeType: "InOutSine" } } }
    ]);
});

test("locking switches off a player's movement and nothing else, and unlocking switches it back on", () => {
    fresh();
    const { check, done } = checks();
    const player = fake.makePlayer("Ada");
    const enabled = (category) => player.inputPermissions.isPermissionCategoryEnabled(category);

    check("movement starts on", enabled(InputPermissionCategory.Movement));

    C.lock(player);
    check("locked: movement is off", enabled(InputPermissionCategory.Movement) === false);
    check("the camera category is left alone (they can still look)", enabled(InputPermissionCategory.Camera) === true);

    C.unlock(player);
    check("unlocked: movement is back", enabled(InputPermissionCategory.Movement) === true);
    done();
});

test("clearing the camera hands the player their own view back", () => {
    fresh();
    const player = fake.makePlayer("Ada");

    C.clearCamera(player);

    assert.deepEqual(player.camera.calls, [{ method: "clear" }]);
});

test("unlockEveryone gives every online player their movement and their camera back, whatever state they were left in", () => {
    fresh();
    const { check, done } = checks();
    const ada = fake.makePlayer("Ada");
    const bob = fake.makePlayer("Bob");
    const gone = fake.makePlayer("Gone");

    for (const p of [ada, bob, gone]) C.lock(p);
    gone.isValid = false;
    fake.advance(1);

    const before = lines.length;
    C.unlockEveryone();

    check("Ada can move and had her camera cleared", ada.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement) && ada.camera.calls.some((c) => c.method === "clear"));
    check("so did Bob", bob.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement) && bob.camera.calls.some((c) => c.method === "clear"));
    check("one who left is skipped without a word", said(before).length === 0 && gone.camera.calls.length === 0);
    done();
});

test("a player who left is skipped by every call, quietly", () => {
    fresh();
    const player = fake.makePlayer("Ada");
    player.isValid = false;

    const before = lines.length;

    C.lock(player);
    C.unlock(player);
    C.playShot(player, shot(), 5);
    C.flyDown(player, { x: 0, y: 70, z: 0 }, 3);
    C.clearCamera(player);

    assert.equal(player.camera.calls.length, 0);
    assert.equal(said(before).length, 0);
});

test("a camera that throws is reported once per kind of call and never thrown", () => {
    fresh();
    const { check, done } = checks();
    const player = fake.makePlayer("Ada");

    fake.cameraError = "the camera is not available";
    const before = lines.length;

    C.playShot(player, shot(), 5);
    C.playShot(player, shot(), 5);
    C.flyDown(player, { x: 0, y: 70, z: 0 }, 3);
    C.clearCamera(player);
    C.clearCamera(player);

    const text = said(before);
    check("nothing was thrown and nothing was recorded", player.camera.calls.length === 0);
    check("a shot, a fly-down and a clear are each reported, once", text.length === 3, text.join(" | "));
    check("with what failed and why", text.some((l) => /camera shot failed: .*not available/.test(l)) && text.some((l) => /fly-down failed/.test(l)) && text.some((l) => /clear camera failed/.test(l)), text.join(" | "));

    C.forgetFailures();
    C.clearCamera(player);
    check("forgetting the failures lets one be reported again", said(before).length === 4);
    done();
});

test("an input lock that throws is reported once per kind and never thrown, and the player is not left half-handled", () => {
    fresh();
    const { check, done } = checks();
    const player = fake.makePlayer("Ada");

    fake.inputPermissionError = "input permissions are not available";
    const before = lines.length;

    C.lock(player);
    C.lock(player);
    C.unlock(player);

    const text = said(before);
    check("a lock and an unlock are each reported, once", text.length === 2, text.join(" | "));
    check("with what failed", text.some((l) => /lock failed/.test(l) && !/unlock/.test(l)) && text.some((l) => /unlock failed/.test(l)), text.join(" | "));
    done();
});

test("one player's failure does not stop unlockEveryone for the rest", () => {
    fresh();
    const ada = fake.makePlayer("Ada");
    const bob = fake.makePlayer("Bob");

    C.lock(ada);
    C.lock(bob);

    // Ada's input handle throws; Bob's does not.
    ada.inputPermissions.setPermissionCategory = () => { throw new Error("Ada is odd"); };
    fake.advance(1);

    C.unlockEveryone();

    assert.equal(bob.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement), true);
    assert.ok(bob.camera.calls.some((c) => c.method === "clear"));
});
