import { test } from "node:test";
import { load, checks, approx } from "./helpers.mjs";

// The train's track maths: recording a route, saving it, smoothing it into a curve, measuring
// along it, the way it points, the speed profile and the steering that pulls a physics body onto it.
// Pure code, so there is no fake game here and every number is exact.

const {
    EMPTY_SPEC, addWaypoint, undoWaypoint, setLoop, whyNotARoute, serializeSpec, parseSpec,
    buildRoute, pointAt, headingAt, yawOf, nextStation, distanceAhead, nearestS,
    nextSpeed, stepDistance, steer, summarize, sampleEvery
} = await load("logic/route.js");

const P = (x, y, z, station) => (station === undefined ? { x, y, z } : { x, y, z, station });
const spec = (waypoints, loop = false) => ({ loop, waypoints });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Marks a list of points in order; every one must be accepted. */
function record(points, loop = false) {
    let s = spec([], loop);
    for (const p of points) {
        const r = addWaypoint(s, p, p.station);
        if (!r.ok) throw new Error(`could not record ${JSON.stringify(p)}: ${r.reason}`);
        s = r.spec;
    }
    return s;
}

const STRAIGHT = record([P(0, 64, 0, "Depot"), P(0, 64, 20), P(0, 64, 40, "End")]);
const LSHAPE = record([P(0, 64, 0, "Start"), P(10, 64, 0), P(10, 64, 10, "Corner"), P(10, 64, 30)]);
const SQUARE = record([P(0, 64, 0, "A"), P(20, 64, 0), P(20, 64, 20, "B"), P(0, 64, 20)], true);

// ---------------------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------------------

test("recording: points are rounded, stations named, undo and loop work on the record", () => {
    const { check, done } = checks();

    const a = addWaypoint(EMPTY_SPEC, { x: 1.23456, y: 64, z: -7.891 });
    check("first mark accepted", a.ok);
    check("coordinates rounded to 0.01", a.ok && a.spec.waypoints[0].x === 1.23 && a.spec.waypoints[0].z === -7.89, JSON.stringify(a.spec?.waypoints));

    const b = addWaypoint(a.spec, P(11, 64, -7.89), "  Grand   Central  Terminus-and-more  ");
    check("station added", b.ok);
    check("name trimmed, spaces squeezed, cut to 24", b.ok && b.spec.waypoints[1].station === "Grand Central Terminus-a", b.spec?.waypoints[1]?.station);

    const c = addWaypoint(b.spec, P(11.2, 64, -7.89));
    check("marking on top of the last point refuses", !c.ok && /on top of/.test(c.reason), JSON.stringify(c));

    const d = addWaypoint(a.spec, P(1.3, 64, -7.8), "Depot");
    check("naming the point you stand on makes it a station instead of a new point", d.ok && d.spec.waypoints.length === 1 && d.spec.waypoints[0].station === "Depot", JSON.stringify(d));

    const e = addWaypoint(d.spec, P(1.3, 64, -7.8), "Other");
    check("a point that is already a station cannot be renamed by marking again", !e.ok && /already the station "Depot"/.test(e.reason), JSON.stringify(e));

    const f = addWaypoint(b.spec, P(30, 64, 0), "GRAND CENTRAL TERMINUS-A");
    check("station names are unique, ignoring case", !f.ok && /already a station/.test(f.reason), JSON.stringify(f));
    const g = addWaypoint(a.spec, P(1.3, 64, -7.8), "   ");
    check("a blank station name refuses", !g.ok && /needs a name/.test(g.reason), JSON.stringify(g));

    const full = addWaypoint(b.spec, P(50, 64, 0), undefined, 2);
    check("a full route refuses", !full.ok && /full/.test(full.reason), JSON.stringify(full));
    check("marking at the same spot is not blocked by fullness when it only names the point", addWaypoint(a.spec, P(1.3, 64, -7.8), "Depot", 1).ok);

    const u = undoWaypoint(b.spec);
    check("undo removes the last point, not the first", u.ok && u.spec.waypoints.length === 1 && u.spec.waypoints[0].x === 1.23 && u.spec.waypoints[0].station === undefined, JSON.stringify(u.spec));
    check("undo on an empty route refuses", !undoWaypoint(EMPTY_SPEC).ok);
    check("the earlier record was not changed by editing", a.spec.waypoints.length === 1 && b.spec.waypoints.length === 2);

    check("loop flag set on a copy", setLoop(b.spec, true).loop === true && b.spec.loop === false);
    done();
});

