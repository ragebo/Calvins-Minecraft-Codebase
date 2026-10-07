import { EnchantmentTypes, ItemStack, Potions, type Container, type Player } from "@minecraft/server";
import { specMatches, type ItemSpec, type StackInfo } from "../logic/shop.js";

/**
 * Items, between a shop's data and the game: reading what a builder holds into an ItemSpec, making a customer's goods from one,
 * and counting, taking and handing over items in a player's bag.
 *
 * Every function that CHANGES a bag (`takeFrom`, `giveStacks`) calls `Container.setItem` or `addItem`, which the engine refuses
 * in a before-event or a custom-command callback (restricted execution): call them from a form's answer, or from `system.run`.
 * The reads are fine anywhere.
 */

/** The 36 slots of a player's bag (hotbar and inventory), or undefined when the player cannot be read. */
export function bagOf(player: Player): Container | undefined {
    try {
        return player.getComponent("minecraft:inventory")?.container;
    } catch {
        return undefined;
    }
}

/** What the player holds in the selected slot, or undefined for an empty hand. */
export function heldStack(player: Player): ItemStack | undefined {
    try {
        return bagOf(player)?.getItem(player.selectedSlotIndex);
    } catch {
        return undefined;
    }
}

function potionOf(stack: ItemStack): readonly [string, string] | undefined {
    try {
        const component = stack.getComponent("minecraft:potion");
        return component ? [component.potionEffectType.id, component.potionDeliveryType.id] : undefined;
    } catch {
        return undefined;
    }
}

function enchantmentsOf(stack: ItemStack): (readonly [string, number])[] {
    try {
        const list = stack.getComponent("minecraft:enchantable")?.getEnchantments() ?? [];
        return list.map((e): readonly [string, number] => [e.type.id, e.level]);
    } catch {
        return [];
    }
}

/** How a deal sees a stack in a bag. */
export function infoOf(stack: ItemStack): StackInfo {
    const name = stack.nameTag;
    return { type: stack.typeId, name: name === undefined || name === "" ? undefined : name, potion: potionOf(stack) };
}

/** What a builder holds, as a spec: the kind, how many, and its name, lore, enchantments and (for a potion) which one. */
export function specOf(stack: ItemStack): ItemSpec {

    const potion = potionOf(stack);
    const enchants = enchantmentsOf(stack);
    let lore: string[] = [];

    try {
        lore = stack.getLore();
    } catch {
        // an item whose lore cannot be read is described without it
    }

    const name = stack.nameTag;

    return {
        type: stack.typeId,
        amount: stack.amount,
        ...(name !== undefined && name !== "" ? { name } : {}),
        ...(lore.length > 0 ? { lore } : {}),
        ...(enchants.length > 0 ? { enchants } : {}),
        ...(potion ? { potion } : {})
    };
}

/** One finished item of this spec, a single one: a potion made as a potion, then named, given its lore and enchanted. Throws when the game refuses any of it. */
function buildOne(spec: ItemSpec): ItemStack {

    const stack = spec.potion ? Potions.resolve(spec.potion[0], spec.potion[1]) : new ItemStack(spec.type, 1);

    if (spec.name !== undefined) stack.nameTag = spec.name;
    if (spec.lore) stack.setLore([...spec.lore]);

    if (spec.enchants) {

        const enchantable = stack.getComponent("minecraft:enchantable");

        if (!enchantable) throw new Error(`${spec.type} cannot be enchanted`);

        for (const [id, level] of spec.enchants) {
            const type = EnchantmentTypes.get(id);
            if (!type) throw new Error(`the game does not know the enchantment ${id}`);
            enchantable.addEnchantment({ type, level });
        }
    }

    return stack;
}

/**
 * The stacks that make up this spec's goods: as many as the item's own stack limit needs (a sword is one at a time, arrows
 * sixty-four). Throws, with the game's own words, when any of it cannot be made, so a deal can refuse BEFORE it takes a coin.
 */
export function makeStacks(spec: ItemSpec): ItemStack[] {

    const stacks: ItemStack[] = [];
    let left = spec.amount;

    while (left > 0) {
        const stack = buildOne(spec);
        stack.amount = Math.min(left, Math.max(1, stack.maxAmount));
        left -= stack.amount;
        stacks.push(stack);
    }

    return stacks;
}

/** How many of what the spec asks for the bag holds. */
export function countOf(bag: Container, spec: ItemSpec): number {

    let total = 0;

    for (let slot = 0; slot < bag.size; slot++) {
        const stack = bag.getItem(slot);
        if (stack && specMatches(spec, infoOf(stack))) total += stack.amount;
    }

    return total;
}

/** Takes `spec.amount` of what matches out of the bag, a stack at a time. False, with nothing taken, when there is not enough. */
export function takeFrom(bag: Container, spec: ItemSpec): boolean {

    if (countOf(bag, spec) < spec.amount) return false;

    let need = spec.amount;

    for (let slot = 0; slot < bag.size && need > 0; slot++) {

        const stack = bag.getItem(slot);

        if (!stack || !specMatches(spec, infoOf(stack))) continue;

        const used = Math.min(need, stack.amount);

        if (used === stack.amount) {
            bag.setItem(slot, undefined);
        } else {
            // getItem answers a copy: the slot only changes when the smaller stack is put back.
            stack.amount -= used;
            bag.setItem(slot, stack);
        }

        need -= used;
    }

    return true;
}

/**
 * Hands the stacks to the player. Whatever does not fit in the bag is dropped at their feet, which is what `/give` does, so a
 * full bag never makes a paid-for item vanish. Answers how many items were dropped.
 */
export function giveStacks(player: Player, stacks: readonly ItemStack[]): number {

    const bag = bagOf(player);
    let dropped = 0;

    for (const stack of stacks) {

        const leftover = bag ? bag.addItem(stack) : stack;

        if (leftover) {
            player.dimension.spawnItem(leftover, player.location);
            dropped += leftover.amount;
        }
    }

    return dropped;
}
