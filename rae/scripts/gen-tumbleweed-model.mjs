// Generates the tumbleweed's model: BountySys_RP/models/entity/tumbleweed.geo.json and
// textures/entity/tumbleweed.png, a tangled ball of thin "twig" boxes.
//
//     node scripts/gen-tumbleweed-model.mjs
//
// Same idea as gen-train-model.mjs: no art is drawn, a tiny palette texture gives each box a flat colour,
// and the shape is whatever this file says it is. A twig is one thin box; the tangle is many twigs, each
// its own bone (bones rotate cleanly; a lone cube's own rotation is less predictable across renderers),
// all pivoting near the same point at different angles. To use a hand-made Blockbench model instead,
// replace tumbleweed.geo.json (keep the geometry identifier `geometry.tumbleweed`) and the texture, and
// stop running this script (test/assets.test.mjs compares the committed files against this generator).
//
// Units are model pixels, 16 to a block. The ball sits on the ground: its centre is at `RADIUS` above
// y = 0, so the entity (whose own origin is at its feet) shows the whole tangle above the ground.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const GEOMETRY_ID = "geometry.tumbleweed";
export const TEXTURE_SIZE = 16;

/** Roughly a 0.8-block ball (16 model pixels to a block). */
export const RADIUS = 6.4;
const TWIG_LENGTH = RADIUS * 2;
const TWIG_THICKNESS = 2;

/** Colour name -> [r, g, b]. The order is the texel order (texel i is at x = i, y = 0). */
export const PALETTE = {
    tan: [176, 140, 84],
    brown: [128, 96, 54],
    darkBrown: [90, 64, 36],
    dust: [206, 178, 128]
};
const NAMES = Object.keys(PALETTE);

/**
 * One twig per entry: [rotationX, rotationY, rotationZ, colour], all pivoting at the ball's centre.
 * The angles were picked by eye for an even, tangled spread, not by a formula.
 */
const TWIGS = [
    [0, 0, 0, "tan"],
    [0, 45, 0, "brown"],
    [0, 90, 0, "darkBrown"],
    [0, 135, 0, "dust"],
    [60, 0, 0, "brown"],
    [60, 90, 0, "tan"],
    [120, 45, 0, "darkBrown"],
    [120, 135, 0, "tan"],
    [35, 20, 70, "dust"],
    [150, 160, 40, "brown"]
];

const FACES = ["north", "east", "south", "west", "up", "down"];

function faceUv(colour) {
    const texel = NAMES.indexOf(colour);
    if (texel < 0) throw new Error(`unknown colour "${colour}"`);
    return Object.fromEntries(FACES.map((face) => [face, { uv: [texel, 0], uv_size: [1, 1] }]));
}

export function buildGeometry() {
    const pivot = [0, RADIUS, 0];

    return {
        format_version: "1.16.0",
        "minecraft:geometry": [{
            description: {
                identifier: GEOMETRY_ID,
                texture_width: TEXTURE_SIZE,
                texture_height: TEXTURE_SIZE,
                visible_bounds_width: 1,
                visible_bounds_height: 1,
                visible_bounds_offset: [0, RADIUS / 16, 0]
            },
            bones: [
                { name: "root", pivot },
                ...TWIGS.map(([rx, ry, rz, colour], i) => ({
                    name: `twig${i}`,
                    parent: "root",
                    pivot,
                    rotation: [rx, ry, rz],
                    cubes: [{
                        origin: [-TWIG_LENGTH / 2, RADIUS - TWIG_THICKNESS / 2, -TWIG_THICKNESS / 2],
                        size: [TWIG_LENGTH, TWIG_THICKNESS, TWIG_THICKNESS],
                        uv: faceUv(colour)
                    }]
                }))
            ]
        }]
    };
}

export function renderGeometry() {
    return JSON.stringify(buildGeometry(), null, 4)
        .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, "[$1, $2, $3]") + "\n";
}

// ---- The texture ----------------------------------------------------------------------------------------------

/** The RGBA pixels of the palette texture: texel i of row 0 is colour i, everything else transparent. */
export function buildPixels() {
    const pixels = Buffer.alloc(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    NAMES.forEach((name, i) => {
        const [r, g, b] = PALETTE[name];
        pixels.set([r, g, b, 255], i * 4);
    });
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