test("whyNotARoute: what a route needs before a train can use it", () => {
    const { check, done } = checks();
    check("nothing marked", /at least 2/.test(whyNotARoute(EMPTY_SPEC)));
    check("one point", /at least 2/.test(whyNotARoute(spec([P(0, 0, 0, "A")]))));
    check("no station", /no station/.test(whyNotARoute(spec([P(0, 0, 0), P(0, 0, 9)]))));
    check("a loop needs 3", /loop needs at least 3/.test(whyNotARoute(spec([P(0, 0, 0, "A"), P(0, 0, 9)], true))));
    check("two points and a station is a route", whyNotARoute(spec([P(0, 0, 0, "A"), P(0, 0, 9)])) === undefined);
    check("three points make a loop", whyNotARoute(SQUARE) === undefined);
    check("buildRoute refuses what is not a route", buildRoute(EMPTY_SPEC) === undefined);
    done();
});

test("saving: the record survives a round trip, and garbage never becomes a route or throws", () => {
    const { check, done } = checks();
    for (const s of [STRAIGHT, LSHAPE, SQUARE, EMPTY_SPEC]) {
        const back = parseSpec(serializeSpec(s));
        check("round trip", JSON.stringify(back) === JSON.stringify(s), serializeSpec(s));
    }
    const text = serializeSpec(SQUARE);
    check("compact enough for a property", text.length < 200, String(text.length));

    const bad = [
        undefined, null, 5, "", "not json", "null", "[]", "{}", '{"v":2,"l":0,"p":[]}', '{"v":1,"l":0}', '{"v":1,"l":0,"p":5}',
        '{"v":1,"l":0,"p":[[1,2]]}', '{"v":1,"l":0,"p":[[1,2,3,4,5]]}', '{"v":1,"l":0,"p":[[1,2,"z"]]}',
        '{"v":1,"l":0,"p":[[1,2,3,7]]}', '{"v":1,"l":0,"p":[[1,2,3,""]]}', '{"v":1,"l":0,"p":[["1",2,3]]}', '{"v":1,"l":0,"p":[1]}'
    ];
    for (const value of bad) {
        let result, threw = false;
        try { result = parseSpec(value); } catch { threw = true; }
        check(`parse ${JSON.stringify(value)}`, !threw && result === undefined, threw ? "threw" : JSON.stringify(result));
    }
    check("a non-finite number is rejected", parseSpec('{"v":1,"l":0,"p":[[1e999,2,3]]}') === undefined);
    check("loop reads back as a boolean", parseSpec('{"v":1,"l":1,"p":[]}').loop === true && parseSpec('{"v":1,"l":0,"p":[]}').loop === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------------------------------------

test("a straight route measures exactly and passes through every mark", () => {
    const { check, done } = checks();
    const route = buildRoute(STRAIGHT);
    check("length", approx(route.length, 40, 1e-9), String(route.length));
    check("start", dist(pointAt(route, 0), P(0, 64, 0)) < 1e-9);
    check("middle mark", dist(pointAt(route, 20), P(0, 64, 20)) < 1e-9, JSON.stringify(pointAt(route, 20)));
    check("end", dist(pointAt(route, 40), P(0, 64, 40)) < 1e-9);
    check("halfway along a leg is halfway", dist(pointAt(route, 10), P(0, 64, 10)) < 1e-9);
    check("stations sit at their marks", route.stations.length === 2 && route.stations[0].name === "Depot" && approx(route.stations[0].s, 0) && route.stations[1].name === "End" && approx(route.stations[1].s, 40), JSON.stringify(route.stations));
    done();
});

test("a corner is smoothed: the curve passes through every mark, stays close to the marked path, and has no jumps", () => {
    const { check, done } = checks();
    const route = buildRoute(LSHAPE);
    const marks = LSHAPE.waypoints;

    const nearest = marks.map((m) => Math.min(...route.ss.map((_, i) => dist({ x: route.xs[i], y: route.ys[i], z: route.zs[i] }, m))));
    check("every mark is on the curve", nearest.every((d) => d < 1e-9), JSON.stringify(nearest));

    // A spline that passes through a mark bows out a little between marks, so it is a touch longer than straight lines joining them.
    const polyline = dist(marks[0], marks[1]) + dist(marks[1], marks[2]) + dist(marks[2], marks[3]);
    const chord = dist(marks[0], marks[3]);
    check("close to the marked path's length, and longer than the straight chord", route.length > chord && route.length >= polyline - 1e-9 && route.length < polyline * 1.1, `${route.length} vs ${polyline} / ${chord}`);

    // Distance really is arc length: a step of ds along s moves the point by ds (a hair less on a curve).
    let worst = 0, least = Infinity, maxTurn = 0, previousYaw = headingAt(route, 0).yaw;
    const ds = 0.25;
    for (let s = 0; s < route.length - ds; s += ds) {
        const moved = dist(pointAt(route, s), pointAt(route, s + ds));
        worst = Math.max(worst, moved); least = Math.min(least, moved);
        const yaw = headingAt(route, s + ds).yaw;
        let turn = Math.abs(yaw - previousYaw); if (turn > 180) turn = 360 - turn;
        maxTurn = Math.max(maxTurn, turn); previousYaw = yaw;
    }
    check("never moves more than the distance asked", worst <= ds + 1e-9, String(worst));
    check("never moves much less (no dead spots)", least >= ds * 0.9, String(least));
    check("heading changes smoothly (no snap at the corner)", maxTurn < 15, `max turn per ${ds} blocks: ${maxTurn}`);
    done();
});

test("yaw follows Bedrock's convention: 0 faces +Z, 90 faces -X, -90 faces +X, 180 faces -Z", () => {
    const { check, done } = checks();
    check("+Z", yawOf(0, 1) === 0, String(yawOf(0, 1)));
    check("-X", approx(yawOf(-1, 0), 90), String(yawOf(-1, 0)));
    check("+X", approx(yawOf(1, 0), -90), String(yawOf(1, 0)));
    check("-Z", approx(yawOf(0, -1), 180), String(yawOf(0, -1)));
    check("no move", yawOf(0, 0) === 0);
    check("+X+Z diagonal", approx(yawOf(1, 1), -45), String(yawOf(1, 1)));

    const heading = (from, to) => headingAt(buildRoute(record([{ ...from, station: "A" }, to])), 5);
    check("a route heading south", approx(heading(P(0, 64, 0), P(0, 64, 30)).yaw, 0));
    check("a route heading west", approx(heading(P(0, 64, 0), P(-30, 64, 0)).yaw, 90));
    check("a route heading east", approx(heading(P(0, 64, 0), P(30, 64, 0)).yaw, -90));
    check("a route heading north", approx(heading(P(0, 64, 0), P(0, 64, -30)).yaw, 180));

    const climb = headingAt(buildRoute(record([P(0, 64, 0, "A"), P(0, 74, 10)])), 5);
    check("climbing looks up: negative pitch", climb.pitch < -40 && climb.pitch > -50, String(climb.pitch));
    const dive = headingAt(buildRoute(record([P(0, 74, 0, "A"), P(0, 64, 10)])), 5);
    check("descending looks down: positive pitch", dive.pitch > 40 && dive.pitch < 50, String(dive.pitch));
    check("level is 0", approx(headingAt(buildRoute(STRAIGHT), 10).pitch, 0));
    done();
});

test("an open route continues in a straight line beyond both ends", () => {
    const { check, done } = checks();
    const route = buildRoute(STRAIGHT);
    check("behind the start", dist(pointAt(route, -7), P(0, 64, -7)) < 1e-9, JSON.stringify(pointAt(route, -7)));
    check("past the end", dist(pointAt(route, 47), P(0, 64, 47)) < 1e-9, JSON.stringify(pointAt(route, 47)));
    check("the heading there is the same as at the end", approx(headingAt(route, -7).yaw, 0) && approx(headingAt(route, 47).yaw, 0));
    done();
});

test("a loop wraps, closes on itself and is smooth across the join", () => {
    const { check, done } = checks();
    const route = buildRoute(SQUARE);
    check("length is the square's 80 blocks plus the bow of the smoothed sides", route.length >= 80 && route.length < 90, String(route.length));
    check("the end is the start", dist(pointAt(route, route.length - 1e-9), pointAt(route, 0)) < 1e-6);
    for (const s of [0, 7, 33.3]) {
        check(`s and s+length are the same point (s=${s})`, dist(pointAt(route, s), pointAt(route, s + route.length)) < 1e-9);
        check(`negative s wraps (s=${s})`, dist(pointAt(route, s - route.length), pointAt(route, s)) < 1e-9);
        check(`s + 3 laps (s=${s})`, dist(pointAt(route, s + 3 * route.length), pointAt(route, s)) < 1e-6);
    }
    let maxTurn = 0, previous = headingAt(route, 0).yaw;
    for (let s = 0.25; s <= route.length + 5; s += 0.25) {
        const yaw = headingAt(route, s).yaw;
        let turn = Math.abs(yaw - previous); if (turn > 180) turn = 360 - turn;
        maxTurn = Math.max(maxTurn, turn); previous = yaw;
    }
    check("no snap in heading anywhere, including across the join", maxTurn < 20, String(maxTurn));
    done();
});

test("a train's cars follow the curve: a point k*spacing behind the head is on the route and that far back", () => {
    const { check, done } = checks();
    const route = buildRoute(SQUARE);
    for (const head of [30, 55.5, 61, 2]) {
        const cars = [0, 1, 2].map((k) => pointAt(route, head - k * 7));
        // Around a smooth curve the straight distance between cars is at most the 7 blocks of track between them.
        check(`car 1 is within 7 blocks of the head (head=${head})`, dist(cars[0], cars[1]) <= 7 + 1e-9, String(dist(cars[0], cars[1])));
        check(`and not bunched up (head=${head})`, dist(cars[0], cars[1]) > 5, String(dist(cars[0], cars[1])));
        check(`car 2 is within 7 of car 1 (head=${head})`, dist(cars[1], cars[2]) <= 7 + 1e-9);
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Stations and progress
// ---------------------------------------------------------------------------------------------------------

test("stations: the next one ahead, on a loop and on an open route", () => {
    const { check, done } = checks();
    const open = buildRoute(LSHAPE);
    const at = (name) => open.stations.find((s) => s.name === name).s;
    check("from the start, the next is Corner (Start is here)", nextStation(open, 0).name === "Corner");
    check("between Start and Corner", nextStation(open, at("Corner") - 1).name === "Corner");
    check("standing on Corner, the next ahead does not count it", nextStation(open, at("Corner")) === undefined);
    check("past the last station there is none", nextStation(open, at("Corner") + 5) === undefined);
    check("distance to it", approx(distanceAhead(open, 3, at("Corner")), at("Corner") - 3));
    check("an open route: behind is negative", distanceAhead(open, at("Corner") + 2, at("Corner")) < 0);

    const loop = buildRoute(SQUARE);
    const a = loop.stations.find((s) => s.name === "A").s, b = loop.stations.find((s) => s.name === "B").s;
    check("a loop after B comes A again", nextStation(loop, b + 1).name === "A");
    check("standing on A, the next is B", nextStation(loop, a).name === "B");
    check("just before A, it is A", nextStation(loop, loop.length - 0.5).name === "A");
    check("loop distance wraps forward", approx(distanceAhead(loop, b + 1, a), loop.length - (b + 1) + a), String(distanceAhead(loop, b + 1, a)));
    check("a loop with one station: standing on it, it is a whole lap away", (() => {
        const one = buildRoute(record([P(0, 64, 0, "Only"), P(20, 64, 0), P(20, 64, 20)], true));
        return approx(distanceAhead(one, 0, one.stations[0].s), 0) && nextStation(one, 0).name === "Only";
    })());
    done();
});

test("nearestS finds where along the route a point is", () => {
    const { check, done } = checks();
    const route = buildRoute(STRAIGHT);
    check("beside the middle", Math.abs(nearestS(route, P(3, 64, 20)) - 20) <= 0.5, String(nearestS(route, P(3, 64, 20))));
    check("before the start", nearestS(route, P(0, 64, -10)) === 0);
    check("past the end", approx(nearestS(route, P(0, 64, 90)), 40));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------------------------------------

const PROFILE = { cruise: 0.5, accel: 0.01, brake: 0.02, crawl: 0.05 };

/** Drives a train from rest toward a stop `distance` ahead; returns what happened. */
function drive(distance, profile = PROFILE) {
    let speed = 0, travelled = 0, peak = 0, biggestChange = 0, ticks = 0, lastMove = 0;
    while (distance - travelled > 1e-9 && ticks < 20000) {
        const next = nextSpeed(speed, distance - travelled, profile);
        biggestChange = Math.max(biggestChange, Math.abs(next - speed));
        speed = next;
        lastMove = stepDistance(speed, distance - travelled);
        travelled += lastMove;
        peak = Math.max(peak, speed);
        ticks++;
    }
    return { arrived: distance - travelled <= 1e-9, travelled, peak, biggestChange, ticks, lastMove };
}

test("speed profile: pulls away, cruises, and brakes to land on the stop without overshoot or a lurch", () => {
    const { check, done } = checks();
    for (const distance of [3, 10, 25, 60, 150, 400, 1200]) {
        const r = drive(distance);
        check(`${distance} blocks: arrives`, r.arrived, JSON.stringify(r));
        check(`${distance}: never past the stop`, r.travelled <= distance + 1e-9);
        check(`${distance}: never above cruise`, r.peak <= PROFILE.cruise + 1e-12, String(r.peak));
        check(`${distance}: speed changes by no more than the brake per tick`, r.biggestChange <= PROFILE.brake + 1e-12, String(r.biggestChange));
        check(`${distance}: the last move is at most the crawl (a gentle stop)`, r.lastMove <= PROFILE.crawl + 1e-9, String(r.lastMove));
    }
    check("a long run reaches cruise", drive(1200).peak === PROFILE.cruise);
    check("a short hop never gets to cruise", drive(10).peak < PROFILE.cruise);
    check("1200 blocks take the cruise time plus a short start and stop", drive(1200).ticks < 1200 / PROFILE.cruise + 100, String(drive(1200).ticks));

    check("no stop ahead: cruise", nextSpeed(0.49, Infinity, PROFILE) === PROFILE.cruise);
    check("accelerates by accel", approx(nextSpeed(0.1, Infinity, PROFILE), 0.11));
    check("already at cruise stays there", nextSpeed(0.5, Infinity, PROFILE) === 0.5);
    check("faster than allowed slows by at most the brake", approx(nextSpeed(0.5, 0.01, PROFILE), 0.48), String(nextSpeed(0.5, 0.01, PROFILE)));
    check("a stop right here: still pulls away gently from rest, and holds the crawl once there", approx(nextSpeed(0, 0, PROFILE), PROFILE.accel) && nextSpeed(PROFILE.crawl, 0, PROFILE) === PROFILE.crawl);
    check("stepDistance never passes the stop", stepDistance(0.5, 0.2) === 0.2 && stepDistance(0.1, 5) === 0.1 && stepDistance(0.3, -1) === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------------------------------------

test("steer: the velocity that carries a body to the target, capped, scaled and flagged for a resync", () => {
    const { check, done } = checks();
    const options = { velocityScale: 1, maxStep: 2, resyncDistance: 8 };

    const a = steer(P(0, 64, 0), P(0, 64, 0.5), options);
    check("one tick of velocity equal to the gap", approx(a.velocity.z, 0.5) && a.velocity.x === 0 && a.velocity.y === 0);
    check("distance reported", approx(a.distance, 0.5));
    check("close by: drive", a.resync === false);

    const b = steer(P(0, 64, 0), P(3, 64, 4), options);
    check("a long gap is capped to maxStep along the same direction", approx(Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z), 2) && approx(b.velocity.x / b.velocity.z, 0.75), JSON.stringify(b.velocity));
    check("distance is the real gap, not the capped one", approx(b.distance, 5));

    const c = steer(P(0, 64, 0), P(0, 64, 9), options);
    check("beyond the resync distance: teleport", c.resync === true);
    check("exactly at it: still drive", steer(P(0, 64, 0), P(0, 64, 8), options).resync === false);

    const drag = steer(P(0, 64, 0), P(0, 64, 1), { ...options, velocityScale: 0.5 });
    check("an engine that delivers half of a velocity needs twice the velocity", approx(drag.velocity.z, 2), String(drag.velocity.z));

    const soft = steer(P(0, 64, 0), P(0, 64, 1), { ...options, gain: 0.5 });
    check("gain closes only part of the gap", approx(soft.velocity.z, 0.5));

    const vertical = steer(P(5, 64, 5), P(5, 60, 5), options);
    check("down is down (a 4 block drop, capped at 2)", approx(vertical.velocity.y, -2) && vertical.velocity.x === 0, JSON.stringify(vertical.velocity));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------------

test("summary and sampling", () => {
    const { check, done } = checks();
    const route = buildRoute(STRAIGHT);
    const s = summarize(route, 0.5);
    check("length, loop and stations carried over", s.length === route.length && s.loop === false && s.stations.length === 2);
    check("lap time at cruise: 40 blocks at 0.5/tick is 80 ticks, 4 s", approx(s.seconds, 4), String(s.seconds));
    check("no speed, no time", summarize(route, 0).seconds === Infinity);

    const points = sampleEvery(route, 10);
    check("a point every 10 blocks, both ends included", points.length === 5 && dist(points[0], P(0, 64, 0)) < 1e-9 && dist(points[4], P(0, 64, 40)) < 1e-9, JSON.stringify(points));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------------------------

/** How far the point is from the segment a-b, on the ground plane. */
function distanceToSegment(p, a, b) {
    const abx = b.x - a.x, abz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / (abx * abx + abz * abz)));
    return Math.hypot(p.x - (a.x + t * abx), p.z - (a.z + t * abz));
}

test("marks spaced very unevenly do not make the curve swing wide of the marked path (why the spline is centripetal)", () => {
    const { check, done } = checks();
    // A 2 block hop, then a 60 block leg at a right angle: a uniform spline overshoots badly here.
    const marks = [P(0, 64, 0, "A"), P(2, 64, 0), P(2, 64, 60, "B")];
    const route = buildRoute(record(marks));

    let worst = 0;
    for (let s = 0; s <= route.length; s += 0.25) {
        const p = pointAt(route, s);
        worst = Math.max(worst, Math.min(distanceToSegment(p, marks[0], marks[1]), distanceToSegment(p, marks[1], marks[2])));
    }
    check("never more than 2.5 blocks from the marked path", worst < 2.5, `worst ${worst}`);
    check("still passes through every mark", marks.every((m) => Math.min(...route.ss.map((_, i) => dist({ x: route.xs[i], y: route.ys[i], z: route.zs[i] }, m))) < 1e-9));
    done();
});

test("a square loop is symmetric: every side bows out by the same amount, the closing side included", () => {
    const { check, done } = checks();
    const route = buildRoute(SQUARE);
    const marks = SQUARE.waypoints;
    const quarter = route.length / 4;

    const bows = marks.map((a, k) => {
        const b = marks[(k + 1) % marks.length];
        const mid = pointAt(route, (k + 0.5) * quarter);
        return Math.hypot(mid.x - (a.x + b.x) / 2, mid.z - (a.z + b.z) / 2);
    });
    check("each side is a smooth bow, not a straight side", bows.every((b) => b > 0.5), bows.join(", "));
    check("all four the same (a straight closing side would differ)", bows.every((b) => Math.abs(b - bows[0]) < 1e-6), bows.join(", "));
    done();
});
