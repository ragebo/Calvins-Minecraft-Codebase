import { ItemTypes, world, type Vector3 } from "@minecraft/server";
import { AMMO, GUNS } from "../config/guns.js";
import {
    BOAT_NPC, BOAT_WIN_TELEPORT, BRIDGE_AREA, FORT_AREA, FORT_REWARD_CHEST, FORT_SPAWNS,
    JAIL_SITES, LAW_SPAWNS, OUTLAW_SPAWNS, OVERWORLD_Y_BOUNDS, RANCH_AREA, RANCH_LOWER_SPAWNS,
    RANCH_SAFE_TRIGGER, RANCH_UPPER_SPAWNS, TRAIN_END, TRAIN_START, TRAIN_STRUCTURE, TRAIN_VAULT_CHEST
} from "../config/world.js";
import { missingScoreboards } from "./economy.js";
import { error } from "./log.js";

/**
 * The real preflight system. core/economy.ts's verifyScoreboards() used to be the whole of this:
 * it checked the two scoreboard objectives and world.sendMessage'd the result. This adds the
 * rest of what can go wrong before anyone has even joined — a required world structure, the
 * item ids config/guns.ts's AMMO and GUNS records point at, and every hardcoded coordinate in
 * config/world.ts — and reports it all the way ARCH-06 standardized: through core/log.ts's
 * error(). See rae/src/main.ts's load hook for where this runs.
 *
 * Scope, deliberately: only config/guns.ts's item ids are checked. compass.ts's and menu.ts's
 * item ids are not centralized the same way, and as of this task (ARCH-10, 2026-09-29) a sibling
 * task was concurrently touching core/sound.ts, itself reaching into compass.ts and menu.ts —
 * expanding this task's scope into those two files risked a collision for no benefit. A follow-up
 * task can widen the check if that gap matters.
 */

// ---------------------------------------------------------------------------
// COORDINATES
// ---------------------------------------------------------------------------

/**
 * Checks a batch of named points for the two things a preflight can know without asking the live
 * world anything: every axis is a finite number, and Y sits inside the Overworld's build limit
 * (config/world.ts's OVERWORLD_Y_BOUNDS — see its own comment for how that number was confirmed).
 *
 * Deliberately NOT checked: `isChunkLoaded()`. systems/transit.ts already calls that right
 * before it physically needs a location; reusing it here as a static, load-time check would fail
 * every legitimately far, simply-not-loaded-right-now coordinate, every time the game starts.
 *
 * Pure and unit-testable: never touches `world`, so a test can hand it synthetic points instead
 * of needing the real config or the fake game API.
 */
export function checkCoordinateBounds(points: readonly { label: string; at: Vector3 }[]): string[] {

    const problems: string[] = [];

    for (const { label, at } of points) {

        if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
            problems.push(`${label}: coordinate is not finite (${at.x}, ${at.y}, ${at.z})`);
            continue;
        }

        if (at.y < OVERWORLD_Y_BOUNDS.min || at.y > OVERWORLD_Y_BOUNDS.max) {
            problems.push(`${label}: y=${at.y} is outside the Overworld build limit (${OVERWORLD_Y_BOUNDS.min}..${OVERWORLD_Y_BOUNDS.max})`);
        }
    }

    return problems;
}

/** Every hardcoded coordinate config/world.ts defines, named for checkCoordinateBounds' messages. */
function worldCoordinatePoints(): { label: string; at: Vector3 }[] {

    const points: { label: string; at: Vector3 }[] = [];
    const addEach = (label: string, list: readonly Vector3[]) =>
        list.forEach((at, i) => points.push({ label: `${label} ${i + 1}`, at }));

    addEach("Law spawn", LAW_SPAWNS);
    addEach("Outlaw spawn", OUTLAW_SPAWNS);

    JAIL_SITES.forEach((site, i) => {
        points.push({ label: `Jail ${i + 1} (jail)`, at: site.jail });
        points.push({ label: `Jail ${i + 1} (door trigger)`, at: site.doorTrigger });
    });

    points.push({ label: "Ranch area (min)", at: RANCH_AREA.min });
    points.push({ label: "Ranch area (max)", at: RANCH_AREA.max });
    addEach("Ranch lower spawn", RANCH_LOWER_SPAWNS);
    addEach("Ranch upper spawn", RANCH_UPPER_SPAWNS);
    points.push({ label: "Ranch safe trigger", at: RANCH_SAFE_TRIGGER });

    points.push({ label: "Fort area (min)", at: FORT_AREA.min });
    points.push({ label: "Fort area (max)", at: FORT_AREA.max });
    addEach("Fort spawn", FORT_SPAWNS);
    points.push({ label: "Fort reward chest", at: FORT_REWARD_CHEST });

    points.push({ label: "Train start", at: TRAIN_START });
    points.push({ label: "Train end", at: TRAIN_END });
    points.push({ label: "Train vault chest", at: TRAIN_VAULT_CHEST });

    points.push({ label: "Bridge area (min)", at: BRIDGE_AREA.min });
    points.push({ label: "Bridge area (max)", at: BRIDGE_AREA.max });

    points.push({ label: "Boat NPC", at: BOAT_NPC });
    points.push({ label: "Boat win teleport", at: BOAT_WIN_TELEPORT });

    return points;
}

// ---------------------------------------------------------------------------
// STRUCTURE
// ---------------------------------------------------------------------------

/**
 * Only TRAIN_STRUCTURE is checkable here — see its own comment in config/world.ts for why its
 * backup-structure siblings are not.
 */
function missingStructures(): string[] {
    return world.structureManager.get(TRAIN_STRUCTURE) === undefined
        ? [`Missing structure "${TRAIN_STRUCTURE}" (save it with /structure save ${TRAIN_STRUCTURE})`]
        : [];
}

// ---------------------------------------------------------------------------
// ITEM IDENTIFIERS
// ---------------------------------------------------------------------------

/** Every item id config/guns.ts's AMMO and GUNS records point at — see the file comment for the scope cut. */
function missingItems(): string[] {

    const ids = [
        ...Object.values(AMMO).map((ammo) => ammo.itemId),
        ...Object.values(GUNS).map((gun) => gun.itemId)
    ];

    const missing = ids.filter((id) => ItemTypes.get(id) === undefined);

    return missing.length > 0 ? [`Unknown item identifier(s): ${missing.join(", ")}`] : [];
}

// ---------------------------------------------------------------------------
// THE PREFLIGHT
// ---------------------------------------------------------------------------

/**
 * Call once at startup (see main.ts). Checks the scoreboards, the train structure, every gun and
 * ammo item id, and every hardcoded coordinate, then reports every problem found through ONE
 * combined core/log.ts error() call — not one call per problem, which would either flood the
 * console/chat or bury everything after the first operator-visible line.
 */
export function runPreflightChecks(): { readonly ok: boolean; readonly problems: readonly string[] } {

    const problems: string[] = [];

    const missingBoards = missingScoreboards();
    if (missingBoards.length > 0) {
        problems.push(`Missing scoreboard objectives: ${missingBoards.join(", ")}`);
    }

    problems.push(...missingStructures());
    problems.push(...missingItems());
    problems.push(...checkCoordinateBounds(worldCoordinatePoints()));

    const ok = problems.length === 0;

    if (!ok) {
        error("preflight", `${problems.length} problem(s) found before load: ${problems.join(" | ")}`);
    }

    return { ok, problems };
}
