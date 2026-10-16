import type { Player } from "@minecraft/server";
import { onScriptEvent } from "../core/events.js";
import { attemptEnding } from "../core/endings.js";
import { registerSystem } from "../core/registry.js";

/**
 * The endings' event glue and nothing else (core/endings.ts runs them; the plan is tasks/endings/plan.md). It replaces systems/boat.ts: the boat escape
 * is now the first ending a world has.
 *
 *   /scriptevent rae:ending <id>     run by an NPC's dialogue button or a command block; for an NPC's button the player is the one who pressed it
 *   /scriptevent bounty:escape       the boat's old event, kept so the world's existing NPC keeps working: it is the ending with the id "boat"
 */

onScriptEvent("rae:ending", (player, message, origin) => {

    const who = player ?? (origin.initiator?.typeId === "minecraft:player" ? (origin.initiator as Player) : undefined);

    if (!who) return;

    attemptEnding(who, message.trim());
});

onScriptEvent("bounty:escape", (player) => {

    if (!player) return;

    attemptEnding(player, "boat");
});

registerSystem({
    name: "endings",
    ownedTags: ["winner"],
    reset() {
        // Tags are cleared by the registry. Nothing is kept here: whether a round has ended is core/round.ts's.
    }
});
