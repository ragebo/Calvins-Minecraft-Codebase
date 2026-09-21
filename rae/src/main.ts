import { world, system } from "@minecraft/server";
import { LAW_SPAWNS, OUTLAW_SPAWNS } from "./config/world.js";
import { verifyScoreboards } from "./core/economy.js";
import { onScriptEvent, onSpawn, listScriptEvents } from "./core/events.js";
import { resetGame } from "./core/game.js";
import { listSystems } from "./core/registry.js";
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
import "./systems/probe.js";
import "./systems/transit.js";
import "./systems/aimprobe.js";
import "./systems/menu.js";

// ---------------------------------------------------
// DEBUG COMMANDS
// ---------------------------------------------------

onScriptEvent("rae:debug", () => {
    world.sendMessage("§6=== RAE DEBUG ===");
    world.sendMessage(`§7Systems: §f${listSystems().map((s) => s.name).join(", ")}`);
    world.sendMessage(`§7Events: §f${listScriptEvents().join(", ")}`);
    verifyScoreboards();
});

onScriptEvent("rae:reset", () => resetGame());

system.run(() => {
    world.sendMessage("§aRAE loaded.");
    verifyScoreboards();
});

// ---------------------------------------------------
// SPAWN GLUE
// Doesn't belong to any single ported system — kept here directly,
// same as the debug commands above.
// ---------------------------------------------------

// Order 0: everyone gets effectively infinite saturation.
onSpawn("main:saturation", 0, (ctx) => {
    ctx.player.addEffect("saturation", 20000000, { amplifier: 255, showParticles: false });
});

// Order 200, after jail:spawn (100) has had its say: anyone in a role that
// nothing earlier has already placed (jail, elimination) goes to a random
// spawn. V1 did this as one function with early returns; ctx.placed is the
// explicit version of those returns.
onSpawn("main:respawn-placement", 200, (ctx) => {

    const player = ctx.player;

    if (ctx.placed) return;

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
