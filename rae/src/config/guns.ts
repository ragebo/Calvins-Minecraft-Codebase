/**
 * EVERY gun and ammo stat lives here. Nothing else defines one.
 * First-pass balance numbers — tune freely, nothing else needs to
 * change when you do. That includes the sounds: every id below is a
 * vanilla sound event, and
 *   /playsound <id> @s ~ ~ ~ <volume> <pitch>
 * lets you audition a change in-game before editing it in here.
 */

/** Bump whenever the shape or meaning of what this file exports changes in a way persisted data depends on. */
export const GUNS_SCHEMA_VERSION = 1;

export type AmmoId = "handgun_ammo" | "rifle_ammo" | "shotgun_ammo";

export interface AmmoConfig {
    readonly id: AmmoId;
    readonly itemId: string;
    readonly displayName: string;
}

export const AMMO: Record<AmmoId, AmmoConfig> = {
    handgun_ammo: {
        id: "handgun_ammo",
        itemId: "bountysys:handgun_ammo",
        displayName: "Handgun Rounds"
    },
    rifle_ammo: {
        id: "rifle_ammo",
        itemId: "bountysys:rifle_ammo",
        displayName: "Rifle Rounds"
    },
    shotgun_ammo: {
        id: "shotgun_ammo",
        itemId: "bountysys:shotgun_ammo",
        displayName: "Shotgun Shells"
    }
};

export type GunId =
    | "revolver"
    | "pistol"
    | "bolt_rifle"
    | "semi_rifle"
    | "pump_shotgun"
    | "double_barrel_shotgun";

/** One layer of a gun sound: a vanilla sound event played at the shooter. */
export interface SoundCue {
    /** Vanilla sound event id, e.g. "firework.blast". */
    readonly id: string;
    /** 1 is normal and higher carries farther. Never below 0. */
    readonly volume: number;
    /** 1 is the sound's natural pitch. The engine rejects anything under 0.01. */
    readonly pitch: number;
    /** Ticks after the trigger (the shot, or the start of the reload). Omit to play immediately. */
    readonly delayTicks?: number;
}

export interface GunSounds {
    /** Played as the shot goes off. Delayed cues can add a pump or bolt cycle. */
    readonly fire: readonly SoundCue[];
    /** Played across a reload, so keep every delay under that gun's reloadTicks. */
    readonly reload: readonly SoundCue[];
}

interface BaseGunConfig {
    readonly id: GunId;
    readonly itemId: string;
    readonly displayName: string;
    readonly ammo: AmmoId;
    readonly magazineSize: number;
    /** Ticks that must pass between shots. */
    readonly fireRateTicks: number;
    /** Ticks a reload takes once started (sneak + use to trigger). */
    readonly reloadTicks: number;
    readonly sounds: GunSounds;
}

export interface ProjectileGunConfig extends BaseGunConfig {
    readonly kind: "projectile";
    readonly damage: number;
    /** Blocks per tick. */
    readonly projectileSpeed: number;
}

export interface HitscanGunConfig extends BaseGunConfig {
    readonly kind: "hitscan";
    /** Damage dealt by EACH pellet that connects. */
    readonly pelletDamage: number;
    readonly pelletCount: number;
    /** Half-angle of the spread cone, in degrees. */
    readonly spreadDegrees: number;
    readonly range: number;
}

export type GunConfig = ProjectileGunConfig | HitscanGunConfig;

