import { world, system } from "@minecraft/server";

//====================================
// FORT SETTINGS
//====================================

const FORT = {
    min: { x: -30, y: 69, z: -65 },
    max: { x: -4, y: 79, z: -39 }
};

// Shared by all 3 waves — one spawn is picked at random per mob.
const SPAWN_POINTS = [
    { x: -26, y: 74, z: -43 },
    { x: -26, y: 74, z: -61 },
    { x: -8, y: 74, z: -61 },
    { x: -8, y: 74, z: -43 },
    { x: -13, y: 70, z: -52 },
    { x: -17, y: 70, z: -56 },
    { x: -21, y: 70, z: -52 }
];

const REWARD_CHEST = { x: -8, y: 70, z: -52 };
const REWARD_LOOT_TABLE = "chests/gold_2";

// Vanilla Health Boost only comes in fixed +4 HP steps per level,
// so it can't hit an exact 1.5x (30 HP) on a 20 HP base.
// Amplifier 1 (Health Boost II) = 28 HP (1.4x).
// Amplifier 2 (Health Boost III) = 32 HP (1.6x).
// Picked the closer one below — bump to 2 if you'd rather round up.
const HEALTH_BOOST_AMPLIFIER = 1;
const HEALTH_BOOST_DURATION = 20000000; // effectively permanent

// Applied to every fort mob on spawn to tone down their damage.
// Amplifier 0 = Weakness I, 1 = Weakness II, etc. Duration is
// effectively permanent so it never wears off mid-fight.
const WEAKNESS_AMPLIFIER = 0;
const WEAKNESS_DURATION = 20000000;

let fortRaidActive = false;
let currentWave = 0;
let fortRunId = null;

//====================================
// PARTICIPANT DETECTION
//====================================

function insideFort(loc) {
    return (
        loc.x >= FORT.min.x && loc.x <= FORT.max.x &&
        loc.y >= FORT.min.y && loc.y <= FORT.max.y &&
        loc.z >= FORT.min.z && loc.z <= FORT.max.z
    );
}

function getParticipants() {
    return world.getAllPlayers().filter(player =>
        !player.hasTag("eliminated") &&
        insideFort(player.location)
    );
}

//====================================
// SPAWNING
//====================================

function spawnDefender(type, location) {

    const dimension = world.getDimension("overworld");
    const mob = dimension.spawnEntity(type, location);

    mob.addTag("fort_defender");

    try {

        mob.addEffect("weakness", WEAKNESS_DURATION, {
            amplifier: WEAKNESS_AMPLIFIER,
            showParticles: false
        });

    } catch (error) {

        world.sendMessage(`§c[FORT ERROR] Could not apply weakness to ${type}: ${error}`);

    }

    return mob;
}

function spawnFromList(type, list) {
    const spot = list[Math.floor(Math.random() * list.length)];
    return spawnDefender(type, spot);
}

function removeFortDefenders() {

    const dimension = world.getDimension("overworld");

    for (const entity of dimension.getEntities({ tags: ["fort_defender"] })) {
        entity.kill();
    }
}

function countAliveDefenders() {
    const dimension = world.getDimension("overworld");
    return dimension.getEntities({ tags: ["fort_defender"] }).length;
}

//====================================
// WAVES
// Starting point — adjust counts/mobs freely.
//====================================

function spawnWave(wave, participantCount) {

    const count = Math.max(1, participantCount);

    try {

        if (wave === 1) {

            const pillagers = 1 + count;
            const vindicators = Math.ceil(count / 2);

            for (let i = 0; i < pillagers; i++) spawnFromList("minecraft:pillager", SPAWN_POINTS);
            for (let i = 0; i < vindicators; i++) spawnFromList("minecraft:vindicator", SPAWN_POINTS);

        } else if (wave === 2) {

            const pillagers = Math.ceil(count / 2);
            const vindicators = 1 + count;
            const strays = Math.ceil(count / 2);

            for (let i = 0; i < pillagers; i++) spawnFromList("minecraft:pillager", SPAWN_POINTS);
            for (let i = 0; i < vindicators; i++) spawnFromList("minecraft:vindicator", SPAWN_POINTS);
            for (let i = 0; i < strays; i++) spawnFromList("minecraft:stray", SPAWN_POINTS);

        } else {

            const strays = Math.ceil(count / 2);
            const vindicators = count;
            const blazes = Math.ceil(count / 3);

            for (let i = 0; i < strays; i++) spawnFromList("minecraft:stray", SPAWN_POINTS);
            for (let i = 0; i < vindicators; i++) spawnFromList("minecraft:vindicator", SPAWN_POINTS);
            for (let i = 0; i < blazes; i++) spawnFromList("minecraft:blaze", SPAWN_POINTS);

        }

    } catch (error) {

        world.sendMessage(`§c[FORT ERROR] Could not spawn wave ${wave}: ${error}`);

    }
}

