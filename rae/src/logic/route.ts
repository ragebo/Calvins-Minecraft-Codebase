import type { Vector3 } from "@minecraft/server";

/**
 * The train's track: a route marked point by point in the world, smoothed into a curve, measured
 * by distance travelled, and the maths a moving vehicle needs on it (where it is, which way it
 * points, how fast it may go, how to steer a physics body onto it). Free of game-runtime imports
 * so all of it is testable outside Minecraft.
 *
 * Distances are in blocks along the curve ("s"). Speeds are blocks per tick.
 */

// ---------------------------------------------------------------------------------------------------------
// The route as recorded and saved
// ---------------------------------------------------------------------------------------------------------

export interface Waypoint extends Vector3 {
    /** A named stop. A waypoint without a name only shapes the curve. */
    readonly station?: string;
}

export interface RouteSpec {
    /** true: the last waypoint joins back to the first and the train never reaches an end. */
    readonly loop: boolean;
    readonly waypoints: readonly Waypoint[];
}

export const EMPTY_SPEC: RouteSpec = { loop: false, waypoints: [] };

/** Two waypoints closer than this are the same place (the spline would fold back on itself). */
export const MIN_WAYPOINT_GAP = 1;

const MIN_WAYPOINTS = 2;
const MIN_LOOP_WAYPOINTS = 3;
const MAX_STATION_NAME = 24;

/** Why a route cannot be built, or undefined when it can. */
export function whyNotARoute(spec: RouteSpec): string | undefined {
    const needed = spec.loop ? MIN_LOOP_WAYPOINTS : MIN_WAYPOINTS;
    if (spec.waypoints.length < needed) {
        return spec.loop
            ? `A loop needs at least ${needed} marked points (there are ${spec.waypoints.length}).`
            : `A route needs at least ${needed} marked points (there are ${spec.waypoints.length}).`;
    }
    if (!spec.waypoints.some((w) => w.station !== undefined)) {
        return "The route has no station yet: run /scriptevent rae:train_station <name> where the train should wait.";
    }
    return undefined;
}

const gap = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export type EditResult =
    | { readonly ok: true; readonly spec: RouteSpec }
    | { readonly ok: false; readonly reason: string };

function cleanName(name: string): string {
    return name.trim().replace(/\s+/g, " ").slice(0, MAX_STATION_NAME);
}

/**
 * Adds a waypoint at the end. `station` (when given) names it as a stop. Standing where the last
 * point already is refuses, except to name that point as a station (marking, then naming, at the
 * same spot is the normal way to record a stop).
 */
export function addWaypoint(spec: RouteSpec, at: Vector3, station?: string, maxWaypoints = Infinity): EditResult {
    const name = station === undefined ? undefined : cleanName(station);
    if (name === "") return { ok: false, reason: "A station needs a name." };

    const round = (n: number) => Math.round(n * 100) / 100;
    const point: Vector3 = { x: round(at.x), y: round(at.y), z: round(at.z) };

    if (name !== undefined && spec.waypoints.some((w) => w.station?.toLowerCase() === name.toLowerCase())) {
        return { ok: false, reason: `There is already a station called "${name}".` };
    }

    const last = spec.waypoints[spec.waypoints.length - 1];
    if (last && gap(last, point) < MIN_WAYPOINT_GAP) {
        if (name === undefined) return { ok: false, reason: "That is on top of the last marked point: walk on before marking again." };
        if (last.station !== undefined) return { ok: false, reason: `That point is already the station "${last.station}".` };
        const renamed: Waypoint = { ...last, station: name };
        return { ok: true, spec: { ...spec, waypoints: [...spec.waypoints.slice(0, -1), renamed] } };
    }

    if (spec.waypoints.length >= maxWaypoints) {
        return { ok: false, reason: `The route is full (${maxWaypoints} points).` };
    }
    const waypoint: Waypoint = name === undefined ? point : { ...point, station: name };
    return { ok: true, spec: { ...spec, waypoints: [...spec.waypoints, waypoint] } };
}

/** Removes the last marked point. */
export function undoWaypoint(spec: RouteSpec): EditResult {
    if (spec.waypoints.length === 0) return { ok: false, reason: "There is nothing to undo." };
    return { ok: true, spec: { ...spec, waypoints: spec.waypoints.slice(0, -1) } };
}

export function setLoop(spec: RouteSpec, loop: boolean): RouteSpec {
    return { ...spec, loop };
}

// ---------------------------------------------------------------------------------------------------------
// Saving: a compact string that fits a world dynamic property
// ---------------------------------------------------------------------------------------------------------

const SAVE_VERSION = 1;

