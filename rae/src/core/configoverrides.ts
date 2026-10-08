import type { Player, Vector3 } from "@minecraft/server";
import { AIM, BOAT, COMPASS, ECONOMY, FORT, HARMING, HORSE, JAILBREAK, RAIDS, RANCH, ROBBERY, SHOP, TRAIN, TUMBLEWEED } from "../config/balance.js";
import { GUNS } from "../config/guns.js";
import {
    BOAT_NPC, BOAT_WIN_TELEPORT, BRIDGE_AREA, FORT_AREA, FORT_REWARD_CHEST, FORT_SPAWNS,
    JAIL_SITES, LAW_SPAWNS, OUTLAW_SPAWNS, RANCH_AREA, RANCH_LOWER_SPAWNS, RANCH_SAFE_TRIGGER,
    RANCH_UPPER_SPAWNS, TRAIN_VAULT_CHEST
} from "../config/world.js";
import { warn } from "./log.js";
import { registerPersistable } from "./persist.js";
import { isOperator } from "./players.js";
import { checkCoordinateBounds } from "./preflight.js";

/**
 * Live-editable config: a curated registry of config/guns.ts, config/balance.ts and config/world.ts leaf
 * fields that systems/liveconfig.ts's commands can change while the game is running. A change is applied by
 * mutating the exact object every other system already reads (never replacing it), so it takes effect within
 * a few ticks with no redeploy or relaunch, and is persisted so it survives one.
 *
 * Deliberately NOT a generic "dotted path string -> walk the object graph" resolver: every field below is a
 * hand-written registration closing over its own real getter/setter, so a typo'd id cannot reach into a
 * sounds array or a discriminated union's `kind` field. More lines than a generic walker, but nothing here
 * can corrupt an invariant a config file's own type doesn't already forbid.
 *
 * Deliberately NOT a registerSystem GameSystem: core/registry.ts's resetAllSystems() runs on every "Reset
 * game" click (and /scriptevent rae:reset), and a live-tuned value must survive that the same way
 * core/telemetry.ts's round history does — see its own header comment for the identical reasoning. This
 * file only ever registers a Persistable, never a GameSystem.
 *
 * Excluded on purpose: config/world.ts's TRAIN_START/TRAIN_END and config/balance.ts's TRAIN.stepSize feed
 * systems/train.ts's TRAIN_PATH, built once at module load — every real use reads that frozen array, never
 * these constants again, so editing them here would silently do nothing until a reload. Same for
 * TRANSIT.cruiseSpeed/acceleration/braking/crawlSpeed, which only feed systems/transit.ts's equally frozen
 * PROFILE. Shipping a field that silently contradicts this whole feature's premise ("no reload needed") would
 * be worse than not offering it.
 */

export type FieldKind = "integer" | "float" | "boolean" | "vector3";

interface FieldBase {
    readonly id: string;
    readonly label: string;
    readonly category: string;
}

export interface NumericField extends FieldBase {
    readonly kind: "integer" | "float";
    get(): number;
    set(value: number): void;
    readonly min?: number;
    readonly max?: number;
}

export interface BooleanField extends FieldBase {
    readonly kind: "boolean";
    get(): boolean;
    set(value: boolean): void;
}

export interface Vector3Field extends FieldBase {
    readonly kind: "vector3";
    get(): Vector3;
    set(value: Vector3): void;
}

export type EditableField = NumericField | BooleanField | Vector3Field;

// ---------------------------------------------------------------------------
// THE REGISTRY
// ---------------------------------------------------------------------------

const fields = new Map<string, EditableField>();

/** Captured once per field, the moment it registers — before any persisted override has been replayed — so
 *  resetOverride() always has the real compiled-in value to go back to, regardless of override history. */
const defaults = new Map<string, number | boolean | Vector3>();

function register(field: EditableField): void {

    if (fields.has(field.id)) {
        throw new Error(`Editable config field "${field.id}" is already registered`);
    }

    fields.set(field.id, field);
    defaults.set(field.id, field.kind === "vector3" ? { ...field.get() } : field.get());
}

function numeric(
    id: string, label: string, category: string, kind: "integer" | "float",
    get: () => number, set: (value: number) => void, bounds: { min?: number; max?: number } = {}
): void {
    register({ id, label, category, kind, get, set, min: bounds.min, max: bounds.max });
}

function boolean(id: string, label: string, category: string, get: () => boolean, set: (value: boolean) => void): void {
    register({ id, label, category, kind: "boolean", get, set });
}

