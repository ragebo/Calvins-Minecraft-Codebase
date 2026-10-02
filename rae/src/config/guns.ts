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
    | "double_barrel_shotgun"
    | "gatling_gun";

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

export interface AimConfig {
    /** The field of view while aiming, in degrees. The normal view is about 70, so smaller zooms in further.
     *  Mutable: core/configoverrides.ts edits this in place for a live-tuned gun. */
    fov: number;
    /** Also draw the scope overlay (a black screen with a clear lens and a crosshair). Mutable, see fov. */
    scope?: boolean;
    /** Slowness amplifier while aimed (0 is 15% slower, 1 is 30%, 2 is 45%, 3 is 60%). Omit for no slowdown.
     *  Mutable, see fov. */
    slowness?: number;
}

/**
 * Set only on a gun that is manned, not held: no swing on this gun's itemId ever fires it (nothing ever
 * holds it — it is placed, then ridden). Right-clicking it (itemUse, not while riding) places it; a swing
 * while riding it toggles a self-sustaining fire loop on or off, rather than firing once per swing.
 *
 * There's no engine signal for "the trigger is still held down" — only discrete swings, and confirmed in a
 * real playtest that holding the button doesn't even repeat those — so "hold to fire" from the original
 * request is approximated as a toggle instead, the same fix already used for aiming and for the same root
 * reason. Once started, the loop fires on its own timer, accelerating from fireRateTicksStart towards
 * fireRateTicksSpunUp over spinUpShots consecutive shots, and keeps going — no more clicking needed — until
 * a second swing toggles it off, the magazine runs dry, the rider dismounts, or the gun is removed.
 */
export interface AutomaticConfig {
    readonly mountEntityId: string;
    /** Mutable: core/configoverrides.ts edits these four in place for a live-tuned Gatling gun. */
    fireRateTicksStart: number;
    fireRateTicksSpunUp: number;
    spinUpShots: number;
    /** How far away (blocks) a block can be and still be placed on. */
    placementRange: number;
    /** The model's barrels turn this many degrees per tick while firing, ramping the same way the fire rate
     *  does (see fireRateTicksStart/SpunUp) — cold at the first shot, fastest once fully spun up. Mutable,
     *  see fireRateTicksStart above. */
    spinDegreesStart: number;
    spinDegreesSpunUp: number;
}

export interface GunSounds {
    /** Played as the shot goes off. Delayed cues can add a pump or bolt cycle. */
    readonly fire: readonly SoundCue[];
    /** Played when a manual-priming gun's between-shots cycle click lands (see `primeTicks`). */
    readonly prime?: readonly SoundCue[];
    /** Played across a reload, so keep every delay under that gun's reloadTicks. */
    readonly reload: readonly SoundCue[];
}

interface BaseGunConfig {
    readonly id: GunId;
    readonly itemId: string;
    readonly displayName: string;
    readonly ammo: AmmoId;
    /** Mutable: core/configoverrides.ts edits magazineSize/fireRateTicks/primeTicks/reloadTicks in place
     *  for a live-tuned gun. */
    magazineSize: number;
    /** Ticks that must pass between shots. */
    fireRateTicks: number;
    /**
     * Omit for a gun that fires on every trigger pull, same as always. Set it and firing becomes
     * two clicks: the shot, then one more click (no earlier than this many ticks later) to cycle
     * the action (a revolver's hammer, a lever gun's lever) before the next shot can fire — a
     * click while still cycling does nothing, same silent ignore as a too-soon fire. Since a real
     * player's own click-to-click time dwarfs a few ticks either way, needing two clicks instead
     * of one is what actually slows the gun down in practice, not this number itself.
     */
    primeTicks?: number;
    /** Ticks a reload takes once started (Q, or clicking an empty gun). */
    reloadTicks: number;
    /** What holding right-click does. Unreachable on a mounted gun (see `automatic`): nothing is ever held to fire itemUse on. */
    readonly aim: AimConfig;
    /** Set only for a gun that is manned rather than carried — see AutomaticConfig. */
    readonly automatic?: AutomaticConfig;
    /** Smoke (and flame) at the muzzle. Hitscan guns add a trail and impact puffs on top (GunEffects). */
    readonly effects: MuzzleEffects;
    readonly sounds: GunSounds;
}

