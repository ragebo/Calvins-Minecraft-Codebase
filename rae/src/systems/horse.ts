import { world, system, type Entity } from "@minecraft/server";
import { HORSE } from "../config/balance.js";
import { registerSystem } from "../core/registry.js";

function standardizeHorse(horse: Entity): void {

    if (!horse || horse.typeId !== "minecraft:horse") return;

    try {

        const movement = horse.getComponent("minecraft:movement");

        if (movement) {
            movement.setCurrentValue(HORSE.speed);
        }

    } catch (error) {
        world.sendMessage(`§c[HORSE ERROR] ${error}`);
    }
}

// Not unified through core/events.ts — there is no shared entitySpawn
// dispatcher (only entityDie and scriptEventReceive are, per the
// migration rules), so this stays a direct subscription.
world.afterEvents.entitySpawn.subscribe((event) => {

    const entity = event.entity;

    if (entity.typeId !== "minecraft:horse") return;

    // Wait one tick so the horse has fully spawned.
    system.run(() => {
        standardizeHorse(entity);
    });
});

registerSystem({
    name: "horse",
    reset() {
        // No internal state, no owned tags.
    }
});