/**
 * `target` is mutated in place (`.x`/`.y`/`.z` assigned individually), never replaced — so every existing
 * reference to it (an array element another list also points at, e.g. config/world.ts's TELEPORT_TARGETS
 * sharing the same spawn objects) sees the edit too. Never pass a copy here.
 */
function vector3(id: string, label: string, category: string, target: Vector3): void {
    register({
        id, label, category, kind: "vector3",
        get: () => ({ x: target.x, y: target.y, z: target.z }),
        set: (value) => { target.x = value.x; target.y = value.y; target.z = value.z; }
    });
}

export function getField(id: string): EditableField | undefined {
    return fields.get(id);
}

export function listFields(category?: string): readonly EditableField[] {
    const all = [...fields.values()].sort((a, b) => a.id.localeCompare(b.id));
    return category === undefined ? all : all.filter((field) => field.category === category);
}

export function listCategories(): string[] {
    return [...new Set([...fields.values()].map((field) => field.category))].sort();
}

// ---------------------------------------------------------------------------
// VALIDATION AND APPLY — the one place anything actually writes
// ---------------------------------------------------------------------------

export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function applyValue(field: EditableField, value: unknown): ApplyResult {

    if (field.kind === "vector3") {

        const candidate = value as Partial<Vector3> | null | undefined;

        if (typeof candidate !== "object" || candidate === null
            || typeof candidate.x !== "number" || typeof candidate.y !== "number" || typeof candidate.z !== "number") {
            return { ok: false, reason: "expected a position (x, y, z)" };
        }

        const problems = checkCoordinateBounds([{ label: field.label, at: candidate as Vector3 }]);
        if (problems.length > 0) return { ok: false, reason: problems.join("; ") };

        field.set(candidate as Vector3);
        return { ok: true };
    }

    if (field.kind === "boolean") {
        if (typeof value !== "boolean") return { ok: false, reason: "expected true or false" };
        field.set(value);
        return { ok: true };
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "expected a finite number" };
    }

    if (field.kind === "integer" && !Number.isInteger(value)) {
        return { ok: false, reason: "expected a whole number" };
    }

    if (field.min !== undefined && value < field.min) return { ok: false, reason: `must be at least ${field.min}` };
    if (field.max !== undefined && value > field.max) return { ok: false, reason: `must be at most ${field.max}` };

    field.set(value);
    return { ok: true };
}

/** The active overrides, by field id — what differs from the compiled-in default right now. Also exactly
 *  what gets persisted: see the Persistable below. */
const overrides = new Map<string, number | boolean | Vector3>();

/**
 * Applies `value` to `id` on behalf of `player`. Refuses a non-operator (belt-and-suspenders: every real
 * entry point in systems/liveconfig.ts also declares its own command operator-only at the engine level, via
 * CommandPermissionLevel.GameDirectors — this is the second, defence-in-depth check).
 */
export function setOverride(player: Player, id: string, value: unknown): ApplyResult {

    if (!isOperator(player)) return { ok: false, reason: "operators only" };

    const field = fields.get(id);
    if (!field) return { ok: false, reason: `unknown config field "${id}"` };

    const result = applyValue(field, value);
    if (!result.ok) return result;

    overrides.set(id, field.kind === "vector3" ? { ...field.get() } : field.get());
    return { ok: true };
}

/** Reverts `id` to the value it had at registration (the compiled-in default), on behalf of `player`. */
export function resetOverride(player: Player, id: string): ApplyResult {

    if (!isOperator(player)) return { ok: false, reason: "operators only" };

    const field = fields.get(id);
    if (!field) return { ok: false, reason: `unknown config field "${id}"` };

    const fallback = defaults.get(id);
    if (fallback === undefined) return { ok: false, reason: `"${id}" has no captured default` };

    // Routed through applyValue, same as setOverride, so there is exactly one place that ever writes —
    // even though a captured default is already known-good and could just be assigned directly.
    const result = applyValue(field, fallback);
    if (!result.ok) return result;

    overrides.delete(id);
    return { ok: true };
}

export function hasOverride(id: string): boolean {
    return overrides.has(id);
}

// ---------------------------------------------------------------------------
// GUNS — every numeric/boolean balance field on every gun
// ---------------------------------------------------------------------------

