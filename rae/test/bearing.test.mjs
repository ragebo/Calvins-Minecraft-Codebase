import { test } from "node:test";
import { load, checks, strip, approx } from "./helpers.mjs";

const { relativeBearing, bearingBar } = await load("core/bearing.js");

const S = { x: 0, y: 0, z: 1 }, N = { x: 0, y: 0, z: -1 }, E = { x: 1, y: 0, z: 0 }, W = { x: -1, y: 0, z: 0 };
const o = { x: 0, y: 64, z: 0 };
const T = { east: { x: 10, y: 64, z: 0 }, west: { x: -10, y: 64, z: 0 }, south: { x: 0, y: 64, z: 10 }, north: { x: 0, y: 64, z: -10 } };

test("relativeBearing: hand-checked compass cases", () => {
    const { check, done } = checks();
    check("facing S, east is LEFT (-90)", approx(relativeBearing(S, o, T.east), -90));
    check("facing S, west is RIGHT (+90)", approx(relativeBearing(S, o, T.west), 90));
    check("facing S, south is dead ahead (0)", approx(relativeBearing(S, o, T.south), 0));
    check("facing S, north is directly behind (±180)", approx(Math.abs(relativeBearing(S, o, T.north)), 180));
    check("facing N, east is RIGHT (+90)", approx(relativeBearing(N, o, T.east), 90));
    check("facing N, west is LEFT (-90)", approx(relativeBearing(N, o, T.west), -90));
    check("facing E, south is RIGHT (+90)", approx(relativeBearing(E, o, T.south), 90));
    check("facing E, north is LEFT (-90)", approx(relativeBearing(E, o, T.north), -90));
    check("facing W, north is RIGHT (+90)", approx(relativeBearing(W, o, T.north), 90));
    check("facing W, south is LEFT (-90)", approx(relativeBearing(W, o, T.south), -90));
    check("facing S, southeast is -45", approx(relativeBearing(S, o, { x: 10, y: 64, z: 10 }), -45));
    check("facing S, southwest is +45", approx(relativeBearing(S, o, { x: -10, y: 64, z: 10 }), 45));
    check("pitch and height are ignored", approx(relativeBearing({ x: 0, y: -0.7, z: 0.714 }, o, { x: 10, y: 200, z: 0 }), -90));
    check("looking straight down -> undefined", relativeBearing({ x: 0, y: -1, z: 0 }, o, T.east) === undefined);
    check("nearly straight up -> undefined", relativeBearing({ x: 0.001, y: 1, z: 0.001 }, o, T.east) === undefined);
    check("target directly above -> 0, not NaN", relativeBearing(S, o, { x: 0, y: 90, z: 0 }) === 0);
    done();
});

test("relativeBearing: agrees with an independent yaw-based derivation", () => {
    // yaw 0 = south, 90 = west, facing = (-sin, cos); relative = wrap(targetYaw - playerYaw)
    let mismatches = 0;
    for (let i = 0; i < 500; i++) {
        const yaw = (Math.random() * 360 - 180) * Math.PI / 180;
        const facing = { x: -Math.sin(yaw), y: 0, z: Math.cos(yaw) };
        const to = { x: Math.random() * 200 - 100, y: 64, z: Math.random() * 200 - 100 };
        const targetYaw = Math.atan2(-to.x, to.z);
        let expected = ((targetYaw - yaw) * 180 / Math.PI) % 360;
        if (expected > 180) expected -= 360;
        if (expected <= -180) expected += 360;
        const got = relativeBearing(facing, o, to);
        if (Math.abs(((got - expected) % 360 + 540) % 360 - 180) > 1e-6) mismatches++;
    }
    if (mismatches > 0) throw new Error(`${mismatches} of 500 random cases disagreed`);
});

const opts = { cells: 21, halfWidthDegrees: 90, alignToleranceDegrees: 10 };
const cellsOf = (bar) => strip(bar).slice(2, 2 + 21);
const markerAt = (bar) => cellsOf(bar).indexOf("*");

test("bearingBar: marker placement, chevrons, alignment colour", () => {
    const { check, done } = checks();
    check("0 deg -> center cell (10)", markerAt(bearingBar(0, opts)) === 10);
    check("+90 -> last cell (20)", markerAt(bearingBar(90, opts)) === 20);
    check("-90 -> first cell (0)", markerAt(bearingBar(-90, opts)) === 0);
    check("+45 -> cell 15", markerAt(bearingBar(45, opts)) === 15);
    check("-45 -> cell 5", markerAt(bearingBar(-45, opts)) === 5);
    check("center reference '+' shows when marker is elsewhere", cellsOf(bearingBar(45, opts))[10] === "+");
    check("no '+' when marker sits on center", !cellsOf(bearingBar(0, opts)).includes("+"));

    const right = bearingBar(120, opts), left = bearingBar(-120, opts), idle = bearingBar(undefined, opts);
    check("+120: no marker, right chevron lit", markerAt(right) === -1 && right.includes("§e»") && right.includes("§8«"));
    check("-120: no marker, left chevron lit", markerAt(left) === -1 && left.includes("§e«") && left.includes("§8»"));
    check("180 (behind): right chevron lit", bearingBar(180, opts).includes("§e»"));
    check("exactly +90 is still on the bar, chevron dim", markerAt(bearingBar(90, opts)) === 20 && bearingBar(90, opts).includes("§8»"));
    check("90.5 is off the bar", markerAt(bearingBar(90.5, opts)) === -1 && bearingBar(90.5, opts).includes("§e»"));
    check("undefined: idle strip, both chevrons dim", markerAt(idle) === -1 && idle.includes("§8«") && idle.includes("§8»"));
    check("aligned marker is green", bearingBar(5, opts).includes("§a*"));
    check("boundary 10 deg still aligned", bearingBar(10, opts).includes("§a*"));
    check("10.01 deg not aligned (yellow)", bearingBar(10.01, opts).includes("§e*"));
    check("only ASCII plus « » (the game's font has no arrows)", /^[\x20-\x7E«»§]*$/.test(bearingBar(37, opts)));
    done();
});

test("bearingBar: width never changes and there is never more than one marker", () => {
    let widthChanges = 0, multiMarker = 0;
    for (let r = -180; r <= 180; r += 0.5) {
        const plain = strip(bearingBar(r, opts));
        if (plain.length !== 25) widthChanges++;
        if ((plain.match(/\*/g) ?? []).length > 1) multiMarker++;
    }
    if (widthChanges || multiMarker) throw new Error(`width changed ${widthChanges}x, multi-marker ${multiMarker}x`);
});
