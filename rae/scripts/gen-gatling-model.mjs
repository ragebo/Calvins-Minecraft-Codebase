// Generates the placed Gatling gun's model: BountySys_RP/models/entity/gatling_gun.geo.json and
// textures/entity/gatling_gun.png.
//
//     node scripts/gen-gatling-model.mjs
//
// Same technique as scripts/gen-train-model.mjs (read that file's own header first): a handful of boxes, and
// a texture that is one flat colour per texel, so no art has to be drawn and a colour change is one line
// here. To use a hand-made Blockbench model instead, replace `gatling_gun.geo.json` (keep the geometry
// identifier `geometry.gatling_gun`, and the "base"/"turret"/"barrels" bone names systems/guns.ts's
// animation targets) and the texture, and stop running this script.
//
// Units are model pixels, 16 to a block. Three bones:
//   - "base": the wooden plate and post. Never rotates.
//   - "turret": the brass receiver and the crank, parented to "base", pivoting where a real gun would hinge
//     (the receiver's vertical centre) so it can pitch up and down to follow whoever is riding it, without
//     tipping the tripod. Driven by a client-synced entity property (systems/guns.ts, via
//     BountySys_RP/animations/gatling_gun.animation.json), the same technique systems/tumbleweed.ts already
//     uses for its own roll.
//   - "barrels": the five barrels and their muzzle caps, parented to "turret" (so they inherit its pitch),
//     pivoting on the barrel circle's own centre so they can spin around their own length while firing — a
//     second, independent client-synced property drives this one.
// Yaw needs no property at all: the whole entity's own setRotation already turns every bone together.
// The barrels point forward (-Z, the way Bedrock models face); the seat systems/guns.ts's rideable
// component defines sits just behind and above the receiver, roughly where a gunner would stand to crank it.
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

/** [origin x, y, z, size x, y, z, colour]. Never rotates: the tripod stays level regardless of aim. */
const BASE = [
    [-8, 0, -8, 16, 2, 16, "darkWood"],
    [-3, 2, -3, 6, 10, 6, "wood"]
];

/** Pitches with the barrels, but never spins: the receiver housing and its crank. */
const TURRET = [
    [-7, 12, -6, 14, 6, 10, "brass"],
    // Crank handle on the side, for the "you spin it up" read.
    [7, 13, -2, 3, 3, 2, "darkIron"]
];

/** Spins around its own length (the Z axis) while firing, ringing BARRELS_PIVOT's centre. */
const BARRELS = [
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
    [-4, 12, -21, 2, 2, 1, "darkIron"]
];

/** The receiver's own vertical and depth centre: where a real gun's elevation hinge would sit. */
const TURRET_PIVOT = [0, 15, -1];
/** The barrel circle's own centre: pitches along with TURRET_PIVOT (it's a child of "turret"), spins around
 *  this axis independently of it. The exact Z doesn't affect how a Z-axis spin looks, only where along the
 *  barrels' own length the (immaterial) axis line sits. */
const BARRELS_PIVOT = [0, 15, -6];

const FACES = ["north", "east", "south", "west", "up", "down"];

function faceUv(colour) {
    const texel = NAMES.indexOf(colour);
    if (texel < 0) throw new Error(`unknown colour "${colour}"`);
    return Object.fromEntries(FACES.map((face) => [face, { uv: [texel, 0], uv_size: [1, 1] }]));
}

function cubesFor(list) {
    return list.map(([x, y, z, w, h, d, colour]) => ({ origin: [x, y, z], size: [w, h, d], uv: faceUv(colour) }));
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
            bones: [
                { name: "base", pivot: [0, 0, 0], cubes: cubesFor(BASE) },
                { name: "turret", parent: "base", pivot: TURRET_PIVOT, cubes: cubesFor(TURRET) },
                { name: "barrels", parent: "turret", pivot: BARRELS_PIVOT, cubes: cubesFor(BARRELS) }
            ]
        }]
    };
}

/** The geometry file's text: indented, but each cube on one line so the file stays readable. */
export function renderGeometry() {
    const geometry = buildGeometry();
    const bones = geometry["minecraft:geometry"][0].bones;

    // Each bone's real cubes are pulled out and replaced with a unique placeholder before stringifying, then
    // spliced back in as pre-indented one-line-per-cube text — the placeholder's own name keeps the bones'
    // replacements from colliding with each other.
    const cubeLines = bones.map((bone) => bone.cubes.map((cube) => " ".repeat(24) + JSON.stringify(cube)).join(",\n"));
    bones.forEach((bone) => { bone.cubes = [`@@CUBES_${bone.name}@@`]; });

    let text = JSON.stringify(geometry, null, 4)
        .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, "[$1, $2, $3]");

    bones.forEach((bone, i) => {
        text = text.replace(new RegExp(` *"@@CUBES_${bone.name}@@"`), cubeLines[i]);
    });

    return text + "\n";
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
