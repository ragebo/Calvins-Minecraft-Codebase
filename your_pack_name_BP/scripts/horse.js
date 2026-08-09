import { world, system } from "@minecraft/server";

//====================================
// HORSE SETTINGS
//====================================

// Change these to balance your game.
const HORSE_SPEED = 0.20;
const HORSE_JUMP = 0.50;

//====================================
// STANDARDIZE HORSE
//====================================

function standardizeHorse(horse) {

    if (!horse || horse.typeId !== "minecraft:horse") return;

    try {

        //--------------------------------
        // Movement speed
        //--------------------------------

        const movement = horse.getComponent("minecraft:movement");

        if (movement) {
            movement.setCurrentValue(HORSE_SPEED);
        }

        //--------------------------------
        // Debug
        //--------------------------------

        world.sendMessage(
            `§7[HORSE DEBUG] Horse standardized | Speed: ${HORSE_SPEED}`
        );

    } catch (error) {

        world.sendMessage(
            `§c[HORSE ERROR] ${error}`
        );

    }
}

//====================================
// DETECT NEW HORSES
//====================================

world.afterEvents.entitySpawn.subscribe((event) => {

    const entity = event.entity;

    if (entity.typeId !== "minecraft:horse") return;

    // Wait one tick so the horse has fully spawned.
    system.run(() => {

        standardizeHorse(entity);

    });

});