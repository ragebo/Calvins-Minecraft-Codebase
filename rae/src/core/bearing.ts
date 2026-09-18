import type { Vector3 } from "@minecraft/server";

/**
 * Direction math and display for the law compass. Deliberately free of
 * any game-runtime imports so it can be exercised outside Minecraft.
 */

/** Below this horizontal length a facing vector is "looking straight up or down". */
const MIN_HORIZONTAL_FACING = 0.01;

/**
 * Signed angle, in degrees, from the way `facing` points to the way
 * from `from` to `to`, on the horizontal plane (y is ignored).
 * Positive = target is on the facing entity's right, negative = left,
 * ±180 = directly behind.
 *
 * Returns undefined when `facing` has no horizontal component, since
 * "ahead" means nothing when looking straight up or down.
 *
 * +X is east and +Z is south, so viewed from above with north up,
 * positive angles turn clockwise — i.e. to the right.
 */
export function relativeBearing(facing: Vector3, from: Vector3, to: Vector3): number | undefined {

    if (Math.hypot(facing.x, facing.z) < MIN_HORIZONTAL_FACING) return undefined;

    const dx = to.x - from.x;
    const dz = to.z - from.z;

    const cross = facing.x * dz - facing.z * dx;
    const dot = facing.x * dx + facing.z * dz;

    return (Math.atan2(cross, dot) * 180) / Math.PI;
}

export interface BearingBarOptions {
    /** Odd, so there's a true center cell. */
    readonly cells: number;
    /** The bar spans this many degrees either side of straight ahead. */
    readonly halfWidthDegrees: number;
    /** The marker turns green within this many degrees of dead ahead. */
    readonly alignToleranceDegrees: number;
}

// `=`, `+` and `*` share one advance width in Minecraft's font, so the
// bar's total width — and therefore where the centered action bar
// text sits — doesn't shift as the marker moves along it.
const TRACK = "=";
const CENTER = "+";
const MARKER = "*";

/**
 * Renders a strip like  « ==========+===*====== »  where the marker
 * slides left and right with the target's bearing, and the outer
 * chevrons light up when the target is beyond the strip's range on
 * that side (behind you, turn that way). Undefined bearing draws an
 * idle strip with no marker.
 *
 * Only characters confirmed present in the game's font are used —
 * it has no arrow glyphs.
 */
export function bearingBar(relative: number | undefined, options: BearingBarOptions): string {

    const last = options.cells - 1;
    const center = last / 2;
    const half = options.halfWidthDegrees;

    const behindLeft = relative !== undefined && relative < -half;
    const behindRight = relative !== undefined && relative > half;

    let markerIndex = -1;

    if (relative !== undefined && !behindLeft && !behindRight) {
        markerIndex = Math.round(((relative + half) / (2 * half)) * last);
    }

    const aligned = relative !== undefined && Math.abs(relative) <= options.alignToleranceDegrees;

    let cells = "";
    let activeColor = "";

    for (let i = 0; i <= last; i++) {

        let color: string;
        let glyph: string;

        if (i === markerIndex) {
            color = aligned ? "§a" : "§e";
            glyph = MARKER;
        } else if (i === center) {
            color = "§7";
            glyph = CENTER;
        } else {
            color = "§8";
            glyph = TRACK;
        }

        if (color !== activeColor) {
            cells += color;
            activeColor = color;
        }

        cells += glyph;
    }

    const left = `${behindLeft ? "§e" : "§8"}«`;
    const right = `${behindRight ? "§e" : "§8"}»`;

    return `${left} ${cells} ${right}`;
}
