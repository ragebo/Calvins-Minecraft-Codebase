import { system, type Player } from "@minecraft/server";
import { AIM } from "../config/balance.js";
import { warn } from "./log.js";
import { clearTitle, showTitle } from "./ui.js";

/**
 * What a gun does to the screen: zoom the camera, put a scope overlay over it, and (GUN-07, a spike) briefly
 * flash a hit-marker overlay. One place, so the guns and the measurement spike (systems/aimprobe.ts) do it
 * the same way.
 *
 * Measured in the real game (2026-09-20, docs/test-cards/AIM-SPIKE.md): Camera.setFov zooms smoothly and setFov()
 * puts the view back; the overlay is a HUD image (BountySys_RP/ui) that shows while the HUD's title text equals
 * AIM.scopeTitle.
 *
 * (GUN-03's recoil lived here too for a while — Camera.addShake, with Camera.stopShaking() before each shot
 * so rapid fire didn't stack shakes into a mess. Still looked bad after that fix, per a real playtest, so it
 * was removed outright rather than keep tuning a mechanism whose fundamentally random character was the
 * actual problem, not the stacking. See git history (core/aim.ts's shakeCamera, config/guns.ts's
 * RecoilConfig) if it's ever worth trying again with a different approach.)
 *
 * The hit marker reuses the scope's own title-text switch technique (there is no other way to toggle a HUD
 * image: a custom entity property can only be declared on an entity this addon's own behavior pack defines,
 * never on the vanilla player, so a per-player property to bind the image to isn't available at all). Both
 * switches share the one title channel a player has, which is why this file — not two independent callers —
 * owns both: flashHitMarker always knows what to restore the title to afterward.
 */

const reported = new Set<string>();

/** A camera or HUD failure must never break firing, and it would repeat on every aim, so each kind is reported once. */
function report(what: string, error: unknown): void {
    if (reported.has(what)) return;
    reported.add(what);
    warn("aim", `${what} failed: ${error}`);
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
 * Puts the title back to properly cleared from ANY previous switch text (the scope's, the hit marker's, or
 * anything else that reuses this one title channel) — never just an empty clearTitle() alone, because the
 * HUD keeps the last text it was given: clearing straight from a switch value left the thing bound to it up
 * in the first real-game run. So the text is overwritten with one that draws nothing, and the title is
 * cleared once that has had time to arrive.
 */
function clearTitleSafely(player: Player): void {
    showTitle(player, AIM.scopeOffTitle, { fadeInTicks: 0, stayTicks: 1, fadeOutTicks: 0 });
    system.runTimeout(() => {
        if (player.isValid) clearTitle(player);
    }, AIM.scopeClearDelayTicks);
}

/** Switches the scope overlay off (it shows while the title equals AIM.scopeTitle). */
export function hideScope(player: Player): void {
    clearTitleSafely(player);
}

/**
 * SPIKE (GUN-07, docs/test-cards/GUN-FEEDBACK.md): briefly switches the hit-marker overlay on, then puts
 * the title back — the scope switch if the shooter is still aiming with one (`restoreScope`), or properly
 * cleared otherwise. This is the one title channel both features share, so a hit landed while scoped
 * briefly interrupts the scope overlay for the flash's own duration rather than showing both at once — a
 * known, deliberate trade-off of this first pass; see the test card for what to actually check in game.
 */
export function flashHitMarker(player: Player, options: { readonly restoreScope: boolean }): void {

    showTitle(player, AIM.hitMarkerTitle, { fadeInTicks: 0, stayTicks: AIM.hitMarkerFlashTicks, fadeOutTicks: 0 });

    system.runTimeout(() => {
        if (!player.isValid) return;
        if (options.restoreScope) showScope(player);
        else clearTitleSafely(player);
    }, AIM.hitMarkerFlashTicks);
}

// ---------------------------------------------------------------------------------------------------------
// Who is aiming
// ---------------------------------------------------------------------------------------------------------

/**
 * Who is aiming a gun right now (player id -> the gun's item id). systems/guns.ts keeps it up to date as it starts and stops each
 * aim, and anything else that cares whether a gun is POINTED (the robbery framework's hold-ups) reads it here: a system may not
 * import another system, so what two of them share lives in core.
 */
const aimers = new Map<string, string>();

/** Records that this player started aiming the gun with this item id, or stopped (no item id). */
export function noteAiming(playerId: string, gunItemId: string | undefined): void {
    if (gunItemId === undefined) aimers.delete(playerId);
    else aimers.set(playerId, gunItemId);
}

/** The item id of the gun this player is aiming, or undefined when they are not aiming one. */
export function aimingWith(playerId: string): string | undefined {
    return aimers.get(playerId);
}
