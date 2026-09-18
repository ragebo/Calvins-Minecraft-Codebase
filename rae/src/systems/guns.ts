import {
    world, system,
    type Player, type Entity, type Vector3,
    EquipmentSlot, EntityDamageCause
} from "@minecraft/server";
import { AMMO, GUNS, BULLET_ENTITY_ID, BULLET_LIFETIME_TICKS, type GunConfig, type GunId } from "../config/guns.js";
import { registerSystem } from "../core/registry.js";

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

// Per player+gun. Keyed by "<player name>:<gun id>".
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
    return `${player.name}:${gunId}`;
}

function getMainhandItemTypeId(player: Player): string | undefined {
    const equippable = player.getComponent("minecraft:equippable");
    return equippable?.getEquipmentSlot(EquipmentSlot.Mainhand)?.getItem()?.typeId;
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

    system.runTimeout(() => {

        reloadingKeys.delete(key);

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
        player.playSound("random.levelup", { volume: 0.6 });
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
        player.playSound("random.click", { volume: 0.5 });
        player.sendMessage("§7*click* — empty. Sneak + use to reload.");
        return;
    }

    lastFiredTick.set(key, system.currentTick);
    setLoadedRounds(player, gun, loaded - 1);

    if (gun.kind === "projectile") {
        fireProjectile(player, gun);
    } else {
        fireHitscan(player, gun);
    }

    player.dimension.playSound("random.bow", player.location, { pitch: 0.9, volume: 1 });
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

function fireHitscan(player: Player, gun: Extract<GunConfig, { kind: "hitscan" }>): void {

    const origin = player.getHeadLocation();
    const baseDirection = player.getViewDirection();

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
            // No physical projectile exists for hitscan pellets, so
            // the "projectile" cause (which requires a real
            // damagingProjectile entity) isn't available here.
            closest.applyDamage(gun.pelletDamage, {
                cause: EntityDamageCause.entityAttack,
                damagingEntity: player
            });
        }
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

world.afterEvents.itemUse.subscribe((event) => {

    const gun = gunsByItemId.get(event.itemStack.typeId);
    if (!gun) return;

    const player = event.source;

    if (player.isSneaking) {
        startReload(player, gun);
    } else {
        tryFire(player, gun);
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
    }
});
