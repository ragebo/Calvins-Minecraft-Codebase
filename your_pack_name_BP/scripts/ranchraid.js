import { world, system } from "@minecraft/server";

//Clear
function removeRaidDefenders() {

    const dimension = world.getDimension("overworld");

    for (const entity of dimension.getEntities({
        tags: ["ranch_defender"]
    })) {

        entity.kill();

    }
}

function spawnFromList(type, list) {

    const spot = list[Math.floor(Math.random() * list.length)];

    spawnDefender(type, spot);
}

let ranchRaidActive = false;

// ======================================================
// RANCH SETTINGS
// ======================================================

function unlockSafe() {

    world.sendMessage("§aSafe unlocked!");

    // command to unlock the safe in your game
    world.getDimension("overworld").runCommand("setblock -284 76 -55 redstone_block");

}

const RANCH = {
    min: { x: -295, y: 68, z: -66 },
    max: { x: -277, y: 83, z: -41 }
};

const lowerSpawns = [
    { x: -291, y: 69, z: -59 },
    { x: -289, y: 69, z: -59 },
    { x: -283, y: 69, z: -48 },
    { x: -292, y: 69, z: -48 },
];

const upperSpawns = [
    { x: -283, y: 73, z: -59 },
    { x: -291, y: 73, z: -53 }
];

// ======================================================
// PLAYER DETECTION
// ======================================================

function insideRanch(loc) {
    return (
        loc.x >= RANCH.min.x &&
        loc.x <= RANCH.max.x &&
        loc.y >= RANCH.min.y &&
        loc.y <= RANCH.max.y &&
        loc.z >= RANCH.min.z &&
        loc.z <= RANCH.max.z
    );
}

function getRaidersInRanch() {
    return world.getAllPlayers().filter(player =>
        !player.hasTag("eliminated") &&
        insideRanch(player.location)
    );
}

// ======================================================
// WAVES
// ======================================================

function spawnDefender(type, location) {

    const dimension = world.getDimension("overworld");

    const mob = dimension.spawnEntity(type, location);

    mob.addTag("ranch_defender");

    //world.sendMessage(
    //    `§7[DEBUG] Spawned ${type}`
    //);

    return mob;
}

function spawnWave(wave) {

    const raiders = getRaidersInRanch();
    const count = raiders.length;

    //world.sendMessage(
    //    `§7[DEBUG] ${count} player(s) currently participating.`
    //);

    //world.sendMessage(
    //    `§e[DEBUG] Wave ${wave} | ${count} outlaw(s)`
    //);

    const pillagers = 1 + Math.ceil(count * 1);
    const witches = Math.floor(count * 0.5);
    const golems = Math.floor((count) / 2);

    let index = 0;

    if (wave === 1) {

    // Outside defenders
    for (let i = 0; i < pillagers; i++)
        spawnFromList("minecraft:pillager", lowerSpawns);

    for (let i = 0; i < witches; i++)
        spawnFromList("minecraft:witch", lowerSpawns);

}
else if (wave === 2) {

    // Half downstairs
    for (let i = 0; i < Math.ceil(pillagers / 2); i++)
        spawnFromList("minecraft:pillager", lowerSpawns);

    // Half upstairs
    for (let i = 0; i < Math.floor(pillagers / 2); i++)
        spawnFromList("minecraft:pillager", upperSpawns);

    for (let i = 0; i < witches; i++)
        spawnFromList("minecraft:witch", upperSpawns);

}
else {

    // Vault defense
    for (let i = 0; i < golems; i++)
        spawnFromList("minecraft:iron_golem", upperSpawns);

    for (let i = 0; i < pillagers; i++)
        spawnFromList("minecraft:pillager", upperSpawns);

}
}

// ======================================================
// Heals
// ======================================================

system.runInterval(() => {

    if (!ranchRaidActive) return;

    for (const player of world.getAllPlayers()) {

        if (
            player.hasTag("outlaw") &&
            insideRanch(player.location)
        ) {

            player.runCommand(
                "effect @s regeneration 5 0 true"
            );

        }

    }

}, 20);

// ======================================================
// START RAID
// ======================================================

export function startRanchRaid() {

    const raiders = getRaidersInRanch();

    ranchRaidActive = true;

    if (raiders.length === 0) {
        world.sendMessage("§cNo outlaws are inside the ranch.");
        return;
    }

    let originalTime = 40 + raiders.length * 10;
    let timer = originalTime;
    let wave = 1;

    world.sendMessage(
        `§4Raid Started! ${raiders.length} outlaw(s).`
    );

    spawnWave(1);

    const run = system.runInterval(() => {

        const raiders = getRaidersInRanch();

        //-------------------------------------------------
        // Raid Failed
        //-------------------------------------------------

        if (raiders.length === 0) {

            world.sendMessage(
                "§cRaid ended early."
            );

            removeRaidDefenders();
            ranchRaidActive = false;
            system.clearRun(run);

            return;
        }

        //-------------------------------------------------
        // Increase timer if reinforcements arrive
        //-------------------------------------------------

        const desiredTime = 30 + raiders.length * 10;

        if (desiredTime > originalTime) {

            timer += desiredTime - originalTime;

            originalTime = desiredTime;

            //world.sendMessage(
            //    `§e[DEBUG] Reinforcements arrived. Timer = ${timer}`
            //);

        }

        //-------------------------------------------------
        // Debug every 5 seconds
        //-------------------------------------------------

          // if (timer % 5 === 0) {
         //
        //    world.sendMessage(
       //         `§7[DEBUG] ${timer}s remaining | ${raiders.length} outlaw(s)`
        //    );

       // }

        timer--;

        //-------------------------------------------------
        // Wave 2 (66%)
        //-------------------------------------------------

        if (wave === 1 && timer <= Math.floor(originalTime * 0.66)) {

            wave = 2;

            //world.sendMessage(
            //    "§6[DEBUG] Wave 2!"
            //);

            spawnWave(2);

        }

        //-------------------------------------------------
        // Final Wave (33%)
        //-------------------------------------------------

        if (wave === 2 && timer <= Math.floor(originalTime * 0.33)) {

            wave = 3;

            //world.sendMessage(
            //    "§4[DEBUG] FINAL WAVE!"
            //);

            spawnWave(3);

        }

        //-------------------------------------------------
        // Unlock Safe
        //-------------------------------------------------

        if (timer <= 0) {

            //world.sendMessage(
            //    "§a[DEBUG] Safe unlocked!"
            //);

            unlockSafe();

            removeRaidDefenders();
            ranchRaidActive = false;
            system.clearRun(run);

        }

    }, 20);

}

system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:ranch") return;

    world.sendMessage("§aRanch raid started!");

    startRanchRaid();

});