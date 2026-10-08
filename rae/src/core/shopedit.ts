import type { Player } from "@minecraft/server";
import { SHOP as S } from "../config/balance.js";
import {
    addTrade, buyDeal, cleanName, copyShop, effectDeal, enchantDeal, findTrade, mountDeal, retarget, sellDeal, slugify, swapDeal, teleportDeal,
    toHundredth, uniqueId, newShop, updateTrade,
    type Destination, type Edit, type ItemSpec, type NewTrade, type Requirement, type Shop, type Trade
} from "../logic/shop.js";
import { warn } from "./log.js";
import { bagOf, heldStack, specOf } from "./shopitems.js";
import { findAnimal, findEffect, findEnchantment } from "./shopservices.js";
import { allShops, getShop, listStored, saveShop } from "./shopstore.js";

/**
 * What a builder does to shops, between the screens and commands that ask for it and the store that keeps them: which shop
 * they are working on, making one, copying one, and putting a deal on one made from what they hold in their hand. Nothing here
 * changes the world besides saving a shop (a world property, which a command callback is allowed to write), so all of it is safe
 * to call from a custom command; making or moving the NPC is core/shopnpc.ts's, and needs `system.run`.
 *
 * Every change goes through `applyEdit` or the store's own save, which validate the whole shop, so a screen can ask for
 * something the rules refuse and the answer is a sentence, never a half-made shop.
 */

const SELECTED_PROPERTY = "rae:shop:selected";

