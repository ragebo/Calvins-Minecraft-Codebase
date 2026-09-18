/**
 * EVERY gun and ammo stat lives here. Nothing else defines one.
 * First-pass balance numbers — tune freely, nothing else needs to
 * change when you do.
 */

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
