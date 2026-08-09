import { world, system } from "@minecraft/server";

//----------------------------------
// SPAWN POINTS
//----------------------------------

// CHANGE THESE to your real spawn locations. Add as many as you
// like to each list — one gets picked at random per player.
const LAW_SPAWNS = [
    { x: 125, y: 83, z: 196 },
    { x: -250, y: 64, z: 234 }
];

const OUTLAW_SPAWNS = [
    { x: -287, y: 68, z: -152 },
    { x: -137, y: 109, z: -287 },
    { x: 172, y: 82, z: -262 }
];

function pickRandomSpawn(list) {
    return list[Math.floor(Math.random() * list.length)];
}

//----------------------------------
// INTRO CAMERA
//----------------------------------

// Plays the 5-stage camera sequence for one player: ease to
// their own spot, jump way up (~180), pan in (~50), pan in
// again (~15), then clear. Same pattern as the original
// native-class commands — just anchored on each player's real
// coordinates instead of one fixed spot. x/z are captured once
// and locked in, so the camera can't drift if the player moves
// mid-sequence.
function playIntroCamera(player) {

    try {

        const x = player.location.x;
        const y = player.location.y;
        const z = player.location.z;

        // 90 ticks after they're at their spawn point.
        system.runTimeout(() => {
            player.runCommand(
                `camera @s set minecraft:free ease 4.0 in_out_sine pos ${x} ${y} ${z}`
            );
        }, 90);

        system.runTimeout(() => {
            player.runCommand(
                `camera @s set minecraft:free ease 0.25 in_out_quad pos ${x} ~180 ${z} rot 90 0`
            );
        }, 105);

        system.runTimeout(() => {
            player.runCommand(
                `camera @s set minecraft:free ease 0.25 in_out_quad pos ${x} ~50 ${z} rot 90 0`
            );
        }, 120);

        system.runTimeout(() => {
            player.runCommand(
                `camera @s set minecraft:free ease 0.25 in_out_quad pos ${x} ~15 ${z} rot 90 0`
            );
        }, 135);

        system.runTimeout(() => {
            player.runCommand("camera @s clear");
        }, 150);

    } catch (error) {

        world.sendMessage(`§c[CAMERA ERROR] Could not run intro camera for ${player.name}: ${error}`);

    }
}

// Plays the intro camera for every current law/outlaw player at
// once, each looking at their own real location. Call this
// whenever you want — it's independent of role assignment now.
export function playIntroCameraForAll() {

    for (const player of world.getAllPlayers()) {

        if (!player.hasTag("law") && !player.hasTag("outlaw")) continue;

        playIntroCamera(player);
    }
}

system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "bounty:camera") return;

    playIntroCameraForAll();

});

export { LAW_SPAWNS, OUTLAW_SPAWNS, pickRandomSpawn };

//----------------------------------
// SHUFFLE
//----------------------------------

function shuffle(array) {

    for (let i = array.length - 1; i > 0; i--) {

        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

//----------------------------------
// START ROUND
//----------------------------------

export function startRoleSelection() {

    const players = shuffle([...world.getAllPlayers()]);

    if (players.length < 2) {
        world.sendMessage("§cNot enough players to start.");
        return;
    }

    //----------------------------------
    // Clear old tags
    //----------------------------------

    for (const player of players) {

        player.removeTag("law");
        player.removeTag("outlaw");
        player.removeTag("native");
        player.removeTag("jailed");
        player.removeTag("eliminated");
        player.removeTag("send_to_jail");

    }

    //----------------------------------
    // Calculate role counts
    //----------------------------------

    const lawCount = Math.max(1, Math.ceil(players.length / 4));

    //----------------------------------
    // Assign roles
    //----------------------------------

    let index = 0;

for (; index < lawCount; index++) {
    players[index].addTag("law");
}

   for (; index < players.length; index++) {
    players[index].addTag("outlaw");
}

    //----------------------------------
    // Random spawn per player
    //----------------------------------

    for (const player of players) {

        try {

            const isLaw = player.hasTag("law");
            const spawnList = isLaw ? LAW_SPAWNS : OUTLAW_SPAWNS;
            const spawnPoint = pickRandomSpawn(spawnList);

            player.teleport(spawnPoint);

        } catch (error) {

            world.sendMessage(`§c[ROLES ERROR] Could not set up ${player.name}: ${error}`);

        }
    }


    //----------------------------------
    // Rolling animation
    //----------------------------------

    for (const player of players) {
        player.onScreenDisplay.setTitle("§eRolling...");
    }

    system.runTimeout(() => {

        for (const player of players) {
            player.onScreenDisplay.setTitle("§6...");
        }

    }, 20);

    system.runTimeout(() => {

        for (const player of players) {
            player.onScreenDisplay.setTitle("§e...");
        }

    }, 40);

    system.runTimeout(() => {

    for (const player of players) {

        if (player.hasTag("law")) {
            player.onScreenDisplay.setTitle("§9LAWMAN");
        } else {
            player.onScreenDisplay.setTitle("§cOUTLAW");
        }

    }

    world.sendMessage("§aRoles Assigned!");

}, 60);
}

system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id === "bounty:start_round") {
        startRoleSelection();
    }

});