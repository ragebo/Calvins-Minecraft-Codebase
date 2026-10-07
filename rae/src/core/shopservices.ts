import { EffectTypes, EnchantmentTypes, EntityTypes, TicksPerSecond, world, type Entity, type Player } from "@minecraft/server";
import { SHOP as S } from "../config/balance.js";
import { gameName, type EffectReward, type EnchantReward, type MountReward, type ServiceReward, type TeleportReward } from "../logic/shop.js";
import { bagOf } from "./shopitems.js";
import { spotBefore } from "./shopnpc.js";

/**
 * Services: what a deal does TO the customer instead of handing them goods. A potion effect, an enchantment on the item they
 * hold, a tame mount beside them, a teleport.
 *
 * A service has two halves so a deal can stay all or nothing. `prepareService` only READS: it finds out whether the game knows
 * the effect, the enchantment or the animal, and whether the customer holds something the enchantment fits, and answers
 * either a reason or a `Prepared` with the two actions. `apply` does it and may throw; `undo` puts it back as far as it can
 * (an effect is removed, a mount is removed, a teleport is reversed; an enchantment is undone by the bag snapshot
 * core/shoptrade.ts restores). core/shoptrade.ts prepares every service BEFORE a coin moves, applies them last, and undoes the
 * ones already applied if the game throws part-way.
 *
 * `apply` and `undo` change the world (addEffect, spawnEntity, teleport, setItem) so, like the rest of a deal, they are for a
 * form's answer or `system.run`, never a before-event or a command callback. `prepareService` is safe anywhere.
 */

export interface Prepared {
    /** Does it. Throws when the game refuses; whatever it had half done it cleans up itself. */
    readonly apply: () => void;
    /** Puts back what `apply` did, as far as it can. */
    readonly undo: () => void;
}

export type Preparation =
    | { readonly ok: true; readonly prepared: Prepared }
    | { readonly ok: false; readonly reason: string };

const fail = (reason: string): Preparation => ({ ok: false, reason });
const ready = (prepared: Prepared): Preparation => ({ ok: true, prepared });

/** Looks an id up as it was typed and, failing that, with the `minecraft:` namespace, since the game's lookups differ about it. */
function lookup<T>(find: (id: string) => T | undefined, id: string): T | undefined {

    const direct = find(id);

    if (direct !== undefined || id.includes(":")) return direct;

    return find(`minecraft:${id}`);
}

export const findEffect = (id: string) => lookup((name) => EffectTypes.get(name), id);
export const findEnchantment = (id: string) => lookup((name) => EnchantmentTypes.get(name), id);
export const findAnimal = (id: string) => lookup((name) => EntityTypes.get(name), id);

/** An item or animal id as it reads in the middle of a sentence: "iron sword". */
const plain = (id: string): string => id.replace(/^[a-z0-9_]+:/, "").replace(/_/g, " ");

function prepareEffect(player: Player, reward: EffectReward): Preparation {

    const type = findEffect(reward.effect);

    if (!type) return fail(`the game does not know the effect ${reward.effect}`);

    return ready({
        apply: () => { player.addEffect(type, reward.seconds * TicksPerSecond, { amplifier: reward.amplifier, showParticles: true }); },
        undo: () => { player.removeEffect(type); }
    });
}

function prepareEnchant(player: Player, reward: EnchantReward): Preparation {

    const type = findEnchantment(reward.enchantment);

    if (!type) return fail(`the game does not know the enchantment ${reward.enchantment}`);

    const bag = bagOf(player);
    const slot = player.selectedSlotIndex;
    const held = bag?.getItem(slot);

    if (!bag || !held) return fail("hold the item you want enchanted");

    const enchantable = held.getComponent("minecraft:enchantable");

    if (!enchantable) return fail(`${plain(held.typeId)} cannot be enchanted`);

    const wanted = `${gameName(reward.enchantment)} ${reward.level}`;

    try {
        if (!enchantable.canAddEnchantment({ type, level: reward.level })) return fail(`${wanted} does not fit the ${plain(held.typeId)} you hold`);
    } catch (err) {
        return fail(`${wanted} cannot go on the ${plain(held.typeId)} you hold (${err instanceof Error ? err.message : String(err)})`);
    }

    return ready({
        apply() {
            // getItem answers a copy: the enchantment only lands when the changed stack is put back.
            const stack = bag.getItem(slot);
            const target = stack?.getComponent("minecraft:enchantable");

            if (!stack || !target) throw new Error("the item you were holding is gone");

            target.addEnchantment({ type, level: reward.level });
            bag.setItem(slot, stack);
        },
        // The bag is snapshotted by the deal and put back whole, which takes the enchantment off with it.
        undo() { /* nothing of its own to put back */ }
    });
}

function prepareMount(player: Player, reward: MountReward): Preparation {

    const type = findAnimal(reward.entity);

    if (!type) return fail(`the game does not know the animal ${reward.entity} (try ${S.commonMounts})`);

    let spawned: Entity | undefined;

    const remove = (): void => {
        if (spawned?.isValid) spawned.remove();
        spawned = undefined;
    };

    return ready({
        apply() {
            try {
                spawned = player.dimension.spawnEntity(type.id, spotBefore(player, S.mountSpawnDistance));

                const mount = spawned.getComponent("minecraft:tamemount");

                if (!mount) throw new Error(`${plain(reward.entity)} cannot be tamed`);

                mount.tameToPlayer(true, player);
            } catch (err) {
                remove();
                throw err;
            }
        },
        undo: remove
    });
}

function prepareTeleport(player: Player, reward: TeleportReward): Preparation {

    let dimension;

    try {
        dimension = world.getDimension(reward.dimension);
    } catch {
        return fail(`the game does not know the dimension ${reward.dimension}`);
    }

    let from: { readonly x: number; readonly y: number; readonly z: number; readonly dimension: typeof dimension } | undefined;

    return ready({
        apply() {
            const here = player.location;
            from = { x: here.x, y: here.y, z: here.z, dimension: player.dimension };
            player.teleport({ x: reward.x, y: reward.y, z: reward.z }, { dimension });
        },
        undo() {
            if (from) player.teleport({ x: from.x, y: from.y, z: from.z }, { dimension: from.dimension });
        }
    });
}

/** Finds out whether the game can do this for this customer right now, and answers how (or why not). Only reads. */
export function prepareService(player: Player, reward: ServiceReward): Preparation {

    switch (reward.kind) {
        case "effect": return prepareEffect(player, reward);
        case "enchant": return prepareEnchant(player, reward);
        case "mount": return prepareMount(player, reward);
        case "teleport": return prepareTeleport(player, reward);
    }
}

/** The order services are done in: the enchantment first (it needs the item in hand), the teleport last (so nothing is left behind). */
const ORDER: Record<ServiceReward["kind"], number> = { enchant: 0, effect: 1, mount: 2, teleport: 3 };

export const inOrder = (rewards: readonly ServiceReward[]): ServiceReward[] => [...rewards].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
