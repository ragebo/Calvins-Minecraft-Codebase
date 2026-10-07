import { system, world, type Dimension, type Entity, type Player, type Vector3 } from "@minecraft/server";
import { SHOP as S } from "../config/balance.js";
import { warn } from "./log.js";

/**
 * The NPC that carries a shop: finding it, making it, moving it, removing it. A shop NPC is a vanilla `minecraft:npc` with
 * three marks: a dynamic property saying which shop it is (the truth), a tag so one query finds them all, and, when this addon
 * made it, a second tag so deleting a shop removes only NPCs it made and never one a builder placed by hand.
 *
 * Everything that changes the world here (spawn, teleport, remove, run a command) is refused in a before-event or a
 * custom-command callback: call it from `system.run` or a form's answer. Reading which shop an NPC is, is allowed anywhere.
 */

const SOURCE = "shop";

const DIMENSION_IDS = ["overworld", "nether", "the_end"] as const;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Whether this entity is a vanilla NPC at all. */
export function isNpc(entity: Entity): boolean {
    try {
        return entity.typeId === S.npcType;
    } catch {
        return false;
    }
}

/** The shop this NPC carries, or undefined when it is not one of ours (or cannot be read). */
export function shopOf(entity: Entity): string | undefined {

    try {
        if (entity.typeId !== S.npcType) return undefined;
        const id = entity.getDynamicProperty(S.npcProperty);
        return typeof id === "string" ? id : undefined;
    } catch {
        return undefined;
    }
}

export interface ShopNpc {
    readonly entity: Entity;
    readonly shop: string;
}

/** Every shop NPC in the loaded world, with its shop. An NPC in an unloaded chunk is not found until its chunk loads. */
export function shopNpcs(): ShopNpc[] {

    const found: ShopNpc[] = [];

    for (const id of DIMENSION_IDS) {

        let dimension: Dimension;
        let entities: Entity[];

        try {
            dimension = world.getDimension(id);
            entities = dimension.getEntities({ type: S.npcType, tags: [S.npcTag] });
        } catch {
            continue;
        }

        for (const entity of entities) {
            const shop = shopOf(entity);
            if (shop !== undefined) found.push({ entity, shop });
        }
    }

    return found;
}

export const npcsOf = (shopId: string): Entity[] => shopNpcs().filter((npc) => npc.shop === shopId).map((npc) => npc.entity);

/** The shop NPC the player is looking at, if any. */
export function aimedShopNpc(player: Player): ShopNpc | undefined {

    try {
        for (const hit of player.getEntitiesFromViewDirection({ maxDistance: S.aimReach, type: S.npcType })) {
            const shop = shopOf(hit.entity);
            if (shop !== undefined) return { entity: hit.entity, shop };
        }
    } catch {
        // an unreadable aim is the same as aiming at nothing
    }

    return undefined;
}

/** Points an NPC at the dialogue scene whose one button opens the shop (`dialogue change`). True when the game took it. */
export function assignScene(entity: Entity): boolean {

    try {
        return entity.runCommand(`dialogue change @s ${S.dialogueScene}`).successCount > 0;
    } catch (err) {
        warn(SOURCE, `could not point an NPC at the dialogue scene ${S.dialogueScene}: ${errorText(err)}`);
        return false;
    }
}

/** Makes an NPC the one that carries this shop: the property, the tag, the name above its head, and the scene. */
export function bindNpc(entity: Entity, shop: { readonly id: string; readonly name: string }): void {

    entity.setDynamicProperty(S.npcProperty, shop.id);
    entity.addTag(S.npcTag);
    entity.nameTag = shop.name;

    if (!S.useDialogueScene) return;

    if (!assignScene(entity)) {
        // A freshly spawned entity may not take a command in its first tick: try once more shortly.
        system.runTimeout(() => {
            if (entity.isValid && shopOf(entity) === shop.id) assignScene(entity);
        }, S.sceneRetryTicks);
    }
}

/** Takes the shop off an NPC and leaves the NPC where it stands. */
export function unbindNpc(entity: Entity): void {
    entity.setDynamicProperty(S.npcProperty, undefined);
    entity.removeTag(S.npcTag);
}

/** The spot just in front of a builder, level with their feet. */
function spotBefore(player: Player): Vector3 {

    const here = player.location;
    const look = player.getViewDirection();
    const length = Math.hypot(look.x, look.z);

    if (length < 0.01) return { x: here.x, y: here.y, z: here.z };

    return { x: here.x + (look.x / length) * S.spawnDistance, y: here.y, z: here.z + (look.z / length) * S.spawnDistance };
}

/** Makes a new NPC in front of the builder, facing them, carrying the shop. */
export function spawnShopNpc(player: Player, shop: { readonly id: string; readonly name: string }): Entity {

    const entity = player.dimension.spawnEntity(S.npcType, spotBefore(player));

    entity.addTag(S.npcMadeTag);
    bindNpc(entity, shop);
    entity.teleport(entity.location, { facingLocation: player.location });

    return entity;
}

/** Brings an NPC to stand in front of the builder, facing them. */
export function bringNpc(entity: Entity, player: Player): void {
    entity.teleport(spotBefore(player), { dimension: player.dimension, facingLocation: player.location });
}

/** Puts the shop's NPC in front of the builder: the one that exists is brought over, or, when none is found, a new one is made. */
export function placeNpcFor(player: Player, shop: { readonly id: string; readonly name: string }): "moved" | "made" {

    const [existing] = npcsOf(shop.id);

    if (existing) {
        bringNpc(existing, player);
        existing.nameTag = shop.name;
        return "moved";
    }

    spawnShopNpc(player, shop);

    return "made";
}

/** Whether this addon made the NPC (so removing its shop removes it too). */
export function wasMadeHere(entity: Entity): boolean {
    try {
        return entity.hasTag(S.npcMadeTag);
    } catch {
        return false;
    }
}

/** Removes the NPCs of a shop that this addon made, and lets go of any a builder placed by hand. Answers [removed, released]. */
export function retireNpcs(shopId: string): readonly [removed: number, released: number] {

    let removed = 0;
    let released = 0;

    for (const entity of npcsOf(shopId)) {
        try {
            if (wasMadeHere(entity)) {
                entity.remove();
                removed++;
            } else {
                unbindNpc(entity);
                released++;
            }
        } catch (err) {
            warn(SOURCE, `could not retire an NPC of ${shopId}: ${errorText(err)}`);
        }
    }

    return [removed, released];
}
