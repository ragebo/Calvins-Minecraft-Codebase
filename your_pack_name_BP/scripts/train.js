import { world, system, BlockVolume, BlockPermutation, ItemStack } from "@minecraft/server";

//====================================
// TRAIN SETTINGS
//====================================

// Name of the structure you saved with /structure save.
// Build the train once in-game, then save it under this name.
const TRAIN_STRUCTURE = "mystructure:train";

// The real size of your saved train structure — this is about
// the TRAIN itself, not the track. It has nothing to do with
// how long the track is; TRAIN_START/TRAIN_END below handle that
// separately, so the track can be any length.
// x is the length along the direction of travel.
const TRAIN_SIZE = { x: 29, y: 5, z: 3 };

// Used to name the temporary backups of the track at each stop.
// You do not need to create these yourself.
const BACKUP_PREFIX = "mystructure:track_backup_";

// Name for the saved copy of the bridge, so it can be rebuilt later.
const BRIDGE_BACKUP = "mystructure:bridge_backup";

// How long after the bridge blows before it gets rebuilt.
// 1200 ticks = 1 minute. Set this separately from the train
// cleanup delay in case you want the bridge back sooner or later.
const BRIDGE_RESTORE_DELAY_TICKS = 1600;

// Just the two ends of the track. The path between them is
// generated automatically below — no need to list every point.
// This can be any length; it's independent of TRAIN_SIZE above.
const TRAIN_START = { x: -284, y: 94, z: -269 };
const TRAIN_END = { x: -241, y: 94, z: -269 }; // set this to your real track end

// How many blocks the train moves per step. 1 = smoothest,
// matches what you had before but without typing every point.
const STEP_SIZE = 1;

// Builds the list of waypoints from TRAIN_START to TRAIN_END,
// STEP_SIZE blocks apart. Works along any direction, not just
// a single axis.
function buildTrainPath(start, end, stepSize) {

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;

    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.round(distance / stepSize));

    const path = [];

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

const TRAIN_PATH = buildTrainPath(TRAIN_START, TRAIN_END, STEP_SIZE);

// How many ticks between each move. Lower = faster train.
const MOVE_INTERVAL_TICKS = 6;

// Where the vault car's chest is. Set this to the chest block's
// real coordinates.
const VAULT_CHEST = { x: -236, y: 97, z: -268 };

// The chest fills with a random amount of gold in this range.
const GOLD_ITEM = "minecraft:gold_ingot";
const GOLD_MIN = 5;
const GOLD_MAX = 15;

// How many pillagers spawn once the train stops at the vault car.
const GUARD_COUNT = 2;

// How long the train and guards stay after the robbery ends,
// before they get cleaned up. 1200 ticks = 1 minute.
const CLEANUP_DELAY_TICKS = 1200;

// Bridge area to clear. Fill in real coordinates.
const BRIDGE = {
     min: { x: -212, y: 92, z: -270},
    max: { x: -206 , y: 94, z: -265 }
};

let trainActive = false;
let currentStop = 0;

//====================================
// MOVE THE TRAIN
//====================================

function placeTrainAt(point) {

    const dimension = world.getDimension("overworld");

    try {

        dimension.runCommand(
            `structure load "${TRAIN_STRUCTURE}" ${point.x} ${point.y} ${point.z}`
        );

    } catch (error) {

        world.sendMessage(
            `§c[TRAIN ERROR] Could not load structure "${TRAIN_STRUCTURE}": ${error}`
        );
        world.sendMessage(
            `§c[TRAIN ERROR] Check that you saved it with /structure save ${TRAIN_STRUCTURE}`
        );

    }
}

