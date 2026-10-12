import { EasingType, InputPermissionCategory, type Player, type Vector3 } from "@minecraft/server";
import { START as S } from "../config/balance.js";
import type { Shot } from "../logic/start.js";
import { warn } from "./log.js";
import { players } from "./players.js";

/**
 * The one place the start sequence touches a player's camera and input (core/startsequence.ts says when; this says how).
 *
 * A PAN is two camera calls on the built-in free camera: the camera appears at the shot's start mark, then eases to its end mark over
 * the seconds given. It is what `/camera <player> set minecraft:free ... ease ...` does, in the script API. A FLY-DOWN is the same from
 * above a spawn: the camera starts looking straight down from `flyDownHeight` blocks up and eases to the player's own eyes and view, so
 * letting go of it afterwards changes nothing they see. A LOCK switches off all movement input (jump, sneak, strafing, mount and dismount
 * come with it) so nobody wanders, or gets hurt, while a cutscene plays; the camera category is left on, so they can still look around.
 *
 * Every call here is wrapped. A start must never hang on a camera: an engine error is reported once per kind of call (it would repeat for
 * every player and every shot) and never thrown, and a player who left in the meantime is skipped without a word.
 *
 * Unmeasured in the real game when this was written: whether the two calls of a pan, made in the same tick, ease from the first mark as
 * hoped; how free cameras behave for several players at once. docs/test-cards/START-SEQUENCE.md says what to watch.
 */

const FREE_CAMERA = "minecraft:free";

const reported = new Set<string>();

/** Forgets which failures were already reported, so the next of each kind is reported again. For tests. */
export function forgetFailures(): void {
    reported.clear();
}

/** Runs `body` for a player who is still there. An engine error becomes one line in the log per kind of call, never an exception. */
function attempt(what: string, player: Player, body: () => void): void {

    if (!player.isValid) return;

    try {
        body();
    } catch (err) {
        if (reported.has(what)) return;

        reported.add(what);
        warn("cinematic", `${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Plays one shot for one player: the camera appears at the start mark and eases to the end mark over `seconds`. */
export function playShot(player: Player, shot: Shot, seconds: number): void {

    attempt("camera shot", player, () => {
        const { start, end } = shot;

        player.camera.setCamera(FREE_CAMERA, { location: { x: start.x, y: start.y, z: start.z }, rotation: { x: start.pitch, y: start.yaw } });
        player.camera.setCamera(FREE_CAMERA, {
            location: { x: end.x, y: end.y, z: end.z },
            rotation: { x: end.pitch, y: end.yaw },
            easeOptions: { easeTime: Math.max(0, seconds), easeType: EasingType.Linear }
        });
    });
}

/**
 * The camera comes down from above `spawn` to the player's eyes over `seconds`. The player is expected to be at the spawn already: it is their
 * own facing the camera lands on, so releasing it changes nothing.
 */
export function flyDown(player: Player, spawn: Vector3, seconds: number): void {

    attempt("fly-down", player, () => {
        const view = player.getRotation();
        const eyes = { x: spawn.x, y: spawn.y + S.eyeHeight, z: spawn.z };

        player.camera.setCamera(FREE_CAMERA, { location: { x: eyes.x, y: eyes.y + S.flyDownHeight, z: eyes.z }, rotation: { x: 90, y: view.y } });
        player.camera.setCamera(FREE_CAMERA, {
            location: eyes,
            rotation: { x: view.x, y: view.y },
            easeOptions: { easeTime: Math.max(0, seconds), easeType: EasingType.InOutSine }
        });
    });
}

/** Hands the player their own view back, ending any cutscene camera and any ease in progress. */
export function clearCamera(player: Player): void {
    attempt("clear camera", player, () => player.camera.clear());
}

export function lock(player: Player): void {
    attempt("lock", player, () => player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false));
}

export function unlock(player: Player): void {
    attempt("unlock", player, () => player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true));
}

/** The safety net: every online player gets their movement and their own camera back, whatever state they were left in. */
export function unlockEveryone(): void {

    for (const player of players()) {
        unlock(player);
        clearCamera(player);
    }
}
