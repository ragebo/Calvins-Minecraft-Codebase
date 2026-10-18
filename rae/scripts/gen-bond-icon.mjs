// Generates the bond item's icon: BountySys_RP/textures/items/bond.png, a 16x16 certificate with a gold seal.
//
//     node scripts/gen-bond-icon.mjs
//
// Placeholder art so the item had a sprite of its own; the owner replaces sprites in the pack when they have their own (as with the menu icon).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const SIZE = 16;

const EDGE = [24, 84, 48, 255];
const PAPER = [244, 232, 196, 255];
const SHADE = [222, 205, 160, 255];
const INK = [96, 78, 44, 255];
const GOLD = [236, 178, 36, 255];
const GOLD_DARK = [160, 108, 16, 255];
const RIBBON = [190, 48, 48, 255];

export function buildBondPixels() {
    const pixels = Buffer.alloc(SIZE * SIZE * 4);
    const put = (x, y, colour) => pixels.set(colour, (y * SIZE + x) * 4);

    // The sheet: x 2..13, y 1..14, with a green border and a shaded bottom edge.
    for (let y = 1; y <= 14; y++) {
        for (let x = 2; x <= 13; x++) {
            const border = x === 2 || x === 13 || y === 1 || y === 14;
            put(x, y, border ? EDGE : y === 13 ? SHADE : PAPER);
        }
    }

    // Lines of text: a title, then two shorter lines.
    for (let x = 5; x <= 10; x++) put(x, 3, INK);
    for (let x = 4; x <= 11; x++) put(x, 5, SHADE);
    for (let x = 4; x <= 11; x++) put(x, 7, SHADE);

    // A ribbon under a gold seal, bottom right.
    put(10, 12, RIBBON); put(12, 12, RIBBON);
    put(10, 13, RIBBON); put(12, 13, RIBBON);
    for (const [x, y] of [[10, 9], [11, 9], [12, 9], [9, 10], [13, 10], [9, 11], [13, 11]]) put(x, y, GOLD_DARK);
    for (const [x, y] of [[10, 10], [11, 10], [12, 10], [10, 11], [11, 11], [12, 11], [11, 12]]) put(x, y, GOLD);

    return pixels;
}

export function buildBondPng() {
    return encodePng(SIZE, SIZE, buildBondPixels());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = path.resolve(import.meta.dirname, "..", "..", "BountySys_RP", "textures", "items");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bond.png"), buildBondPng());
    console.log("wrote textures/items/bond.png");
}
