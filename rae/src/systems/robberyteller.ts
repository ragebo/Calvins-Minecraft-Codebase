import { system, world, type ItemStack, type Player } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { debug, error, warn } from "../core/log.js";
import { isOperator } from "../core/players.js";
import { registerSystem } from "../core/registry.js";
import "../core/robberyholdup.js";
import { select } from "../core/robberyedit.js";
import { openElementMenu } from "../core/robberyforms.js";
import { tellerOf } from "../core/robberyteller.js";

/**
 * The game-event side of tellers: a click on one. The hold-up itself is a tick handler in core/robberyholdup.ts (imported above, so
 * it registers); this file only decides what a click on a teller means.
 *
 *   - Nobody trades with, or talks to, a teller: it is being robbed. The click is cancelled, so a villager teller's trade screen and
 *     an NPC teller's own box never open.
 *   - "The wand EDITS; anything else PLAYS": an operator holding the wand who clicks a teller gets that element's screen.
 *   - An operator who sneaks gets the game's own screen, where an NPC's skin is changed.
 *
 * The "before" callback is restricted (it may read and set `cancel`, nothing that changes the world), so it decides and hands the
 * screen to the next tick. Another system (systems/shoptalk.ts) also hears this event and must leave a teller alone: it does.
 *
 * NOT measured in the real game (docs/test-cards/ROBBERY-TELLER.md): that cancel stops a villager's trade screen.
 */

const SOURCE = "robbery";

/** The last tick each player's click on a teller was handled: the game can report one click more than once. */
const lastClick = new Map<string, number>();

const sameClick = (player: Player): boolean => system.currentTick - (lastClick.get(player.id) ?? -Infinity) <= R.wandClickGapTicks;

const holdsWand = (player: Player, item: ItemStack | undefined): boolean => item?.typeId === R.wandItemId && isOperator(player);

function guarded(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        error(SOURCE, `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

try {
    world.beforeEvents.playerInteractWithEntity.subscribe((event) => {

        guarded("a click on a teller", () => {

            const key = tellerOf(event.target);
            if (!key) return;

            const player = event.player;
            const wand = holdsWand(player, event.itemStack);

            // Off unless /scriptevent rae:log_debug on: what the game reported, for when a click does not do what it should.
            debug(SOURCE, `click on the teller ${key.robbery}/${key.element}: wand=${wand} sneak=${player.isSneaking}`);

            if (wand) {
                event.cancel = true;

                if (sameClick(player)) return;
                lastClick.set(player.id, system.currentTick);

                system.run(() => guarded("opening a teller's screen", () => {
                    select(player, key.robbery);
                    void openElementMenu(player, key.robbery, key.element);
                }));

                return;
            }

            if (isOperator(player) && player.isSneaking) return;

            event.cancel = true;
        });
    });
} catch (err) {
    warn(SOURCE, `could not listen for clicks on tellers: ${err instanceof Error ? err.message : String(err)}`);
}

registerSystem({
    name: "robberyteller",
    reset() {
        lastClick.clear();
    }
});