function registerGunFields(): void {

    for (const [gunId, gun] of Object.entries(GUNS)) {

        const label = (suffix: string) => `${gun.displayName}: ${suffix}`;

        numeric(`${gunId}.magazineSize`, label("magazine size"), "Guns", "integer", () => gun.magazineSize, (v) => { gun.magazineSize = v; }, { min: 1 });
        numeric(`${gunId}.fireRateTicks`, label("fire rate (ticks)"), "Guns", "integer", () => gun.fireRateTicks, (v) => { gun.fireRateTicks = v; }, { min: 1 });
        numeric(`${gunId}.reloadTicks`, label("reload ticks"), "Guns", "integer", () => gun.reloadTicks, (v) => { gun.reloadTicks = v; }, { min: 1 });

        if (gun.primeTicks !== undefined) {
            numeric(`${gunId}.primeTicks`, label("prime ticks"), "Guns", "integer", () => gun.primeTicks!, (v) => { gun.primeTicks = v; }, { min: 1 });
        }

        numeric(`${gunId}.aim.fov`, label("aim FOV"), "Guns", "float", () => gun.aim.fov, (v) => { gun.aim.fov = v; }, { min: AIM.fovMin, max: AIM.fovMax });
        boolean(`${gunId}.aim.scope`, label("scope overlay"), "Guns", () => gun.aim.scope === true, (v) => { gun.aim.scope = v; });

        if (gun.aim.slowness !== undefined) {
            numeric(`${gunId}.aim.slowness`, label("aim slowness"), "Guns", "integer", () => gun.aim.slowness!, (v) => { gun.aim.slowness = v; }, { min: 0, max: 3 });
        }

        if (gun.kind === "projectile") {
            numeric(`${gunId}.damage`, label("damage"), "Guns", "float", () => gun.damage, (v) => { gun.damage = v; }, { min: 0 });
            numeric(`${gunId}.projectileSpeed`, label("projectile speed"), "Guns", "float", () => gun.projectileSpeed, (v) => { gun.projectileSpeed = v; }, { min: 0.01 });
        } else {
            numeric(`${gunId}.pelletDamage`, label("pellet damage"), "Guns", "float", () => gun.pelletDamage, (v) => { gun.pelletDamage = v; }, { min: 0 });
            numeric(`${gunId}.pelletCount`, label("pellet count"), "Guns", "integer", () => gun.pelletCount, (v) => { gun.pelletCount = v; }, { min: 1 });
            numeric(`${gunId}.spreadDegrees`, label("spread (degrees)"), "Guns", "float", () => gun.spreadDegrees, (v) => { gun.spreadDegrees = v; }, { min: 0 });
            numeric(`${gunId}.range`, label("range"), "Guns", "float", () => gun.range, (v) => { gun.range = v; }, { min: 1 });
        }

        if (gun.automatic) {
            const auto = gun.automatic;
            numeric(`${gunId}.automatic.fireRateTicksStart`, label("spin-up: start fire rate"), "Guns", "integer", () => auto.fireRateTicksStart, (v) => { auto.fireRateTicksStart = v; }, { min: 1 });
            numeric(`${gunId}.automatic.fireRateTicksSpunUp`, label("spin-up: max fire rate"), "Guns", "integer", () => auto.fireRateTicksSpunUp, (v) => { auto.fireRateTicksSpunUp = v; }, { min: 1 });
            numeric(`${gunId}.automatic.spinUpShots`, label("spin-up: shots to max"), "Guns", "integer", () => auto.spinUpShots, (v) => { auto.spinUpShots = v; }, { min: 1 });
            numeric(`${gunId}.automatic.placementRange`, label("placement range"), "Guns", "float", () => auto.placementRange, (v) => { auto.placementRange = v; }, { min: 1 });
            numeric(`${gunId}.automatic.spinDegreesStart`, label("barrel spin: start (deg/tick)"), "Guns", "float", () => auto.spinDegreesStart, (v) => { auto.spinDegreesStart = v; }, { min: 0 });
            numeric(`${gunId}.automatic.spinDegreesSpunUp`, label("barrel spin: max (deg/tick)"), "Guns", "float", () => auto.spinDegreesSpunUp, (v) => { auto.spinDegreesSpunUp = v; }, { min: 0 });
        }
    }
}

// ---------------------------------------------------------------------------
// WORLD — every named coordinate except TRAIN_START/TRAIN_END (see file header)
// ---------------------------------------------------------------------------