function backupTrackAt(index, point) {

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

function restoreTrackAt(index, point) {

    if (!point) return;

    const dimension = world.getDimension("overworld");

    try {

        dimension.runCommand(
            `structure load "${BACKUP_PREFIX}${index}" ${point.x} ${point.y} ${point.z}`
        );

    } catch (error) {

        world.sendMessage(`§c[TRAIN ERROR] Could not restore track at stop ${index}: ${error}`);

    }
}

//====================================
// VAULT CHEST
//====================================

function fillVaultChest() {

    const dimension = world.getDimension("overworld");

    try {

        const block = dimension.getBlock(VAULT_CHEST);

        if (!block) {
            world.sendMessage("§c[TRAIN ERROR] No block found at the vault chest location.");
            return;
        }

        const inventory = block.getComponent("minecraft:inventory");

        if (!inventory || !inventory.container) {
            world.sendMessage("§c[TRAIN ERROR] VAULT_CHEST does not point at a container block.");
            return;
        }

        const container = inventory.container;

        const amount = Math.floor(Math.random() * (GOLD_MAX - GOLD_MIN + 1)) + GOLD_MIN;

        // Gold ingots cap at a 64 stack, so split larger amounts
        // across as many stacks as needed.
        let remaining = amount;

        while (remaining > 0) {

            const stackSize = Math.min(remaining, 64);

            container.addItem(new ItemStack(GOLD_ITEM, stackSize));

            remaining -= stackSize;
        }

        world.sendMessage("§6The vault chest is full of gold!");

    } catch (error) {

        world.sendMessage(`§c[TRAIN ERROR] Could not fill the vault chest: ${error}`);

    }
}

//====================================
// GUARDS
//====================================

function spawnGuard(point, offset = 0) {

    const dimension = world.getDimension("overworld");

    const mob = dimension.spawnEntity("minecraft:pillager", {
        x: point.x + 12,
        y: point.y + 3,
        z: point.z + offset
    });

    mob.addTag("train_guard");

    return mob;
}

function removeGuards() {

    const dimension = world.getDimension("overworld");

    for (const entity of dimension.getEntities({ tags: ["train_guard"] })) {
        entity.kill();
    }
}

//====================================
// REWARD FOR KILLING A GUARD
//====================================

world.afterEvents.entityDie.subscribe((event) => {

    const dead = event.deadEntity;
    const killer = event.damageSource.damagingEntity;

    if (!dead.hasTag("train_guard")) return;
    if (!killer || killer.typeId !== "minecraft:player") return;

    const coinsObj = world.scoreboard.getObjective("coins");
    if (!coinsObj) return;

    const reward = Math.floor(Math.random() * 10) + 10;

    coinsObj.setScore(
        killer,
        (coinsObj.getScore(killer) ?? 0) + reward
    );

    killer.sendMessage(`§a+${reward} coins`);
});

//====================================
// BRIDGE
//====================================

function backupBridge() {

    const dimension = world.getDimension("overworld");

    try {

        dimension.runCommand(
            `structure save "${BRIDGE_BACKUP}" ` +
            `${BRIDGE.min.x} ${BRIDGE.min.y} ${BRIDGE.min.z} ` +
            `${BRIDGE.max.x} ${BRIDGE.max.y} ${BRIDGE.max.z} memory`
        );

    } catch (error) {

        world.sendMessage(`§c[TRAIN ERROR] Could not back up the bridge: ${error}`);

    }
}

function explodeBridge() {

    const dimension = world.getDimension("overworld");

    try {

        dimension.createExplosion(
            {
                x: (BRIDGE.min.x + BRIDGE.max.x) / 2,
                y: (BRIDGE.min.y + BRIDGE.max.y) / 2,
                z: (BRIDGE.min.z + BRIDGE.max.z) / 2
            },
            4,
            { breaksBlocks: false }
        );

        const bridgeVolume = new BlockVolume(BRIDGE.min, BRIDGE.max);

        dimension.fillBlocks(bridgeVolume, BlockPermutation.resolve("minecraft:air"));

        world.sendMessage("§4The bridge has been destroyed!");

    } catch (error) {

        world.sendMessage(`§c[TRAIN ERROR] Could not destroy the bridge: ${error}`);

    }
}

function restoreBridge() {

    const dimension = world.getDimension("overworld");

    try {

        dimension.runCommand(
            `structure load "${BRIDGE_BACKUP}" ${BRIDGE.min.x} ${BRIDGE.min.y} ${BRIDGE.min.z}`
        );

        world.sendMessage("§7The bridge has been rebuilt.");

    } catch (error) {

        world.sendMessage(`§c[TRAIN ERROR] Could not rebuild the bridge: ${error}`);

    }
}

// Backs up the bridge, blows it, then rebuilds it after
// BRIDGE_RESTORE_DELAY_TICKS.
export function destroyBridge() {

    backupBridge();
    explodeBridge();

    system.runTimeout(() => {
        restoreBridge();
    }, BRIDGE_RESTORE_DELAY_TICKS);
}

//====================================
// START THE ROBBERY
//====================================

export function startTrainRobbery() {

    if (trainActive) {
        world.sendMessage("§cA train robbery is already in progress.");
        return;
    }

    trainActive = true;
    currentStop = 0;

    world.sendMessage("§6The train is moving out!");

    destroyBridge();

    backupTrackAt(currentStop, TRAIN_PATH[currentStop]);
    placeTrainAt(TRAIN_PATH[currentStop]);

    const run = system.runInterval(() => {

        try {

            const previousStop = TRAIN_PATH[currentStop];
            const previousIndex = currentStop;

            currentStop++;

            //-------------------------------------------------
            // Train reached the end of the track
            //-------------------------------------------------

            if (currentStop >= TRAIN_PATH.length) {

                // Stop the run first, so a failure below can never
                // leave this interval firing forever.
                trainActive = false;
                system.clearRun(run);

                fillVaultChest();

                world.sendMessage(
                    "§6The vault car is open! §7Get to the chest before someone else does."
                );

                // Guards show up now that the train has stopped,
                // not while it was still moving.
                for (let i = 0; i < GUARD_COUNT; i++) {
                    spawnGuard(previousStop, i);
                }

                // Leave the train and any surviving guards in place,
                // then clean them up after CLEANUP_DELAY_TICKS.
                system.runTimeout(() => {

                    restoreTrackAt(previousIndex, previousStop);
                    removeGuards();

                    world.sendMessage("§7The train has been cleaned up.");

                }, CLEANUP_DELAY_TICKS);

                return;
            }

            //-------------------------------------------------
            // Move to the next point
            //-------------------------------------------------

            // Restore the old spot FIRST. The train is wider than
            // one step, so positions overlap — restoring after
            // placing the new train would wipe out the overlapping
            // part of it. Restoring first means the backup taken
            // below reflects the real ground.
            restoreTrackAt(previousIndex, previousStop);

            backupTrackAt(currentStop, TRAIN_PATH[currentStop]);
            placeTrainAt(TRAIN_PATH[currentStop]);

        } catch (error) {

            // Never let one bad tick keep this interval running forever.
            trainActive = false;
            system.clearRun(run);

            world.sendMessage(`§c[TRAIN ERROR] Robbery stopped: ${error}`);

        }

    }, MOVE_INTERVAL_TICKS);
}

//====================================
// LEVER TRIGGER
//====================================

// Place a command block on your lever with:
// scriptevent bounty:train

system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:train") return;

    startTrainRobbery();

});