// Generates the placed Gatling gun's model: BountySys_RP/models/entity/gatling_gun.geo.json and
// textures/entity/gatling_gun.png.
//
//     node scripts/gen-gatling-model.mjs
//
// Same technique as scripts/gen-train-model.mjs (read that file's own header first): a handful of boxes, and
// a texture that is one flat colour per texel, so no art has to be drawn and a colour change is one line
// here. To use a hand-made Blockbench model instead, replace `gatling_gun.geo.json` (keep the geometry
// identifier `geometry.gatling_gun`) and the texture, and stop running this script.
//
// Units are model pixels, 16 to a block. A wooden base plate and post carry a brass receiver; five barrels
// ring the receiver and point forward (-Z, the way Bedrock models face) so the cluster reads as a Gatling
// gun's signature look without any bone rotation (every box here is axis-aligned, same simplification
// gen-train-model.mjs makes). The seat systems/guns.ts's rideable component defines sits just behind and
// above the receiver, roughly where a gunner would stand to crank it.
// `test/assets.test.mjs` runs `buildGeometry()` and `buildPng()` and fails when the committed files are not what it makes.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const GEOMETRY_ID = "geometry.gatling_gun";
export const TEXTURE_SIZE = 16;

/** Colour name -> [r, g, b]. The order is the texel order (texel i is at x = i, y = 0). */
export const PALETTE = {
    wood: [110, 78, 46],
    darkWood: [78, 54, 30],
    brass: [180, 140, 60],
    iron: [70, 70, 76],
    darkIron: [40, 40, 44]
};
const NAMES = Object.keys(PALETTE);

/** [origin x, y, z, size x, y, z, colour]. */
const GUN = [
    // Base plate and post: a squat wooden mount, planted where the gun is placed.
    [-8, 0, -8, 16, 2, 16, "darkWood"],
    [-3, 2, -3, 6, 10, 6, "wood"],
    // Receiver: the brass block the barrels and the crank attach to.
    [-7, 12, -6, 14, 6, 10, "brass"],
    // Five barrels ringing the receiver's centre, all pointing forward out of its front (-Z) face.
    [-1, 18, -20, 2, 2, 14, "iron"],
    [3, 16, -20, 2, 2, 14, "iron"],
    [-5, 16, -20, 2, 2, 14, "iron"],
    [2, 12, -20, 2, 2, 14, "iron"],
    [-4, 12, -20, 2, 2, 14, "iron"],
    // Muzzle caps, a shade darker so the cluster doesn't read as one flat colour end-on.
    [-1, 18, -21, 2, 2, 1, "darkIron"],
    [3, 16, -21, 2, 2, 1, "darkIron"],
    [-5, 16, -21, 2, 2, 1, "darkIron"],
    [2, 12, -21, 2, 2, 1, "darkIron"],
    [-4, 12, -21, 2, 2, 1, "darkIron"],
    // Crank handle on the side, for the "you spin it up" read.
    [7, 13, -2, 3, 3, 2, "darkIron"]
];

const FACES = ["north", "east", "south", "west", "up", "down"];

function faceUv(colour) {
    const texel = NAMES.indexOf(colour);
    if (texel < 0) throw new Error(`unknown colour "${colour}"`);
    return Object.fromEntries(FACES.map((face) => [face, { uv: [texel, 0], uv_size: [1, 1] }]));
}

export function buildGeometry() {
    return {
        format_version: "1.16.0",
        "minecraft:geometry": [{
            description: {
                identifier: GEOMETRY_ID,
                texture_width: TEXTURE_SIZE,
                texture_height: TEXTURE_SIZE,
                visible_bounds_width: 3,
                visible_bounds_height: 2,
                visible_bounds_offset: [0, 0.6, 0]
            },
            bones: [{
                name: "gun",
                pivot: [0, 0, 0],
                cubes: GUN.map(([x, y, z, w, h, d, colour]) => ({ origin: [x, y, z], size: [w, h, d], uv: faceUv(colour) }))
            }]
        }]
    };
}

/** The geometry file's text: indented, but each cube on one line so the file stays readable. */
export function renderGeometry() {
    const geometry = buildGeometry();
    const bone = geometry["minecraft:geometry"][0].bones[0];
    const cubes = bone.cubes;
    bone.cubes = ["@@CUBES@@"];
    const cubeLines = cubes.map((cube) => " ".repeat(24) + JSON.stringify(cube)).join(",\n");
    return JSON.stringify(geometry, null, 4)
        .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, "[$1, $2, $3]")
        .replace(/ *"@@CUBES@@"/, cubeLines) + "\n";
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
    writeFileSync(path.join(rp, "models", "entity", "gatling_gun.geo.json"), renderGeometry());
    writeFileSync(path.join(rp, "textures", "entity", "gatling_gun.png"), buildPng());
    console.log("wrote models/entity/gatling_gun.geo.json and textures/entity/gatling_gun.png");
}
