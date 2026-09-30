import {
    world, system,
    type Dimension, type ItemStack, type Player, type Entity, type Vector3,
    type EntityApplyDamageByProjectileOptions, type EntityApplyDamageOptions,
    EquipmentSlot, EntityDamageCause, EntitySwingSource
} from "@minecraft/server";
import { AMMO, GUNS, BULLET_ENTITY_ID, BULLET_LIFETIME_TICKS, GATLING_AIM_PITCH_PROPERTY, GATLING_BARREL_SPIN_PROPERTY, HIT_WINDOW_TICKS, type AutomaticConfig, type GunConfig, type GunId, type MuzzleEffects, type SoundCue } from "../config/guns.js";
import { AIM, TUMBLEWEED_ENTITY_ID } from "../config/balance.js";
import { hideScope, showScope, zoomReset, zoomTo } from "../core/aim.js";
import { warn } from "../core/log.js";
import { registerSystem } from "../core/registry.js";
import { playFor, playSequence } from "../core/sound.js";
import { onTick } from "../core/tick.js";

/**
 * One shared engine for all 6 guns, parameterized entirely by
 * config/guns.ts. Projectile guns spawn a shared bullet entity and
 * apply damage themselves on impact (rather than trusting whatever
 * the entity's own vanilla projectile damage would be) so every gun
 * can have an independent damage number. Shotguns are true hitscan:
 * several rays per trigger pull, each jittered within the gun's
 * spread cone, fired via Dimension.getEntitiesFromRay.
 *
 * The revolver and the repeater (semi_rifle) need their action manually cycled between shots
 * (config/guns.ts's primeTicks): the click right after a shot doesn't fire, it primes, and the one
 * after that does. Needing two clicks per shot is what actually slows these two down in practice; see
 * tryFire.
 *
 * The Gatling gun is manned, not held (config/guns.ts's automatic): right-clicking it (itemUse) places it
 * as a rideable entity and consumes the item, and a swing while riding that entity toggles a self-sustaining
 * fire loop on or off (see toggleAutomatic/fireAutomaticStep) rather than firing once per swing — there is no
 * real held-button signal for a swing in this engine (confirmed: holding it doesn't even repeat the swing),
 * so "hold to fire" is approximated as a toggle instead, the same fix already used for aiming.
 */

