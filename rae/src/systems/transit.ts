import { system, world, type Dimension, type Entity, type Player, type Vector3 } from "@minecraft/server";
import { TRANSIT as T } from "../config/balance.js";
import { onScriptEvent } from "../core/events.js";
import { registerSystem } from "../core/registry.js";
import { onTick } from "../core/tick.js";
import { format, tell } from "../core/ui.js";
import {
    EMPTY_SPEC, addWaypoint, buildRoute, headingAt, nextSpeed, parseSpec, pointAt, sampleEvery,
    serializeSpec, setLoop, steer, stepDistance, summarize, undoWaypoint, whyNotARoute,
    type Route, type RouteSpec, type SpeedProfile
} from "../logic/route.js";

/**
 * The train: a rideable custom entity driven along a route that is recorded in the world.
 *
 * SLICE 1 (this file so far): the route recorder and a spike that puts ONE car on the route and drives it
 * two ways, by momentum (velocity set every tick, aimed at the next point on the route) and by teleport
 * (placed on the next point every tick), logging what the game really does to the content log so the
 * real train (slice 2) is built on measured numbers. The measurements are:
 *   - `rae:train_spike drag`   how far a velocity really moves an entity per tick, and how it decays
 *   - `rae:train_spike limits` the largest impulse the engine accepts
 *   - `rae:train_spike seats`  how the car's four seats take riders (cows stand in for players)
 *
 * The route only lives in a world property: the pure maths (smoothing, distance, heading, speed, steering)
 * is logic/route.ts.
 */

const OVERWORLD = "minecraft:overworld";
const CAR_TYPE = "bountysys:train_car";
const CAR_TAG = "rae_train";
const COW_TYPE = "minecraft:cow";
const ROUTE_PROPERTY = "rae:train_route";

const LOG = "[train-spike]";
const log = (text: string): void => console.warn(`${LOG} ${text}`);

const PROFILE: SpeedProfile = { cruise: T.cruiseSpeed, accel: T.acceleration, brake: T.braking, crawl: T.crawlSpeed };

