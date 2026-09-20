// Generates the train's model: BountySys_RP/models/entity/train.geo.json and textures/entity/train.png.
//
//     node scripts/gen-train-model.mjs
//
// The model is a set of boxes, and the texture is a tiny palette (one flat colour per texel): every face of
// every box points at the texel of its colour, so no art has to be drawn and a colour change is one line
// here. To use a hand-made Blockbench model instead, replace `train.geo.json` (keep the geometry identifier
// `geometry.train_car`) and the texture, and stop running this script.
//
// Units are model pixels, 16 to a block. The car's front is -Z (the way Bedrock models face), the floor is
// at y = 0, the origin is the middle of the floor, and the entity's collision box is 3.2 x 2.4 blocks.
// `test/assets.test.mjs` runs `buildGeometry()` and `buildPng()` and fails when the committed files are not what it makes.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GEOMETRY_ID = "geometry.train_car";
export const TEXTURE_SIZE = 16;

/** Colour name -> [r, g, b]. The order is the texel order (texel i is at x = i, y = 0). */
export const PALETTE = {
    red: [168, 40, 36],
    darkRed: [110, 26, 26],
    grey: [88, 90, 96],
    black: [30, 30, 34],
    wood: [138, 98, 58],
    darkWood: [92, 64, 38],
    gold: [214, 168, 48],
    lamp: [255, 236, 150],
    tail: [220, 40, 30]
};
const NAMES = Object.keys(PALETTE);

/** [origin x, y, z, size x, y, z, colour]. */
const CAR = [
    // Running gear: chassis, four wheels, a coupler at each end.
    [-21, 2, -25, 42, 4, 50, "grey"],
    [-23, 0, -19, 4, 6, 8, "black"], [19, 0, -19, 4, 6, 8, "black"],
    [-23, 0, 11, 4, 6, 8, "black"], [19, 0, 11, 4, 6, 8, "black"],
    [-2, 3, -30, 4, 2, 5, "grey"], [-2, 3, 25, 4, 2, 5, "grey"],
    // Floor and walls (low, so seated riders show above them).
    [-19, 6, -23, 38, 1, 46, "darkWood"],
    [-21, 6, -25, 2, 13, 50, "red"], [19, 6, -25, 2, 13, 50, "red"],
    [-19, 6, -25, 38, 13, 2, "red"], [-19, 6, 23, 38, 13, 2, "red"],
    // A gold rail along the top of the walls.
    [-22, 19, -25, 4, 2, 50, "gold"], [18, 19, -25, 4, 2, 50, "gold"],
    [-18, 19, -26, 36, 2, 3, "gold"], [-18, 19, 23, 36, 2, 3, "gold"],
    // Two benches, each with a back, facing forward (-Z).
    [-17, 7, -19, 34, 4, 9, "wood"], [-17, 11, -10, 34, 8, 2, "wood"],
    [-17, 7, 8, 34, 4, 9, "wood"], [-17, 11, 17, 34, 8, 2, "wood"],
    // Roof on four posts.
    [-21, 21, -25, 3, 10, 3, "grey"], [18, 21, -25, 3, 10, 3, "grey"],
    [-21, 21, 22, 3, 10, 3, "grey"], [18, 21, 22, 3, 10, 3, "grey"],
    [-23, 31, -27, 46, 3, 54, "darkRed"], [-19, 34, -23, 38, 2, 46, "darkRed"],
    // Lamps: yellow at the front (-Z), red at the back, so which way a car faces is plain.
    [-14, 10, -26, 6, 4, 1, "lamp"], [8, 10, -26, 6, 4, 1, "lamp"],
    [-14, 10, 25, 6, 4, 1, "tail"], [8, 10, 25, 6, 4, 1, "tail"]
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
                visible_bounds_width: 5,
                visible_bounds_height: 3,
                visible_bounds_offset: [0, 1.2, 0]
            },
            bones: [{
                name: "car",
                pivot: [0, 0, 0],
                cubes: CAR.map(([x, y, z, w, h, d, colour]) => ({ origin: [x, y, z], size: [w, h, d], uv: faceUv(colour) }))
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

// ---- A minimal PNG writer (RGBA, 8 bits, no interlace, filter 0) -----------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
}

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
    const header = Buffer.alloc(13);
    header.writeUInt32BE(TEXTURE_SIZE, 0);
    header.writeUInt32BE(TEXTURE_SIZE, 4);
    header.set([8, 6, 0, 0, 0], 8);                     // 8 bits, RGBA, deflate, filter method 0, no interlace
    const pixels = buildPixels();
    const rows = [];
    for (let y = 0; y < TEXTURE_SIZE; y++) rows.push(Buffer.from([0]), pixels.subarray(y * TEXTURE_SIZE * 4, (y + 1) * TEXTURE_SIZE * 4));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(rows))),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

// ---- Command line ------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const rp = path.resolve(import.meta.dirname, "..", "..", "BountySys_RP");
    mkdirSync(path.join(rp, "models", "entity"), { recursive: true });
    mkdirSync(path.join(rp, "textures", "entity"), { recursive: true });
    writeFileSync(path.join(rp, "models", "entity", "train.geo.json"), renderGeometry());
    writeFileSync(path.join(rp, "textures", "entity", "train.png"), buildPng());
    console.log("wrote models/entity/train.geo.json and textures/entity/train.png");
}
