// Generates the hit-marker overlay: BountySys_RP/textures/ui/rae_hit_marker.png.
//
//     node scripts/gen-hit-marker.mjs
//
// A small, mostly-transparent picture: four short white dashes around the centre, forming an X — the
// classic "your shot landed" marker, flashed briefly over the crosshair (ui/rae_hit_marker.json, switched
// the same way the scope overlay is: core/aim.ts's flashHitMarker). `test/assets.test.mjs` compares the
// committed file with buildHitMarkerPixels().

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const WIDTH = 128;
export const HEIGHT = 128;
/** How far from the centre each dash starts, in pixels. */
const GAP = 16;
/** How far each dash runs past GAP. */
const LENGTH = 22;
/** Half the dash's width. */
const THICKNESS = 3;

export function buildHitMarkerPixels() {
    const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
    const cx = (WIDTH - 1) / 2, cy = (HEIGHT - 1) / 2;
    const root2 = Math.SQRT2;

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {

            const dx = x - cx, dy = y - cy;

            // Rotate 45 degrees: u/v are distances along the two diagonals an X's four dashes sit on.
            const u = (dx + dy) / root2;
            const v = (dx - dy) / root2;

            const onFirstDiagonal = Math.abs(v) <= THICKNESS && Math.abs(u) >= GAP && Math.abs(u) <= GAP + LENGTH;
            const onSecondDiagonal = Math.abs(u) <= THICKNESS && Math.abs(v) >= GAP && Math.abs(v) <= GAP + LENGTH;

            const alpha = (onFirstDiagonal || onSecondDiagonal) ? 255 : 0;
            pixels.set([255, 255, 255, alpha], (y * WIDTH + x) * 4);
        }
    }
    return pixels;
}

export function buildHitMarkerPng() {
    return encodePng(WIDTH, HEIGHT, buildHitMarkerPixels());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = path.resolve(import.meta.dirname, "..", "..", "BountySys_RP", "textures", "ui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "rae_hit_marker.png"), buildHitMarkerPng());
    console.log("wrote textures/ui/rae_hit_marker.png");
}