export function serializeSpec(spec: RouteSpec): string {
    return JSON.stringify({
        v: SAVE_VERSION,
        l: spec.loop ? 1 : 0,
        p: spec.waypoints.map((w) => (w.station === undefined ? [w.x, w.y, w.z] : [w.x, w.y, w.z, w.station]))
    });
}

/** The saved string back into a route, or undefined for anything that is not one (never throws). */
export function parseSpec(text: string | undefined): RouteSpec | undefined {
    if (typeof text !== "string" || text === "") return undefined;
    let data: unknown;
    try { data = JSON.parse(text); } catch { return undefined; }
    if (typeof data !== "object" || data === null) return undefined;
    const record = data as Record<string, unknown>;
    if (record.v !== SAVE_VERSION || !Array.isArray(record.p)) return undefined;

    const waypoints: Waypoint[] = [];
    for (const entry of record.p as unknown[]) {
        if (!Array.isArray(entry) || entry.length < 3 || entry.length > 4) return undefined;
        const [x, y, z, station] = entry as unknown[];
        if (![x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
        if (station !== undefined && (typeof station !== "string" || station === "")) return undefined;
        const base = { x: x as number, y: y as number, z: z as number };
        waypoints.push(station === undefined ? base : { ...base, station });
    }
    return { loop: record.l === 1, waypoints };
}

// ---------------------------------------------------------------------------------------------------------
// The smoothed route
// ---------------------------------------------------------------------------------------------------------

export interface Station {
    readonly name: string;
    /** Distance along the route, in [0, length). */
    readonly s: number;
}

export interface Route {
    readonly loop: boolean;
    /** Total length in blocks. For a loop it includes the closing stretch back to the start. */
    readonly length: number;
    readonly stations: readonly Station[];
    // The curve as a table of samples, cumulative distance first.
    readonly ss: readonly number[];
    readonly xs: readonly number[];
    readonly ys: readonly number[];
    readonly zs: readonly number[];
}

const ALPHA = 0.5;                                      // centripetal: no loops or overshoot at sharp marks
const EPSILON = 1e-6;

function lerp3(a: Vector3, b: Vector3, weightB: number): Vector3 {
    return { x: a.x + (b.x - a.x) * weightB, y: a.y + (b.y - a.y) * weightB, z: a.z + (b.z - a.z) * weightB };
}

/** A point on the centripetal Catmull-Rom curve from p1 to p2 (Barry-Goldman form), t in [0, 1]. */
function curvePoint(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number): Vector3 {
    const knot = (a: Vector3, b: Vector3) => Math.pow(Math.max(gap(a, b), EPSILON), ALPHA);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const u = t1 + (t2 - t1) * t;

    const a1 = lerp3(p0, p1, (u - t0) / (t1 - t0));
    const a2 = lerp3(p1, p2, (u - t1) / (t2 - t1));
    const a3 = lerp3(p2, p3, (u - t2) / (t3 - t2));
    const b1 = lerp3(a1, a2, (u - t0) / (t2 - t0));
    const b2 = lerp3(a2, a3, (u - t1) / (t3 - t1));
    return lerp3(b1, b2, (u - t1) / (t2 - t1));
}

/** A phantom neighbour beyond an open route's end, so the curve leaves the end along its last direction. */
const mirror = (end: Vector3, inner: Vector3): Vector3 => ({ x: 2 * end.x - inner.x, y: 2 * end.y - inner.y, z: 2 * end.z - inner.z });

/**
 * Smooths the marked points into a route. `samplesPerBlock` sets how finely the curve is measured
 * (2 is plenty). Returns undefined when the spec is not a route (see whyNotARoute).
 */
export function buildRoute(spec: RouteSpec, samplesPerBlock = 2): Route | undefined {
    if (whyNotARoute(spec) !== undefined) return undefined;

    const points = spec.waypoints;
    const count = points.length;
    const segments = spec.loop ? count : count - 1;
    const at = (i: number): Vector3 => {
        if (spec.loop) return points[((i % count) + count) % count]!;
        if (i < 0) return mirror(points[0]!, points[1]!);
        if (i >= count) return mirror(points[count - 1]!, points[count - 2]!);
        return points[i]!;
    };

    const xs: number[] = [], ys: number[] = [], zs: number[] = [], ss: number[] = [];
    const knotS: number[] = [];                          // distance at each waypoint, for stations
    let travelled = 0;

    const push = (p: Vector3) => {
        if (xs.length > 0) travelled += Math.hypot(p.x - xs[xs.length - 1]!, p.y - ys[ys.length - 1]!, p.z - zs[zs.length - 1]!);
        xs.push(p.x); ys.push(p.y); zs.push(p.z); ss.push(travelled);
    };

    for (let i = 0; i < segments; i++) {
        const p1 = at(i), p2 = at(i + 1);
        const steps = Math.max(2, Math.ceil(gap(p1, p2) * samplesPerBlock));
        push(p1);
        knotS.push(travelled);
        for (let k = 1; k < steps; k++) push(curvePoint(at(i - 1), p1, p2, at(i + 2), k / steps));
    }
    // The end of the last segment: the final waypoint (open) or the start again (loop).
    const last = spec.loop ? at(0) : points[count - 1]!;
    push(last);
    if (!spec.loop) knotS.push(travelled);

    const stations: Station[] = [];
    points.forEach((w, i) => {
        if (w.station !== undefined) stations.push({ name: w.station, s: knotS[i]! });
    });

    return { loop: spec.loop, length: travelled, stations, ss, xs, ys, zs };
}

/** Distance wrapped into the route for a loop; unchanged for an open route. */
function wrap(route: Route, s: number): number {
    if (!route.loop || route.length <= 0) return s;
    return ((s % route.length) + route.length) % route.length;
}

/** Index i such that ss[i] <= s <= ss[i + 1] (s already inside [0, length]). */
function segmentIndex(route: Route, s: number): number {
    let low = 0, high = route.ss.length - 2;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (route.ss[mid]! <= s) low = mid; else high = mid - 1;
    }
    return low;
}

/**
 * The position at distance `s`. On a loop `s` wraps. On an open route, before the start and past the end,
 * the point continues in a straight line along the end direction, so cars queued behind the front
 * of a train standing at the start still sit on the track's line.
 */
export function pointAt(route: Route, s: number): Vector3 {
    const d = wrap(route, s);
    const last = route.ss.length - 1;

    if (!route.loop && d < 0) {
        const t = tangentAtSample(route, 0);
        return { x: route.xs[0]! + t.x * d, y: route.ys[0]! + t.y * d, z: route.zs[0]! + t.z * d };
    }
    if (!route.loop && d > route.length) {
        const t = tangentAtSample(route, last - 1);
        const over = d - route.length;
        return { x: route.xs[last]! + t.x * over, y: route.ys[last]! + t.y * over, z: route.zs[last]! + t.z * over };
    }

    const i = segmentIndex(route, d);
    const span = route.ss[i + 1]! - route.ss[i]!;
    const w = span <= 0 ? 0 : (d - route.ss[i]!) / span;
    return {
        x: route.xs[i]! + (route.xs[i + 1]! - route.xs[i]!) * w,
        y: route.ys[i]! + (route.ys[i + 1]! - route.ys[i]!) * w,
        z: route.zs[i]! + (route.zs[i + 1]! - route.zs[i]!) * w
    };
}

/** Unit direction of the sample segment starting at index i. */
function tangentAtSample(route: Route, i: number): Vector3 {
    const dx = route.xs[i + 1]! - route.xs[i]!, dy = route.ys[i + 1]! - route.ys[i]!, dz = route.zs[i + 1]! - route.zs[i]!;
    const n = Math.hypot(dx, dy, dz);
    return n < EPSILON ? { x: 0, y: 0, z: 0 } : { x: dx / n, y: dy / n, z: dz / n };
}

// ---------------------------------------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------------------------------------

export interface Heading {
    /** Bedrock yaw in degrees, (-180, 180]: 0 faces +Z (south), 90 faces -X (west), -90 faces +X (east), 180 faces -Z. */
    readonly yaw: number;
    /** Bedrock pitch in degrees: positive looks down, negative up. */
    readonly pitch: number;
}

const DEG = 180 / Math.PI;

/** The Bedrock yaw for a horizontal move of (dx, dz); 0 when there is no horizontal move. */
export function yawOf(dx: number, dz: number): number {
    if (Math.hypot(dx, dz) < EPSILON) return 0;
    const yaw = -Math.atan2(dx, dz) * DEG;
    return yaw <= -180 ? yaw + 360 : yaw;
}

/**
 * The way the route points at `s`, from the chord across `span` blocks each side. A chord instead of
 * the exact tangent keeps the heading steady over the small kinks a sampled curve has.
 */
export function headingAt(route: Route, s: number, span = 1.5): Heading {
    const a = pointAt(route, s - span), b = pointAt(route, s + span);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    return { yaw: yawOf(dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * DEG };
}

// ---------------------------------------------------------------------------------------------------------
// Stations and progress
// ---------------------------------------------------------------------------------------------------------

/** The distance from `from` forward to the station at `stationS`. On a loop it is in [0, length); on an open route negative (behind) is returned as-is. */
export function distanceAhead(route: Route, from: number, stationS: number): number {
    if (!route.loop) return stationS - from;
    const d = wrap(route, stationS - from);
    return d;
}

/** The next station ahead of `s` (a station at exactly `s` does not count), or undefined when there is none. */
export function nextStation(route: Route, s: number): Station | undefined {
    const HERE = 1e-6;
    let best: Station | undefined;
    let bestDistance = Infinity;
    for (const station of route.stations) {
        let d = distanceAhead(route, s, station.s);
        if (route.loop && d < HERE) d += route.length;
        if (!route.loop && d < HERE) continue;
        if (d < bestDistance) { best = station; bestDistance = d; }
    }
    return best;
}

/** The distance along the route of the point closest to `p` (for placing something already near the track). */
export function nearestS(route: Route, p: Vector3): number {
    let best = 0, bestSquared = Infinity;
    for (let i = 0; i < route.ss.length; i++) {
        const dx = route.xs[i]! - p.x, dy = route.ys[i]! - p.y, dz = route.zs[i]! - p.z;
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared < bestSquared) { bestSquared = squared; best = route.ss[i]!; }
    }
    return best;
}

// ---------------------------------------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------------------------------------

export interface SpeedProfile {
    /** Top speed, blocks per tick. */
    readonly cruise: number;
    /** Speed gained per tick while pulling away. */
    readonly accel: number;
    /** Speed lost per tick while slowing for a stop. */
    readonly brake: number;
    /** Slowest speed while a stop is still ahead, so a train never stalls just short of the platform. */
    readonly crawl: number;
}

/** Braking is planned with a little less than the real brake so the discrete steps land on the stop instead of past it. */
const BRAKE_MARGIN = 0.8;

/**
 * The train's speed for the next tick. `remaining` is the distance left to a stop, or Infinity when there is none
 * ahead. Accelerates to cruise, and slows so the speed reaches the crawl at the stop.
 */
export function nextSpeed(speed: number, remaining: number, profile: SpeedProfile): number {
    const brakingLimit = Math.sqrt(2 * profile.brake * BRAKE_MARGIN * Math.max(remaining, 0));
    const limit = Math.max(profile.crawl, Math.min(profile.cruise, brakingLimit));
    if (speed < limit) return Math.min(limit, speed + profile.accel);
    return Math.max(limit, speed - profile.brake);
}

/** How far to travel this tick: the speed, but never past the stop. */
export const stepDistance = (speed: number, remaining: number): number => Math.min(speed, Math.max(remaining, 0));

// ---------------------------------------------------------------------------------------------------------
// Steering a physics body onto the route
// ---------------------------------------------------------------------------------------------------------

export interface SteerOptions {
    /** The fraction of the wanted move that one unit of velocity delivers in a tick (1 = no drag; measured by the spike). */
    readonly velocityScale: number;
    /** The largest velocity to command, blocks per tick. */
    readonly maxStep: number;
    /** Farther than this from the target the body is placed there instead of driven (after a stall or on spawn). */
    readonly resyncDistance: number;
    /** How much of the gap to close each tick, (0, 1]; 1 closes it all at once. */
    readonly gain?: number;
}

export interface Steer {
    /** The velocity to give the body this tick (set, not added: clear the old one first). */
    readonly velocity: Vector3;
    /** How far the body is from the target now. */
    readonly distance: number;
    /** true: teleport it to the target instead of driving it. */
    readonly resync: boolean;
}

export function steer(current: Vector3, target: Vector3, options: SteerOptions): Steer {
    const gain = options.gain ?? 1;
    const dx = target.x - current.x, dy = target.y - current.y, dz = target.z - current.z;
    const distance = Math.hypot(dx, dy, dz);
    const scale = gain / options.velocityScale;

    let vx = dx * scale, vy = dy * scale, vz = dz * scale;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > options.maxStep) {
        const shrink = options.maxStep / speed;
        vx *= shrink; vy *= shrink; vz *= shrink;
    }
    return { velocity: { x: vx, y: vy, z: vz }, distance, resync: distance > options.resyncDistance };
}

// ---------------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------------

export interface RouteSummary {
    readonly length: number;
    readonly loop: boolean;
    readonly stations: readonly Station[];
    /** Seconds for one trip at cruise speed (ignores acceleration and stops). */
    readonly seconds: number;
}

export function summarize(route: Route, cruiseBlocksPerTick: number): RouteSummary {
    return {
        length: route.length,
        loop: route.loop,
        stations: route.stations,
        seconds: cruiseBlocksPerTick > 0 ? route.length / cruiseBlocksPerTick / 20 : Infinity
    };
}

/** Points along the route every `every` blocks, for drawing it. */
export function sampleEvery(route: Route, every: number): Vector3[] {
    const out: Vector3[] = [];
    for (let s = 0; s <= route.length; s += every) out.push(pointAt(route, s));
    return out;
}
