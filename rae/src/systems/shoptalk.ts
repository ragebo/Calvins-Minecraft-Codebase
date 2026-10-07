import { system, world, type ItemStack, type Player } from "@minecraft/server";
import { ROBBERY, SHOP as S } from "../config/balance.js";
import { onScriptEvent } from "../core/events.js";
import { debug, error, warn } from "../core/log.js";
import { isOperator } from "../core/players.js";
import { registerSystem } from "../core/registry.js";
import { openAdoptNpc, openShop, openShopEditor } from "../core/shopforms.js";
import { isNpc, shopOf } from "../core/shopnpc.js";
import { format, tell } from "../core/ui.js";

/**
 * The player's side of a shop: a click on a shop NPC becomes the shop screen. Two ways in, because how the real game treats a
 * click on a vanilla NPC was unmeasured when this was written (systems/npcprobe.ts and docs/test-cards/NPC-PROBE.md measure it):
 *
 *   1. Interception. The "before" event for a click on an entity fires before the game opens the NPC's own dialogue. Cancelling
 *      it should stop that dialogue, and the shop opens in its place: one screen. If the game ignores the cancel the player gets
 *      both screens, so SHOP.interceptClicks can be turned off live (`/rae:config_set_bool shop.interceptClicks false`).
 *   2. The dialogue scene. A shop NPC is pointed at one static scene (dialogue/rae_npc.json) whose button runs
 *      `/scriptevent rae:npc shop`. An NPC's button runs a command as the NPC with the player who pressed it as the initiator,
 *      so this finds the shop from the NPC and the customer from the initiator. Two screens, but a documented mechanism.
 *
 * "The wand EDITS; anything else PLAYS": an operator holding the robbery wand who clicks a shop NPC gets the builder's screen
 * (and one who clicks a plain NPC is offered to make it a shop); an operator who sneaks gets the game's own NPC screen, where
 * its skin is changed.
 *
 * The "before" callback is restricted (it may read and set `cancel`, nothing that changes the world), so it decides and hands
 * the screens to the next tick.
 */

const SOURCE = "shop";

/** The last tick each player's NPC click was handled: the game can report one click more than once. */
const lastClick = new Map<string, number>();

const sameClick = (player: Player): boolean => system.currentTick - (lastClick.get(player.id) ?? -Infinity) <= S.clickGapTicks;

const holdsWand = (player: Player, item: ItemStack | undefined): boolean => item?.typeId === ROBBERY.wandItemId && isOperator(player);

function guarded(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        error(SOURCE, `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Runs a screen on the next tick, once per click, and never lets it break the click. */
function open(player: Player, screen: () => Promise<void>): void {

    if (sameClick(player)) return;

    lastClick.set(player.id, system.currentTick);

    system.run(() => guarded("opening a shop screen", () => { void screen(); }));
}

try {
    world.beforeEvents.playerInteractWithEntity.subscribe((event) => {

        guarded("a click on an NPC", () => {

            const target = event.target;

            if (!isNpc(target)) return;

            const player = event.player;
            const shopId = shopOf(target);
            const wand = holdsWand(player, event.itemStack);

            if (shopId === undefined) {
                // A vanilla NPC that is not a shop. Only the wand does anything with it: offer to make it one.
                if (wand) {
                    event.cancel = true;
                    open(player, () => openAdoptNpc(player, target));
                }
                return;
            }

            // Off unless /scriptevent rae:log_debug on: what the game reported, for when a click does not do what it should.
            debug(SOURCE, `click on the NPC of ${shopId}: wand=${wand} sneak=${player.isSneaking} intercept=${S.interceptClicks}`);

            if (wand) {
                event.cancel = true;
                open(player, () => openShopEditor(player, shopId));
                return;
            }

            // An operator who sneaks gets the game's own NPC screen, where its skin is changed.
            if (isOperator(player) && player.isSneaking) return;

            // Interception off: the dialogue scene's button carries this click instead.
            if (!S.interceptClicks) return;

            event.cancel = true;
            open(player, () => openShop(player, shopId));
        });
    });
} catch (err) {
    warn(SOURCE, `could not listen for clicks on NPCs: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * `/scriptevent rae:npc shop`, the one button of the dialogue scene. Only an NPC's button may run it: typed by hand it has no NPC
 * and no customer, so it says what it is for instead.
 */
onScriptEvent("rae:npc", (player, message, origin) => {

    const action = message.trim().split(/\s+/)[0] ?? "";

    if (!origin.fromNpc) {
        if (player) tell(player, format("info", "rae:npc is what a shop NPC's dialogue button runs. To try a shop yourself, use /rae:shop_open <shop>."));
        return;
    }

    const customer = origin.initiator?.typeId === "minecraft:player" ? (origin.initiator as Player) : undefined;
    const npc = origin.entity;

    if (!customer || !npc) {
        warn(SOURCE, `rae:npc ${action} ran from an NPC with no player behind it`);
        return;
    }

    if (action !== "shop") {
        warn(SOURCE, `rae:npc ran with an action it does not know: "${action}"`);
        return;
    }

    const shopId = shopOf(npc);

    if (shopId === undefined) {
        tell(customer, format("warn", "This NPC has no shop."));
        return;
    }

    void openShop(customer, shopId);
});

registerSystem({
    name: "shoptalk",
    reset() {
        lastClick.clear();
    }
});
