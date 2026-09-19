import { world, system, BlockVolume, BlockPermutation, type Vector3 } from "@minecraft/server";
import { TRAIN_START, TRAIN_END, TRAIN_SIZE, TRAIN_VAULT_CHEST, BRIDGE_AREA } from "../config/world.js";
import { TRAIN, LOOT } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";
import { onDeath } from "../core/events.js";
import { onTick } from "../core/tick.js";
import { addCoins } from "../core/economy.js";
import { registerEvent, finishEvent } from "../core/director.js";

/**
 * Name of the structure saved with /structure save. Not a tunable
 * number, so it stays local rather than in config/balance.ts.
 */
const TRAIN_STRUCTURE = "mystructure:train";
const BACKUP_PREFIX = "mystructure:track_backup_";
const BRIDGE_BACKUP = "mystructure:bridge_backup";

/**
 * Builds the list of waypoints from start to end, stepSize blocks
 * apart. Works along any direction, not just a single axis.
 */
function buildTrainPath(start: Vector3, end: Vector3, stepSize: number): Vector3[] {

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;

    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.round(distance / stepSize));

    const path: Vector3[] = [];

    for (let i = 0; i <= steps; i++) {

        const t = i / steps;

        path.push({
            x: Math.round(start.x + dx * t),
            y: Math.round(start.y + dy * t),
            z: Math.round(start.z + dz * t)
        });
    }

    return path;
}

const TRAIN_PATH = buildTrainPath(TRAIN_START, TRAIN_END, TRAIN.stepSize);

let trainActive = false;
let currentStop = 0;
/** Stops the movement loop started by startTrainRobbery. Null when none has been started. */
let stopTrainLoop: (() => void) | null = null;

//====================================
// MOVE THE TRAIN
//====================================

function placeTrainAt(point: Vector3): void {

    const dimension = world.getDimension("overworld");

    try {
        dimension.runCommand(
            `structure load "${TRAIN_STRUCTURE}" ${point.x} ${point.y} ${point.z}`
        );
    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not load structure "${TRAIN_STRUCTURE}": ${error}`);
        world.sendMessage(`§c[TRAIN ERROR] Check that you saved it with /structure save ${TRAIN_STRUCTURE}`);
    }
}

function backupTrackAt(index: number, point: Vector3): void {

    const dimension = world.getDimension("overworld");

    try {
        // Saves whatever is currently at this stop (rails, ground,
        // etc.) so it can be put back later.
        dimension.runCommand(
            `structure save "${BACKUP_PREFIX}${index}" ${point.x} ${point.y} ${point.z} ` +
            `${point.x + TRAIN_SIZE.x - 1} ${point.y + TRAIN_SIZE.y - 1} ${point.z + TRAIN_SIZE.z - 1} memory`
        );
    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not back up track at stop ${index}: ${error}`);
    }
}

function restoreTrackAt(index: number, point: Vector3 | undefined): void {

    if (!point) return;

    const dimension = world.getDimension("overworld");

    try {
        dimension.runCommand(`structure load "${BACKUP_PREFIX}${index}" ${point.x} ${point.y} ${point.z}`);
    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not restore track at stop ${index}: ${error}`);
    }
}

//====================================
// VAULT CHEST
//====================================

function fillVaultChest(): void {

    const dimension = world.getDimension("overworld");

    try {

        const block = dimension.getBlock(TRAIN_VAULT_CHEST);

        if (!block) {
            world.sendMessage("§c[TRAIN ERROR] No block found at the vault chest location.");
            return;
        }

        const inventory = block.getComponent("minecraft:inventory");

        if (!inventory || !inventory.container) {
            world.sendMessage("§c[TRAIN ERROR] VAULT_CHEST does not point at a container block.");
            return;
        }

        dimension.runCommand(
            `loot insert ${TRAIN_VAULT_CHEST.x} ${TRAIN_VAULT_CHEST.y} ${TRAIN_VAULT_CHEST.z} loot "${LOOT.trainVault}"`
        );

        world.sendMessage("§6The vault chest is full of gold!");

    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not fill the vault chest: ${error}`);
    }
}

//====================================
// GUARDS
//====================================

function spawnGuard(point: Vector3, offset = 0) {

    const dimension = world.getDimension("overworld");

    const mob = dimension.spawnEntity("minecraft:pillager", {
        x: point.x + 12,
        y: point.y + 3,
        z: point.z + offset
    });

    mob.addTag("train_guard");

    return mob;
}

function removeGuards(): void {
    const dimension = world.getDimension("overworld");
    for (const entity of dimension.getEntities({ tags: ["train_guard"] })) {
        entity.kill();
    }
}

onDeath("train:kill-reward", 200, (ctx) => {

    // Same InvalidEntityError risk as the generic raid engine's kill
    // reward handler — the dead entity's handle can already be gone
    // by the time this runs.
    if (!ctx.dead.isValid) return;
    if (!ctx.dead.hasTag("train_guard")) return;
    if (!ctx.killer) return;

    const reward = Math.floor(Math.random() * (TRAIN.guardRewardMax - TRAIN.guardRewardMin + 1)) + TRAIN.guardRewardMin;

    addCoins(ctx.killer, reward);
    ctx.killer.sendMessage(`§a+${reward} coins`);
});

//====================================
// BRIDGE
//====================================

