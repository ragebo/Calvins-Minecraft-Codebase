import { test } from "node:test";
import { fake, system, world, load, checks, strip } from "./helpers.mjs";

// The train system, slice 1: the route recorder and the spike car. Time only moves when a test moves it.
// The fake game gives entities a small physics model (velocity moves a body once a tick), so the
// momentum driver is tested against a body that really moves, including one that delivers less than it
// is told to (fake.physics.delivered), which is what the real engine's drag would look like.

const { TRANSIT: T } = await load("config/balance.js");
await load("systems/transit.js");
const { resetAllSystems } = await load("core/registry.js");
const { parseSpec, serializeSpec, buildRoute, pointAt, nearestS } = await load("logic/route.js");

const overworld = fake.dimension("overworld");
const CAR = "bountysys:train_car";
const PROPERTY = "rae:train_route";

const logs = [];
const realWarn = console.warn;
console.warn = (...args) => logs.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const say = (id, player, message = "") => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity: player, message });
const cars = () => overworld.getEntities({ type: CAR });
const spikeLines = () => logs.filter((l) => l.startsWith("[train-spike]"));
const saved = () => parseSpec(world.getDynamicProperty(PROPERTY));

/** A clean world: no route, no cars, one player. */
function fresh() {
    fake.reset();
    logs.length = 0;
    const player = fake.makePlayer("Ada", { location: { x: 0, y: 64, z: 0 } });
    say("rae:train_clear", player);
    resetAllSystems();
    player.messages.length = 0;
    return player;
}

/** Walks the player along `points`, marking each; a point with a name is marked as a station. */
function recordRoute(player, points, { loop = false } = {}) {
    for (const p of points) {
        player._location = { x: p.x, y: p.y, z: p.z };
        if (p.name) say("rae:train_station", player, p.name); else say("rae:train_mark", player);
    }
    if (loop) say("rae:train_loop", player);
    player.messages.length = 0;
}

const LINE = [{ x: 0, y: 64, z: 0, name: "Depot" }, { x: 0, y: 64, z: 50 }, { x: 0, y: 64, z: 100, name: "End" }];
const SQUARE = [{ x: 0, y: 64, z: 0, name: "A" }, { x: 30, y: 64, z: 0 }, { x: 30, y: 64, z: 30, name: "B" }, { x: 0, y: 64, z: 30 }];

const text = (player) => player.messages.map(strip).join("\n");
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const rideOn = (car, rider) => car.getComponent("minecraft:rideable").addRider(rider);

// ---------------------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------------------

test("marking, naming, undoing, looping and clearing edit the saved route, and say so", () => {
    const { check, done } = checks();
    const p = fresh();

    p._location = { x: 10.126, y: 70, z: -4 };
    say("rae:train_mark", p);
    check("the mark is saved in the world, rounded", JSON.stringify(saved()?.waypoints) === JSON.stringify([{ x: 10.13, y: 70, z: -4 }]), JSON.stringify(saved()));
    check("it says which point and where", /Marked point 1 at 10\.1, 70\.0, -4\.0/.test(text(p)), text(p));

    p._location = { x: 10, y: 70, z: 30 };
    say("rae:train_station", p, "  Old Town ");
    check("a station is a named point", saved()?.waypoints[1]?.station === "Old Town", JSON.stringify(saved()));
    check("and says so", /Station "Old Town" is point 2/.test(text(p)), text(p));
    check("two points and a station is already a usable route, and it says that", /usable route/.test(text(p)), text(p));

    p.messages.length = 0;
    say("rae:train_station", p, "");
    check("a station without a name shows how to name it", /Give the station a name/.test(text(p)), text(p));
    check("and changes nothing", saved()?.waypoints.length === 2);

    p.messages.length = 0;
    say("rae:train_mark", p);
    check("marking on top of the last point refuses", /on top of/.test(text(p)) && saved()?.waypoints.length === 2, text(p));

    say("rae:train_undo", p);
    check("undo removes the last point", saved()?.waypoints.length === 1 && /1 left/.test(text(p)), text(p));

    say("rae:train_loop", p);
    check("loop toggles on", saved()?.loop === true && /loop/.test(text(p)), text(p));
    say("rae:train_loop", p);
    check("and off", saved()?.loop === false);

    say("rae:train_clear", p);
    check("clear removes the property itself, not just the points", world.getDynamicProperty(PROPERTY) === undefined);
    p.messages.length = 0;
    say("rae:train_undo", p);
    check("undo on an empty route says there is nothing to undo", /nothing to undo/.test(text(p)), text(p));
    done();
});

