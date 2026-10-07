import { system, world, type Block, type Entity, type ItemStack, type Player } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { error, warn } from "../core/log.js";
import { isOperator } from "../core/players.js";
import { registerSystem } from "../core/registry.js";
import { interactionDecision, touch } from "../core/robberyrun.js";
import { anyBoundBlocks, boundAt, getRobbery, type Bound } from "../core/robberystore.js";
import { format, tell } from "../core/ui.js";

/**
 * The game-event side of playing a robbery: turns what the engine reports (a right-click on a block, a block being
 * broken, an explosion, a pressure plate pushed) into calls to core/robberyrun.ts, and nothing else. All the rules live
 * there; this file only decides what to hand it and what to refuse right now.
 *
 * Measured in the real game (2026-10-06): the "before" interact event fires for every right-click on any block, repeats
 * while the button is held (so only the first counts), and setting `cancel` stops a chest opening, a door swinging, a
 * lever or button being used. But a before-event callback is RESTRICTED: it may read, set `cancel`, send a chat message and
 * write a dynamic property, and nothing that changes the world, plays a sound or touches the screen. So each handler here
 * decides and cancels at once and hands everything else to `system.run`.
 *
 * Nothing here costs anything for a world with no robberies: a right-click is one map lookup, an explosion is a size check.
 */

const SOURCE = "robbery";

/** The builder's wand belongs to systems/robberybuilder.ts: an operator holding it is editing, not playing. */
const holdsWand = (player: Player, item: ItemStack | undefined): boolean => item?.typeId === R.wandItemId && isOperator(player);

/** Calls a handler so that nothing it does can reach the game: a robbery must never break a right-click. */
function guarded(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        error(SOURCE, `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Subscribes, and if the engine refuses (or has no such event) says so in the log instead of taking the addon down at
 * load. Only the log: this runs while the scripts are still starting, when asking the world for its players may not work.
 */
function listen(label: string, subscribe: () => unknown): void {
    try {
        subscribe();
    } catch (err) {
        warn(SOURCE, `could not listen for ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

const refOf = (block: Block): Bound | undefined => boundAt(block.dimension.id, block.location.x, block.location.y, block.location.z);

// ---------------------------------------------------------------------------------------------------------
// Using a bound block
// ---------------------------------------------------------------------------------------------------------

listen("block interaction", () => world.beforeEvents.playerInteractWithBlock.subscribe((event) => {

    guarded("interacting with a block", () => {

        const ref = refOf(event.block);
        if (!ref) return;

        if (holdsWand(event.player, event.itemStack)) return;

        const decision = interactionDecision(ref);

        if (decision === "cancel") event.cancel = true;

        // A held right-click repeats the event every tick: only the first is a use. A block the game should handle
        // itself (a chest that was unlocked) needs nothing from the run.
        if (!event.isFirstEvent || decision === "pass") return;

        const player = event.player;
        system.run(() => touch(player, ref));
    });
}));

// A pressure plate or tripwire is "used" by walking on it: there is no interaction to cancel, the entity just pushes it.
function pushedBy(entity: Entity, block: Block): void {

    if (entity.typeId !== "minecraft:player") return;

    const ref = refOf(block);
    if (ref) touch(entity as Player, ref);
}

listen("pressure plates", () => world.afterEvents.pressurePlatePush.subscribe((event) => {
    guarded("a pressure plate push", () => pushedBy(event.source, event.block));
}));

listen("tripwires", () => world.afterEvents.tripWireTrip.subscribe((event) => {
    guarded("a tripwire", () => {
        for (const source of event.sources) pushedBy(source, event.block);
    });
}));

// ---------------------------------------------------------------------------------------------------------
// Protection: a bound block cannot be broken or blown up (unless the robbery says otherwise, or the player is an operator)
// ---------------------------------------------------------------------------------------------------------

function isProtected(block: Block): Bound | undefined {

    const ref = refOf(block);

    return ref && getRobbery(ref.robbery)?.settings.protect === true ? ref : undefined;
}

/** The tick each player was last told off for breaking something, so holding the mouse button does not flood chat. */
const lastNotice = new Map<string, number>();

listen("block breaking", () => world.beforeEvents.playerBreakBlock.subscribe((event) => {

    guarded("breaking a block", () => {

        const ref = isProtected(event.block);
        if (!ref || isOperator(event.player)) return;

        event.cancel = true;

        const now = system.currentTick;
        if (now - (lastNotice.get(event.player.id) ?? -Infinity) < R.noticeTicks) return;
        lastNotice.set(event.player.id, now);

        // sendMessage is one of the few calls a before-event may make. The action bar is not.
        tell(event.player, format("info", `That belongs to the ${getRobbery(ref.robbery)?.name ?? "robbery"} and cannot be broken.`));
    });
}));

listen("explosions", () => world.beforeEvents.explosion.subscribe((event) => {

    // Nearly every explosion in a world with no robbery blocks ends here.
    if (!anyBoundBlocks()) return;

    guarded("an explosion", () => {

        const impacted = event.getImpactedBlocks();
        const kept = impacted.filter((block) => isProtected(block) === undefined);

        if (kept.length !== impacted.length) event.setImpactedBlocks(kept);
    });
}));

registerSystem({
    name: "robberyglue",
    reset() {
        lastNotice.clear();
    }
});