export interface ProjectileGunConfig extends BaseGunConfig {
    readonly kind: "projectile";
    /** Mutable: core/configoverrides.ts edits these in place for a live-tuned gun. */
    damage: number;
    /** Blocks per tick. */
    projectileSpeed: number;
}

/** What every gun shows at the muzzle when it fires. */
export interface MuzzleEffects {
    /** Spawned at the muzzle as the shot goes off (a flash, a puff of smoke). */
    readonly muzzle: readonly string[];
    /** How far in front of the eyes the muzzle is, in blocks. */
    readonly muzzleDistance: number;
    /** Experimental: also make the muzzle a real light source for a moment, not just a particle. */
    readonly muzzleLight?: MuzzleLight;
}

/**
 * Briefly turns the muzzle into a real light source: a temporary, invisible `minecraft:light_block_<level>`
 * placed at the shot and cleared back to air after `ticks` (systems/guns.ts's flashMuzzleLight). Particles
 * don't cast light in this engine, and there is no dynamic-light scripting call — a light-emitting BLOCK is
 * the only way to actually light the surroundings, and placing or clearing one costs a real lighting
 * recalculation. That cost is why this is opt-in per gun rather than added to every one: only revolver and
 * semi_rifle set it, since both have an enforced slow cadence (primeTicks roughly doubles their real
 * interval between shots) — a gun that can re-fire every couple of ticks with no human bottleneck (the
 * Gatling gun) would churn that cost far too often. It's also never let overwrite a real block, only ever
 * placed into air and only ever cleared back to air by the flash that placed it.
 */
export interface MuzzleLight {
    /** 0-15, matching light_block_0..15 (15 is brightest). */
    readonly level: number;
    /** How long the light stays before flashMuzzleLight clears it. */
    readonly ticks: number;
}

/**
 * What a hitscan shot looks like. A shotgun has no bullet to watch, so it draws one: a flash and smoke at the muzzle, a
 * trail of particles along each pellet's path, and a puff where a pellet ends. Every id is a vanilla particle; a wrong one
 * is reported once and the shot still fires.
 *
 * Use only particles that work when spawned bare. Some need a value from whatever spawns them: basic_crit_particle wants a
 * variable.direction, and the first playtest logged 16,836 Molang errors for it. basic_flame_particle and
 * basic_smoke_particle logged none.
 */
export interface GunEffects extends MuzzleEffects {
    /** One of these every trailSpacing blocks along each pellet's path, so the spread can be seen. */
    readonly trail: string;
    readonly trailSpacing: number;
    /** Where a pellet ends on a block or a target (not where it just runs out of range). */
    readonly impact: string;
}

export interface HitscanGunConfig extends BaseGunConfig {
    readonly kind: "hitscan";
    /** Damage dealt by EACH pellet that connects. Mutable: core/configoverrides.ts edits these four in
     *  place for a live-tuned gun. */
    pelletDamage: number;
    pelletCount: number;
    /** Half-angle of the spread cone, in degrees. */
    spreadDegrees: number;
    range: number;
    readonly effects: GunEffects;
}

export type GunConfig = ProjectileGunConfig | HitscanGunConfig;

/** The placed, rideable Gatling gun. Same identifier for the carryable item and the placed entity — items and entities are separate registries, so this doesn't collide. */
export const GATLING_GUN_ENTITY_ID = "bountysys:gatling_gun";

/**
 * A client-synced entity property (range [-90, 90], degrees) the placed Gatling gun declares: a
 * resource-pack animation (BountySys_RP/animations/gatling_gun.animation.json) reads it via molang to pitch
 * its "turret" bone (the receiver and the crank — "barrels" is a further child bone, see
 * GATLING_BARREL_SPIN_PROPERTY, and pitches along with it for free) to match whoever is riding it, the same
 * technique systems/tumbleweed.ts already uses for its own roll. Yaw needs no such property — the whole
 * entity's own setRotation already turns every bone together, which reads fine for a swiveling mount.
 */
export const GATLING_AIM_PITCH_PROPERTY = "bountysys:aim_pitch";

