import {
    world, system,
    type Dimension, type ItemStack, type Player, type Entity, type Vector3,
    EquipmentSlot, EntityDamageCause, EntitySwingSource
} from "@minecraft/server";
import { AMMO, GUNS, BULLET_ENTITY_ID, BULLET_LIFETIME_TICKS, type GunConfig, type GunId, type SoundCue } from "../config/guns.js";
import { AIM } from "../config/balance.js";
import { hideScope, showScope, zoomReset, zoomTo } from "../core/aim.js";
import { registerSystem } from "../core/registry.js";
import { onTick } from "../core/tick.js";

/**
 * One shared engine for all 6 guns, parameterized entirely by
 * config/guns.ts. Projectile guns spawn a shared bullet entity and
 * apply damage themselves on impact (rather than trusting whatever
 * the entity's own vanilla projectile damage would be) so every gun
 * can have an independent damage number. Shotguns are true hitscan:
 * several rays per trigger pull, each jittered within the gun's
 * spread cone, fired via Dimension.getEntitiesFromRay.
 */

const gunsByItemId = new Map<string, GunConfig>();
for (const gun of Object.values(GUNS)) {
    gunsByItemId.set(gun.itemId, gun);
}

// Per player+gun. Keyed by "<player id>:<gun id>". Never the name: two
// players can share a display name, while Entity.id is unique.
//
// Rounds chambered would ideally live on the gun's own ItemStack (via
// setDynamicProperty), so two guns of the same kind could track ammo
// independently. The API refuses that: dynamic properties can't be
// set on a stackable item, and every custom item here is stackable
// by default. Rather than fight that, ammo is tracked per player+gun
// in memory instead — meaning two guns of the same type held by the
// same player would currently share one ammo count. Acceptable for
// a prototype; revisit if that ever actually matters.
const lastFiredTick = new Map<string, number>();
const reloadingKeys = new Set<string>();
const loadedRounds = new Map<string, number>();

function stateKey(player: Player, gunId: GunId): string {
    return `${player.id}:${gunId}`;
}

function getMainhandItemTypeId(player: Player): string | undefined {
    const equippable = player.getComponent("minecraft:equippable");
    return equippable?.getEquipmentSlot(EquipmentSlot.Mainhand)?.getItem()?.typeId;
}

const reportedSoundErrors = new Set<string>();

function playCue(player: Player, cue: SoundCue): void {

    try {
        // Positional, so everyone nearby hears it — not just the shooter.
        player.dimension.playSound(cue.id, player.location, { volume: cue.volume, pitch: cue.pitch });
    } catch (error) {
        // A bad cue must never break firing, and it would repeat on
        // every shot, so report each broken id once.
        if (!reportedSoundErrors.has(cue.id)) {
            reportedSoundErrors.add(cue.id);
            world.sendMessage(`§c[GUN SOUND ERROR] ${cue.id}: ${error}`);
        }
    }
}

/**
 * Delayed cues re-check that the player is still around and still
 * holding this gun, so swapping away or disconnecting mid-reload
 * doesn't leave sounds playing for a weapon nobody is using.
 */
function playCues(player: Player, gun: GunConfig, cues: readonly SoundCue[]): void {

    for (const cue of cues) {

        if (!cue.delayTicks) {
            playCue(player, cue);
            continue;
        }

        system.runTimeout(() => {
            if (!player.isValid) return;
            if (getMainhandItemTypeId(player) !== gun.itemId) return;
            playCue(player, cue);
        }, cue.delayTicks);
    }
}

/** Rounds currently chambered. A freshly given gun reads as full. */
function getLoadedRounds(player: Player, gun: GunConfig): number {
    const key = stateKey(player, gun.id);
    const stored = loadedRounds.get(key);
    return stored ?? gun.magazineSize;
}

function setLoadedRounds(player: Player, gun: GunConfig, value: number): void {
    loadedRounds.set(stateKey(player, gun.id), value);
}

function countAmmoInInventory(player: Player, ammoItemId: string): number {

    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return 0;

    let total = 0;

    for (let i = 0; i < container.size; i++) {
        const stack = container.getItem(i);
        if (stack && stack.typeId === ammoItemId) total += stack.amount;
    }

    return total;
}

/** Returns how much ammo was actually taken, which may be less than asked. */
function consumeAmmoFromInventory(player: Player, ammoItemId: string, amount: number): number {

    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return 0;

    let remaining = amount;

    for (let i = 0; i < container.size && remaining > 0; i++) {

        const stack = container.getItem(i);
        if (!stack || stack.typeId !== ammoItemId) continue;

        const taken = Math.min(stack.amount, remaining);
        remaining -= taken;

        if (taken >= stack.amount) {
            container.setItem(i, undefined);
        } else {
            const reduced = stack.clone();
            reduced.amount = stack.amount - taken;
            container.setItem(i, reduced);
        }
    }

    return amount - remaining;
}

