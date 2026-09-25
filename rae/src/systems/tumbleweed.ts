import { world, type Dimension, type Entity, type Vector3 } from "@minecraft/server";
import { TUMBLEWEED, TUMBLEWEED_ENTITY_ID, TUMBLEWEED_ROLL_PROPERTY } from "../config/balance.js";
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
 *
 * Same owner feedback also asked that it actually roll (not just spin in place) as it moves, only spawn in
 * the desert, despawn quickly, and never hop while it's stuck against something rather than truly rolling.
 * `pushOne` tracks how far it really moved since the last run (not its velocity) to tell "rolling" from
 * "stuck", and `desertSpawnSpot` checks `Dimension.getBiome` before a spawn is allowed to happen at all.
 *
 * Rolling turned out to need its own real mechanism: `Entity.setRotation`'s pitch (tried first, since it's
 * free) does nothing visible on this headless model, confirmed by a playtest of that attempt (2026-09-24).
 * `updateRoll` drives a `bountysys:roll` entity property instead, which
 * `BountySys_RP/animations/tumbleweed.animation.json` turns into an actual root-bone rotation via molang —
 * on its own onTick, every tick rather than every handler run, so the animation reads as smooth rolling
 * rather than a visible step each time the slower handler runs.
 */

const BORN_TICK_PROPERTY = "bornTick";
const LAST_X_PROPERTY = "lastX";
const LAST_Z_PROPERTY = "lastZ";
const ROLL_ACCUMULATED_PROPERTY = "rollAccumulated";
const ROLL_LAST_X_PROPERTY = "rollLastX";
const ROLL_LAST_Z_PROPERTY = "rollLastZ";

/** The tumbleweeds currently alive, refreshed once per (slower) handler run below — so the every-tick roll
 * update doesn't need its own `dimension.getEntities` call every single tick. */
let known: Entity[] = [];

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
    const push = {
        x: wind.x + jitter.x + (gust?.x ?? 0),
        z: wind.z + jitter.z + (gust?.z ?? 0)
    };

    // Stuck against something (a block, a corner) rather than truly rolling: judged by how far it actually
    // moved since the last run, not by velocity — a wedged entity can be pushed all day and go nowhere.
    // Nothing recorded yet (it just spawned) counts as free to move, not stuck.
    const lastX = entity.getDynamicProperty(LAST_X_PROPERTY);
    const lastZ = entity.getDynamicProperty(LAST_Z_PROPERTY);
    const moved = typeof lastX === "number" && typeof lastZ === "number"
        ? Math.hypot(entity.location.x - lastX, entity.location.z - lastZ)
        : Infinity;
    const stuck = moved < TUMBLEWEED.stuckThreshold;

    entity.setDynamicProperty(LAST_X_PROPERTY, entity.location.x);
    entity.setDynamicProperty(LAST_Z_PROPERTY, entity.location.z);

    // X/Z (the wind) are reset and reapplied every run, so the push stays exactly what the config says
    // instead of piling up; Y is read back first so real gravity is never fought.
    const current = entity.getVelocity();

    // The bounce: minecraft:physics has no bounciness/restitution setting, so this is a small upward kick
    // standing in for one. Only while it isn't already moving upward (current.y <= 0, i.e. falling or
    // resting) and isn't stuck — a lucky streak of rolls can't stack hops into one huge jump, and it
    // doesn't jitter in place while wedged against something instead of just waiting for the wind to turn.
    const hop = !stuck && current.y <= 0 && Math.random() < TUMBLEWEED.hopChance ? TUMBLEWEED.hopStrength : 0;

    entity.clearVelocity();
    entity.applyImpulse({ x: push.x, y: current.y + hop, z: push.z });

    // Faces the direction it's actually travelling, instead of a fixed heading — the tumbling itself is
    // updateRoll's job now (an entity property plus an animation, not this entity-level rotation: pitch
    // does nothing visible on this headless model). No visible turn while stuck, to match no hop while stuck.
    if (!stuck && (push.x !== 0 || push.z !== 0)) {
        const yaw = (Math.atan2(push.x, push.z) * 180) / Math.PI;
        entity.setRotation({ x: 0, y: yaw });
    }
}