//====================================
// REWARD
//====================================

function giveReward() {

    const dimension = world.getDimension("overworld");

    try {

        dimension.runCommand(
            `loot insert ${REWARD_CHEST.x} ${REWARD_CHEST.y} ${REWARD_CHEST.z} loot "${REWARD_LOOT_TABLE}"`
        );

    } catch (error) {

        world.sendMessage(`§c[FORT ERROR] Could not fill reward chest: ${error}`);

    }

    for (const player of getParticipants()) {

        try {

            player.addEffect("health_boost", HEALTH_BOOST_DURATION, {
                amplifier: HEALTH_BOOST_AMPLIFIER,
                showParticles: false
            });

            const health = player.getComponent("minecraft:health");

            if (health) health.resetToMaxValue();

        } catch (error) {

            world.sendMessage(`§c[FORT ERROR] Could not reward ${player.name}: ${error}`);

        }
    }

    world.sendMessage("§6The fort has been cleared! §eThe reward chest is open.");
}

//====================================
// START
//====================================

export function startFortRaid() {

    if (fortRaidActive) {
        world.sendMessage("§cA fort raid is already in progress.");
        return;
    }

    const participants = getParticipants();

    if (participants.length === 0) {
        world.sendMessage("§cNo one is inside the fort.");
        return;
    }

    fortRaidActive = true;
    currentWave = 1;

    world.sendMessage(`§4Fort raid started! ${participants.length} defender(s).`);

    spawnWave(currentWave, participants.length);

    // Fail-check: if everyone leaves the fort, the raid ends early.
    // Same pattern as ranch raid.
    fortRunId = system.runInterval(() => {

        if (!fortRaidActive) return;

        if (getParticipants().length === 0) {

            world.sendMessage("§c[DEBUG] Fort raid ended");

            removeFortDefenders();
            fortRaidActive = false;
            system.clearRun(fortRunId);
        }

    }, 20);
}

//====================================
// WAVE ADVANCEMENT
// Purely event-driven off entityDie — no polling needed to
// detect a cleared wave.
//====================================

let waveAdvancing = false;

world.afterEvents.entityDie.subscribe((event) => {

    if (!fortRaidActive) return;
    if (!event.deadEntity.hasTag("fort_defender")) return;

    system.run(() => {

        if (!fortRaidActive) return;
        if (waveAdvancing) return; // another death this same tick already handled it
        if (countAliveDefenders() > 0) return;

        waveAdvancing = true;

        if (currentWave >= 3) {

            fortRaidActive = false;

            if (fortRunId !== null) system.clearRun(fortRunId);

            giveReward();

            waveAdvancing = false;

            return;
        }

        currentWave++;

        world.sendMessage(`§6Wave ${currentWave}!`);

        spawnWave(currentWave, getParticipants().length);

        waveAdvancing = false;
    });
});

//====================================
// REGENERATION WHILE RAID IS ACTIVE
// Same idea as ranch raid's heal, but using the native effect
// API instead of runCommand, and covering all participants
// (not just outlaws) since that's how fort raid was scoped.
//====================================

system.runInterval(() => {

    if (!fortRaidActive) return;

    for (const player of getParticipants()) {

        try {

            player.addEffect("regeneration", 100, {
                amplifier: 0,
                showParticles: false
            });

        } catch (error) {

            world.sendMessage(`§c[FORT ERROR] Could not apply regeneration to ${player.name}: ${error}`);

        }
    }

}, 20);

system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:fort") return;

    startFortRaid();

});