const pos = (p: Vector3): string => `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
const gap = (a: Vector3, b: Vector3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fixed = (n: number, digits = 3): string => n.toFixed(digits);

// ---------------------------------------------------------------------------------------------------------
// The saved route
// ---------------------------------------------------------------------------------------------------------

/** Read on first use, not at load: a world property is not available while the scripts are still starting. */
let saved: RouteSpec | undefined;
let built: { readonly spec: RouteSpec; readonly route: Route | undefined } | undefined;

function currentSpec(): RouteSpec {
    if (saved === undefined) {
        const text = world.getDynamicProperty(ROUTE_PROPERTY);
        saved = parseSpec(typeof text === "string" ? text : undefined) ?? EMPTY_SPEC;
    }
    return saved;
}

/** false when the route does not fit the property (nothing is changed then). */
function save(next: RouteSpec): boolean {
    if (next.waypoints.length === 0) {
        world.setDynamicProperty(ROUTE_PROPERTY, undefined);
    } else {
        const text = serializeSpec(next);
        if (text.length > T.maxSavedChars) return false;
        world.setDynamicProperty(ROUTE_PROPERTY, text);
    }
    saved = next;
    return true;
}

function currentRoute(): Route | undefined {
    const spec = currentSpec();
    if (built?.spec !== spec) built = { spec, route: buildRoute(spec, T.samplesPerBlock) };
    return built.route;
}

// ---------------------------------------------------------------------------------------------------------
// Recorder commands
// ---------------------------------------------------------------------------------------------------------

/** These commands use where the player stands, so they need a player to run them. */
function onPlayerCommand(id: string, fn: (player: Player, message: string) => void): void {
    onScriptEvent(id, (player, message) => {
        if (!player) {
            console.warn(`[transit] ${id} has to be run by a player.`);
            return;
        }
        fn(player, message.trim());
    });
}

function record(player: Player, station?: string): void {

    if (player.dimension.id !== OVERWORLD) {
        tell(player, format("warn", "The train only runs in the overworld."));
        return;
    }

    const result = addWaypoint(currentSpec(), player.location, station, T.maxWaypoints);
    if (!result.ok) {
        tell(player, format("warn", result.reason));
        return;
    }
    if (!save(result.spec)) {
        tell(player, format("warn", "That route is too long to save. Nothing was changed."));
        return;
    }

    const points = result.spec.waypoints;
    const last = points[points.length - 1]!;
    tell(player, format("ok", last.station === undefined
        ? `Marked point ${points.length} at ${pos(last)}.`
        : `Station "${last.station}" is point ${points.length}, at ${pos(last)}.`));

    if (whyNotARoute(result.spec) === undefined) {
        tell(player, format("info", "That is a usable route: /scriptevent rae:train_show draws it."));
    }
}

onPlayerCommand("rae:train_mark", (player) => record(player));

onPlayerCommand("rae:train_station", (player, name) => {
    if (name === "") {
        tell(player, format("warn", "Give the station a name: /scriptevent rae:train_station Depot"));
        return;
    }
    record(player, name);
});

onPlayerCommand("rae:train_undo", (player) => {
    const result = undoWaypoint(currentSpec());
    if (!result.ok) {
        tell(player, format("warn", result.reason));
        return;
    }
    save(result.spec);
    tell(player, format("ok", `Removed the last point (${result.spec.waypoints.length} left).`));
});

onPlayerCommand("rae:train_clear", (player) => {
    const count = currentSpec().waypoints.length;
    stopRun("route cleared");
    save(EMPTY_SPEC);
    tell(player, format("ok", `The route is cleared (${count} points removed).`));
});

onPlayerCommand("rae:train_loop", (player) => {
    const next = setLoop(currentSpec(), !currentSpec().loop);
    save(next);
    tell(player, format("ok", next.loop
        ? "The route is a loop: the last point joins back to the first."
        : "The route is a line: the train runs from the first point to the last."));
});

onPlayerCommand("rae:train_info", (player) => {
    const spec = currentSpec();
    tell(player, format("info", `Route: ${spec.waypoints.length} points, ${spec.loop ? "a loop" : "a line"}.`));

    const route = currentRoute();
    if (!route) {
        tell(player, format("warn", whyNotARoute(spec) ?? "This is not a route."));
        return;
    }
    const summary = summarize(route, T.cruiseSpeed);
    tell(player, format("info", `${fixed(summary.length, 0)} blocks, about ${fixed(summary.seconds, 0)} s at cruise speed.`));
    tell(player, format("info", `Stations: ${summary.stations.map((s) => `${s.name} (${fixed(s.s, 0)})`).join(", ")}.`));
});

let stopShow: (() => void) | undefined;

onPlayerCommand("rae:train_show", (player) => {
    const route = currentRoute();
    if (!route) {
        tell(player, format("warn", whyNotARoute(currentSpec()) ?? "This is not a route."));
        return;
    }

    stopShow?.();
    const dimension = world.getDimension(OVERWORLD);
    const points = sampleEvery(route, T.showSpacing);
    let shown = 0;

    stopShow = onTick("transit:show", () => {
        shown += T.showEveryTicks;
        if (!player.isValid || shown > T.showTicks) {
            stopShow?.();
            stopShow = undefined;
            return;
        }
        const here = player.location;
        for (const p of points) {
            if (gap(p, here) <= T.showRadius) dimension.spawnParticle("minecraft:endrod", { x: p.x, y: p.y + 0.3, z: p.z });
        }
        for (const station of route.stations) {
            const p = pointAt(route, station.s);
            if (gap(p, here) > T.showRadius) continue;
            for (let up = 0; up < 6; up++) dimension.spawnParticle("minecraft:endrod", { x: p.x, y: p.y + 0.3 + up * 0.5, z: p.z });
        }
    }, { everyTicks: T.showEveryTicks });

    tell(player, format("ok", `Drawing the route for ${T.showTicks / 20} seconds. Stations have a tall column.`));
});

// ---------------------------------------------------------------------------------------------------------
// The spike car
// ---------------------------------------------------------------------------------------------------------

type Mode = "momentum" | "teleport";

interface Window {
    ticks: number;
    errorSum: number;
    errorMax: number;
    deliveredSum: number;
    deliveredCount: number;
}

interface Run {
    readonly car: Entity;
    readonly route: Route;
    readonly mode: Mode;
    state: "waiting" | "running" | "arrived";
    /** The tick the car sets off, once someone sits; undefined while nobody has. */
    departAt: number | undefined;
    /** Set by `go`: leave now, whoever is aboard. */
    forced: boolean;
    s: number;
    speed: number;
    startedTick: number;
    /** Where the car was aimed last tick, where it was, and how big the velocity it was given: for the error and drag numbers. */
    lastTarget: Vector3 | undefined;
    lastHere: Vector3 | undefined;
    lastCommand: number;
    resyncs: number;
    held: number;
    window: Window;
}

let run: Run | undefined;
let stopDrive: (() => void) | undefined;
/** A car placed by the drag, limits and seats tests (not on the route). */
let testCar: Entity | undefined;
let cows: Entity[] = [];
let stopDragTest: (() => void) | undefined;
/** Counts up whenever the test cars are cleared, so a late timeout leaves a newer batch alone. */
let batch = 0;

const freshWindow = (): Window => ({ ticks: 0, errorSum: 0, errorMax: 0, deliveredSum: 0, deliveredCount: 0 });

const ridersOf = (car: Entity): Entity[] => car.getComponent("minecraft:rideable")?.getRiders() ?? [];

function describeRiders(car: Entity): string {
    const at = car.location;
    return ridersOf(car).map((rider) => {
        const label = rider.typeId === "minecraft:player" ? (rider as Player).name : rider.typeId.replace("minecraft:", "");
        const p = rider.location;
        return `${label}@${fixed(p.x - at.x, 2)},${fixed(p.y - at.y, 2)},${fixed(p.z - at.z, 2)}`;
    }).join(" ");
}

function safeRemove(entity: Entity | undefined): void {
    try { if (entity?.isValid) entity.remove(); } catch { /* already gone */ }
}

/** Stops whatever the spike is doing and takes its entities out of the world. */
function stopRun(reason: string): void {
    batch++;
    stopDrive?.();
    stopDrive = undefined;
    stopDragTest?.();
    stopDragTest = undefined;
    if (run) log(`stopped (${reason}) after ${system.currentTick - run.startedTick} ticks, resyncs=${run.resyncs}, held=${run.held}`);
    safeRemove(run?.car);
    safeRemove(testCar);
    for (const cow of cows) safeRemove(cow);
    run = undefined;
    testCar = undefined;
    cows = [];
}

function startRun(player: Player, mode: Mode): void {

    const route = currentRoute();
    if (!route) {
        tell(player, format("warn", whyNotARoute(currentSpec()) ?? "This is not a route."));
        return;
    }

    stopRun("a new run");

    const dimension = world.getDimension(OVERWORLD);
    const start = pointAt(route, 0);
    if (!dimension.isChunkLoaded(start)) {
        tell(player, format("warn", "The start of the route is not loaded: go to the first station first."));
        return;
    }

    let car: Entity;
    try {
        car = dimension.spawnEntity(CAR_TYPE, start);
    } catch (error) {
        tell(player, format("warn", `Could not spawn the car: ${error}`));
        return;
    }
    car.addTag(CAR_TAG);
    car.setRotation({ x: 0, y: headingAt(route, 0).yaw });

    run = {
        car, route, mode, state: "waiting", departAt: undefined, forced: false, s: 0, speed: 0,
        startedTick: system.currentTick, lastTarget: undefined, lastHere: undefined, lastCommand: 0,
        resyncs: 0, held: 0, window: freshWindow()
    };
    stopDrive = onTick("transit:drive", driveTick, { everyTicks: 1 });

    log(`${mode} run: route ${fixed(route.length, 1)} blocks, ${route.loop ? "loop" : "line"}, car ${car.id} at ${pos(start)}`);
    tell(player, format("ok", `The car is at the start (${mode}). Right-click it to sit; it leaves ${T.spikeDepartDelayTicks / 20} s after someone does. /scriptevent rae:train_spike go leaves now, stop removes it.`));
}

function driveTick(): void {

    const r = run;
    if (!r) return;

    if (!r.car.isValid) {
        log("the car is gone (removed or unloaded)");
        stopRun("car gone");
        return;
    }

    const tick = system.currentTick;

    if (r.state === "waiting") {
        const riders = ridersOf(r.car);
        if (!r.forced) {
            if (riders.length > 0 && r.departAt === undefined) {
                r.departAt = tick + T.spikeDepartDelayTicks;
                log(`${riders.length} rider(s) aboard: ${describeRiders(r.car)}; leaving in ${T.spikeDepartDelayTicks} ticks`);
            }
            if (riders.length === 0) r.departAt = undefined;
            if (r.departAt === undefined || tick < r.departAt) return;
        }
        r.state = "running";
        log(`leaving the start, ${riders.length} aboard`);
    }

    if (r.state === "arrived") {
        // The last step was commanded on the arrival tick; now that it has been taken, stand still.
        r.car.clearVelocity();
        stopDrive?.();
        stopDrive = undefined;
        return;
    }

    if (r.state !== "running") return;

    const dimension = r.car.dimension;
    const here = r.car.location;

    // How far the car really is from where last tick's command was aiming it, and how much of that command the engine delivered.
    const window = r.window;
    if (r.lastTarget) {
        const error = gap(here, r.lastTarget);
        window.errorSum += error;
        window.errorMax = Math.max(window.errorMax, error);
    }
    if (r.mode === "momentum" && r.lastHere && r.lastCommand > 0.05) {
        window.deliveredSum += gap(here, r.lastHere) / r.lastCommand;
        window.deliveredCount++;
    }
    window.ticks++;

    const remaining = r.route.loop ? Infinity : r.route.length - r.s;
    const speed = nextSpeed(r.speed, remaining, PROFILE);
    const move = stepDistance(speed, remaining);
    const targetS = r.s + move;
    const target = pointAt(r.route, targetS);

    // Never run into chunks that are not loaded: hold still until they are.
    if (!dimension.isChunkLoaded(target)) {
        r.car.clearVelocity();
        r.held++;
        r.lastTarget = undefined;
        r.lastHere = undefined;
        r.lastCommand = 0;
        if (window.ticks >= T.spikeLogEveryTicks) reportWindow(r);
        return;
    }

    r.speed = speed;
    r.s = targetS;
    const rotation = { x: 0, y: headingAt(r.route, targetS).yaw };

    if (r.mode === "teleport") {
        r.car.teleport(target, { rotation, keepVelocity: false });
        r.lastCommand = 0;
    } else {
        const steering = steer(here, target, {
            velocityScale: T.velocityScale, maxStep: T.maxStep, resyncDistance: T.resyncDistance, gain: T.correctionGain
        });
        if (steering.resync) {
            // Far from the route (a stall, or just spawned): place it back on the route, then drive on from there.
            r.car.teleport(target, { rotation, keepVelocity: false });
            r.resyncs++;
            r.lastCommand = 0;
        } else {
            r.car.clearVelocity();
            r.car.applyImpulse(steering.velocity);
            r.car.setRotation(rotation);
            r.lastCommand = Math.hypot(steering.velocity.x, steering.velocity.y, steering.velocity.z);
        }
    }
    r.lastTarget = target;
    r.lastHere = here;

    if (window.ticks >= T.spikeLogEveryTicks) reportWindow(r);

    if (!r.route.loop && remaining - move <= 1e-6) {
        // The velocity just given carries the car the last of the way; the next tick clears it.
        r.state = "arrived";
        reportWindow(r);
        log(`arrived at the end of the route after ${tick - r.startedTick} ticks, ${r.resyncs} resyncs, ${r.held} ticks held`);
    }
}

function reportWindow(r: Run): void {
    const w = r.window;
    const mean = w.ticks > 0 ? w.errorSum / w.ticks : 0;
    const delivered = w.deliveredCount > 0 ? fixed(w.deliveredSum / w.deliveredCount) : "n/a";
    log(`${r.mode} t=${system.currentTick - r.startedTick} s=${fixed(r.s, 1)}/${fixed(r.route.length, 1)} speed=${fixed(r.speed)} `
        + `error(mean=${fixed(mean)} max=${fixed(w.errorMax)}) delivered=${delivered} resyncs=${r.resyncs} held=${r.held} `
        + `riders=[${describeRiders(r.car)}]`);
    r.window = freshWindow();
}

// ---------------------------------------------------------------------------------------------------------
// The measurements
// ---------------------------------------------------------------------------------------------------------

/** A car in front of the player, off the route, for the tests that do not need one. */
function placeTestCar(player: Player): Entity | undefined {
    stopRun("a new test");
    const look = player.getViewDirection();
    const flat = Math.hypot(look.x, look.z) || 1;
    const at = { x: player.location.x + (look.x / flat) * 4, y: player.location.y + 1, z: player.location.z + (look.z / flat) * 4 };
    try {
        const car = player.dimension.spawnEntity(CAR_TYPE, at);
        car.addTag(CAR_TAG);
        testCar = car;
        return car;
    } catch (error) {
        tell(player, format("warn", `Could not spawn the car: ${error}`));
        return undefined;
    }
}

/** For each impulse size: how far the car moves in each of the next ticks, and what the engine says its velocity is. */
function dragTest(player: Player): void {

    const car = placeTestCar(player);
    if (!car) return;

    const start = car.location;
    const speeds = T.dragTestSpeeds;
    const SAMPLES = 6;
    const CYCLE = SAMPLES + 3;                                  // kick, sample x6, log and put back, settle
    const delivered: string[] = [];
    let tick = 0;
    let last = start;
    let moved: number[] = [];
    let readback: number[] = [];

    stopDragTest = onTick("transit:drag", () => {

        const index = Math.floor(tick / CYCLE);
        const step = tick % CYCLE;
        tick++;

        if (!car.isValid) {
            log("drag: the car vanished");
            stopRun("drag test");
            return;
        }
        if (index >= speeds.length) {
            log(`drag summary: delivered in the first tick = ${delivered.join(", ")} (set TRANSIT.velocityScale to the value for a small impulse)`);
            tell(player, format("ok", "Drag test done: see the content log."));
            stopRun("drag test done");
            return;
        }

        const impulse = speeds[index]!;
        if (step === 0) {
            car.clearVelocity();
            car.applyImpulse({ x: impulse, y: 0, z: 0 });
            last = car.location;
            moved = [];
            readback = [];
        } else if (step <= SAMPLES) {
            const here = car.location;
            moved.push(here.x - last.x);
            readback.push(car.getVelocity().x);
            last = here;
        } else if (step === SAMPLES + 1) {
            const firstTick = moved[0] ?? 0;
            delivered.push(`${impulse}: ${fixed(firstTick / impulse)}`);
            log(`drag: impulse ${impulse} -> moved per tick [${moved.map((m) => fixed(m)).join(", ")}], velocity readback [${readback.map((v) => fixed(v)).join(", ")}]`);
            car.clearVelocity();
            car.teleport(start, { keepVelocity: false });
        }
    }, { everyTicks: 1 });

    tell(player, format("ok", "Drag test running: watch the content log."));
}

/** The biggest impulse the engine accepts. Each is cleared in the same tick, so the car never moves. */
function limitsTest(player: Player): void {

    const car = placeTestCar(player);
    if (!car) return;

    const results = T.impulseLimitTests.map((size) => {
        try {
            car.applyImpulse({ x: size, y: 0, z: 0 });
            car.clearVelocity();
            return `${size}: ok`;
        } catch (error) {
            try { car.clearVelocity(); } catch { /* keep going */ }
            return `${size}: ${String(error).slice(0, 80)}`;
        }
    });

    log(`limits: ${results.join(" | ")}`);
    tell(player, format("ok", `Impulse limits: ${results.join("; ")}`));
    stopRun("limits test done");
}

/** Cows stand in for players: how many the car takes, and where each one sits. */
function seatsTest(player: Player, message: string): void {

    const wanted = Math.min(T.seatTestMaxCows, Math.max(1, Number.parseInt(message, 10) || 4));
    const car = run?.car.isValid ? run.car : placeTestCar(player);
    if (!car) return;

    const seats = car.getComponent("minecraft:rideable");
    if (!seats) {
        tell(player, format("warn", "The car has no seats: is the behavior pack the newest version?"));
        return;
    }

    const results: string[] = [];
    const mine: Entity[] = [];
    for (let i = 0; i < wanted; i++) {
        try {
            const cow = car.dimension.spawnEntity(COW_TYPE, car.location);
            mine.push(cow);
            results.push(String(seats.addRider(cow)));
        } catch (error) {
            results.push(`threw ${String(error).slice(0, 60)}`);
        }
    }
    cows.push(...mine);
    const thisBatch = batch;

    log(`seats: seatCount=${seats.seatCount}, ${wanted} cows, addRider results [${results.join(", ")}], riders now ${seats.getRiders().length}`);
    tell(player, format("ok", `Seats: ${results.filter((r) => r === "true").length} of ${wanted} cows sat. Offsets go to the content log.`));

    system.runTimeout(() => {
        if (car.isValid) log(`seats: rider offsets from the car (x,y,z): ${describeRiders(car)}`);
    }, 10);

    system.runTimeout(() => {
        if (batch !== thisBatch) return;
        for (const cow of mine) safeRemove(cow);
        cows = cows.filter((cow) => !mine.includes(cow));
    }, T.seatTestTicks);
}

const USAGE = "Usage: /scriptevent rae:train_spike momentum | teleport | go | stop | drag | limits | seats [cows]";

onPlayerCommand("rae:train_spike", (player, message) => {

    const [command = "", argument = ""] = message.toLowerCase().split(/\s+/);

    switch (command) {
        case "momentum":
        case "teleport":
            startRun(player, command);
            return;
        case "go":
            if (run?.state === "waiting") {
                run.forced = true;
                tell(player, format("ok", "Leaving now."));
            } else {
                tell(player, format("warn", "There is no car waiting: start one with momentum or teleport."));
            }
            return;
        case "stop":
            stopRun("stopped by command");
            tell(player, format("ok", "Test cars removed."));
            return;
        case "drag":
            dragTest(player);
            return;
        case "limits":
            limitsTest(player);
            return;
        case "seats":
            seatsTest(player, argument);
            return;
        default:
            tell(player, format("warn", USAGE));
    }
});

// ---------------------------------------------------------------------------------------------------------
// Clean-up: no car is ever left behind
// ---------------------------------------------------------------------------------------------------------

const isLive = (entity: Entity): boolean => entity.id === run?.car.id || entity.id === testCar?.id;

/** A car that loads with a chunk (after a reload or a restart) belongs to no run, so it goes. */
world.afterEvents.entityLoad.subscribe((event) => {
    if (event.entity.typeId === CAR_TYPE && !isLive(event.entity)) safeRemove(event.entity);
});

function sweepStrays(dimension: Dimension): void {
    for (const car of dimension.getEntities({ type: CAR_TYPE })) {
        if (!isLive(car)) safeRemove(car);
    }
}

// Cars already in loaded chunks when the scripts start (a /reload) do not fire entityLoad.
system.runTimeout(() => sweepStrays(world.getDimension(OVERWORLD)), 40);

registerSystem({
    name: "transit",
    reset() {
        // The route is part of the world, not of a round: only the cars go.
        stopRun("round reset");
        stopShow?.();
        stopShow = undefined;
        sweepStrays(world.getDimension(OVERWORLD));
    }
});
