import { world, system, type Player, type Entity, type Vector3 } from "@minecraft/server";
import {
    FORT_AREA, FORT_SPAWNS, FORT_REWARD_CHEST,
    RANCH_AREA, RANCH_LOWER_SPAWNS, RANCH_UPPER_SPAWNS, RANCH_SAFE_TRIGGER
} from "../config/world.js";
import { FORT, RANCH, LOOT } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { onDeath, onScriptEvent } from "../core/events.js";
import { onTick } from "../core/tick.js";
import { registerRaid, resetAllRaids, startRaid } from "../core/raid.js";
import { addCoins } from "../core/economy.js";

/**
 * FORT — fits the shared wave engine exactly: fixed waves that
 * advance once cleared, no per-kill coin reward, a loot chest and
 * a full heal at the end.
 */

registerRaid({
    id: "fort",
    area: FORT_AREA,
    spawns: FORT_SPAWNS,
    waves: [
        [
            { type: "minecraft:pillager", base: 1, perPlayer: 1 },
            { type: "minecraft:vindicator", base: 0, perPlayer: 0.5 }
        ],
        [
            { type: "minecraft:pillager", base: 0, perPlayer: 0.5 },
            { type: "minecraft:vindicator", base: 1, perPlayer: 1 },
            { type: "minecraft:stray", base: 0, perPlayer: 0.5 }
        ],
        [
            { type: "minecraft:stray", base: 0, perPlayer: 0.5 },
            { type: "minecraft:vindicator", base: 0, perPlayer: 1 },
            { type: "minecraft:blaze", base: 0, perPlayer: 1 / 3 }
        ]
    ],
    advance: { kind: "onClear" },
    healPlayers: true,
    onComplete(participants) {

        const dimension = world.getDimension("overworld");

        try {
            dimension.runCommand(
                `loot insert ${FORT_REWARD_CHEST.x} ${FORT_REWARD_CHEST.y} ${FORT_REWARD_CHEST.z} loot "${LOOT.fortReward}"`
            );
        } catch (error) {
            world.sendMessage(`§c[FORT ERROR] Could not fill reward chest: ${error}`);
        }

        for (const player of participants) {
            try {

                player.addEffect("health_boost", FORT.healthBoostDurationTicks, {
                    amplifier: FORT.healthBoostAmplifier,
                    showParticles: false
                });

                const health = player.getComponent("minecraft:health");
                if (health) health.resetToMaxValue();

            } catch (error) {
                world.sendMessage(`§c[FORT ERROR] Could not reward ${player.name}: ${error}`);
            }
        }

        world.sendMessage("§6The fort has been cleared! §eThe reward chest is open.");
    },
    onFail() {
        world.sendMessage("§c[DEBUG] Fort raid ended");
    }
});

onScriptEvent("bounty:fort", () => {
    // The shared startRaid() checks for an existing run, an empty
    // area, etc. and messages the player itself.
    startRaid("fort");
});

/**
 * RANCH — does NOT fit the shared engine above. Its wave advance is
 * a dynamic countdown that stretches whenever reinforcements arrive
 * (not a fixed per-wave timer or "wait until clear"), its mobs get
 * no weakness effect, and its regen tick count differs from every
 * other raid. Forcing it through registerRaid would silently change
 * all three. Kept hand-rolled instead, same as V1.
 */

let ranchRaidActive = false;
let ranchRunId: number | null = null;

function insideRanch(loc: Vector3): boolean {
    return (
        loc.x >= RANCH_AREA.min.x && loc.x <= RANCH_AREA.max.x &&
        loc.y >= RANCH_AREA.min.y && loc.y <= RANCH_AREA.max.y &&
        loc.z >= RANCH_AREA.min.z && loc.z <= RANCH_AREA.max.z
    );
}

function getRaidersInRanch(): Player[] {
    return world.getAllPlayers().filter((player) =>
        !player.hasTag("eliminated") &&
        insideRanch(player.location)
    );
}

function spawnRanchDefender(type: string, location: Vector3): Entity {
    const dimension = world.getDimension("overworld");
    const mob = dimension.spawnEntity(type, location);
    mob.addTag("ranch_defender");
    return mob;
}

function spawnFromRanchList(type: string, list: readonly Vector3[]): void {
    const spot = list[Math.floor(Math.random() * list.length)];
    spawnRanchDefender(type, spot);
}

function removeRanchDefenders(): void {
    const dimension = world.getDimension("overworld");
    for (const entity of dimension.getEntities({ tags: ["ranch_defender"] })) {
        entity.kill();
    }
}

function unlockRanchSafe(): void {
    world.sendMessage("§aSafe unlocked!");
    world.getDimension("overworld").runCommand(
        `setblock ${RANCH_SAFE_TRIGGER.x} ${RANCH_SAFE_TRIGGER.y} ${RANCH_SAFE_TRIGGER.z} redstone_block`
    );
}