test("commands that need a player, dimension or room say why instead of doing something wrong", () => {
    const { check, done } = checks();
    const p = fresh();

    logs.length = 0;
    say("rae:train_mark", undefined);
    check("run without a player: nothing saved, one log line", world.getDynamicProperty(PROPERTY) === undefined && logs.some((l) => /rae:train_mark has to be run by a player/.test(l)), logs.join("|"));

    const nether = fake.makePlayer("Nia", { dimension: fake.dimension("nether"), location: { x: 0, y: 64, z: 0 } });
    say("rae:train_mark", nether);
    check("in another dimension: refuses", /only runs in the overworld/.test(text(nether)) && world.getDynamicProperty(PROPERTY) === undefined, text(nether));

    const before = T.maxWaypoints;
    T.maxWaypoints = 2;
    try {
        recordRoute(p, [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 10 }]);
        p._location = { x: 0, y: 64, z: 20 };
        say("rae:train_mark", p);
        check("a full route refuses", /full/.test(text(p)) && saved()?.waypoints.length === 2, text(p));
    } finally { T.maxWaypoints = before; }

    say("rae:train_clear", p);
    const savedBefore = T.maxSavedChars;
    T.maxSavedChars = 30;
    try {
        recordRoute(p, [{ x: 0, y: 64, z: 0 }]);
        p._location = { x: 0, y: 64, z: 10 };
        say("rae:train_mark", p);
        check("a route too long to save is refused and the saved one is untouched", /too long to save/.test(text(p)) && saved()?.waypoints.length === 1, text(p));
    } finally { T.maxSavedChars = savedBefore; }
    done();
});

test("info tells what the route is, or why it is not one yet", () => {
    const { check, done } = checks();
    const p = fresh();

    say("rae:train_info", p);
    check("nothing marked", /0 points/.test(text(p)) && /at least 2/.test(text(p)), text(p));

    recordRoute(p, [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 40 }]);
    say("rae:train_info", p);
    check("no station yet says how to add one", /no station/.test(text(p)), text(p));

    p.messages.length = 0;
    recordRoute(p, [{ x: 0, y: 64, z: 80, name: "End" }]);
    say("rae:train_info", p);
    check("a route: length, time at cruise, stations", /80 blocks/.test(text(p)) && /8 s at cruise/.test(text(p)) && /End \(80\)/.test(text(p)), text(p));
    done();
});