function registerWorldFields(): void {

    LAW_SPAWNS.forEach((spawn, i) => vector3(`world.lawSpawn.${i + 1}`, `Law spawn ${i + 1}`, "World", spawn));
    OUTLAW_SPAWNS.forEach((spawn, i) => vector3(`world.outlawSpawn.${i + 1}`, `Outlaw spawn ${i + 1}`, "World", spawn));

    JAIL_SITES.forEach((site, i) => {
        vector3(`world.jail.${i + 1}`, `Jail ${i + 1}`, "World", site.jail);
        vector3(`world.jailDoorTrigger.${i + 1}`, `Jail ${i + 1} door trigger`, "World", site.doorTrigger);
    });

    vector3("world.ranchArea.min", "Ranch area (min corner)", "World", RANCH_AREA.min);
    vector3("world.ranchArea.max", "Ranch area (max corner)", "World", RANCH_AREA.max);
    RANCH_LOWER_SPAWNS.forEach((spawn, i) => vector3(`world.ranchLowerSpawn.${i + 1}`, `Ranch lower spawn ${i + 1}`, "World", spawn));
    RANCH_UPPER_SPAWNS.forEach((spawn, i) => vector3(`world.ranchUpperSpawn.${i + 1}`, `Ranch upper spawn ${i + 1}`, "World", spawn));
    vector3("world.ranchSafeTrigger", "Ranch safe trigger", "World", RANCH_SAFE_TRIGGER);

    vector3("world.fortArea.min", "Fort area (min corner)", "World", FORT_AREA.min);
    vector3("world.fortArea.max", "Fort area (max corner)", "World", FORT_AREA.max);
    FORT_SPAWNS.forEach((spawn, i) => vector3(`world.fortSpawn.${i + 1}`, `Fort spawn ${i + 1}`, "World", spawn));
    vector3("world.fortRewardChest", "Fort reward chest", "World", FORT_REWARD_CHEST);

    vector3("world.trainVaultChest", "Train vault chest", "World", TRAIN_VAULT_CHEST);

    vector3("world.bridgeArea.min", "Bridge area (min corner)", "World", BRIDGE_AREA.min);
    vector3("world.bridgeArea.max", "Bridge area (max corner)", "World", BRIDGE_AREA.max);

    vector3("world.boatNpc", "Boat escape NPC", "World", BOAT_NPC);
    vector3("world.boatWinTeleport", "Boat win teleport", "World", BOAT_WIN_TELEPORT);
}

// ---------------------------------------------------------------------------
// BALANCE — the gameplay-tuning namespaces only; see file header for what's excluded and why
// ---------------------------------------------------------------------------