function startReload(player: Player, gun: GunConfig): void {

    const key = stateKey(player, gun.id);

    if (reloadingKeys.has(key)) return;

    const currentLoaded = getLoadedRounds(player, gun);

    if (currentLoaded >= gun.magazineSize) {
        player.sendMessage("§7Already fully loaded.");
        return;
    }

    const ammoConfig = AMMO[gun.ammo];

    if (countAmmoInInventory(player, ammoConfig.itemId) <= 0) {
        player.sendMessage(`§cNo ${ammoConfig.displayName} left.`);
        return;
    }

    reloadingKeys.add(key);
    player.sendMessage(`§7Reloading ${gun.displayName}...`);
    playCues(player, gun, gun.sounds.reload);

    system.runTimeout(() => {

        reloadingKeys.delete(key);

        // The player may have disconnected while the reload was in progress.
        if (!player.isValid) return;

        // The player may have swapped items away and back while the
        // reload was in progress.
        if (getMainhandItemTypeId(player) !== gun.itemId) return;

        const stillLoaded = getLoadedRounds(player, gun);
        const needed = gun.magazineSize - stillLoaded;

        if (needed <= 0) return;

        const consumed = consumeAmmoFromInventory(player, ammoConfig.itemId, needed);

        if (consumed <= 0) {
            player.sendMessage(`§cRan out of ${ammoConfig.displayName} mid-reload.`);
            return;
        }

        setLoadedRounds(player, gun, stillLoaded + consumed);
        player.sendMessage(`§a${gun.displayName} reloaded. (${stillLoaded + consumed}/${gun.magazineSize})`);

    }, gun.reloadTicks);
}

function tryFire(player: Player, gun: GunConfig): void {

    const key = stateKey(player, gun.id);

    if (reloadingKeys.has(key)) return;

    const lastFired = lastFiredTick.get(key) ?? -Infinity;
    if (system.currentTick - lastFired < gun.fireRateTicks) return;

    const loaded = getLoadedRounds(player, gun);

    if (loaded <= 0) {
        // Clicking an empty gun reloads it: on a horse there is no key to spare for it.
        player.playSound("random.click", { volume: 0.5 });
        startReload(player, gun);
        return;
    }

    lastFiredTick.set(key, system.currentTick);
    setLoadedRounds(player, gun, loaded - 1);

    if (gun.kind === "projectile") {
        fireProjectile(player, gun);
    } else {
        fireHitscan(player, gun);
    }

    playCues(player, gun, gun.sounds.fire);
}

function fireProjectile(player: Player, gun: Extract<GunConfig, { kind: "projectile" }>): void {

    const spawnPos = player.getHeadLocation();
    const direction = player.getViewDirection();

    const projectile = player.dimension.spawnEntity(BULLET_ENTITY_ID, spawnPos);
    projectile.setDynamicProperty("gunId", gun.id);

    const projectileComponent = projectile.getComponent("minecraft:projectile");

    if (projectileComponent) {
        projectileComponent.owner = player;
        projectileComponent.shoot({
            x: direction.x * gun.projectileSpeed,
            y: direction.y * gun.projectileSpeed,
            z: direction.z * gun.projectileSpeed
        });
    }

    // Safety net if it never hits anything — expected to already be
    // gone by then, so this is not an error condition.
    system.runTimeout(() => {
        try {
            projectile.remove();
        } catch {
            // Already removed by a hit — expected.
        }
    }, BULLET_LIFETIME_TICKS);
}

/** One pellet's flight: which way it went, how far, and whether it ended on something (a block or a target) rather than at its range. */
interface PelletPath {
    readonly direction: Vector3;
    readonly length: number;
    readonly ended: boolean;
}

/** A trail closer than this is not drawn: a spacing of zero (or less) in the config would otherwise never end. */
const MIN_TRAIL_SPACING = 0.25;

const reportedEffectErrors = new Set<string>();

function spawnEffect(dimension: Dimension, id: string, location: Vector3): void {

    try {
        dimension.spawnParticle(id, location);
    } catch (error) {
        // A wrong particle id must never break a shot, and it would repeat on every pellet, so each is reported once.
        if (reportedEffectErrors.has(id)) return;
        reportedEffectErrors.add(id);
        console.warn(`[gun effects] ${id} failed: ${error}`);
    }
}

