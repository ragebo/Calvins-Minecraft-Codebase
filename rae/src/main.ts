import { world, system } from "@minecraft/server";
import { LAW_SPAWNS, OUTLAW_SPAWNS } from "./config/world.js";
import { verifyScoreboards } from "./core/economy.js";
import { onScriptEvent, listScriptEvents } from "./core/events.js";
import { listSystems, resetAllSystems } from "./core/registry.js";
import { onTick } from "./core/tick.js";
import { pickRandom } from "./systems/roles.js";

// Systems register themselves on import. Order does not matter:
// handler ordering is declared explicitly in events.ts.
import "./systems/roles.js";
import "./systems/jail.js";
import "./systems/jailbreak.js";
import "./systems/raids.js";
import "./systems/train.js";
import "./systems/boat.js";
import "./systems/economy-rules.js";
import "./systems/horse.js";
import "./systems/gold.js";
import "./systems/guns.js";
import "./systems/compass.js";
import "./systems/endgame.js";

// ---------------------------------------------------
// DEBUG COMMANDS
// ---------------------------------------------------

onScriptEvent("rae:debug", () => {
    world.sendMessage("§6=== RAE DEBUG ===");
    world.sendMessage(`§7Systems: §f${listSystems().map((s) => s.name).join(", ")}`);
    world.sendMessage(`§7Events: §f${listScriptEvents().join(", ")}`);
    verifyScoreboards();
});

onScriptEvent("rae:reset", () => {
    resetAllSystems();
    world.sendMessage("§7All systems reset.");
});

system.run(() => {
    world.sendMessage("§aRAE loaded.");
    verifyScoreboards();
});

// ---------------------------------------------------
// SPAWN GLUE
// Doesn't belong to any single ported system — kept here directly,
// same as the debug commands above.
// ---------------------------------------------------

world.afterEvents.playerSpawn.subscribe((event) => {

    const player = event.player;

    // Give effectively infinite saturation.
    player.addEffect("saturation", 20000000, { amplifier: 255, showParticles: false });

    // jail.ts's own playerSpawn handler owns the send_to_jail and
    // eliminated cases — skip the generic respawn below for those,
    // same mutual exclusion V1 had as one function with early returns.
    if (player.hasTag("send_to_jail") || player.hasTag("eliminated")) return;

    // Random respawn point for everyone else currently in a role.
    if (player.hasTag("law") || player.hasTag("outlaw")) {

        try {

            const spawnList = player.hasTag("law") ? LAW_SPAWNS : OUTLAW_SPAWNS;

            system.run(() => {
                player.teleport(pickRandom(spawnList));
            });

        } catch (error) {
            world.sendMessage(`§c[SPAWN ERROR] Could not respawn ${player.name}: ${error}`);
        }
    }
});

// Handles water poison.
onTick("main:water-poison", (ctx) => {
    for (const player of ctx.players) {
        if (player.isInWater) {
            player.addEffect("poison", 40, { amplifier: 0, showParticles: false });
        }
    }
});