function registerBalanceFields(): void {

    numeric("economy.villagerRewardMin", "Economy: villager reward (min)", "Economy", "integer", () => ECONOMY.villagerRewardMin, (v) => { ECONOMY.villagerRewardMin = v; }, { min: 0 });
    numeric("economy.villagerRewardMax", "Economy: villager reward (max)", "Economy", "integer", () => ECONOMY.villagerRewardMax, (v) => { ECONOMY.villagerRewardMax = v; }, { min: 0 });
    numeric("economy.villagerBountyGain", "Economy: bounty gain per villager", "Economy", "integer", () => ECONOMY.villagerBountyGain, (v) => { ECONOMY.villagerBountyGain = v; }, { min: 0 });
    numeric("economy.deathCoinsKept", "Economy: coin fraction kept on death", "Economy", "float", () => ECONOMY.deathCoinsKept, (v) => { ECONOMY.deathCoinsKept = v; }, { min: 0, max: 1 });
    numeric("economy.goldIngotValue", "Economy: coins per gold ingot", "Economy", "integer", () => ECONOMY.goldIngotValue, (v) => { ECONOMY.goldIngotValue = v; }, { min: 0 });
    numeric("economy.boatEscapePerOutlaw", "Economy: boat escape cost per outlaw", "Economy", "integer", () => ECONOMY.boatEscapePerOutlaw, (v) => { ECONOMY.boatEscapePerOutlaw = v; }, { min: 0 });

    numeric("boat.escapeRadius", "Boat: gather radius", "Boat Escape", "float", () => BOAT.escapeRadius, (v) => { BOAT.escapeRadius = v; }, { min: 0 });

    numeric("jailbreak.hitsToUnlock", "Jailbreak: hits to unlock", "Jailbreak", "integer", () => JAILBREAK.hitsToUnlock, (v) => { JAILBREAK.hitsToUnlock = v; }, { min: 1 });
    numeric("jailbreak.sweetSpotTolerance", "Jailbreak: sweet spot tolerance", "Jailbreak", "integer", () => JAILBREAK.sweetSpotTolerance, (v) => { JAILBREAK.sweetSpotTolerance = v; }, { min: 0, max: 100 });
    numeric("jailbreak.lawBlockRadius", "Jailbreak: law block radius", "Jailbreak", "float", () => JAILBREAK.lawBlockRadius, (v) => { JAILBREAK.lawBlockRadius = v; }, { min: 0 });
    numeric("jailbreak.attemptCooldownTicks", "Jailbreak: attempt cooldown (ticks)", "Jailbreak", "integer", () => JAILBREAK.attemptCooldownTicks, (v) => { JAILBREAK.attemptCooldownTicks = v; }, { min: 0 });
    numeric("jailbreak.failTimeoutTicks", "Jailbreak: fail timeout (ticks)", "Jailbreak", "integer", () => JAILBREAK.failTimeoutTicks, (v) => { JAILBREAK.failTimeoutTicks = v; }, { min: 1 });
    numeric("jailbreak.failWeaknessTicks", "Jailbreak: fail weakness (ticks)", "Jailbreak", "integer", () => JAILBREAK.failWeaknessTicks, (v) => { JAILBREAK.failWeaknessTicks = v; }, { min: 0 });
    numeric("jailbreak.failWeaknessAmplifier", "Jailbreak: fail weakness amplifier", "Jailbreak", "integer", () => JAILBREAK.failWeaknessAmplifier, (v) => { JAILBREAK.failWeaknessAmplifier = v; }, { min: 0 });
    numeric("jailbreak.rescueReward", "Jailbreak: rescue reward", "Jailbreak", "integer", () => JAILBREAK.rescueReward, (v) => { JAILBREAK.rescueReward = v; }, { min: 0 });
    numeric("jailbreak.escortSafeDistance", "Jailbreak: escort safe distance", "Jailbreak", "float", () => JAILBREAK.escortSafeDistance, (v) => { JAILBREAK.escortSafeDistance = v; }, { min: 0 });
    numeric("jailbreak.escortEffectTicks", "Jailbreak: escort effect refresh (ticks)", "Jailbreak", "integer", () => JAILBREAK.escortEffectTicks, (v) => { JAILBREAK.escortEffectTicks = v; }, { min: 1 });

    numeric("raids.mobWeaknessAmplifier", "Raids: mob weakness amplifier", "Raids", "integer", () => RAIDS.mobWeaknessAmplifier, (v) => { RAIDS.mobWeaknessAmplifier = v; }, { min: 0 });
    numeric("raids.playerRegenTicks", "Raids: player regen refresh (ticks)", "Raids", "integer", () => RAIDS.playerRegenTicks, (v) => { RAIDS.playerRegenTicks = v; }, { min: 1 });
    numeric("raids.failureListMaxPlayers", "Raids: failure list max players", "Raids", "integer", () => RAIDS.failureListMaxPlayers, (v) => { RAIDS.failureListMaxPlayers = v; }, { min: 1 });

    numeric("fort.healthBoostAmplifier", "Fort: health boost amplifier", "Fort Raid", "integer", () => FORT.healthBoostAmplifier, (v) => { FORT.healthBoostAmplifier = v; }, { min: 0 });
    numeric("fort.healthBoostDurationTicks", "Fort: health boost duration (ticks)", "Fort Raid", "integer", () => FORT.healthBoostDurationTicks, (v) => { FORT.healthBoostDurationTicks = v; }, { min: 1 });

    numeric("ranch.pillagerRewardMin", "Ranch: pillager reward (min)", "Ranch Raid", "integer", () => RANCH.pillagerRewardMin, (v) => { RANCH.pillagerRewardMin = v; }, { min: 0 });
    numeric("ranch.pillagerRewardMax", "Ranch: pillager reward (max)", "Ranch Raid", "integer", () => RANCH.pillagerRewardMax, (v) => { RANCH.pillagerRewardMax = v; }, { min: 0 });
    numeric("ranch.witchRewardMin", "Ranch: witch reward (min)", "Ranch Raid", "integer", () => RANCH.witchRewardMin, (v) => { RANCH.witchRewardMin = v; }, { min: 0 });
    numeric("ranch.witchRewardMax", "Ranch: witch reward (max)", "Ranch Raid", "integer", () => RANCH.witchRewardMax, (v) => { RANCH.witchRewardMax = v; }, { min: 0 });
    numeric("ranch.golemRewardMin", "Ranch: golem reward (min)", "Ranch Raid", "integer", () => RANCH.golemRewardMin, (v) => { RANCH.golemRewardMin = v; }, { min: 0 });
    numeric("ranch.golemRewardMax", "Ranch: golem reward (max)", "Ranch Raid", "integer", () => RANCH.golemRewardMax, (v) => { RANCH.golemRewardMax = v; }, { min: 0 });
    numeric("ranch.regenTicks", "Ranch: outlaw regen refresh (ticks)", "Ranch Raid", "integer", () => RANCH.regenTicks, (v) => { RANCH.regenTicks = v; }, { min: 1 });
    numeric("ranch.startTimeBase", "Ranch: start timer base (s)", "Ranch Raid", "integer", () => RANCH.startTimeBase, (v) => { RANCH.startTimeBase = v; }, { min: 0 });
    numeric("ranch.startTimePerRaider", "Ranch: start timer per raider (s)", "Ranch Raid", "integer", () => RANCH.startTimePerRaider, (v) => { RANCH.startTimePerRaider = v; }, { min: 0 });
    numeric("ranch.reinforceTimeBase", "Ranch: reinforce timer base (s)", "Ranch Raid", "integer", () => RANCH.reinforceTimeBase, (v) => { RANCH.reinforceTimeBase = v; }, { min: 0 });
    numeric("ranch.reinforceTimePerRaider", "Ranch: reinforce timer per raider (s)", "Ranch Raid", "integer", () => RANCH.reinforceTimePerRaider, (v) => { RANCH.reinforceTimePerRaider = v; }, { min: 0 });
    numeric("ranch.wave2Threshold", "Ranch: wave 2 threshold (fraction)", "Ranch Raid", "float", () => RANCH.wave2Threshold, (v) => { RANCH.wave2Threshold = v; }, { min: 0, max: 1 });
    numeric("ranch.wave3Threshold", "Ranch: wave 3 threshold (fraction)", "Ranch Raid", "float", () => RANCH.wave3Threshold, (v) => { RANCH.wave3Threshold = v; }, { min: 0, max: 1 });

    numeric("train.moveIntervalTicks", "Train: move interval (ticks)", "Train", "integer", () => TRAIN.moveIntervalTicks, (v) => { TRAIN.moveIntervalTicks = v; }, { min: 1 });
    numeric("train.guardCount", "Train: guard count", "Train", "integer", () => TRAIN.guardCount, (v) => { TRAIN.guardCount = v; }, { min: 0 });
    numeric("train.cleanupDelayTicks", "Train: cleanup delay (ticks)", "Train", "integer", () => TRAIN.cleanupDelayTicks, (v) => { TRAIN.cleanupDelayTicks = v; }, { min: 0 });
    numeric("train.bridgeRestoreDelayTicks", "Train: bridge restore delay (ticks)", "Train", "integer", () => TRAIN.bridgeRestoreDelayTicks, (v) => { TRAIN.bridgeRestoreDelayTicks = v; }, { min: 0 });
    numeric("train.guardRewardMin", "Train: guard reward (min)", "Train", "integer", () => TRAIN.guardRewardMin, (v) => { TRAIN.guardRewardMin = v; }, { min: 0 });
    numeric("train.guardRewardMax", "Train: guard reward (max)", "Train", "integer", () => TRAIN.guardRewardMax, (v) => { TRAIN.guardRewardMax = v; }, { min: 0 });

    // Gameplay-feel subset of AIM only: scopeTitle/scopeOffTitle/hitMarkerTitle are magic strings
    // cross-checked byte-for-byte against BountySys_RP/ui/*.json by assets.test.mjs, and
    // scopeClearDelayTicks/scopeStayTicks/offhandPollTicks are internal mechanism timing, not gameplay feel.
    numeric("aim.fovEaseSeconds", "Aim: FOV ease time (s)", "Aim", "float", () => AIM.fovEaseSeconds, (v) => { AIM.fovEaseSeconds = v; }, { min: 0 });
    numeric("aim.fovMin", "Aim: minimum FOV", "Aim", "float", () => AIM.fovMin, (v) => { AIM.fovMin = v; }, { min: 30, max: 110 });
    numeric("aim.fovMax", "Aim: maximum FOV", "Aim", "float", () => AIM.fovMax, (v) => { AIM.fovMax = v; }, { min: 30, max: 110 });
    numeric("aim.slowEffectTicks", "Aim: slowdown refresh (ticks)", "Aim", "integer", () => AIM.slowEffectTicks, (v) => { AIM.slowEffectTicks = v; }, { min: 1 });
    numeric("aim.hitMarkerFlashTicks", "Aim: hit marker flash (ticks)", "Aim", "integer", () => AIM.hitMarkerFlashTicks, (v) => { AIM.hitMarkerFlashTicks = v; }, { min: 1 });

    numeric("horse.speed", "Horse: speed", "Horses", "float", () => HORSE.speed, (v) => { HORSE.speed = v; }, { min: 0 });
    numeric("horse.jump", "Horse: jump", "Horses", "float", () => HORSE.jump, (v) => { HORSE.jump = v; }, { min: 0 });

    numeric("tumbleweed.tickInterval", "Tumbleweed: tick interval", "Tumbleweeds", "integer", () => TUMBLEWEED.tickInterval, (v) => { TUMBLEWEED.tickInterval = v; }, { min: 1 });
    numeric("tumbleweed.windHeadingDegrees", "Tumbleweed: wind heading (deg)", "Tumbleweeds", "float", () => TUMBLEWEED.windHeadingDegrees, (v) => { TUMBLEWEED.windHeadingDegrees = v; }, { min: 0, max: 360 });
    numeric("tumbleweed.windStrength", "Tumbleweed: wind strength", "Tumbleweeds", "float", () => TUMBLEWEED.windStrength, (v) => { TUMBLEWEED.windStrength = v; }, { min: 0 });
    numeric("tumbleweed.jitter", "Tumbleweed: sideways jitter", "Tumbleweeds", "float", () => TUMBLEWEED.jitter, (v) => { TUMBLEWEED.jitter = v; }, { min: 0 });
    numeric("tumbleweed.gustChance", "Tumbleweed: gust chance", "Tumbleweeds", "float", () => TUMBLEWEED.gustChance, (v) => { TUMBLEWEED.gustChance = v; }, { min: 0, max: 1 });
    numeric("tumbleweed.gustStrength", "Tumbleweed: gust strength", "Tumbleweeds", "float", () => TUMBLEWEED.gustStrength, (v) => { TUMBLEWEED.gustStrength = v; }, { min: 0 });
    numeric("tumbleweed.hopChance", "Tumbleweed: hop chance", "Tumbleweeds", "float", () => TUMBLEWEED.hopChance, (v) => { TUMBLEWEED.hopChance = v; }, { min: 0, max: 1 });
    numeric("tumbleweed.hopStrength", "Tumbleweed: hop strength", "Tumbleweeds", "float", () => TUMBLEWEED.hopStrength, (v) => { TUMBLEWEED.hopStrength = v; }, { min: 0 });
    numeric("tumbleweed.stuckThreshold", "Tumbleweed: stuck threshold", "Tumbleweeds", "float", () => TUMBLEWEED.stuckThreshold, (v) => { TUMBLEWEED.stuckThreshold = v; }, { min: 0 });
    numeric("tumbleweed.radius", "Tumbleweed: radius", "Tumbleweeds", "float", () => TUMBLEWEED.radius, (v) => { TUMBLEWEED.radius = v; }, { min: 0.01 });
    numeric("tumbleweed.rollScale", "Tumbleweed: roll scale", "Tumbleweeds", "float", () => TUMBLEWEED.rollScale, (v) => { TUMBLEWEED.rollScale = v; }, { min: 0 });
    numeric("tumbleweed.maxActive", "Tumbleweed: max active", "Tumbleweeds", "integer", () => TUMBLEWEED.maxActive, (v) => { TUMBLEWEED.maxActive = v; }, { min: 0 });
    numeric("tumbleweed.spawnDistanceMin", "Tumbleweed: spawn distance (min)", "Tumbleweeds", "float", () => TUMBLEWEED.spawnDistanceMin, (v) => { TUMBLEWEED.spawnDistanceMin = v; }, { min: 0 });
    numeric("tumbleweed.spawnDistanceMax", "Tumbleweed: spawn distance (max)", "Tumbleweeds", "float", () => TUMBLEWEED.spawnDistanceMax, (v) => { TUMBLEWEED.spawnDistanceMax = v; }, { min: 0 });
    numeric("tumbleweed.spawnLift", "Tumbleweed: spawn lift", "Tumbleweeds", "float", () => TUMBLEWEED.spawnLift, (v) => { TUMBLEWEED.spawnLift = v; }, { min: 0 });
    numeric("tumbleweed.maxAgeTicks", "Tumbleweed: max age (ticks)", "Tumbleweeds", "integer", () => TUMBLEWEED.maxAgeTicks, (v) => { TUMBLEWEED.maxAgeTicks = v; }, { min: 1 });
    numeric("tumbleweed.despawnDistance", "Tumbleweed: despawn distance", "Tumbleweeds", "float", () => TUMBLEWEED.despawnDistance, (v) => { TUMBLEWEED.despawnDistance = v; }, { min: 0 });

    numeric("harming.levelOffset", "Harming: level offset", "Harming", "integer", () => HARMING.levelOffset, (v) => { HARMING.levelOffset = v; }, { min: 0 });

    numeric("compass.updateIntervalTicks", "Compass: update interval (ticks)", "Compass", "integer", () => COMPASS.updateIntervalTicks, (v) => { COMPASS.updateIntervalTicks = v; }, { min: 1 });
    numeric("compass.retargetIntervalTicks", "Compass: retarget interval (ticks)", "Compass", "integer", () => COMPASS.retargetIntervalTicks, (v) => { COMPASS.retargetIntervalTicks = v; }, { min: 1 });
    numeric("compass.toggleCooldownTicks", "Compass: toggle cooldown (ticks)", "Compass", "integer", () => COMPASS.toggleCooldownTicks, (v) => { COMPASS.toggleCooldownTicks = v; }, { min: 1 });
    numeric("compass.barCells", "Compass: bearing bar cells", "Compass", "integer", () => COMPASS.barCells, (v) => { COMPASS.barCells = v; }, { min: 1 });
    numeric("compass.barHalfWidthDegrees", "Compass: bearing bar half-width (deg)", "Compass", "float", () => COMPASS.barHalfWidthDegrees, (v) => { COMPASS.barHalfWidthDegrees = v; }, { min: 1, max: 180 });
    numeric("compass.alignToleranceDegrees", "Compass: align tolerance (deg)", "Compass", "float", () => COMPASS.alignToleranceDegrees, (v) => { COMPASS.alignToleranceDegrees = v; }, { min: 0 });

    // The two switches that decide how a click on a shop NPC reaches the shop (systems/shoptalk.ts). Whether the game lets a
    // script cancel its own NPC dialogue is what docs/test-cards/NPC-PROBE.md measures, and these let the answer be applied
    // in the game, with no redeploy.
    boolean("shop.interceptClicks", "Shop: a click on a shop NPC opens the shop at once (off: the NPC's dialogue button does)", "Shops", () => SHOP.interceptClicks, (v) => { SHOP.interceptClicks = v; });
    boolean("shop.useDialogueScene", "Shop: point new shop NPCs at the dialogue scene", "Shops", () => SHOP.useDialogueScene, (v) => { SHOP.useDialogueScene = v; });

    // A punch on a bound item frame cannot be stopped, only undone (core/robberyrun.ts frameHit). What the game does on a punch is
    // what docs/test-cards/ROBBERY-FRAME.md measures; if undoing it ever misbehaves this turns it off with no redeploy.
    boolean("robbery.guardFramePunches", "Robbery: undo a punch on a bound item frame (the popped item is taken back, the frame put back)", "Robbery", () => ROBBERY.guardFramePunches, (v) => { ROBBERY.guardFramePunches = v; });
}

registerGunFields();
registerWorldFields();
registerBalanceFields();

// ---------------------------------------------------------------------------
// PERSISTENCE — a 4th Persistable, alongside round/telemetry/state
// ---------------------------------------------------------------------------

interface SavedOverride {
    readonly id: string;
    readonly value: number | boolean | Vector3;
}

registerPersistable({
    key: "config-overrides",
    version: 1,
    save: (): SavedOverride[] => [...overrides.entries()].map(([id, value]) => ({ id, value })),
    restore(data, savedVersion) {

        if (savedVersion !== 1) return;

        const saved = data as SavedOverride[] | undefined;
        if (!Array.isArray(saved)) return;

        for (const entry of saved) {

            const field = fields.get(entry.id);
            if (!field) {
                warn("configoverrides", `saved override for unknown field "${entry.id}", skipped`);
                continue;
            }

            const result = applyValue(field, entry.value);
            if (!result.ok) {
                warn("configoverrides", `saved override for "${entry.id}" is no longer valid (${result.reason}), skipped`);
                continue;
            }

            overrides.set(entry.id, field.kind === "vector3" ? { ...field.get() } : field.get());
        }
    }
});