function pointAlong(origin: Vector3, direction: Vector3, distance: number): Vector3 {
    return { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
}

/**
 * A shotgun has no bullet to watch, so the shot is drawn: a flash and smoke at the muzzle, a trail along every pellet's
 * path (which shows the spread), and a puff where a pellet ends on something. All of it is config/guns.ts effects.
 */
function showShot(player: Player, gun: Extract<GunConfig, { kind: "hitscan" }>, origin: Vector3, direction: Vector3, paths: readonly PelletPath[]): void {

    const fx = gun.effects;
    const dimension = player.dimension;

    // A little below the eyes, where the barrel is.
    const muzzle = pointAlong(origin, direction, fx.muzzleDistance);
    const at = { x: muzzle.x, y: muzzle.y - 0.2, z: muzzle.z };
    for (const id of fx.muzzle) spawnEffect(dimension, id, at);

    const spacing = Number.isFinite(fx.trailSpacing) ? Math.max(MIN_TRAIL_SPACING, fx.trailSpacing) : MIN_TRAIL_SPACING;

    for (const path of paths) {

        for (let distance = spacing; distance < path.length; distance += spacing) {
            spawnEffect(dimension, fx.trail, pointAlong(origin, path.direction, distance));
        }

        if (path.ended) spawnEffect(dimension, fx.impact, pointAlong(origin, path.direction, path.length));
    }
}

function fireHitscan(player: Player, gun: Extract<GunConfig, { kind: "hitscan" }>): void {

    const origin = player.getHeadLocation();
    const baseDirection = player.getViewDirection();

    // Pellets that land on the same target are added up and dealt as ONE hit. Several applyDamage
    // calls on one target in the same tick can be swallowed by its post-hit invulnerability (vanilla
    // ignores a repeat hit that is not bigger than the last, so every pellet after the first would
    // count for nothing). One summed hit deals the full damage whether or not that applies in this
    // build; systems/probe.ts (rae:probe_damage) measures it.
    const landed = new Map<string, { entity: Entity; pellets: number }>();

    // Where each pellet went, for drawing the shot.
    const paths: PelletPath[] = [];

    for (let i = 0; i < gun.pelletCount; i++) {

        const direction = jitterDirection(baseDirection, gun.spreadDegrees);

        const blockHit = player.dimension.getBlockFromRay(origin, direction, { maxDistance: gun.range });
        const maxDistance = blockHit
            ? distanceBetween(origin, blockWorldHitPoint(blockHit.block.location, blockHit.faceLocation))
            : gun.range;

        const entityHits = player.dimension.getEntitiesFromRay(origin, direction, { maxDistance });

        let closest: Entity | undefined;
        let closestDistance = Infinity;

        for (const hit of entityHits) {
            if (hit.entity === player) continue;
            if (hit.distance < closestDistance) {
                closest = hit.entity;
                closestDistance = hit.distance;
            }
        }

        if (closest) {
            const entry = landed.get(closest.id);

            if (entry) entry.pellets++;
            else landed.set(closest.id, { entity: closest, pellets: 1 });
        }

        paths.push({ direction, length: closest ? closestDistance : maxDistance, ended: closest !== undefined || blockHit !== undefined });
    }

    showShot(player, gun, origin, baseDirection, paths);

    for (const { entity, pellets } of landed.values()) {

        // Killed or removed since the ray found it, by something that ran in between.
        if (!entity.isValid) continue;

        // No physical projectile exists for hitscan pellets, so
        // the "projectile" cause (which requires a real
        // damagingProjectile entity) isn't available here.
        entity.applyDamage(gun.pelletDamage * pellets, {
            cause: EntityDamageCause.entityAttack,
            damagingEntity: player
        });
    }
}

function blockWorldHitPoint(blockLocation: Vector3, faceLocation: Vector3): Vector3 {
    return {
        x: blockLocation.x + faceLocation.x,
        y: blockLocation.y + faceLocation.y,
        z: blockLocation.z + faceLocation.z
    };
}

function distanceBetween(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Randomly rotates a unit direction within a cone of the given half-angle. */
function jitterDirection(direction: Vector3, spreadDegrees: number): Vector3 {

    if (spreadDegrees <= 0) return direction;

    const arbitrary: Vector3 = Math.abs(direction.y) < 0.99
        ? { x: 0, y: 1, z: 0 }
        : { x: 1, y: 0, z: 0 };

    const right = normalize(cross(direction, arbitrary));
    const up = cross(right, direction);

    const maxOffset = Math.tan((spreadDegrees * Math.PI) / 180);

    // Uniform random point in a disk, so the cone isn't corner-biased.
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * maxOffset;

    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;

    return normalize({
        x: direction.x + right.x * offsetX + up.x * offsetY,
        y: direction.y + right.y * offsetX + up.y * offsetY,
        z: direction.z + right.z * offsetX + up.z * offsetY
    });
}

function cross(a: Vector3, b: Vector3): Vector3 {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
    };
}

function normalize(v: Vector3): Vector3 {
    const length = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (length === 0) return { x: 0, y: 0, z: 1 };
    return { x: v.x / length, y: v.y / length, z: v.z / length };
}

// ---------------------------------------------------------------------------------------------------------
// Controls. Measured in the real game (docs/test-cards/AIM-SPIKE.md), because a script sees very little of the
// player's input and a horse takes the usual keys (sneak dismounts, and reports nothing):
//
//   left-click   fires. The swing has source Attack at the air or a mob and Mine at a block, riding or not.
//   right-click  toggles the aim (a tap: itemUse). It cannot be a hold, because the game sends no attack input while
//                an item is in use, so a held aim could never fire.
//   Q            reloads. A drop is an itemDrop of the gun, the slot emptying and a swing with source DropItem,
//                all in one tick; the gun is taken back into its slot and a reload starts.
//   an empty click   reloads too (tryFire).
//
// There is no sneak or off-hand key involved: sneak cannot be used on a horse and Bedrock has no swap key.
// ---------------------------------------------------------------------------------------------------------

world.afterEvents.playerSwingStart.subscribe((event) => {

    if (event.swingSource === EntitySwingSource.DropItem) {
        noteDropSwing(event.player);
        return;
    }

    if (event.swingSource !== EntitySwingSource.Attack && event.swingSource !== EntitySwingSource.Mine) return;

    const gun = gunsByItemId.get(event.heldItemStack?.typeId ?? "");
    if (gun) tryFire(event.player, gun);
});

// ---- Aim -----------------------------------------------------------------------------------------------
//
// Right-click TOGGLES the aim; it cannot be a hold. While an item is in use (a held right-click on a hold-to-use item) the
// game sends no attack input at all, as with a drawn bow, so a held aim could never fire (the owner found this the first
// time they tried to shoot through a scope). A tap has no use state, so a left-click still fires while aimed.

interface Aiming {
    readonly player: Player;
    readonly gun: GunConfig;
}

const aiming = new Map<string, Aiming>();
let stopAimWatch: (() => void) | undefined;

/** How often an aim is checked against what the player is still doing, and the slowdown refreshed, in ticks. */
const AIM_WATCH_TICKS = 4;

let slowFailureReported = false;

/** Aiming slows the player: an effect that lasts a few ticks and is refreshed for as long as the aim does. */
function slowWhileAimed(player: Player, gun: GunConfig): void {

    if (gun.aim.slowness === undefined) return;

    try {
        player.addEffect("slowness", AIM.slowEffectTicks, { amplifier: gun.aim.slowness, showParticles: false });
    } catch (error) {
        if (slowFailureReported) return;
        slowFailureReported = true;
        console.warn(`[aim] slowing the player failed: ${error}`);
    }
}

function startAim(player: Player, gun: GunConfig): void {

    if (aiming.has(player.id)) return;

    aiming.set(player.id, { player, gun });
    zoomTo(player, gun.aim.fov);
    if (gun.aim.scope) showScope(player);
    slowWhileAimed(player, gun);

    // Nothing tells a script that a player switched slot, died or left, so the aim is checked.
    stopAimWatch ??= onTick("guns:aim", () => {
        for (const [id, state] of [...aiming]) {
            if (!state.player.isValid || getMainhandItemTypeId(state.player) !== state.gun.itemId) {
                stopAim(id);
                continue;
            }
            slowWhileAimed(state.player, state.gun);
        }
    }, { everyTicks: AIM_WATCH_TICKS });
}

function stopAim(playerId: string): void {

    const state = aiming.get(playerId);
    if (!state) return;

    aiming.delete(playerId);

    if (state.player.isValid) {
        zoomReset(state.player);
        if (state.gun.aim.scope) hideScope(state.player);
    }

    if (aiming.size === 0) {
        stopAimWatch?.();
        stopAimWatch = undefined;
    }
}

world.afterEvents.itemUse.subscribe((event) => {

    const gun = gunsByItemId.get(event.itemStack.typeId);
    if (!gun) return;

    const player = event.source;

    if (aiming.has(player.id)) stopAim(player.id);
    else startAim(player, gun);
});

// ---- Reload key (Q) --------------------------------------------------------------------------------------

interface DroppedGun {
    readonly entity: Entity;
    readonly stack: ItemStack;
    readonly gun: GunConfig;
}

/** What one player's drop looked like this tick. The pieces arrive as separate events, in a known order, and only the whole means "Q". */
interface DropState {
    readonly tick: number;
    drops: DroppedGun[] | undefined;
    /** The slot a gun was just taken out of, from the inventory change. */
    slot: number | undefined;
    swung: boolean;
    resolved: boolean;
}

const dropStates = new Map<string, DropState>();

function dropStateOf(player: Player): DropState {

    const now = system.currentTick;
    let state = dropStates.get(player.id);

    if (!state || state.tick !== now) {
        state = { tick: now, drops: undefined, slot: undefined, swung: false, resolved: false };
        dropStates.set(player.id, state);
    }

    return state;
}

/** Puts the stack back: in the slot it came from if that is empty, otherwise anywhere. False when it does not fit. */
function giveBack(player: Player, stack: ItemStack, slot: number | undefined): boolean {

    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return false;

    if (slot !== undefined && slot >= 0 && slot < container.size && container.getItem(slot) === undefined) {
        container.setItem(slot, stack);
        return true;
    }

    return container.addItem(stack) === undefined;
}

/**
 * Q was pressed with a gun in hand once the drop and the DropItem swing have both arrived. A drop with no swing
 * (dying, or dragging the item out of the inventory screen) is a real drop and is left alone.
 */
function resolveDrop(player: Player): void {

    const state = dropStateOf(player);
    if (state.resolved || !state.swung || !state.drops || state.drops.length === 0) return;
    state.resolved = true;

    let reloaded = false;

    for (const drop of state.drops) {

        if (!giveBack(player, drop.stack, state.slot)) {
            player.sendMessage("§cNo room in your inventory: pick the gun up off the ground.");
            continue;
        }

        try {
            drop.entity.remove();
        } catch {
            // Already gone.
        }

        if (!reloaded) {
            reloaded = true;
            startReload(player, drop.gun);
        }
    }
}

function noteDropSwing(player: Player): void {
    dropStateOf(player).swung = true;
    resolveDrop(player);
}

world.afterEvents.entityItemDrop.subscribe((event) => {

    if (event.entity.typeId !== "minecraft:player") return;

    const drops: DroppedGun[] = [];

    // Once, in the real game, event.items was not iterable ("value is not iterable" at this loop): read it defensively.
    const items: Entity[] = event.items ? Array.from(event.items) : [];

    for (const item of items) {

        // An entity that is already gone throws when asked for its component.
        try {
            const stack = item.getComponent("minecraft:item")?.itemStack;
            const gun = stack ? gunsByItemId.get(stack.typeId) : undefined;
            if (stack && gun) drops.push({ entity: item, stack, gun });
        } catch {
            // Not a live item entity: nothing to take back.
        }
    }

    if (drops.length === 0) return;

    const player = event.entity as Player;
    dropStateOf(player).drops = drops;
    resolveDrop(player);
});

world.afterEvents.playerInventoryItemChange.subscribe((event) => {
    if (event.itemStack === undefined && event.beforeItemStack && gunsByItemId.has(event.beforeItemStack.typeId)) {
        dropStateOf(event.player).slot = event.slot;
    }
});

world.afterEvents.projectileHitEntity.subscribe((event) => {

    // A single hit can fire this event more than once in the same
    // tick (e.g. overlapping hitboxes) — the first invocation may
    // have already removed the projectile by the time a second runs.
    if (!event.projectile.isValid) return;

    const gunId = event.projectile.getDynamicProperty("gunId");
    if (typeof gunId !== "string" || !(gunId in GUNS)) return;

    const gun = GUNS[gunId as GunId];
    if (gun.kind !== "projectile") return;

    const hitEntity = event.getEntityHit().entity;

    if (hitEntity && hitEntity.isValid) {
        // The "projectile" cause requires the actual projectile
        // entity, not a bare cause string.
        hitEntity.applyDamage(gun.damage, {
            damagingProjectile: event.projectile,
            damagingEntity: event.source
        });
    }

    event.projectile.remove();
});

world.afterEvents.projectileHitBlock.subscribe((event) => {

    if (!event.projectile.isValid) return;

    const gunId = event.projectile.getDynamicProperty("gunId");
    if (typeof gunId !== "string" || !(gunId in GUNS)) return;

    event.projectile.remove();
});

registerSystem({
    name: "guns",
    reset() {
        lastFiredTick.clear();
        reloadingKeys.clear();
        loadedRounds.clear();
        dropStates.clear();
        for (const id of [...aiming.keys()]) stopAim(id);
    }
});
