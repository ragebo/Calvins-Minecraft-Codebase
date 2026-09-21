import { registerSystem } from "../core/registry.js";
import { onScriptEvent } from "../core/events.js";
import { sendEveryoneToSpawns, startRandomRound } from "../core/game.js";

/**
 * TEMPLATE FILE.
 *
 * Port every other system to match this shape:
 *   1. Import coordinates from config/world, numbers from config/balance.
 *   2. Register with registerSystem, declaring ownedTags and reset.
 *   3. Register triggers with onScriptEvent, never a raw subscription.
 *   4. Register loops with onTick, never a raw runInterval.
 *
 * What starting a round and sending people to their spawns actually do lives in core/game.ts, so the in-game
 * menu (systems/menu.ts) can do the same things. These script events are the old command-block button.
 */

// main.ts places respawning players with it.
export { pickRandom } from "../core/game.js";

registerSystem({
    name: "roles",
    ownedTags: ["law", "outlaw", "native"],
    reset() {
        // Tags are cleared by the registry. Nothing else to clear.
    }
});

onScriptEvent("bounty:start_round", () => { startRandomRound(); });
onScriptEvent("bounty:teleport", () => sendEveryoneToSpawns());
