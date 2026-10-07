import type { ItemStack, Player } from "@minecraft/server";
import { addCoins, getBounty, getCoins, missingScoreboards, setCoins, takeCoins } from "./economy.js";
import { error } from "./log.js";
import { bagOf, countOf, giveStacks, makeStacks, takeFrom } from "./shopitems.js";
import { inOrder, prepareService, type Prepared } from "./shopservices.js";
import { recordOf } from "./state.js";
import { coinsText, describeDone, describeItem, isService, type Requirement, type ServiceReward, type Trade } from "../logic/shop.js";

/**
 * Carrying out a deal, all or nothing.
 *
 * A vanilla NPC button is a list of separate commands, and each one succeeds or fails on its own: a button that charged first
 * and then found the player short for the item, or that gave the item and never charged, is how the old shops lost and gave away
 * coins. A deal here is one function. It checks that the goods can be made, that the customer may take the deal at all (law or
 * outlaw only, a bounty), that they can pay, and that the game can do every service (core/shopservices.ts); only then does it
 * take the payment, hand over the goods and do the services. If the game throws part-way, the bag and the coins are put back
 * exactly as they were (a copy of every slot is kept for that) and the services already done are undone.
 *
 * `whyCannotTrade` only reads, so a screen can call it for every deal to show which ones the customer can take.
 * `carryOutTrade` changes a bag (Container.setItem and addItem) and the world (effects, a mount, a teleport), which the engine
 * refuses in a before-event or a custom-command callback: call it from a form's answer or from system.run.
 */

const SOURCE = "shop";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

export type TradeOutcome =
    | { readonly ok: true; readonly summary: string; readonly dropped: number }
    | { readonly ok: false; readonly reason: string };

/** Whether the deal touches coins at all (as a price or as a payout). */
const usesCoins = (trade: Trade): boolean => trade.cost.coins > 0 || trade.rewards.some((r) => r.kind === "coins");

/** Why this customer may not take a deal at all, whatever they carry (their side, their bounty), or undefined when they may. Reads only. */
export function whyNotAllowed(player: Player, requires: Requirement | undefined): string | undefined {

    if (!requires) return undefined;

    if (requires.role !== undefined && recordOf(player)?.role !== requires.role) return `only ${requires.role} players can do this`;

    if (requires.bounty !== undefined) {

        if (missingScoreboards().includes("bounty")) return "the bounty scoreboard has not been made yet (/scoreboard objectives add bounty dummy)";

        const have = getBounty(player);

        if (have < requires.bounty) return `you need a bounty of ${requires.bounty} (you have ${have})`;
    }

    return undefined;
}

const servicesOf = (trade: Trade): ServiceReward[] => inOrder(trade.rewards.filter(isService));

/** Why this player cannot take this deal right now, or undefined when they can. Reads only. */
export function whyCannotTrade(player: Player, trade: Trade): string | undefined {

    const barred = whyNotAllowed(player, trade.requires);

    if (barred) return barred;

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

    // The game must be able to do every service for this customer: an unknown effect, nothing in hand to enchant.
    for (const reward of servicesOf(trade)) {
        const preparation = prepareService(player, reward);
        if (!preparation.ok) return preparation.reason;
    }

    return undefined;
}

/** A copy of every slot, so a failure part-way can put the bag back exactly. */
function snapshotOf(bag: NonNullable<ReturnType<typeof bagOf>>): (ItemStack | undefined)[] {
    return Array.from({ length: bag.size }, (_, slot) => bag.getItem(slot));
}

/** Takes the payment, hands over the goods and does the services, or refuses without changing anything. */
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

    // 2. May the customer take it, can they pay, and can the game do each service?
    const why = whyCannotTrade(player, trade);

    if (why) return { ok: false, reason: `Not yet: ${why}.` };

    const services: Prepared[] = [];

    for (const reward of servicesOf(trade)) {
        const preparation = prepareService(player, reward);
        if (!preparation.ok) return { ok: false, reason: `Not yet: ${preparation.reason}.` };
        services.push(preparation.prepared);
    }

    const bag = bagOf(player);

    if (!bag) return { ok: false, reason: "your bag cannot be read right now" };

    // 3. Pay, 4. hand over, 5. do the services. Whatever the game throws in between, everything goes back.
    const coinsBefore = getCoins(player);
    const slotsBefore = snapshotOf(bag);
    const done: Prepared[] = [];

    try {

        if (trade.cost.coins > 0) takeCoins(player, trade.cost.coins);

        for (const spec of trade.cost.items) takeFrom(bag, spec);

        const dropped = giveStacks(player, goods);

        for (const reward of trade.rewards) {
            if (reward.kind === "coins") addCoins(player, reward.amount);
        }

        for (const service of services) {
            service.apply();
            done.push(service);
        }

        return { ok: true, summary: describeDone(trade), dropped };

    } catch (err) {

        error(SOURCE, `a deal failed part-way and was undone: ${errorText(err)}`);

        for (const service of done.reverse()) {
            try {
                service.undo();
            } catch (undoErr) {
                error(SOURCE, `and undoing a service failed too: ${errorText(undoErr)}`);
            }
        }

        // Every slot, and the coins, are put back on their own: one that the game refuses must not leave the rest undone.
        for (let slot = 0; slot < slotsBefore.length; slot++) {
            try {
                bag.setItem(slot, slotsBefore[slot]);
            } catch (undoErr) {
                error(SOURCE, `and putting slot ${slot} back failed too: ${errorText(undoErr)}`);
            }
        }

        try {
            setCoins(player, coinsBefore);
        } catch (undoErr) {
            error(SOURCE, `and putting the coins back failed too: ${errorText(undoErr)}`);
        }

        return { ok: false, reason: "something went wrong, so nothing was charged" };
    }
}
