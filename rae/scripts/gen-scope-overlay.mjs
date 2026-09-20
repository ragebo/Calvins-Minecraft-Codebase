// Generates the scope overlay: BountySys_RP/textures/ui/rae_scope.png.
//
//     node scripts/gen-scope-overlay.mjs
//
// A full-screen picture that is black everywhere except a clear circle in the middle (the lens), with a
// thin crosshair inside it. The HUD element that shows it (ui/rae_scope.json) stretches it over the whole
// screen, so the circle is round on a 16:9 screen and slightly oval on others. `test/assets.test.mjs`
// compares the committed file with buildScopePixels().

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

export const WIDTH = 1024;
export const HEIGHT = 576;
/** The clear circle's radius, in pixels of the 1024 x 576 picture. */
export const LENS_RADIUS = 270;
/** The soft edge of the lens, in pixels. */
const EDGE = 2;
/** The crosshair: half the line's thickness, the gap left round the centre, and the space kept clear of the rim. */
const LINE = 1;
const GAP = 14;
const RIM_MARGIN = 10;

export function buildScopePixels() {
    const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
    const cx = (WIDTH - 1) / 2, cy = (HEIGHT - 1) / 2;

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const dx = x - cx, dy = y - cy;
            const distance = Math.hypot(dx, dy);

            // Opaque black outside the lens, fading to clear over EDGE pixels at its rim.
            let alpha = Math.round(255 * Math.min(1, Math.max(0, (distance - (LENS_RADIUS - EDGE)) / (2 * EDGE))));

            // The crosshair, inside the lens only.
            const onVertical = Math.abs(dx) <= LINE && Math.abs(dy) >= GAP && Math.abs(dy) <= LENS_RADIUS - RIM_MARGIN;
            const onHorizontal = Math.abs(dy) <= LINE && Math.abs(dx) >= GAP && Math.abs(dx) <= LENS_RADIUS - RIM_MARGIN;
            if (onVertical || onHorizontal) alpha = 255;

            pixels.set([0, 0, 0, alpha], (y * WIDTH + x) * 4);
        }
    }
    return pixels;
}

export function buildScopePng() {
    return encodePng(WIDTH, HEIGHT, buildScopePixels());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = path.resolve(import.meta.dirname, "..", "..", "BountySys_RP", "textures", "ui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "rae_scope.png"), buildScopePng());
    console.log("wrote textures/ui/rae_scope.png");
}
