import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

system.run(() => {
    world.sendMessage("§a[SHOP DEBUG] shop.js loaded!");
});
world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    const player = event.player;
    const entity = event.target;

    player.sendMessage("§e[SHOP DEBUG] Interaction detected!");
    player.sendMessage(`§7Entity type: ${entity.typeId}`);
    player.sendMessage(`§7Tags: ${entity.getTags().join(", ")}`);

    if (!entity.hasTag("horse_shop")) {
        player.sendMessage("§c[SHOP DEBUG] Entity does not have horse_shop tag.");
        return;
    }

    player.sendMessage("§a[SHOP DEBUG] horse_shop tag found!");

    showHorseShop(player);
});

async function showHorseShop(player) {
    player.sendMessage("§e[SHOP DEBUG] Attempting to open form...");

    try {
        const form = new ActionFormData()
            .title("§6Horse Shop")
            .body("Purchase supplies for your journey.")
            .button("Horse Spawn Egg - $100")
            .button("Saddle - $50")
            .button("Exit");

        const response = await form.show(player);

        player.sendMessage(
            `§a[SHOP DEBUG] Form closed. Selection: ${response.selection}`
        );
    } catch (error) {
        player.sendMessage(`§c[SHOP ERROR] ${error}`);
    }
}