export function selectedId(player: Player): string | undefined {

    try {
        const value = player.getDynamicProperty(SELECTED_PROPERTY);
        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
}

export function select(player: Player, id: string | undefined): void {

    try {
        player.setDynamicProperty(SELECTED_PROPERTY, id);
    } catch (err) {
        warn("shop", `could not remember ${player.name}'s selection: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** The shop this builder is working on: the one they chose, or, if they chose none, the only one there is. */
export function selectedShop(player: Player): Shop | undefined {

    const chosen = selectedId(player);
    const shop = chosen !== undefined ? getShop(chosen) : undefined;

    if (shop) return shop;

    const all = allShops();

    return all.length === 1 ? all[0] : undefined;
}

export type Outcome =
    | { readonly ok: true; readonly shop: Shop; readonly trade?: Trade }
    | { readonly ok: false; readonly reason: string };

const fail = (reason: string): Outcome => ({ ok: false, reason });

/** Edits a saved shop: runs the change, validates the result as a whole, and saves it. Nothing is saved unless every step works. */
export function applyEdit(id: string, edit: (shop: Shop) => Edit): Outcome {

    const current = getShop(id);
    if (!current) return fail(`there is no shop ${id}`);

    const edited = edit(current);
    if (!edited.ok) return fail(edited.reason);

    const saved = saveShop(edited.shop);

    return saved.ok ? { ok: true, shop: saved.value } : fail(saved.reason);
}

/** An id for a shop called `name` that nothing else has: its slug, or the slug with a number after it. */
function freeId(name: string): string {
    return uniqueId(slugify(name), new Set(listStored().map((stored) => stored.id)));
}

/** Makes a new, empty shop and selects it. (Its NPC is made separately: that changes the world.) */
export function createShop(player: Player, nameText: string): Outcome {

    const name = cleanName(nameText);
    const made = newShop(freeId(name), name);

    if (!made.ok) return fail(made.reason);

    const saved = saveShop(made.shop);

    if (!saved.ok) return fail(saved.reason);

    select(player, saved.value.id);

    return { ok: true, shop: saved.value };
}

/** A new shop with the same deals as `sourceId`, under a new name, selected. (Its NPC is made separately.) */
export function copyShopAs(player: Player, sourceId: string, nameText: string): Outcome {

    const source = getShop(sourceId);
    if (!source) return fail(`there is no shop ${sourceId}`);

    const name = cleanName(nameText);
    const copy = copyShop(source, freeId(name), name);

    if (!copy.ok) return fail(copy.reason);

    const saved = saveShop(copy.shop);

    if (!saved.ok) return fail(saved.reason);

    select(player, saved.value.id);

    return { ok: true, shop: saved.value };
}

/** Puts a deal on a shop. */
export function addDeal(shopId: string, deal: NewTrade): Outcome {

    const current = getShop(shopId);
    if (!current) return fail(`there is no shop ${shopId}`);

    const added = addTrade(current, deal);
    if (!added.ok) return fail(added.reason);

    const saved = saveShop(added.shop);

    return saved.ok ? { ok: true, shop: saved.value, trade: added.trade } : fail(saved.reason);
}

/** What the NPC does with the item in the builder's hand: sells it to players, or buys it from them. */
export type HeldKind = "sells" | "buys";

/**
 * A deal made from the item the builder holds. "sells": the NPC hands over what is held (as many as the stack) and players pay
 * `coins`. "buys": players hand over what is held and are paid `coins`.
 */
export function addHeldDeal(player: Player, shopId: string, kind: HeldKind, coins: number): Outcome {

    const held = heldStack(player);

    if (!held) return fail("hold the item first");

    const spec = specOf(held);

    return addDeal(shopId, kind === "sells" ? buyDeal(spec, coins) : sellDeal(spec, coins));
}

export type ServiceKind = "effect" | "enchant" | "mount" | "teleport";

/** What a builder types or picks for a service deal. Only the fields the kind uses are read. */
export interface ServiceFields {
    /** The effect, enchantment or animal, as typed ("regeneration", "jump boost", "horse"). Not used by a teleport. */
    readonly what: string;
    /** An effect's level (1 is normal) or an enchantment's level. */
    readonly level: number;
    /** How long an effect lasts, in seconds. */
    readonly seconds: number;
    readonly coins: number;
    /** What a teleport's place is called. May be empty. */
    readonly name: string;
    /** Where a teleport goes, as typed. Absent: where the builder is standing. */
    readonly where?: Destination;
}

/** Where the builder is standing, in the form a teleport keeps: to a hundredth of a block, in their dimension. */
export function whereIStand(player: Player): Destination {

    const here = player.location;

    return { x: toHundredth(here.x), y: toHundredth(here.y), z: toHundredth(here.z), dimension: player.dimension.id.replace(/^minecraft:/, "") };
}

/** "Jump Boost " -> "jump_boost": how a builder's typing becomes a game id. */
const typedId = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, "_");

/** An id with the `minecraft:` namespace the game's lookups for enchantments and animals expect when none was typed. */
const namespaced = (id: string): string => (id.includes(":") ? id : `minecraft:${id}`);

/**
 * A service deal from what a builder typed. The game is asked whether it knows the effect, enchantment or animal, so a typo
 * is refused here with what to try, and not found out by a customer. A teleport is to where the builder stands, in their
 * dimension, so the way to set one is to go there and say what it costs.
 */
export function addServiceDeal(player: Player, shopId: string, kind: ServiceKind, fields: ServiceFields): Outcome {

    switch (kind) {

        case "effect": {
            const id = typedId(fields.what).replace(/^minecraft:/, "");
            if (id.length === 0) return fail(`name the effect (${S.commonEffects})`);
            if (!Number.isInteger(fields.level) || fields.level < 1) return fail("the level is a whole number from 1 (1 is the normal strength)");
            if (!findEffect(id)) return fail(`the game does not know the effect "${fields.what.trim()}" (try ${S.commonEffects})`);
            return addDeal(shopId, effectDeal(id, fields.seconds, fields.level - 1, fields.coins));
        }

        case "enchant": {
            const id = namespaced(typedId(fields.what));
            if (typedId(fields.what).length === 0) return fail("name the enchantment (flame, power, sharpness...)");
            if (!findEnchantment(id)) return fail(`the game does not know the enchantment "${fields.what.trim()}"`);
            return addDeal(shopId, enchantDeal(id, fields.level, fields.coins));
        }

        case "mount": {
            const id = namespaced(typedId(fields.what));
            if (typedId(fields.what).length === 0) return fail(`name the animal (${S.commonMounts})`);
            if (!findAnimal(id)) return fail(`the game does not know the animal "${fields.what.trim()}" (try ${S.commonMounts})`);
            return addDeal(shopId, mountDeal(id, fields.coins));
        }

        case "teleport": {
            const where = fields.where ?? whereIStand(player);
            const name = cleanName(fields.name);

            return addDeal(shopId, teleportDeal({ ...where, ...(name.length > 0 ? { name } : {}) }, fields.coins));
        }
    }
}

/** Who may take a deal: a side, a bounty, both, or (undefined) anyone. */
export function setRequirement(shopId: string, tradeId: string, requires: Requirement | undefined): Outcome {
    return applyEdit(shopId, (shop) => updateTrade(shop, tradeId, { requires }));
}

/**
 * Sends a deal's teleport somewhere else, and renames the place (an empty name takes the name off). Nothing else about the deal
 * changes: its price, who may take it and any other reward stay as they were.
 */
export function setTeleport(shopId: string, tradeId: string, to: Destination, name: string): Outcome {

    return applyEdit(shopId, (shop) => {

        const trade = findTrade(shop, tradeId);
        if (!trade) return { ok: false, reason: `there is no deal ${tradeId}` };

        const rewards = retarget(trade, to, name);

        return rewards.ok ? updateTrade(shop, tradeId, { rewards: rewards.value }) : rewards;
    });
}

/** One stack in a builder's bag, to choose from. */
export interface BagChoice {
    readonly slot: number;
    readonly spec: ItemSpec;
}

/** What is in the builder's bag, a choice per occupied slot, leaving out the slot they are holding. */
export function bagChoices(player: Player): BagChoice[] {

    const bag = bagOf(player);
    const choices: BagChoice[] = [];

    if (!bag) return choices;

    for (let slot = 0; slot < bag.size; slot++) {
        if (slot === player.selectedSlotIndex) continue;
        const stack = bag.getItem(slot);
        if (stack) choices.push({ slot, spec: specOf(stack) });
    }

    return choices;
}

/**
 * A trade: the NPC hands over what the builder holds, and players hand over `amount` of what is in `giveSlot` (and `coins` as
 * well, if any). The kind asked for is the item in that slot (its name and potion, never its enchantments).
 */
export function addSwapDeal(player: Player, shopId: string, giveSlot: number, amount: number, coins: number): Outcome {

    const held = heldStack(player);

    if (!held) return fail("hold the item players will get first");

    if (giveSlot === player.selectedSlotIndex) return fail("the item players hand over cannot be the one they get");

    const give = bagOf(player)?.getItem(giveSlot);

    if (!give) return fail("that slot is empty now");

    return addDeal(shopId, swapDeal(specOf(held), [{ ...specOf(give), amount }], coins));
}
