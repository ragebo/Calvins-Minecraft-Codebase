import type { ItemStack, Player } from "@minecraft/server";
import { addCoins, getCoins, missingScoreboards, setCoins, takeCoins } from "./economy.js";
import { error } from "./log.js";
import { bagOf, countOf, giveStacks, makeStacks, takeFrom } from "./shopitems.js";
import { coinsText, describeDone, describeItem, type Trade } from "../logic/shop.js";

/**
 * Carrying out a deal, all or nothing.
 *
 * A vanilla NPC button is a list of separate commands, and each one succeeds or fails on its own: a button that charged first
 * and then found the player short for the item, or that gave the item and never charged, is how the old shops lost and gave away
 * coins. A deal here is one function. It checks that the goods can be made, checks that the player can pay, and only then
 * takes the payment and hands over the goods; if the game throws part-way, the bag and the coins are put back exactly as they
 * were (a copy of every slot is kept for that).
 *
 * `whyCannotTrade` only reads, so a screen can call it for every deal to show which ones the player can afford. `carryOutTrade`
 * changes a bag (Container.setItem and addItem), which the engine refuses in a before-event or a custom-command callback:
 * call it from a form's answer or from system.run.
 */

const SOURCE = "shop";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

export type TradeOutcome =
    | { readonly ok: true; readonly summary: string; readonly dropped: number }
    | { readonly ok: false; readonly reason: string };

/** Whether the deal touches coins at all (as a price or as a payout). */
const usesCoins = (trade: Trade): boolean => trade.cost.coins > 0 || trade.rewards.some((r) => r.kind === "coins");

/** Why this player cannot take this deal right now, or undefined when they can. Reads only. */
export function whyCannotTrade(player: Player, trade: Trade): string | undefined {

    if (usesCoins(trade) && missingScoreboards().includes("coins")) {
        return "the coins scoreboard has not been made yet (/scoreboard objectives add coins dummy)";
    }

    const have = getCoins(player);

    if (trade.cost.coins > have) return `you need ${coinsText(trade.cost.coins)} (you have ${have})`;

    if (trade.cost.items.length > 0) {

        const bag = bagOf(player);

        if (!bag) return "your bag cannot be read right now";

        for (const spec of trade.cost.items) {
            const held = countOf(bag, spec);
            if (held < spec.amount) return `you need ${describeItem(spec)} (you have ${held})`;
        }
    }

    return undefined;
}

/** A copy of every slot, so a failure part-way can put the bag back exactly. */
function snapshotOf(bag: NonNullable<ReturnType<typeof bagOf>>): (ItemStack | undefined)[] {
    return Array.from({ length: bag.size }, (_, slot) => bag.getItem(slot));
}

/** Takes the payment and hands over the goods, or refuses without changing anything. */
export function carryOutTrade(player: Player, trade: Trade): TradeOutcome {

    // 1. Can the goods be made at all? Found out before a coin moves.
    const goods: ItemStack[] = [];

    try {
        for (const reward of trade.rewards) {
            if (reward.kind === "item") goods.push(...makeStacks(reward.item));
        }
    } catch (err) {
        error(SOURCE, `a deal's goods could not be made: ${errorText(err)}`);
        return { ok: false, reason: "that cannot be made right now, so nothing was charged" };
    }

    // 2. Can the player pay?
    const why = whyCannotTrade(player, trade);

    if (why) return { ok: false, reason: `Not yet: ${why}.` };

    const bag = bagOf(player);

    if (!bag) return { ok: false, reason: "your bag cannot be read right now" };

    // 3. Pay, then 4. hand over. Whatever the game throws in between, everything goes back.
    const coinsBefore = getCoins(player);
    const slotsBefore = snapshotOf(bag);

    try {

        if (trade.cost.coins > 0) takeCoins(player, trade.cost.coins);

        for (const spec of trade.cost.items) takeFrom(bag, spec);

        const dropped = giveStacks(player, goods);

        for (const reward of trade.rewards) {
            if (reward.kind === "coins") addCoins(player, reward.amount);
        }

        return { ok: true, summary: describeDone(trade), dropped };

    } catch (err) {

        error(SOURCE, `a deal failed part-way and was undone: ${errorText(err)}`);

        try {
            for (let slot = 0; slot < slotsBefore.length; slot++) bag.setItem(slot, slotsBefore[slot]);
            setCoins(player, coinsBefore);
        } catch (undoErr) {
            error(SOURCE, `and putting it back failed too: ${errorText(undoErr)}`);
        }

        return { ok: false, reason: "something went wrong, so nothing was charged" };
    }
}
