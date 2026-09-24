import { world, type Entity, type Vector3 } from "@minecraft/server";
import { TUMBLEWEED, TUMBLEWEED_ENTITY_ID } from "../config/balance.js";
import { toggleTumbleweeds, tumbleweedsEnabled } from "../core/ambience.js";
import { onScriptEvent } from "../core/events.js";
import { registerSystem } from "../core/registry.js";
import { onTick } from "../core/tick.js";
import { announce } from "../core/ui.js";

/**
 * Tumbleweeds: a purely ambient entity nudged along by a steady "world wind". They cannot hurt or be hurt
 * by anything (their own damage_sensor).
 *
 * v1 (2026-09-21) had `minecraft:physics` fully off, so it could never be a physical obstacle — but with
 * no collision of its own, nothing rested it on the ground either, and it visibly floated and clipped
 * through terrain (playtest) and moved "weirdly" with a script-driven ground-snap standing in for real
 * physics (owner feedback, same day). v2 gives it real physics instead: `has_gravity` and `has_collision`
 * are both on, so the engine settles it onto the ground and stops it at obstacles the normal way, and this
 * file only nudges it sideways with `applyImpulse` every handler run, the way you'd nudge any physical
 * entity. The trade-off: a hitscan gun's ray still excludes the type outright (systems/guns.ts), so a
 * shotgun always passes through, but a PROJECTILE gun's bullet has its own real collision and can now
 * physically stop on a tumbleweed the same as it would on a mob, since there is no "collide with terrain
 * but not with a bullet" option in `minecraft:physics`.
 *
 * They are spawned and swept by this file's own onTick handler: no gameplay system depends on them, and
 * resetting a round leaves them alone (they are decoration, not round state).
 *
 * `pushOne`'s occasional upward kick is what makes it look like it's bouncing (owner feedback 2026-09-23:
 * moving too slowly and not bouncing at all) — `minecraft:physics` has no bounciness/restitution setting
 * to turn on, so this is scripted, gated to only fire while it isn't already moving upward.
 */

const BORN_TICK_PROPERTY = "bornTick";

function distance(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A vector of length `strength` pointing `headingDegrees` clockwise from +Z (the way a player's yaw is measured). */
function headingVector(headingDegrees: number, strength: number): Vector3 {
    const radians = (headingDegrees * Math.PI) / 180;
    return { x: Math.sin(radians) * strength, y: 0, z: Math.cos(radians) * strength };
}

function pushOne(entity: Entity): void {

    const wind = headingVector(TUMBLEWEED.windHeadingDegrees, TUMBLEWEED.windStrength);
    const jitter = headingVector(Math.random() * 360, Math.random() * TUMBLEWEED.jitter);
    const gust = Math.random() < TUMBLEWEED.gustChance ? headingVector(TUMBLEWEED.windHeadingDegrees, TUMBLEWEED.gustStrength) : undefined;

    // X/Z (the wind) are reset and reapplied every run, so the push stays exactly what the config says
    // instead of piling up; Y is read back first so real gravity is never fought.
    const current = entity.getVelocity();

    // The bounce: minecraft:physics has no bounciness/restitution setting, so this is a small upward kick
    // standing in for one. Only while it isn't already moving upward (current.y <= 0, i.e. falling or
    // resting) — otherwise a run of lucky rolls while it's still airborne from the last hop would stack
    // into one big launch instead of a series of small bounces.
    const hop = current.y <= 0 && Math.random() < TUMBLEWEED.hopChance ? TUMBLEWEED.hopStrength : 0;

    entity.clearVelocity();
    entity.applyImpulse({
        x: wind.x + jitter.x + (gust?.x ?? 0),
        y: current.y + hop,
        z: wind.z + jitter.z + (gust?.z ?? 0)
    });

    // Tumbles in place, independent of which way the wind is pushing it: a real tumbleweed spins on
    // whatever axis it happens to be resting on, not necessarily the one it is travelling along.
    const spin = entity.getRotation();
    entity.setRotation({ x: spin.x, y: (spin.y + TUMBLEWEED.spinDegrees) % 360 });
}

/** True once it has rolled out of every player's sight, or has simply been around long enough. */
function shouldDespawn(entity: Entity, players: readonly { location: Vector3 }[], tick: number): boolean {

    const born = entity.getDynamicProperty(BORN_TICK_PROPERTY);
    if (typeof born === "number" && tick - born >= TUMBLEWEED.maxAgeTicks) return true;

    if (players.length === 0) return false;
    return players.every((player) => distance(player.location, entity.location) > TUMBLEWEED.despawnDistance);
}

/**
 * An x/z spot upwind of a random online player, so the new tumbleweed blows past them rather than away from
 * them, lifted a little above their height: real gravity is what settles it onto the actual ground from
 * there, rather than trusting a player's own height to already match the terrain some distance away.
 */
function spawnSpot(players: readonly { location: Vector3 }[]): Vector3 {

    const near = players[Math.floor(Math.random() * players.length)]!;
    const upwind = headingVector(TUMBLEWEED.windHeadingDegrees + 180, 1);
    const range = TUMBLEWEED.spawnDistanceMin + Math.random() * (TUMBLEWEED.spawnDistanceMax - TUMBLEWEED.spawnDistanceMin);
    const jitter = headingVector(Math.random() * 360, range * 0.3);

    return {
        x: near.location.x + upwind.x * range + jitter.x,
        y: near.location.y + TUMBLEWEED.spawnLift,
        z: near.location.z + upwind.z * range + jitter.z
    };
}

onTick("tumbleweed", (ctx) => {

    const dimension = world.getDimension("overworld");
    const rolling = dimension.getEntities({ type: TUMBLEWEED_ENTITY_ID });

    for (const entity of rolling) {

        if (shouldDespawn(entity, ctx.players, ctx.tick)) {
            entity.remove();
            continue;
        }

        pushOne(entity);
    }

    if (tumbleweedsEnabled() && rolling.length < TUMBLEWEED.maxActive && ctx.players.length > 0) {
        const spawned = dimension.spawnEntity(TUMBLEWEED_ENTITY_ID, spawnSpot(ctx.players));
        spawned.setDynamicProperty(BORN_TICK_PROPERTY, ctx.tick);
    }

}, { everyTicks: TUMBLEWEED.tickInterval });

/** The menu's toggle, for a command block (it needs no player, unlike rae:menu). */
onScriptEvent("rae:tumbleweed", () => {
    const on = toggleTumbleweeds();
    announce(on ? "§7Tumbleweeds are on: new ones will roll in." : "§7Tumbleweeds are off: no new ones will spawn.");
});

registerSystem({
    name: "tumbleweed",
    reset() {
        // Cosmetic, not round state: a reset leaves existing tumbleweeds and the on/off toggle alone.
    }
});