export const GUNS: Record<GunId, GunConfig> = {
    revolver: {
        id: "revolver",
        itemId: "bountysys:revolver",
        displayName: "Revolver",
        ammo: "handgun_ammo",
        magazineSize: 6,
        fireRateTicks: 8,
        reloadTicks: 40,
        sounds: {
            fire: [
                { id: "firework.blast", volume: 2.0, pitch: 0.9 },
                { id: "random.explode", volume: 0.6, pitch: 1.7 }
            ],
            reload: [
                { id: "random.lever_click", volume: 0.7, pitch: 0.8 },
                { id: "armor.equip_chain", volume: 0.6, pitch: 1.3, delayTicks: 10 },
                { id: "random.pop", volume: 0.5, pitch: 1.5, delayTicks: 19 },
                { id: "random.pop", volume: 0.5, pitch: 1.7, delayTicks: 25 },
                { id: "random.lever_click", volume: 0.8, pitch: 1.3, delayTicks: 36 }
            ]
        },
        kind: "projectile",
        damage: 4,
        projectileSpeed: 3.5
    },
    pistol: {
        id: "pistol",
        itemId: "bountysys:pistol",
        displayName: "Pistol",
        ammo: "handgun_ammo",
        magazineSize: 8,
        fireRateTicks: 10,
        reloadTicks: 30,
        sounds: {
            fire: [
                { id: "firework.blast", volume: 1.6, pitch: 1.2 }
            ],
            reload: [
                { id: "random.click", volume: 0.6, pitch: 0.9 },
                { id: "armor.equip_chain", volume: 0.6, pitch: 1.0, delayTicks: 9 },
                { id: "random.lever_click", volume: 0.8, pitch: 1.2, delayTicks: 20 },
                { id: "tile.piston.in", volume: 0.5, pitch: 1.9, delayTicks: 27 }
            ]
        },
        kind: "projectile",
        damage: 6,
        projectileSpeed: 3.5
    },
    bolt_rifle: {
        id: "bolt_rifle",
        itemId: "bountysys:bolt_rifle",
        displayName: "Bolt-Action Rifle",
        ammo: "rifle_ammo",
        magazineSize: 1,
        fireRateTicks: 10,
        reloadTicks: 70,
        sounds: {
            fire: [
                { id: "firework.large_blast", volume: 3.0, pitch: 0.85 },
                { id: "random.explode", volume: 0.7, pitch: 1.5 }
            ],
            reload: [
                { id: "tile.piston.out", volume: 0.7, pitch: 1.3 },
                { id: "random.click", volume: 0.6, pitch: 0.7, delayTicks: 16 },
                { id: "random.pop", volume: 0.6, pitch: 1.2, delayTicks: 32 },
                { id: "tile.piston.in", volume: 0.7, pitch: 1.5, delayTicks: 48 },
                { id: "random.lever_click", volume: 0.9, pitch: 0.9, delayTicks: 62 }
            ]
        },
        kind: "projectile",
        damage: 14,
        projectileSpeed: 6
    },
    semi_rifle: {
        id: "semi_rifle",
        itemId: "bountysys:semi_rifle",
        displayName: "Semi-Auto Rifle",
        ammo: "rifle_ammo",
        magazineSize: 15,
        fireRateTicks: 6,
        reloadTicks: 35,
        sounds: {
            fire: [
                { id: "firework.large_blast", volume: 2.2, pitch: 1.25 }
            ],
            reload: [
                { id: "random.click", volume: 0.6, pitch: 0.8 },
                { id: "armor.equip_iron", volume: 0.6, pitch: 1.0, delayTicks: 11 },
                { id: "tile.piston.out", volume: 0.5, pitch: 1.8, delayTicks: 24 },
                { id: "tile.piston.in", volume: 0.6, pitch: 2.0, delayTicks: 30 }
            ]
        },
        kind: "projectile",
        damage: 5,
        projectileSpeed: 4.5
    },
    pump_shotgun: {
        id: "pump_shotgun",
        itemId: "bountysys:pump_shotgun",
        displayName: "Pump Shotgun",
        ammo: "shotgun_ammo",
        magazineSize: 5,
        fireRateTicks: 15,
        reloadTicks: 45,
        sounds: {
            fire: [
                { id: "random.explode", volume: 2.5, pitch: 1.1 },
                { id: "firework.large_blast", volume: 1.5, pitch: 0.9 },
                { id: "tile.piston.out", volume: 0.7, pitch: 1.6, delayTicks: 8 },
                { id: "tile.piston.in", volume: 0.7, pitch: 1.8, delayTicks: 12 }
            ],
            reload: [
                { id: "random.click", volume: 0.6, pitch: 0.9 },
                { id: "random.pop", volume: 0.5, pitch: 1.2, delayTicks: 8 },
                { id: "random.pop", volume: 0.5, pitch: 1.3, delayTicks: 15 },
                { id: "random.pop", volume: 0.5, pitch: 1.4, delayTicks: 22 },
                { id: "random.pop", volume: 0.5, pitch: 1.5, delayTicks: 29 },
                { id: "tile.piston.out", volume: 0.7, pitch: 1.6, delayTicks: 37 },
                { id: "tile.piston.in", volume: 0.7, pitch: 1.8, delayTicks: 42 }
            ]
        },
        kind: "hitscan",
        pelletDamage: 2,
        pelletCount: 8,
        spreadDegrees: 8,
        range: 12
    },
    double_barrel_shotgun: {
        id: "double_barrel_shotgun",
        itemId: "bountysys:double_barrel_shotgun",
        displayName: "Double-Barrel Shotgun",
        ammo: "shotgun_ammo",
        magazineSize: 2,
        fireRateTicks: 4,
        reloadTicks: 50,
        sounds: {
            fire: [
                { id: "random.explode", volume: 3.0, pitch: 0.85 },
                { id: "firework.large_blast", volume: 2.0, pitch: 0.75 }
            ],
            reload: [
                { id: "random.lever_click", volume: 0.7, pitch: 0.7 },
                { id: "random.chestopen", volume: 0.5, pitch: 1.5, delayTicks: 5 },
                { id: "random.pop", volume: 0.5, pitch: 1.3, delayTicks: 24 },
                { id: "random.pop", volume: 0.5, pitch: 1.5, delayTicks: 31 },
                { id: "random.chestclosed", volume: 0.7, pitch: 1.7, delayTicks: 44 },
                { id: "random.lever_click", volume: 0.8, pitch: 1.3, delayTicks: 48 }
            ]
        },
        kind: "hitscan",
        pelletDamage: 2.5,
        pelletCount: 10,
        spreadDegrees: 12,
        range: 8
    }
};

/** The custom projectile entity every projectile gun spawns. */
export const BULLET_ENTITY_ID = "bountysys:bullet";

/** Safety-net cleanup if a bullet never hits anything. */
export const BULLET_LIFETIME_TICKS = 60;
