import { system, type Player } from "@minecraft/server";
import { AIM } from "../config/balance.js";
import { clearTitle, showTitle } from "./ui.js";

/**
 * The two things aiming does to the screen: zoom the camera, and put a scope overlay over it. One place, so
 * the guns and the measurement spike (systems/aimprobe.ts) do it the same way.
 *
 * Measured in the real game (2026-09-20, docs/test-cards/AIM-SPIKE.md): Camera.setFov zooms smoothly and setFov()
 * puts the view back; the overlay is a HUD image (BountySys_RP/ui) that shows while the HUD's title text equals
 * AIM.scopeTitle.
 */

const reported = new Set<string>();

/** A camera or HUD failure must never break firing, and it would repeat on every aim, so each kind is reported once. */
function report(what: string, error: unknown): void {
    if (reported.has(what)) return;
    reported.add(what);
    console.warn(`[aim] ${what} failed: ${error}`);
}

/**
 * Eases the camera to `fov` degrees (the normal view is about 70; smaller is closer). The engine refuses a value
 * outside AIM.fovMin..fovMax, so the request is clamped into it.
 */
export function zoomTo(player: Player, fov: number): void {
    try {
        const clamped = Math.min(AIM.fovMax, Math.max(AIM.fovMin, fov));
        player.camera.setFov({ fov: clamped, easeOptions: { easeTime: AIM.fovEaseSeconds } });
    } catch (error) {
        report("zoom", error);
    }
}

/** Puts the field of view back to the player's own. */
export function zoomReset(player: Player): void {
    try {
        player.camera.setFov();
    } catch (error) {
        report("zoom reset", error);
    }
}

export function showScope(player: Player): void {
    showTitle(player, AIM.scopeTitle, { fadeInTicks: 0, stayTicks: AIM.scopeStayTicks, fadeOutTicks: 0 });
}

/**
 * Switches the overlay off. The overlay shows while the HUD's title text equals the switch text, and the HUD keeps
 * the last text it was given: clearing the title alone left the overlay up in the first real-game run. So the text
 * is overwritten with one that draws nothing, and the title is cleared once that has had time to arrive.
 */
export function hideScope(player: Player): void {
    showTitle(player, AIM.scopeOffTitle, { fadeInTicks: 0, stayTicks: 1, fadeOutTicks: 0 });
    system.runTimeout(() => {
        if (player.isValid) clearTitle(player);
    }, AIM.scopeClearDelayTicks);
}