test("show draws the route near the player for a while, tall columns at stations, then stops", () => {
    const { check, done } = checks();
    const p = fresh();

    say("rae:train_show", p);
    check("with no route it says why", /at least 2/.test(text(p)), text(p));

    recordRoute(p, [{ x: 0, y: 64, z: 0, name: "Depot" }, { x: 0, y: 64, z: 100 }, { x: 0, y: 64, z: 300, name: "Far" }]);
    p._location = { x: 0, y: 64, z: 0 };
    overworld.particles.length = 0;
    say("rae:train_show", p);
    fake.advance(T.showEveryTicks);
    const first = overworld.particles.length;
    check("particles appear", first > 0, String(first));
    check("only within the radius of the player", overworld.particles.every((q) => Math.abs(q.location.z) <= T.showRadius + 3.5), JSON.stringify(overworld.particles.slice(-3)));
    check("the depot has a column of 6 stacked particles", overworld.particles.filter((q) => Math.abs(q.location.z) < 1e-9 && Math.abs(q.location.x) < 1e-9).length >= 6);
    check("the far station is not drawn from here", !overworld.particles.some((q) => q.location.z > 200));

    fake.advance(T.showTicks + 4 * T.showEveryTicks);
    const later = overworld.particles.length;
    fake.advance(100);
    check("it stops by itself", overworld.particles.length === later, `${later} -> ${overworld.particles.length}`);
    check("after showTicks it drew roughly showTicks/showEveryTicks times", later > first * (T.showTicks / T.showEveryTicks) * 0.8 && later < first * (T.showTicks / T.showEveryTicks) * 1.2, `${first} per draw, ${later} total`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The spike car
// ---------------------------------------------------------------------------------------------------------

/** A route, a spike car of `mode` on it, and a rider aboard. */
function ride(mode, points = LINE, options = {}) {
    const p = fresh();
    recordRoute(p, points, options);
    say("rae:train_spike", p, mode);
    const car = cars()[0];
    if (options.rider !== false) rideOn(car, p);
    return { p, car };
}

test("the spike needs a route and a mode, and says how to use it", () => {
    const { check, done } = checks();
    const p = fresh();
    say("rae:train_spike", p, "momentum");
    check("no route: says why and spawns nothing", /at least 2/.test(text(p)) && cars().length === 0, text(p));

    p.messages.length = 0;
    say("rae:train_spike", p, "");
    check("no mode: usage", /Usage: .*momentum/.test(text(p)), text(p));
    p.messages.length = 0;
    say("rae:train_spike", p, "fly");
    check("an unknown mode: usage", /Usage/.test(text(p)));
    p.messages.length = 0;
    say("rae:train_spike", p, "go");
    check("go with nothing waiting says so", /no car waiting/.test(text(p)), text(p));
    done();
});

test("the car waits at the start until someone sits, then leaves after the delay", () => {
    const { check, done } = checks();
    const { p, car } = ride("momentum", LINE, { rider: false });

    check("a car was spawned, tagged, at the first point, facing along the route (+Z is yaw 0)", cars().length === 1 && car.hasTag("rae_train") && dist(car.location, { x: 0, y: 64, z: 0 }) < 1e-9 && car.rotation.y === 0, JSON.stringify([car.location, car.rotation]));
    fake.advance(200);
    check("empty, it does not move", dist(car.location, { x: 0, y: 64, z: 0 }) < 1e-9, JSON.stringify(car.location));

    rideOn(car, p);
    fake.advance(T.spikeDepartDelayTicks - 5);
    check("a rider sits: still waiting inside the delay", car.location.z === 0, String(car.location.z));
    fake.advance(20);
    check("after the delay it is under way", car.location.z > 0, String(car.location.z));
    check("and the log says who was aboard", spikeLines().some((l) => /1 rider\(s\) aboard: Ada@/.test(l)) && spikeLines().some((l) => /leaving the start, 1 aboard/.test(l)), spikeLines().join("\n"));
    done();
});

test("a rider who gets off before the delay ends cancels the departure; `go` leaves without anyone", () => {
    const { check, done } = checks();
    const { p, car } = ride("momentum");

    fake.advance(20);
    car.getComponent("minecraft:rideable").ejectRider(p);
    fake.advance(T.spikeDepartDelayTicks + 30);
    check("nobody aboard at the end of the delay: the car stayed", car.location.z === 0, String(car.location.z));

    say("rae:train_spike", p, "go");
    fake.advance(10);
    check("go: it leaves", car.location.z > 0, String(car.location.z));
    done();
});

test("momentum: the car follows the route exactly, never exceeds cruise speed, and stops on the end", () => {
    const { check, done } = checks();
    const { car } = ride("momentum");

    let last = car.location.z, biggestStep = 0, offLine = 0, backwards = 0, ticksMoving = 0, arrivedAt = null;
    for (let i = 0; i < 700; i++) {
        fake.advance(1);
        const z = car.location.z;
        biggestStep = Math.max(biggestStep, z - last);
        if (z < last - 1e-9) backwards++;
        offLine = Math.max(offLine, Math.abs(car.location.x));
        if (z > last + 1e-9) ticksMoving++;
        if (arrivedAt === null && Math.abs(z - 100) < 1e-6) arrivedAt = i;
        last = z;
    }
    check("it arrives at the end of the route", Math.abs(car.location.z - 100) < 1e-6, String(car.location.z));
    check("in a sensible time (100 blocks at 0.5 a tick, plus the start delay, pulling away and braking)", arrivedAt !== null && arrivedAt > T.spikeDepartDelayTicks + 200 && arrivedAt < T.spikeDepartDelayTicks + 200 + 80, String(arrivedAt));
    check("never above cruise speed", biggestStep <= T.cruiseSpeed + 1e-9, String(biggestStep));
    check("reaches cruise speed", biggestStep > T.cruiseSpeed - 1e-6, String(biggestStep));
    check("never goes backwards", backwards === 0, String(backwards));
    check("stays on the line", offLine < 1e-9, String(offLine));
    check("no teleport was needed", car.teleports.length === 0, String(car.teleports.length));
    check("it stops there: no velocity left", car.velocity.z === 0 && car.velocity.x === 0);
    check("the log says it arrived", spikeLines().some((l) => /arrived at the end of the route/.test(l)), spikeLines().slice(-2).join("\n"));

    const count = spikeLines().length;
    fake.advance(100);
    check("once arrived the driver is off: nothing more is logged", spikeLines().length === count);
    done();
});

test("momentum log lines report the tracking error, what the engine delivered, and where riders sit", () => {
    const { check, done } = checks();
    const { car } = ride("momentum");
    fake.advance(T.spikeDepartDelayTicks + 100);

    const running = spikeLines().filter((l) => /^\[train-spike\] momentum t=/.test(l));
    check("a line about every second", running.length >= 4, String(running.length));
    const line = running[running.length - 1] ?? "";
    check("it has the error, the delivered fraction, the resyncs and the riders", /error\(mean=0\.000 max=0\.000\)/.test(line) && /delivered=1\.000/.test(line) && /resyncs=0 held=0/.test(line) && /riders=\[Ada@0\.00,0\.40,0\.00\]/.test(line), line);
    check("a car that goes as told has zero error", running.every((l) => /mean=0\.000/.test(l)), running.join("\n"));
    check("the car is still there", car.isValid);
    done();
});

test("an engine that delivers only part of a velocity: the car settles off its aim, and TRANSIT.velocityScale removes the error", () => {
    const { check, done } = checks();
    const before = T.velocityScale;
    const lastLine = () => spikeLines().filter((l) => /momentum t=/.test(l)).at(-1) ?? "";

    try {
        // The engine turns half of each velocity into movement. Cruising, the car has to be told a gap of 1 block to
        // move the 0.5 it needs, so it runs half a block behind the point it aimed for.
        const first = ride("momentum");
        fake.physics.delivered = 0.5;
        fake.advance(T.spikeDepartDelayTicks + 150);
        const laggingZ = first.car.location.z;
        check("it still follows the line, with no teleport", Math.abs(first.car.location.x) < 1e-9 && first.car.teleports.length === 0);
        check("the tracking error settles at half a block", /error\(mean=0\.5\d\d max=0\.5\d\d\)/.test(lastLine()), lastLine());
        check("the log shows the engine delivered half of what it was told", /delivered=0.500/.test(lastLine()), lastLine());

        // Tell the driver what the engine really delivers, and the error goes.
        T.velocityScale = 0.5;
        const second = ride("momentum");
        fake.physics.delivered = 0.5;
        fake.advance(T.spikeDepartDelayTicks + 150);
        check("with velocityScale 0.5 the error is back to zero", /error\(mean=0\.000 max=0\.000\)/.test(lastLine()) && /delivered=0\.500/.test(lastLine()), lastLine());
        check("and the car is exactly where the route says (a car that lags is behind it)", second.car.location.z > laggingZ + 0.4, `${second.car.location.z} vs ${laggingZ}`);
    } finally {
        T.velocityScale = before;
    }
    done();
});

test("teleport: the car is placed on the route every tick, with no velocity", () => {
    const { check, done } = checks();
    const { car } = ride("teleport");
    fake.advance(T.spikeDepartDelayTicks + 100);

    check("it moved by teleporting", car.teleports.length >= 90, String(car.teleports.length));
    check("with no velocity", car.velocity.z === 0);
    const route = buildRoute(saved());
    check("always exactly on the route", car.teleports.every((t) => dist(t, pointAt(route, nearestS(route, t))) < 0.3 && t.x === 0), JSON.stringify(car.teleports.slice(-2)));
    const line = spikeLines().filter((l) => /^\[train-spike\] teleport t=/.test(l)).at(-1) ?? "";
    check("its log has no engine-delivery figure", /delivered=n\/a/.test(line), line);
    done();
});

test("a car knocked far off the route is put back on it once, then driven on", () => {
    const { check, done } = checks();
    const { car } = ride("momentum");
    fake.advance(T.spikeDepartDelayTicks + 60);
    const zBefore = car.location.z;
    car.teleport({ x: 25, y: 64, z: zBefore }, { keepVelocity: true });
    const teleportsBefore = car.teleports.length;
    fake.advance(1);

    check("one teleport put it back", car.teleports.length === teleportsBefore + 1, String(car.teleports.length - teleportsBefore));
    check("on the line, ahead of where it was", Math.abs(car.location.x) < 1e-6 && car.location.z > zBefore, JSON.stringify(car.location));
    fake.advance(60);
    check("and it carries on by momentum, without more resyncs", car.teleports.length === teleportsBefore + 1 && car.location.z > zBefore + 10, String(car.teleports.length));
    check("the log counts the resync", spikeLines().some((l) => /resyncs=1/.test(l)), spikeLines().slice(-2).join("\n"));
    done();
});

test("the car holds still at a chunk that is not loaded, and goes on when it is", () => {
    const { check, done } = checks();
    const original = overworld.isChunkLoaded;
    let loadedUpTo = 40;
    overworld.isChunkLoaded = (p) => p.z <= loadedUpTo;
    try {
        const { car } = ride("momentum");
        fake.advance(T.spikeDepartDelayTicks + 200);
        check("it never entered the unloaded stretch", car.location.z <= 40 + 1e-9, String(car.location.z));
        check("it is stopped right at the edge, not running", car.velocity.z === 0 && car.location.z > 30, `${car.location.z} v=${car.velocity.z}`);
        check("the log counts the ticks held", spikeLines().some((l) => /held=[1-9]/.test(l)), spikeLines().slice(-1).join(""));

        loadedUpTo = 1000;
        fake.advance(60);
        check("with the chunk loaded it goes on", car.location.z > 45, String(car.location.z));
    } finally { overworld.isChunkLoaded = original; }
    done();
});

test("a loop never ends, the car stays on the smoothed curve, and its heading follows the corners", () => {
    const { check, done } = checks();
    const { car } = ride("momentum", SQUARE, { loop: true });
    const route = buildRoute(saved(), 20);                      // finely measured, so the distance to it is not the table's spacing
    check("the saved route is a loop", route.loop === true);

    let worst = 0, travelled = 0, lastStep = 0;
    const yaws = new Set();
    fake.advance(T.spikeDepartDelayTicks);
    let before = { ...car.location };
    for (let i = 0; i < 1500; i++) {
        fake.advance(1);
        lastStep = dist(car.location, before);
        travelled += lastStep;
        before = { ...car.location };
        worst = Math.max(worst, dist(car.location, pointAt(route, nearestS(route, car.location))));
        yaws.add(Math.round(car.rotation.y / 45) * 45);
    }
    check("after more than a lap it is still going, on the curve", worst < 0.05 && car.teleports.length === 0, `off by ${worst}, teleports ${car.teleports.length}`);
    check("it has gone round more than three times, and is still at cruise speed (a loop has no end to brake for)", travelled > 3 * buildRoute(saved()).length && lastStep > T.cruiseSpeed - 0.01, `travelled ${travelled}, last step ${lastStep}`);
    check("the log never says arrived", !spikeLines().some((l) => /arrived/.test(l)));
    check("it faced all four ways around a square (yaw 0, 90, -90, 180)", [0, 90, -90, 180].every((y) => yaws.has(y) || (y === 180 && yaws.has(-180))), [...yaws].join(","));
    done();
});

test("stop, clear and reset each remove the car and the driver", () => {
    const { check, done } = checks();
    for (const how of ["stop", "clear", "reset"]) {
        const { p, car } = ride("momentum");
        fake.advance(T.spikeDepartDelayTicks + 10);
        if (how === "stop") say("rae:train_spike", p, "stop");
        if (how === "clear") say("rae:train_clear", p);
        if (how === "reset") resetAllSystems();
        check(`${how}: the car is gone`, !car.isValid && cars().length === 0);
        const count = logs.length;
        fake.advance(60);
        check(`${how}: no driver is left running`, logs.length === count, logs.slice(count).join("|"));
    }
    done();
});

test("reset keeps the route (it belongs to the world, not to a round)", () => {
    const { check, done } = checks();
    const p = fresh();
    recordRoute(p, LINE);
    resetAllSystems();
    check("still saved", saved()?.waypoints.length === 3);
    say("rae:train_info", p);
    check("and still usable", /100 blocks/.test(text(p)), text(p));
    done();
});

test("a car that disappears mid-run stops the run without an error", () => {
    const { check, done } = checks();
    const { car } = ride("momentum");
    fake.advance(T.spikeDepartDelayTicks + 30);
    car.remove();
    logs.length = 0;
    fake.advance(5);
    check("it says so and stops", logs.some((l) => /the car is gone/.test(l)));
    const count = logs.length;
    fake.advance(60);
    check("nothing more happens", logs.length === count);
    done();
});

test("a new run replaces the old car; two cars are never left", () => {
    const { check, done } = checks();
    const { p, car } = ride("momentum");
    say("rae:train_spike", p, "teleport");
    check("the first car is gone and there is one new one", !car.isValid && cars().length === 1);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The measurements
// ---------------------------------------------------------------------------------------------------------

test("drag test: reports how far each impulse really moves the car per tick, then removes the car", () => {
    const { check, done } = checks();
    const p = fresh();
    fake.physics.delivered = 0.8;
    fake.physics.drag = 0.5;
    say("rae:train_spike", p, "drag");
    check("a test car is placed", cars().length === 1);
    fake.advance(T.dragTestSpeeds.length * 9 + 5);

    const rows = spikeLines().filter((l) => /drag: impulse/.test(l));
    check("one row per impulse size", rows.length === T.dragTestSpeeds.length, rows.join("\n"));
    const half = rows.find((l) => /impulse 0\.5 /.test(l)) ?? "";
    check("the first tick delivers 0.8 of the impulse (0.4 of 0.5), then it decays by the drag", /moved per tick \[0\.400, 0\.200, 0\.100, 0\.050/.test(half), half);
    check("the engine's own velocity readback is shown", /velocity readback \[0\.5\d\d, 0\.2\d\d/.test(half) || /velocity readback \[0\.25/.test(half) || /velocity readback/.test(half), half);
    const summary = spikeLines().find((l) => /drag summary/.test(l)) ?? "";
    check("the summary gives the delivered fraction for each size", /0\.05: 0\.800, 0\.2: 0\.800, 0\.5: 0\.800, 1: 0\.800, 2: 0\.800/.test(summary), summary);
    check("the car is removed at the end", cars().length === 0);
    check("the player is told", /Drag test done/.test(text(p)), text(p));
    done();
});

test("limits test: tries growing impulses, reports where the engine refuses, and leaves the car where it was", () => {
    const { check, done } = checks();
    const p = fresh();
    fake.maxImpulse = 5;
    say("rae:train_spike", p, "limits");

    const line = spikeLines().find((l) => /limits:/.test(l)) ?? "";
    check("sizes up to the limit are ok", /1: ok \| 2: ok \| 5: ok/.test(line), line);
    check("larger ones report the engine's error", /10: Error: ArgumentOutOfBoundsError/.test(line) && /1000: Error: ArgumentOutOfBoundsError/.test(line), line);
    check("the car is removed", cars().length === 0);
    check("the player gets the result too", /Impulse limits: 1: ok/.test(text(p)), text(p));
    done();
});

test("seats test: cows fill the seats, the log says how many sat and where, and they leave", () => {
    const { check, done } = checks();
    let p = fresh();
    say("rae:train_spike", p, "seats 6");
    const car = cars()[0];
    const line = spikeLines().find((l) => /seats: seatCount/.test(l)) ?? "";
    check("the car has 4 seats: 4 cows sat, 2 did not", /seatCount=4, 6 cows, addRider results \[true, true, true, true, false, false\], riders now 4/.test(line), line);
    check("the player is told the count", /4 of 6 cows sat/.test(text(p)), text(p));
    fake.advance(12);
    check("the offsets from the car are logged", spikeLines().some((l) => /rider offsets from the car \(x,y,z\): cow@/.test(l)), spikeLines().join("\n"));

    fake.advance(T.seatTestTicks);
    check("the cows go after a while", overworld.getEntities({ type: "minecraft:cow" }).length === 0);
    check("the car stays until stopped", car.isValid);
    say("rae:train_spike", p, "stop");
    check("stop removes the car", !car.isValid);

    p = fresh();
    say("rae:train_spike", p, "seats");
    check("with no number it seats 4", /4 cows/.test(spikeLines().at(-1) ?? ""), spikeLines().at(-1));
    say("rae:train_spike", p, "stop");
    check("stop removes the cows too", overworld.getEntities({ type: "minecraft:cow" }).length === 0);

    p = fresh();
    say("rae:train_spike", p, `seats ${T.seatTestMaxCows + 50}`);
    check("the number is capped", overworld.getEntities({ type: "minecraft:cow" }).length === T.seatTestMaxCows, String(overworld.getEntities({ type: "minecraft:cow" }).length));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Clean-up
// ---------------------------------------------------------------------------------------------------------

test("a car that loads with a chunk belongs to no run and is removed; the live car is left alone", () => {
    const { check, done } = checks();
    const { car } = ride("momentum");
    const stray = fake.makeEntity({ typeId: CAR, location: { x: 500, y: 64, z: 500 } });
    const other = fake.makeEntity({ typeId: "minecraft:cow", location: { x: 500, y: 64, z: 500 } });

    world.afterEvents.entityLoad.emit({ entity: stray });
    world.afterEvents.entityLoad.emit({ entity: car });
    world.afterEvents.entityLoad.emit({ entity: other });

    check("the stray is removed", !stray.isValid);
    check("the live car stays", car.isValid);
    check("other entities are untouched", other.isValid);
    done();
});

test("a reset sweeps stray cars in loaded chunks, and the sweep at load does too", () => {
    const { check, done } = checks();
    fresh();
    const stray = fake.makeEntity({ typeId: CAR, location: { x: 1, y: 64, z: 1 } });
    resetAllSystems();
    check("reset removes a stray", !stray.isValid);
    done();
});

test("the car is placed facing along the route from the first tick (a westbound route is yaw 90, not the default 0)", () => {
    const { check, done } = checks();
    const p = fresh();
    recordRoute(p, [{ x: 100, y: 64, z: 0, name: "East" }, { x: 60, y: 64, z: 0 }, { x: 20, y: 64, z: 0, name: "West" }]);
    say("rae:train_spike", p, "momentum");
    const car = cars()[0];
    check("yaw 90 faces -X", Math.abs(car.rotation.y - 90) < 1e-9, JSON.stringify(car.rotation));
    check("level, not tilted", car.rotation.x === 0);
    done();
});

test("a route whose start is not loaded spawns nothing and says why", () => {
    const { check, done } = checks();
    const p = fresh();
    recordRoute(p, LINE);
    const original = overworld.isChunkLoaded;
    overworld.isChunkLoaded = () => false;
    try {
        say("rae:train_spike", p, "momentum");
        check("no car", cars().length === 0);
        check("the player is told to go there", /not loaded/.test(text(p)), text(p));
    } finally { overworld.isChunkLoaded = original; }
    done();
});

test("a car that cannot be spawned is reported, not thrown", () => {
    const { check, done } = checks();
    const p = fresh();
    recordRoute(p, LINE);
    const original = overworld.spawnEntity;
    overworld.spawnEntity = () => { throw new Error("no such entity: bountysys:train_car"); };
    try {
        say("rae:train_spike", p, "momentum");
        check("the player is told why", /Could not spawn the car: Error: no such entity/.test(text(p)), text(p));
        say("rae:train_spike", p, "limits");
        check("the tests that place a car say the same", /Could not spawn the car/.test(text(p).split("\n").slice(1).join("\n")), text(p));
    } finally { overworld.spawnEntity = original; }
    done();
});