const gunsByItemId = new Map<string, GunConfig>();
const gunsByMountEntityId = new Map<string, GunConfig>();
for (const gun of Object.values(GUNS)) {
    gunsByItemId.set(gun.itemId, gun);
    if (gun.automatic) gunsByMountEntityId.set(gun.automatic.mountEntityId, gun);
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

/**
 * A gun with `primeTicks` set (config/guns.ts) needs its action manually cycled between shots: this
 * tracks which player+gun is currently waiting on that click. `lastFiredTick` doubles as "last fire OR
 * prime tick" for these guns, so the same fireRateTicks-style gate (`tryFire`) works for both stages
 * without a second timer.
 */
const needsPrimeKeys = new Set<string>();

function stateKey(player: Player, gunId: GunId): string {
    return `${player.id}:${gunId}`;
}

function getMainhandItemTypeId(player: Player): string | undefined {
    const equippable = player.getComponent("minecraft:equippable");
    return equippable?.getEquipmentSlot(EquipmentSlot.Mainhand)?.getItem()?.typeId;
}

/** The entity a player is currently riding, if any. `entityRidingOn` can throw ("This property can throw
 *  when used", per its own doc) — same guarded-read pattern already used for this component in aimprobe.ts. */
function riddenEntity(player: Player): Entity | undefined {
    try {
        return player.getComponent("minecraft:riding")?.entityRidingOn;
    } catch {
        return undefined;
    }
}

/** True while a player is actively holding this gun (a carried gun) or riding its mount (an automatic gun) —
 *  the one condition every "is this still the gun in use" check (delayed sound cues, a reload finishing)
 *  needs, since a held-item check alone is always false for a gun nobody ever holds. */
function stillUsing(player: Player, gun: GunConfig): boolean {
    if (gun.automatic) return riddenEntity(player)?.typeId === gun.automatic.mountEntityId;
    return getMainhandItemTypeId(player) === gun.itemId;
}

/** An automatic gun's fire cue climbs in pitch with how far into the burst it is, so it audibly "revs up". */
function fireCuesFor(gun: GunConfig, burstLevel: number, spinUpShots: number): readonly SoundCue[] {
    const t = (burstLevel - 1) / Math.max(1, spinUpShots - 1);
    return gun.sounds.fire.map((cue) => ({ ...cue, pitch: cue.pitch + t * 0.5 }));
}

/**
 * Every gun sound carries: everyone nearby should hear a shot or a reload, not just the shooter, so
 * this always plays positionally (core/sound.ts's playAt, via playSequence's `positional` option). A
 * delayed cue re-checks stillUsing — the one condition every gun already needs — so swapping away,
 * dismounting, or disconnecting mid-reload doesn't leave sounds playing for a weapon nobody is using
 * any more. A bad cue is caught and reported by core/sound.ts itself; this file no longer needs to know.
 */
function playCues(player: Player, gun: GunConfig, cues: readonly SoundCue[]): void {
    playSequence(player, cues, { positional: true, shouldPlay: () => stillUsing(player, gun) });
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

/** The private click a player hears from their own empty gun, whether they pulled the trigger themselves or
 *  an automatic gun's own loop found it empty — always paired with starting a reload. */
function playDryClick(player: Player): void {
    playFor(player, { id: "random.click", volume: 0.5 });
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
    needsPrimeKeys.delete(key);   // a full reload leaves it ready to fire, not mid-cycle
    player.sendMessage(`§7Reloading ${gun.displayName}...`);
    playCues(player, gun, gun.sounds.reload);

    system.runTimeout(() => {

        reloadingKeys.delete(key);

        // The player may have disconnected while the reload was in progress.
        if (!player.isValid) return;

        // The player may have swapped items away and back (or, for a mounted gun, dismounted) while the
        // reload was in progress.
        if (!stillUsing(player, gun)) return;

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

    const lastAction = lastFiredTick.get(key) ?? -Infinity;

    // A gun that needs manual priming: this click cycles the action instead of firing it, once
    // it's had at least primeTicks since the shot. Too soon is a silent no-op, same as a too-soon
    // fire below — spamming both clicks back to back can't skip the cycle time either way.
    if (gun.primeTicks !== undefined && needsPrimeKeys.has(key)) {
        if (system.currentTick - lastAction < gun.primeTicks) return;
        needsPrimeKeys.delete(key);
        lastFiredTick.set(key, system.currentTick);
        if (gun.sounds.prime) playCues(player, gun, gun.sounds.prime);
        return;
    }

    if (system.currentTick - lastAction < gun.fireRateTicks) return;

    const loaded = getLoadedRounds(player, gun);

    if (loaded <= 0) {
        // Clicking an empty gun reloads it: on a horse there is no key to spare for it.
        playDryClick(player);
        startReload(player, gun);
        return;
    }

    lastFiredTick.set(key, system.currentTick);
    setLoadedRounds(player, gun, loaded - 1);

    showMuzzle(player, gun.effects);

    if (gun.kind === "projectile") {
        fireProjectile(player, gun);
    } else {
        fireHitscan(player, gun);
    }

    playCues(player, gun, gun.sounds.fire);

    if (gun.primeTicks !== undefined) needsPrimeKeys.add(key);
}

/**
 * An automatic gun's per-player run of its self-sustaining fire loop, started by toggleAutomatic. `burst`
 * lives on the run itself (not a shared map) since nothing else needs to read it once the loop that owns it
 * ends. `automatic` is pulled out once here rather than re-read through `gun.automatic!` everywhere below.
 */
interface GatlingRun {
    readonly player: Player;
    readonly gun: GunConfig;
    readonly automatic: AutomaticConfig;
    burst: number;
}

const gatlingRuns = new Map<string, GatlingRun>();

/**
 * A swing while riding an automatic gun's mount toggles its fire loop rather than firing once per swing:
 * start it if it's not already running, stop it if it is. See AutomaticConfig's own doc comment for why a
 * toggle, not a hold.
 */
function toggleAutomatic(player: Player, gun: GunConfig): void {

    const key = stateKey(player, gun.id);

    if (gatlingRuns.has(key)) {
        gatlingRuns.delete(key);
        return;
    }

    if (reloadingKeys.has(key) || !gun.automatic) return;

    const run: GatlingRun = { player, gun, automatic: gun.automatic, burst: 0 };
    gatlingRuns.set(key, run);
    fireAutomaticStep(key, run);
}

/**
 * One shot of a running Gatling loop, then reschedules itself at a shorter delay than last time (ramping
 * fireRateTicksStart towards fireRateTicksSpunUp over automatic.spinUpShots consecutive shots) — entirely on
 * its own timer, needing no further clicks, until something below stops it.
 */
function fireAutomaticStep(key: string, run: GatlingRun): void {

    // Toggled off (a fresh run took this key, or it was stopped outright) since this step was scheduled.
    if (gatlingRuns.get(key) !== run) return;

    if (!run.player.isValid || riddenEntity(run.player)?.typeId !== run.automatic.mountEntityId) {
        gatlingRuns.delete(key);
        return;
    }

    const loaded = getLoadedRounds(run.player, run.gun);

    if (loaded <= 0) {
        gatlingRuns.delete(key);
        playDryClick(run.player);
        startReload(run.player, run.gun);
        return;
    }

    setLoadedRounds(run.player, run.gun, loaded - 1);
    showMuzzle(run.player, run.gun.effects);

    if (run.gun.kind === "projectile") fireProjectile(run.player, run.gun);
    else fireHitscan(run.player, run.gun);

    run.burst = Math.min(run.burst + 1, run.automatic.spinUpShots);
    playCues(run.player, run.gun, fireCuesFor(run.gun, run.burst, run.automatic.spinUpShots));

    const t = (run.burst - 1) / Math.max(1, run.automatic.spinUpShots - 1);
    const delay = Math.round(run.automatic.fireRateTicksStart + (run.automatic.fireRateTicksSpunUp - run.automatic.fireRateTicksStart) * t);

    system.runTimeout(() => fireAutomaticStep(key, run), delay);
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
        warn("gun effects", `${id} failed: ${error}`);
    }
}

function pointAlong(origin: Vector3, direction: Vector3, distance: number): Vector3 {
    return { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
}

/** What every gun shows at the muzzle as it fires: smoke, and a flash where the gun has one (config/guns.ts effects). */
function showMuzzle(player: Player, fx: MuzzleEffects): void {

    const origin = player.getHeadLocation();
    const muzzle = pointAlong(origin, player.getViewDirection(), fx.muzzleDistance);

    // A little below the eyes, where the barrel is.
    const at = { x: muzzle.x, y: muzzle.y - 0.2, z: muzzle.z };

    for (const id of fx.muzzle) spawnEffect(player.dimension, id, at);
}

/**
 * A shotgun has no bullet to watch, so the shot is drawn: a trail along every pellet's path (which shows the spread), and
 * a puff where a pellet ends on something. All of it is config/guns.ts effects; the muzzle is showMuzzle.
 */
function showShot(player: Player, gun: Extract<GunConfig, { kind: "hitscan" }>, origin: Vector3, paths: readonly PelletPath[]): void {

    const fx = gun.effects;
    const dimension = player.dimension;

    const spacing = Number.isFinite(fx.trailSpacing) ? Math.max(MIN_TRAIL_SPACING, fx.trailSpacing) : MIN_TRAIL_SPACING;

    for (const path of paths) {

        for (let distance = spacing; distance < path.length; distance += spacing) {
            spawnEffect(dimension, fx.trail, pointAlong(origin, path.direction, distance));
        }

        if (path.ended) spawnEffect(dimension, fx.impact, pointAlong(origin, path.direction, path.length));
    }
}

/**
 * What a target was last dealt by a gun, and when, so a rapid follow-up shot can be summed into it
 * instead of lost outright: keyed by target.id, cleared on a round reset.
 */
const lastHit = new Map<string, { tick: number; amount: number }>();

/**
 * Deals gun damage the way `applyDamage` should, given vanilla's post-hit invulnerability: a hit no bigger
 * than the last one dealt within HIT_WINDOW_TICKS is otherwise swallowed outright (measured with
 * `rae:probe_damage`). The shotguns already avoid this within one blast by summing their pellets into one
 * call; this does the same across separate trigger pulls, adding a would-be-lost hit to the pending total
 * instead of dealing it (and losing it) on its own. Every gun's damage should go through this, not a bare
 * `entity.applyDamage`.
 */
function dealGunDamage(target: Entity, amount: number, options: EntityApplyDamageByProjectileOptions | EntityApplyDamageOptions): void {

    const previous = lastHit.get(target.id);
    const withinWindow = previous !== undefined && system.currentTick - previous.tick < HIT_WINDOW_TICKS;
    const dealt = withinWindow && amount <= previous!.amount ? previous!.amount + amount : amount;

    target.applyDamage(dealt, options);
    lastHit.set(target.id, { tick: system.currentTick, amount: dealt });
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

        // Tumbleweeds are decoration: they can never soak up a pellet or shield anyone standing behind one.
        const entityHits = player.dimension.getEntitiesFromRay(origin, direction, { maxDistance, excludeTypes: [TUMBLEWEED_ENTITY_ID] });

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

    showShot(player, gun, origin, paths);

    for (const { entity, pellets } of landed.values()) {

        // Killed or removed since the ray found it, by something that ran in between.
        if (!entity.isValid) continue;

        // No physical projectile exists for hitscan pellets, so
        // the "projectile" cause (which requires a real
        // damagingProjectile entity) isn't available here.
        dealGunDamage(entity, gun.pelletDamage * pellets, {
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
//
// The Gatling gun is the one exception to "left-click fires the held gun": nothing ever holds it, so its
// left-click trigger is a swing while riding its mount entity instead (below), placed by a separate
// right-click-on-a-block handler further down.
// ---------------------------------------------------------------------------------------------------------

world.afterEvents.playerSwingStart.subscribe((event) => {

    if (event.swingSource === EntitySwingSource.DropItem) {
        noteDropSwing(event.player);
        return;
    }

    if (event.swingSource !== EntitySwingSource.Attack && event.swingSource !== EntitySwingSource.Mine) return;

    // An automatic gun is never fired by holding it — only by riding the mount it becomes once placed
    // (below) — so it's deliberately excluded here even though it's still in gunsByItemId for the
    // placement handler's own lookup.
    const heldGun = gunsByItemId.get(event.heldItemStack?.typeId ?? "");
    if (heldGun && !heldGun.automatic) {
        tryFire(event.player, heldGun);
        return;
    }

    const mountedGun = gunsByMountEntityId.get(riddenEntity(event.player)?.typeId ?? "");
    if (mountedGun) toggleAutomatic(event.player, mountedGun);
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
        warn("aim", `slowing the player failed: ${error}`);
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
    // An automatic gun is never held long enough to aim with: right-clicking it places it (below), and it
    // has no zoom worth toggling in the moment before it leaves the player's hand.
    if (!gun || gun.automatic) return;

    const player = event.source;

    if (aiming.has(player.id)) stopAim(player.id);
    else startAim(player, gun);
});

// ---- Placing the Gatling gun -----------------------------------------------------------------------------
//
// The only carryable gun that is never held to fire: right-clicking it (itemUse — the same event the aim
// toggle above already uses, and already proven reliable in this codebase) plants it, facing the way the
// player was facing, and consumes one from the stack. Where: a plain right-click carries no block/face
// information of its own, so this raycasts from the player's own view exactly the way fireHitscan already
// finds a shot's target, rather than depending on an unproven "which block did this land on" event field.
// Firing it from then on is the swing-while-riding branch in the playerSwingStart handler above.

world.afterEvents.itemUse.subscribe((event) => {

    const gun = gunsByItemId.get(event.itemStack.typeId);
    if (!gun?.automatic) return;

    const player = event.source;
    const origin = player.getHeadLocation();
    const direction = player.getViewDirection();
    const hit = player.dimension.getBlockFromRay(origin, direction, { maxDistance: gun.automatic.placementRange });

    if (!hit) {
        player.sendMessage("§7Nothing in range to place it on.");
        return;
    }

    const at = blockWorldHitPoint(hit.block.location, hit.faceLocation);
    const placed = player.dimension.spawnEntity(gun.automatic.mountEntityId, at);
    placed.setRotation({ x: 0, y: player.getRotation().y });

    // Every gun here has max_stack_size 1, so placing it always empties the slot, never decrements a stack.
    const container = player.getComponent("minecraft:inventory")?.container;
    const slot = player.selectedSlotIndex;
    if (container && container.getItem(slot)?.typeId === gun.itemId) container.setItem(slot, undefined);
});

// ---- Tracking the rider's aim ----------------------------------------------------------------------------
//
// A manned Gatling gun turns to follow whoever is riding it, not just while firing. Yaw is the whole
// entity's own rotation (it already turns every bone together, which reads fine for a swiveling mount);
// pitch is isolated to the "turret" bone alone via a client-synced entity property and a resource-pack
// animation reading it (BountySys_RP/animations/gatling_gun.animation.json), the same technique
// systems/tumbleweed.ts already uses for its own roll — the tripod itself never tips. The same animation
// also spins the "barrels" bone — a child of "turret", so it pitches along for free — around its own length
// while a fire loop is actively running, ramping the same way the fire rate itself does; it simply stops
// advancing (not resets) once nothing is firing, coasting to a stop wherever it happened to be, same as a
// real one would.
//
// Every tick, off the player list every other onTick handler already shares, rather than a dimension-wide
// entity scan: cheap, since only ever a handful of players are ever riding one of these at once.

let gatlingPropertyErrorReported = false;

/** A bad property write here must never break aim tracking for everyone else riding one; each broken
 *  property name is reported once, not once per tick per rider. */
function setGatlingProperty(mount: Entity, property: string, value: number): void {
    try {
        mount.setProperty(property, value);
    } catch (error) {
        if (gatlingPropertyErrorReported) return;
        gatlingPropertyErrorReported = true;
        console.warn(`[guns] setting ${property} failed: ${error}`);
    }
}

onTick("guns:gatling-aim", (ctx) => {

    for (const player of ctx.players) {

        const mount = riddenEntity(player);
        if (!mount?.isValid) continue;

        const mountedGun = gunsByMountEntityId.get(mount.typeId);
        if (!mountedGun?.automatic) continue;

        const rotation = player.getRotation();
        mount.setRotation({ x: mount.getRotation().x, y: rotation.y });
        setGatlingProperty(mount, GATLING_AIM_PITCH_PROPERTY, Math.max(-90, Math.min(90, rotation.x)));

        const run = gatlingRuns.get(stateKey(player, mountedGun.id));
        if (!run) continue;   // not currently firing: leave the barrels wherever they stopped

        const t = (run.burst - 1) / Math.max(1, run.automatic.spinUpShots - 1);
        const step = run.automatic.spinDegreesStart + (run.automatic.spinDegreesSpunUp - run.automatic.spinDegreesStart) * t;
        const spin = mount.getProperty(GATLING_BARREL_SPIN_PROPERTY);
        const next = ((typeof spin === "number" ? spin : 0) + step) % 360;
        setGatlingProperty(mount, GATLING_BARREL_SPIN_PROPERTY, next);
    }

}, { everyTicks: 1 });

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
        dealGunDamage(hitEntity, gun.damage, {
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
        needsPrimeKeys.clear();
        gatlingRuns.clear();
        dropStates.clear();
        lastHit.clear();
        for (const id of [...aiming.keys()]) stopAim(id);
    }
});