/**
 * Drives the rolling animation: a real tumbleweed turns by (distance moved / radius) rolling without
 * slipping, so this reuses the same "how far did it actually move" idea `pushOne` uses for the stuck
 * detector, at `TUMBLEWEED.radius` and `rollScale`. A stuck entity's real movement is ~0, so its roll
 * naturally stalls too — no separate stuck check needed here, unlike the hop.
 *
 * Runs from its own every-tick handler (not the slower one `pushOne` runs from), so the animation reads as
 * a smooth roll rather than visibly stepping once every `TUMBLEWEED.tickInterval` ticks. `bountysys:roll`
 * is declared with range [0, 360) (`setProperty` throws outside a property's declared range), so the
 * running total is kept separately (unbounded) and only the wrapped value is written to it.
 */
function updateRoll(entity: Entity): void {

    const lastX = entity.getDynamicProperty(ROLL_LAST_X_PROPERTY);
    const lastZ = entity.getDynamicProperty(ROLL_LAST_Z_PROPERTY);
    const moved = typeof lastX === "number" && typeof lastZ === "number"
        ? Math.hypot(entity.location.x - lastX, entity.location.z - lastZ)
        : 0;

    entity.setDynamicProperty(ROLL_LAST_X_PROPERTY, entity.location.x);
    entity.setDynamicProperty(ROLL_LAST_Z_PROPERTY, entity.location.z);

    const accumulated = entity.getDynamicProperty(ROLL_ACCUMULATED_PROPERTY);
    const radians = (moved / TUMBLEWEED.radius) * TUMBLEWEED.rollScale;
    const degrees = ((typeof accumulated === "number" ? accumulated : 0) + radians * (180 / Math.PI)) % 360;

    entity.setDynamicProperty(ROLL_ACCUMULATED_PROPERTY, degrees);
    entity.setProperty(TUMBLEWEED_ROLL_PROPERTY, degrees);
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

/**
 * `spawnSpot`, but only when the candidate is in one of `TUMBLEWEED.biomes` — undefined otherwise (an
 * unloaded chunk counts as "no", the same as the wrong biome, rather than guessing). If nobody online is
 * near a desert, this returns undefined every run and nothing spawns: expected, not a bug.
 */
function desertSpawnSpot(dimension: Dimension, players: readonly { location: Vector3 }[]): Vector3 | undefined {

    const spot = spawnSpot(players);

    try {
        if (!TUMBLEWEED.biomes.includes(dimension.getBiome(spot).id)) return undefined;
    } catch {
        return undefined;
    }

    return spot;
}

onTick("tumbleweed", (ctx) => {

    const dimension = world.getDimension("overworld");
    const rolling = dimension.getEntities({ type: TUMBLEWEED_ENTITY_ID });
    const stillAlive: Entity[] = [];

    for (const entity of rolling) {

        if (shouldDespawn(entity, ctx.players, ctx.tick)) {
            entity.remove();
            continue;
        }

        pushOne(entity);
        stillAlive.push(entity);
    }

    if (tumbleweedsEnabled() && rolling.length < TUMBLEWEED.maxActive && ctx.players.length > 0) {
        const spot = desertSpawnSpot(dimension, ctx.players);
        if (spot) {
            const spawned = dimension.spawnEntity(TUMBLEWEED_ENTITY_ID, spot);
            spawned.setDynamicProperty(BORN_TICK_PROPERTY, ctx.tick);
            stillAlive.push(spawned);
        }
    }

    known = stillAlive;

}, { everyTicks: TUMBLEWEED.tickInterval });

/** Smooths the rolling animation between the slower handler's runs — see `updateRoll`. */
onTick("tumbleweed:roll", () => {
    for (const entity of known) {
        if (!entity.isValid) continue;
        updateRoll(entity);
    }
}, { everyTicks: 1 });

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