function backupBridge(): void {

    const dimension = world.getDimension("overworld");

    try {
        dimension.runCommand(
            `structure save "${BRIDGE_BACKUP}" ` +
            `${BRIDGE_AREA.min.x} ${BRIDGE_AREA.min.y} ${BRIDGE_AREA.min.z} ` +
            `${BRIDGE_AREA.max.x} ${BRIDGE_AREA.max.y} ${BRIDGE_AREA.max.z} memory`
        );
    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not back up the bridge: ${error}`);
    }
}

function explodeBridge(): void {

    const dimension = world.getDimension("overworld");

    try {

        dimension.createExplosion(
            {
                x: (BRIDGE_AREA.min.x + BRIDGE_AREA.max.x) / 2,
                y: (BRIDGE_AREA.min.y + BRIDGE_AREA.max.y) / 2,
                z: (BRIDGE_AREA.min.z + BRIDGE_AREA.max.z) / 2
            },
            4,
            { breaksBlocks: false }
        );

        const bridgeVolume = new BlockVolume(BRIDGE_AREA.min, BRIDGE_AREA.max);

        dimension.fillBlocks(bridgeVolume, BlockPermutation.resolve("minecraft:air"));

        world.sendMessage("§4The bridge has been destroyed!");

    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not destroy the bridge: ${error}`);
    }
}

function restoreBridge(): void {

    const dimension = world.getDimension("overworld");

    try {
        dimension.runCommand(`structure load "${BRIDGE_BACKUP}" ${BRIDGE_AREA.min.x} ${BRIDGE_AREA.min.y} ${BRIDGE_AREA.min.z}`);
        world.sendMessage("§7The bridge has been rebuilt.");
    } catch (error) {
        world.sendMessage(`§c[TRAIN ERROR] Could not rebuild the bridge: ${error}`);
    }
}

/** Backs up the bridge, blows it, then rebuilds it after the delay. */
export function destroyBridge(): void {

    backupBridge();
    explodeBridge();

    system.runTimeout(() => {
        restoreBridge();
    }, TRAIN.bridgeRestoreDelayTicks);
}

//====================================
// START THE ROBBERY
//
// Moves every TRAIN.moveIntervalTicks (10), counted from the moment
// the robbery starts. onTick runs a handler every 20 ticks unless it
// asks otherwise, which would silently halve the train's speed, so
// the movement handler states its own cadence.
//====================================

/** The robbery's own line for a second start while the train is still moving. */
const ALREADY_MOVING = "§cA train robbery is already in progress.";

/**
 * Starts a robbery. Not called directly: the director calls it once the
 * slot is free (registerEvent below), so it is reached by requestEvent("train")
 * or the bounty:train script event.
 */
export function startTrainRobbery(): boolean {

    if (trainActive) {
        world.sendMessage(ALREADY_MOVING);
        return false;
    }

    trainActive = true;
    currentStop = 0;

    world.sendMessage("§6The train is moving out!");

    destroyBridge();

    backupTrackAt(currentStop, TRAIN_PATH[currentStop]);
    placeTrainAt(TRAIN_PATH[currentStop]);

    stopTrainLoop = onTick("train:move", () => {

        try {

            const previousStop = TRAIN_PATH[currentStop];
            const previousIndex = currentStop;

            currentStop++;

            //-------------------------------------------------
            // Train reached the end of the track
            //-------------------------------------------------

            if (currentStop >= TRAIN_PATH.length) {

                trainActive = false;
                stopTrainLoop?.();

                fillVaultChest();

                world.sendMessage(
                    "§6The vault car is open! §7Get to the chest before someone else does."
                );

                for (let i = 0; i < TRAIN.guardCount; i++) {
                    spawnGuard(previousStop, i);
                }

                system.runTimeout(() => {
                    restoreTrackAt(previousIndex, previousStop);
                    removeGuards();
                    world.sendMessage("§7The train has been cleaned up.");
                    finishEvent("train");
                }, TRAIN.cleanupDelayTicks);

                return;
            }

            //-------------------------------------------------
            // Move to the next point
            //-------------------------------------------------

            // Restore the old spot FIRST. The train is wider than
            // one step, so positions overlap — restoring after
            // placing the new train would wipe out the overlapping
            // part of it.
            restoreTrackAt(previousIndex, previousStop);

            backupTrackAt(currentStop, TRAIN_PATH[currentStop]);
            placeTrainAt(TRAIN_PATH[currentStop]);

        } catch (error) {

            trainActive = false;
            stopTrainLoop?.();
            finishEvent("train");

            world.sendMessage(`§c[TRAIN ERROR] Robbery stopped: ${error}`);
        }

    }, { everyTicks: TRAIN.moveIntervalTicks });

    return true;
}

// Place a command block on your lever with: scriptevent bounty:train
registerEvent({
    id: "train",
    label: "train robbery",
    trigger: "bounty:train",
    // The director asks the slot first, so this is what a second start
    // while the train is still moving gets, as before. Once it has
    // stopped (vault open, guards standing) the director's own
    // "Can't start a train robbery — train is already in progress." applies.
    busyMessage: () => (trainActive ? ALREADY_MOVING : undefined),
    start: startTrainRobbery
});

registerSystem({
    name: "train",
    reset() {

        if (stopTrainLoop !== null) {
            stopTrainLoop();
            stopTrainLoop = null;
        }

        trainActive = false;
        currentStop = 0;

        removeGuards();
    }
});
