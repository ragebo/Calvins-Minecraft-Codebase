import { world, type Entity, type Vector3 } from "@minecraft/server";
import { TUMBLEWEED, TUMBLEWEED_ENTITY_ID } from "../config/balance.js";
import { toggleTumbleweeds, tumbleweedsEnabled } from "../core/ambience.js";
import { onScriptEvent } from "../core/events.js";
import { registerSystem } from "../core/registry.js";
import { onTick } from "../core/tick.js";
import { announce } from "../core/ui.js";

/**
 * Tumbleweeds: a purely ambient entity blown across the ground by a steady "world wind". They cannot hurt
 * or be hurt by anything, and cannot be hit: `minecraft:physics` is fully off (no gravity, no collision,
 * same as the train car), so nothing solid — a wall, a player, a bullet's own hitbox — ever stops one or is
 * stopped by one. Moving a physics-off entity by `applyImpulse` was measured to work in the real game on the
 * train car (2026-09-20); it's the same trick here. Guns additionally exclude the type from their hitscan
 * ray (systems/guns.ts), belt and braces: one standing between a shooter and a target can never soak up a
 * hit or shield anyone, on any gun.
 *
 * They are spawned and swept by this file's own onTick handler: no gameplay system depends on them, and
 * resetting a round leaves them alone (they are decoration, not round state). Without collision they don't
 * settle to the ground on their own, so a spawn spot far from the player who anchors it can end up floating
 * or sinking into a slope — acceptable for ambience, and easy to improve later with a ground-height check.
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

    // Cleared and fully reapplied every run, exactly like the train car's momentum driver (systems/transit.ts):
    // with physics off there is no engine drag to rely on, so this is what keeps the step size config-controlled
    // instead of the impulses piling up run after run.
    entity.clearVelocity();
    entity.applyImpulse({
        x: wind.x + jitter.x + (gust?.x ?? 0),
        y: 0,
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

/** A spot upwind of a random online player, so the new tumbleweed blows past them rather than away from them. */
function spawnSpot(players: readonly { location: Vector3 }[]): Vector3 {

    const near = players[Math.floor(Math.random() * players.length)]!;
    const upwind = headingVector(TUMBLEWEED.windHeadingDegrees + 180, 1);
    const range = TUMBLEWEED.spawnDistanceMin + Math.random() * (TUMBLEWEED.spawnDistanceMax - TUMBLEWEED.spawnDistanceMin);
    const jitter = headingVector(Math.random() * 360, range * 0.3);

    return {
        x: near.location.x + upwind.x * range + jitter.x,
        y: near.location.y,              // no gravity to correct it afterwards, so this is its height for good
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