/**
 * A client-synced entity property (range [0, 360), degrees) the "barrels" bone's own rotation reads via the
 * same animation file, around its own length (so the cluster spins like a real Gatling gun's) rather than
 * the pitch axis "turret" uses. Driven only while the gun is actively firing (config/guns.ts's
 * spinDegreesStart/SpunUp); left wherever it stopped the rest of the time, same as a real one would coast to
 * a stop wherever it happened to be facing.
 */
export const GATLING_BARREL_SPIN_PROPERTY = "bountysys:barrel_spin";

export const GUNS: Record<GunId, GunConfig> = {
    revolver: {
        id: "revolver",
        itemId: "bountysys:revolver",
        displayName: "Revolver",
        ammo: "handgun_ammo",
        magazineSize: 6,
        fireRateTicks: 8,
        primeTicks: 8,
        reloadTicks: 40,
        aim: { fov: 60 },
        sounds: {
            fire: [
                { id: "firework.blast", volume: 2.0, pitch: 0.9 },
                { id: "random.explode", volume: 0.6, pitch: 1.7 }
            ],
            prime: [
                { id: "random.lever_click", volume: 0.7, pitch: 1.4 }
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
        projectileSpeed: 5,
        effects: {
            muzzle: ["minecraft:basic_flame_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"],
            muzzleDistance: 1,
            muzzleLight: { level: 15, ticks: 3 }
        }
    },
    pistol: {
        id: "pistol",
        itemId: "bountysys:pistol",
        displayName: "Pistol",
        ammo: "handgun_ammo",
        magazineSize: 8,
        fireRateTicks: 10,
        reloadTicks: 30,
        aim: { fov: 60 },
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
        projectileSpeed: 5,
        effects: {
            muzzle: ["minecraft:basic_flame_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"],
            muzzleDistance: 1
        }
    },
    bolt_rifle: {
        id: "bolt_rifle",
        itemId: "bountysys:bolt_rifle",
        displayName: "Bolt-Action Rifle",
        ammo: "rifle_ammo",
        magazineSize: 1,
        fireRateTicks: 10,
        reloadTicks: 70,
        aim: { fov: 30, scope: true, slowness: 2 },
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
        projectileSpeed: 25,
        effects: {
            muzzle: ["minecraft:basic_flame_particle", "minecraft:basic_flame_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"],
            muzzleDistance: 1.2
        }
    },
    semi_rifle: {
        id: "semi_rifle",
        itemId: "bountysys:semi_rifle",
        displayName: "Repeater",
        ammo: "rifle_ammo",
        magazineSize: 11,
        fireRateTicks: 15,
        primeTicks: 15,
        reloadTicks: 70,
        aim: { fov: 52, slowness: 1 },
        sounds: {
            fire: [
                { id: "firework.large_blast", volume: 2.2, pitch: 1.25 }
            ],
            prime: [
                { id: "tile.piston.out", volume: 0.5, pitch: 1.9 },
                { id: "tile.piston.in", volume: 0.6, pitch: 2.1, delayTicks: 3 }
            ],
            reload: [
                { id: "random.click", volume: 0.6, pitch: 0.8 },
                { id: "armor.equip_iron", volume: 0.6, pitch: 1.0, delayTicks: 11 },
                { id: "tile.piston.out", volume: 0.5, pitch: 1.8, delayTicks: 24 },
                { id: "tile.piston.in", volume: 0.6, pitch: 2.0, delayTicks: 30 }
            ]
        },
        kind: "projectile",
        damage: 6,
        projectileSpeed: 5,
        effects: {
            muzzle: ["minecraft:basic_flame_particle", "minecraft:basic_flame_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"],
            muzzleDistance: 1.2,
            muzzleLight: { level: 15, ticks: 3 }
        }
    },
    pump_shotgun: {
        id: "pump_shotgun",
        itemId: "bountysys:pump_shotgun",
        displayName: "Pump Shotgun",
        ammo: "shotgun_ammo",
        magazineSize: 5,
        fireRateTicks: 15,
        reloadTicks: 45,
        aim: { fov: 62, slowness: 1 },
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
        range: 12,
        effects: {
            muzzle: [
                "minecraft:basic_flame_particle", "minecraft:basic_flame_particle",
                "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"
            ],
            muzzleDistance: 1.2,
            trail: "minecraft:basic_flame_particle",
            trailSpacing: 2,
            impact: "minecraft:basic_smoke_particle"
        }
    },
    gatling_gun: {
        id: "gatling_gun",
        itemId: GATLING_GUN_ENTITY_ID,
        displayName: "Gatling Gun",
        ammo: "rifle_ammo",
        magazineSize: 90,
        fireRateTicks: 6,
        reloadTicks: 100,
        aim: { fov: 65 },
        automatic: {
            mountEntityId: GATLING_GUN_ENTITY_ID,
            fireRateTicksStart: 8,
            fireRateTicksSpunUp: 2,
            spinUpShots: 12,
            placementRange: 6,
            spinDegreesStart: 12,
            spinDegreesSpunUp: 40
        },
        sounds: {
            fire: [
                { id: "firework.large_blast", volume: 1.8, pitch: 0.8 }
            ],
            reload: [
                { id: "random.chestopen", volume: 0.6, pitch: 0.8 },
                { id: "tile.piston.out", volume: 0.6, pitch: 1.1, delayTicks: 10 },
                { id: "random.pop", volume: 0.5, pitch: 1.1, delayTicks: 24 },
                { id: "random.pop", volume: 0.5, pitch: 1.2, delayTicks: 38 },
                { id: "random.pop", volume: 0.5, pitch: 1.3, delayTicks: 52 },
                { id: "random.pop", volume: 0.5, pitch: 1.4, delayTicks: 66 },
                { id: "tile.piston.in", volume: 0.6, pitch: 1.1, delayTicks: 84 },
                { id: "random.chestclosed", volume: 0.7, pitch: 1.2, delayTicks: 96 }
            ]
        },
        kind: "projectile",
        damage: 3,
        projectileSpeed: 5,
        effects: {
            muzzle: [
                "minecraft:basic_flame_particle", "minecraft:basic_flame_particle",
                "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle",
                "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"
            ],
            muzzleDistance: 1.4
        }
    },
    double_barrel_shotgun: {
        id: "double_barrel_shotgun",
        itemId: "bountysys:double_barrel_shotgun",
        displayName: "Double-Barrel Shotgun",
        ammo: "shotgun_ammo",
        magazineSize: 2,
        fireRateTicks: 4,
        reloadTicks: 50,
        aim: { fov: 62, slowness: 1 },
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
        range: 8,
        effects: {
            muzzle: [
                "minecraft:basic_flame_particle", "minecraft:basic_flame_particle",
                "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle", "minecraft:basic_smoke_particle"
            ],
            muzzleDistance: 1.2,
            trail: "minecraft:basic_flame_particle",
            trailSpacing: 2,
            impact: "minecraft:basic_smoke_particle"
        }
    }
};

/** The custom projectile entity every projectile gun spawns. */
export const BULLET_ENTITY_ID = "bountysys:bullet";

/** Safety-net cleanup if a bullet never hits anything. */
export const BULLET_LIFETIME_TICKS = 60;

/**
 * Vanilla's own post-hit invulnerability: a target that was just hurt ignores a further hit that
 * isn't bigger than the last one, for about this many ticks. Measured in the real game with
 * `rae:probe_damage` (2026-09-19): 12 ticks apart, both hits landed; 4 ticks apart at equal
 * damage, the second was lost. `systems/guns.ts`'s `dealGunDamage` uses this to sum a rapid
 * follow-up shot into the pending total instead of losing it, the same idea the shotguns' own
 * pellet-summing already uses within one blast.
 */
export const HIT_WINDOW_TICKS = 10;

/**
 * GUN-07's hit/kill feedback: played privately to the shooter alone (systems/guns.ts's signalHit), never
 * positionally — this is confirmation for the shooter, not something bystanders need to hear. Shared across
 * every gun rather than configured per gun, since there is no reason a hit should sound different coming
 * from one weapon versus another (unlike the fire/reload cues, which are the gun's own voice).
 */
export const HIT_MARKER_SOUND: SoundCue = { id: "random.orb", volume: 0.4, pitch: 1.6 };
export const KILL_MARKER_SOUND: SoundCue = { id: "random.levelup", volume: 0.5, pitch: 1.1 };