function spawnRanchWave(wave: number): void {

    const raiders = getRaidersInRanch();
    const count = raiders.length;

    const pillagers = 1 + Math.ceil(count * 1);
    const witches = Math.floor(count * 0.5);
    const golems = Math.floor(count / 2);

    if (wave === 1) {

        for (let i = 0; i < pillagers; i++) spawnFromRanchList("minecraft:pillager", RANCH_LOWER_SPAWNS);
        for (let i = 0; i < witches; i++) spawnFromRanchList("minecraft:witch", RANCH_LOWER_SPAWNS);

    } else if (wave === 2) {

        for (let i = 0; i < Math.ceil(pillagers / 2); i++) spawnFromRanchList("minecraft:pillager", RANCH_LOWER_SPAWNS);
        for (let i = 0; i < Math.floor(pillagers / 2); i++) spawnFromRanchList("minecraft:pillager", RANCH_UPPER_SPAWNS);
        for (let i = 0; i < witches; i++) spawnFromRanchList("minecraft:witch", RANCH_UPPER_SPAWNS);

    } else {

        for (let i = 0; i < golems; i++) spawnFromRanchList("minecraft:iron_golem", RANCH_UPPER_SPAWNS);
        for (let i = 0; i < pillagers; i++) spawnFromRanchList("minecraft:pillager", RANCH_UPPER_SPAWNS);
    }
}

onTick("ranch:heal", (ctx) => {

    if (!ranchRaidActive) return;

    for (const player of ctx.players) {
        if (player.hasTag("outlaw") && insideRanch(player.location)) {
            player.runCommand(`effect @s regeneration ${RANCH.regenTicks} 0 true`);
        }
    }
});

/**
 * Note: like V1, this sets ranchRaidActive = true BEFORE checking
 * whether anyone is actually inside — a failed start (no raiders)
 * still leaves the flag on, which is why the heal loop above guards
 * on the flag rather than assuming an active loop exists. Preserved
 * as-is; not a behavior this port is meant to fix.
 */
export function startRanchRaid(): void {

    const raiders = getRaidersInRanch();

    ranchRaidActive = true;

    if (raiders.length === 0) {
        world.sendMessage("§cNo outlaws are inside the ranch.");
        return;
    }

    let originalTime = RANCH.startTimeBase + raiders.length * RANCH.startTimePerRaider;
    let timer = originalTime;
    let wave = 1;

    world.sendMessage(`§4Raid Started! ${raiders.length} outlaw(s).`);

    spawnRanchWave(1);

    ranchRunId = system.runInterval(() => {

        const currentRaiders = getRaidersInRanch();

        if (currentRaiders.length === 0) {
            world.sendMessage("§cRaid ended early.");
            removeRanchDefenders();
            ranchRaidActive = false;
            system.clearRun(ranchRunId!);
            return;
        }

        const desiredTime = RANCH.reinforceTimeBase + currentRaiders.length * RANCH.reinforceTimePerRaider;

        if (desiredTime > originalTime) {
            timer += desiredTime - originalTime;
            originalTime = desiredTime;
        }

        timer--;

        if (wave === 1 && timer <= Math.floor(originalTime * RANCH.wave2Threshold)) {
            wave = 2;
            spawnRanchWave(2);
        }

        if (wave === 2 && timer <= Math.floor(originalTime * RANCH.wave3Threshold)) {
            wave = 3;
            spawnRanchWave(3);
        }

        if (timer <= 0) {
            unlockRanchSafe();
            removeRanchDefenders();
            ranchRaidActive = false;
            system.clearRun(ranchRunId!);
        }

    }, 20);
}

onScriptEvent("bounty:ranch", () => {
    world.sendMessage("§aRanch raid started!");
    startRanchRaid();
});

onDeath("ranch:kill-reward", 200, (ctx) => {

    if (!ctx.dead.hasTag("ranch_defender")) return;
    if (!ctx.killer) return;

    let reward = 0;

    switch (ctx.dead.typeId) {
        case "minecraft:pillager":
            reward = Math.floor(Math.random() * (RANCH.pillagerRewardMax - RANCH.pillagerRewardMin + 1)) + RANCH.pillagerRewardMin;
            break;
        case "minecraft:witch":
            reward = Math.floor(Math.random() * (RANCH.witchRewardMax - RANCH.witchRewardMin + 1)) + RANCH.witchRewardMin;
            break;
        case "minecraft:iron_golem":
            reward = Math.floor(Math.random() * (RANCH.golemRewardMax - RANCH.golemRewardMin + 1)) + RANCH.golemRewardMin;
            break;
    }

    addCoins(ctx.killer, reward);
    ctx.killer.sendMessage(`§a+$${reward}`);
});

registerSystem({
    name: "raids",
    reset() {

        resetAllRaids();

        ranchRaidActive = false;

        if (ranchRunId !== null) {
            system.clearRun(ranchRunId);
            ranchRunId = null;
        }

        removeRanchDefenders();
    }
});
