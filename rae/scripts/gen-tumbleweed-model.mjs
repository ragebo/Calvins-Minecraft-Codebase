// Generates the tumbleweed's model: BountySys_RP/models/entity/tumbleweed.geo.json and
// textures/entity/tumbleweed.png, several crossed dead-bush-style planes scattered around a ball.
//
//     node scripts/gen-tumbleweed-model.mjs
//
// v1 of this generator (2026-09-21) made a tangle of solid 3D "twig" boxes; a playtest screenshot showed it
// reading as a clump of metal fins, not brush. This version follows the vanilla convention instead: a
// "bush" is two thin, zero-depth planes crossed at 90 degrees (exactly how dead bush, ferns and saplings
// are built), each showing the SAME sparse, alpha-cutout twig texture (drawn below, not a flat colour), so
// the transparent gaps in the texture do the work a real bush's gaps do. Several such crosses, each its own
// pair of bones rotated to a different angle around the same centre, build up a rounder tangle than any one
// cross alone. Nothing here is art someone drew: the texture is a deterministic, seeded branch-drawing walk
// (see `drawBranch`), so re-running this script always makes the exact same file (test/assets.test.mjs
// checks the committed files against it). To use a hand-made Blockbench model instead, replace
// tumbleweed.geo.json (keep the geometry identifier `geometry.tumbleweed`) and the texture, and stop
// running this script.
//
// Units are model pixels, 16 to a block. The ball sits on the ground: its centre is at `RADIUS` above
// y = 0, so the entity (whose own origin is at its feet, corrected onto the real terrain every tick by
// systems/tumbleweed.ts, since it has no block collision of its own) shows the whole tangle above the ground.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const GEOMETRY_ID = "geometry.tumbleweed";
export const TEXTURE_SIZE = 32;

/** Roughly a 0.8-block ball (16 model pixels to a block), matching the entity's collision_box. */
export const RADIUS = 6.4;
/** Each cross is bigger than the ball itself: several, overlapping, are what reads as round from any angle. */
const PLANE_SIZE = RADIUS * 2.2;

/** A twig's brown, darkest to lightest. Picked for a dry, sun-bleached look, not realism. */
export const PALETTE = [
    [64, 46, 28],
    [102, 74, 42],
    [140, 106, 62],
    [176, 140, 88]
];

/**
 * One cross per entry: [rotationX, rotationY, rotationZ], all pivoting at the ball's centre. Each becomes
 * two planes 90 degrees apart (the standard cross-plant technique). The angles were picked by eye for an
 * even, tangled spread, not by a formula.
 */
const UNITS = [
    [0, 0, 0],
    [0, 55, 0],
    [0, 110, 0],
    [55, 20, 0],
    [55, 80, 0],
    [110, 40, 15],
    [130, 100, 45]
];

const FACES = ["north", "east", "south", "west", "up", "down"];

/** Every face maps onto the whole texture: there is one drawn look, not a per-part colour swatch. */
function planeUv() {
    return Object.fromEntries(FACES.map((face) => [face, { uv: [0, 0], uv_size: [TEXTURE_SIZE, TEXTURE_SIZE] }]));
}

export function buildGeometry() {
    const pivot = [0, RADIUS, 0];
    const uv = planeUv();

    /** A zero-depth plane, `localRotationY` degrees around its own centre, before the unit's own rotation on top. */
    function plane(name, parent, localRotationY) {
        return {
            name, parent, pivot,
            rotation: [0, localRotationY, 0],
            cubes: [{
                origin: [-PLANE_SIZE / 2, RADIUS - PLANE_SIZE / 2, 0],
                size: [PLANE_SIZE, PLANE_SIZE, 0],
                uv
            }]
        };
    }

    const bones = [{ name: "root", pivot }];

    UNITS.forEach(([rx, ry, rz], i) => {
        const unit = `unit${i}`;
        bones.push({ name: unit, parent: "root", pivot, rotation: [rx, ry, rz] });
        bones.push(plane(`${unit}a`, unit, 0));
        bones.push(plane(`${unit}b`, unit, 90));
    });

    return {
        format_version: "1.16.0",
        "minecraft:geometry": [{
            description: {
                identifier: GEOMETRY_ID,
                texture_width: TEXTURE_SIZE,
                texture_height: TEXTURE_SIZE,
                visible_bounds_width: PLANE_SIZE / 16 + 0.5,
                visible_bounds_height: PLANE_SIZE / 16 + 0.5,
                visible_bounds_offset: [0, RADIUS / 16, 0]
            },
            bones
        }]
    };
}

export function renderGeometry() {
    return JSON.stringify(buildGeometry(), null, 4)
        .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, "[$1, $2, $3]") + "\n";
}

// ---- The texture ----------------------------------------------------------------------------------------------

/** A tiny, seeded PRNG (mulberry32), so the same seed always draws the same branches. */
function mulberry32(seed) {
    let state = seed | 0;
    return function random() {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SEED = 20260921;

/** Walks a wandering, occasionally forking line of pixels: a twig, then its offshoots. */
function drawBranch(pixels, size, random, x, y, angle, length, colourIndex) {

    for (let step = 0; step < length; step++) {

        x += Math.cos(angle);
        y += Math.sin(angle);
        angle += (random() - 0.5) * 0.7;

        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= size || py >= size) return;

        pixels.set([...PALETTE[colourIndex % PALETTE.length], 255], (py * size + px) * 4);

        const remaining = length - step;
        if (remaining > 5 && random() < 0.07) {
            const fork = angle + (random() < 0.5 ? 1 : -1) * (0.7 + random() * 0.5);
            drawBranch(pixels, size, random, x, y, fork, remaining * 0.55, colourIndex + 1);
        }
    }
}

/** A sparse, alpha-cutout twig tangle, transparent (alpha 0) everywhere nothing was drawn. */
export function buildPixels() {

    const pixels = Buffer.alloc(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    const random = mulberry32(SEED);
    const centre = TEXTURE_SIZE / 2;
    const stems = 9;

    for (let i = 0; i < stems; i++) {
        const angle = (i / stems) * Math.PI * 2 + (random() - 0.5) * 0.5;
        drawBranch(pixels, TEXTURE_SIZE, random, centre, centre, angle, TEXTURE_SIZE * 0.46, i);
    }

    return pixels;
}

export function buildPng() {
    return encodePng(TEXTURE_SIZE, TEXTURE_SIZE, buildPixels());
}

// ---- Command line ------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const rp = path.resolve(import.meta.dirname, "..", "..", "BountySys_RP");
    mkdirSync(path.join(rp, "models", "entity"), { recursive: true });
    mkdirSync(path.join(rp, "textures", "entity"), { recursive: true });
    writeFileSync(path.join(rp, "models", "entity", "tumbleweed.geo.json"), renderGeometry());
    writeFileSync(path.join(rp, "textures", "entity", "tumbleweed.png"), buildPng());
    console.log("wrote models/entity/tumbleweed.geo.json and textures/entity/tumbleweed.png");
}
