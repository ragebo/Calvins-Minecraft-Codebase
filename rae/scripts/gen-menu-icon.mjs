// Generates the menu item's icon: BountySys_RP/textures/items/game_menu.png, a 16x16 gold sheriff-star badge.
//
//     node scripts/gen-menu-icon.mjs
//
// It exists so the menu item has an icon of its own without anyone drawing one. Replace the PNG with your own art
// whenever you like and stop running this script (test/assets.test.mjs compares the file with buildMenuIconPixels(),
// so delete that comparison with it).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const SIZE = 16;

const OUTLINE = [92, 58, 16, 255];
const GOLD = [236, 178, 36, 255];
const LIGHT = [255, 226, 120, 255];
const SHADE = [186, 128, 20, 255];

/** A five-pointed star, point up: the corners of its outline in order. */
function starPolygon(cx, cy, outer, inner) {
    const corners = [];
    for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        corners.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
    return corners;
}

function inside(polygon, x, y) {
    let odd = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
}

export function buildMenuIconPixels() {
    const pixels = Buffer.alloc(SIZE * SIZE * 4);
    const cx = 7.5, cy = 8.3;
    const star = starPolygon(cx, cy, 7.4, 3.1);
    const rim = starPolygon(cx, cy, 8.4, 3.9);           // a little larger: the outline is what the rim has and the star does not

    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const px = x + 0.5, py = y + 0.5;
            let colour = null;

            if (inside(star, px, py)) {
                // Light from the top left, shade to the bottom right.
                const lean = (px - cx) + (py - cy);
                colour = lean < -2.5 ? LIGHT : lean > 2.5 ? SHADE : GOLD;
            } else if (inside(rim, px, py)) {
                colour = OUTLINE;
            }

            if (colour) pixels.set(colour, (y * SIZE + x) * 4);
        }
    }
    return pixels;
}

export function buildMenuIconPng() {
    return encodePng(SIZE, SIZE, buildMenuIconPixels());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = path.resolve(import.meta.dirname, "..", "..", "BountySys_RP", "textures", "items");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "game_menu.png"), buildMenuIconPng());
    console.log("wrote textures/items/game_menu.png");
}
