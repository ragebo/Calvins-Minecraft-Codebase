import { system, world, type Dimension, type Entity, type Player, type Vector3 } from "@minecraft/server";
import { SHOP as S } from "../config/balance.js";
import { DIMENSIONS, describeDestination, type Destination } from "../logic/shop.js";
import { warn } from "./log.js";

/**
 * The NPC that carries a shop: finding it, making it, moving it, removing it. A shop NPC is a vanilla `minecraft:npc` with
 * three marks: a dynamic property saying which shop it is (the truth), a tag so one query finds them all, and, when this addon
 * made it, a second tag so deleting a shop removes only NPCs it made and never one a builder placed by hand.
 *
 * An NPC in an area nobody is near is not loaded, and a script cannot see it. So the world also remembers where each shop's NPC
 * was last put or seen, and "bring it here" uses that to load the area for a moment (a temporary ticking area), move the NPC to
 * the builder and let the area go. That is also what stops a "bring it here" from quietly making a SECOND NPC whenever the first
 * is merely out of sight: a new one is made only when the remembered place was loaded and held none.
 *
 * Everything that changes the world here (spawn, teleport, remove, run a command, a ticking area) is refused in a before-event or
 * a custom-command callback: call it from `system.run` or a form's answer. Reading which shop an NPC is, is allowed anywhere.
 */

const SOURCE = "shop";

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

/** What a shop is called, for the name above its NPC's head. */
export interface ShopRef {
    readonly id: string;
    readonly name: string;
}

/** Every shop NPC in the loaded world, with its shop. An NPC in an unloaded chunk is not found until its chunk loads. */
export function shopNpcs(): ShopNpc[] {

    const found: ShopNpc[] = [];

    for (const id of DIMENSIONS) {

        let entities: Entity[];

        try {
            entities = world.getDimension(id).getEntities({ type: S.npcType, tags: [S.npcTag] });
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

/** The loaded shop NPCs grouped by shop: one scan of the world for a list or a picker, not one per shop. */
export function npcsByShop(): Map<string, Entity[]> {

    const grouped = new Map<string, Entity[]>();

    for (const npc of shopNpcs()) grouped.set(npc.shop, [...(grouped.get(npc.shop) ?? []), npc.entity]);

    return grouped;
}

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

// ---------------------------------------------------------------------------------------------------------
// Where a shop's NPC was last put
// ---------------------------------------------------------------------------------------------------------

const spotKey = (shopId: string): string => `${S.spotPrefix}${shopId}`;

/** Where this shop's NPC stands now, in whole blocks. */
function spotOf(entity: Entity): Destination | undefined {

    try {
        const at = entity.location;
        return { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z), dimension: entity.dimension.id.replace(/^minecraft:/, "") };
    } catch {
        return undefined;
    }
}

/** Where this shop's NPC was last put or seen, or undefined when nothing is remembered (or what is kept cannot be read). */
export function recallSpot(shopId: string): Destination | undefined {

    try {
        const text = world.getDynamicProperty(spotKey(shopId));
        if (typeof text !== "string") return undefined;

        const [dimension = "", x, y, z] = text.split("|");
        const spot = { x: Number(x), y: Number(y), z: Number(z), dimension };

        return DIMENSIONS.includes(dimension) && [spot.x, spot.y, spot.z].every(Number.isFinite) ? spot : undefined;
    } catch {
        return undefined;
    }
}

/** Remembers where this shop's NPC stands now. Writes only when it is somewhere new. Never throws. */
export function rememberSpot(shopId: string, entity: Entity): void {

    const spot = spotOf(entity);
    if (!spot) return;

    const text = `${spot.dimension}|${spot.x}|${spot.y}|${spot.z}`;

    try {
        if (world.getDynamicProperty(spotKey(shopId)) !== text) world.setDynamicProperty(spotKey(shopId), text);
    } catch (err) {
        warn(SOURCE, `could not remember where ${shopId}'s NPC is: ${errorText(err)}`);
    }
}

/** Lets go of what is remembered about a shop's NPC (its shop is gone). */
export function forgetSpot(shopId: string): void {

    try {
        world.setDynamicProperty(spotKey(shopId), undefined);
    } catch {
        // nothing was remembered, or it cannot be cleared: either way there is nothing to act on
    }
}

/** Where a shop's NPC is, in a few words, for a list or a screen: `loaded` is the shop's NPCs that are in the loaded world right now. */
export function whereIsNpc(shopId: string, loaded: readonly Entity[]): string {

    const [first] = loaded;

    if (first) {
        const spot = spotOf(first);
        const at = spot ? describeDestination(spot) : "a place that cannot be read";
        return loaded.length === 1 ? `at ${at}` : `${loaded.length} loaded, the first at ${at}`;
    }

    const last = recallSpot(shopId);

    return last ? `not loaded, last at ${describeDestination(last)}` : "none found loaded";
}

// ---------------------------------------------------------------------------------------------------------
// Making, binding, retiring
// ---------------------------------------------------------------------------------------------------------

/** Points an NPC at the dialogue scene whose one button opens the shop (`dialogue change`). True when the game took it. */
export function assignScene(entity: Entity): boolean {

    try {
        return entity.runCommand(`dialogue change @s ${S.dialogueScene}`).successCount > 0;
    } catch (err) {
        warn(SOURCE, `could not point an NPC at the dialogue scene ${S.dialogueScene}: ${errorText(err)}`);
        return false;
    }
}

/** Makes an NPC the one that carries this shop: the property, the tag, the name above its head, the scene, and where it stands. */
export function bindNpc(entity: Entity, shop: ShopRef): void {

    entity.setDynamicProperty(S.npcProperty, shop.id);
    entity.addTag(S.npcTag);
    entity.nameTag = shop.name;
    rememberSpot(shop.id, entity);

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

/** The spot just in front of a player, level with their feet: a new shop NPC's, or a bought mount's. */
export function spotBefore(player: Player, distance: number = S.spawnDistance): Vector3 {

    const here = player.location;
    const look = player.getViewDirection();
    const length = Math.hypot(look.x, look.z);

    if (length < 0.01) return { x: here.x, y: here.y, z: here.z };

    return { x: here.x + (look.x / length) * distance, y: here.y, z: here.z + (look.z / length) * distance };
}

/** Makes a new NPC in front of the builder, facing them, carrying the shop. */
export function spawnShopNpc(player: Player, shop: ShopRef): Entity {

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

// ---------------------------------------------------------------------------------------------------------
// Reaching an NPC that may not be loaded
// ---------------------------------------------------------------------------------------------------------

/** How a try to reach a shop's NPC went. `use` has already run on the NPC for "here" and "fetched". */
export type Reach =
    | { readonly kind: "here" }
    | { readonly kind: "fetched"; readonly from: Destination }
    | { readonly kind: "gone"; readonly last?: Destination }
    | { readonly kind: "stuck"; readonly why: string; readonly last?: Destination };

const stuck = (why: string, last?: Destination): Reach => ({ kind: "stuck", why, ...(last ? { last } : {}) });

/** Resolves after this many ticks. */
const wait = (ticks: number): Promise<void> => new Promise((resolve) => { system.runTimeout(resolve, ticks); });

/** `promise`, or a rejection once `ticks` have passed without it settling. */
function within<T>(promise: Promise<T>, ticks: number): Promise<T> {

    return new Promise<T>((resolve, reject) => {

        const timer = system.runTimeout(() => reject(new Error("the area did not load in time")), ticks);

        promise.then(
            (value) => { system.clearRun(timer); resolve(value); },
            (err: unknown) => { system.clearRun(timer); reject(err); }
        );
    });
}

/** Removes the temporary ticking area, if it is there. */
function dropArea(): void {

    try {
        const areas = world.tickingAreaManager;
        if (areas.hasTickingArea(S.fetchAreaId)) areas.removeTickingArea(S.fetchAreaId);
    } catch (err) {
        warn(SOURCE, `could not remove the ticking area ${S.fetchAreaId}: ${errorText(err)}`);
    }
}

/**
 * The shop's NPC in a dimension whose area has just been loaded, looking for a moment because a newly loaded area's entities can
 * take a few ticks to appear. (None of the shop's NPCs was loaded before, so any it finds now is in the area that was loaded.)
 */
async function lookFor(dimension: Dimension, shopId: string): Promise<Entity | undefined> {

    for (let waited = 0; ; waited += S.fetchSearchGapTicks) {

        const found = dimension.getEntities({ type: S.npcType, tags: [S.npcTag] }).find((npc) => shopOf(npc) === shopId);

        if (found) return found;
        if (waited >= S.fetchSearchTicks) return undefined;

        await wait(S.fetchSearchGapTicks);
    }
}

/** Loads the area where the NPC was last seen, runs `use` on it while it is loaded, and lets the area go. */
async function fetchFrom(shopId: string, last: Destination, use: (npc: Entity) => void): Promise<Reach> {

    let dimension: Dimension;

    try {
        dimension = world.getDimension(last.dimension);
    } catch {
        return stuck(`the game does not know the dimension ${last.dimension}`, last);
    }

    const area = { dimension, from: { x: last.x - 1, y: last.y, z: last.z - 1 }, to: { x: last.x + 1, y: last.y, z: last.z + 1 } };

    try {
        dropArea();     // only one fetch runs at a time, so one still there is left over from a fetch that never finished

        if (!world.tickingAreaManager.hasCapacity(area)) return stuck("there is no room for another ticking area", last);

        await within(world.tickingAreaManager.createTickingArea(S.fetchAreaId, area), S.fetchTimeoutTicks);
    } catch (err) {
        dropArea();
        return stuck(errorText(err), last);
    }

    try {
        const npc = await lookFor(dimension, shopId);

        if (!npc) return { kind: "gone", last };

        use(npc);

        return { kind: "fetched", from: last };
    } catch (err) {
        return stuck(errorText(err), last);
    } finally {
        dropArea();
    }
}

/** Whether reaching this shop's NPC means loading an area first: none is loaded, but a place is remembered. */
export const needsFetch = (shopId: string): boolean => npcsOf(shopId).length === 0 && recallSpot(shopId) !== undefined;

let fetching = false;

/**
 * Runs `use` on the shop's NPC wherever it is. Loaded already: at once. Not loaded but remembered: the area is loaded for a
 * moment, `use` runs while it is, and the area is let go. Neither: "gone". The answer says which, and `use` has run only for
 * "here" and "fetched". It never throws. Changes the world (a ticking area, and whatever `use` does): not for a callback that is restricted.
 */
export async function reachShopNpc(shopId: string, use: (npc: Entity) => void): Promise<Reach> {

    const [loaded] = npcsOf(shopId);
    const last = recallSpot(shopId);

    if (loaded) {
        try {
            use(loaded);
            return { kind: "here" };
        } catch (err) {
            return stuck(errorText(err), last);
        }
    }

    if (!last) return { kind: "gone" };

    if (fetching) return stuck("another NPC is being brought over right now: try again in a moment", last);

    fetching = true;

    try {
        return await fetchFrom(shopId, last, use);
    } finally {
        fetching = false;
    }
}

/** What happened when a shop's NPC was asked to come to a builder. */
export type Brought =
    | { readonly how: "here" }
    | { readonly how: "fetched"; readonly from: Destination }
    | { readonly how: "made"; readonly last?: Destination }
    | { readonly how: "none"; readonly last?: Destination }
    | { readonly how: "stuck"; readonly why: string; readonly last?: Destination };

/**
 * Brings the shop's NPC to stand in front of the builder, from wherever it is. When it is gone (its remembered place was
 * loaded and held none, or nothing was remembered and none is loaded) a new one is made if `mayMake`, else the answer is "none".
 * When it could not be told whether it is gone (the area would not load), nothing is made: that is how a second NPC is avoided.
 */
export async function bringShopNpc(player: Player, shop: ShopRef, mayMake: boolean): Promise<Brought> {

    const reach = await reachShopNpc(shop.id, (npc) => {
        if (!player.isValid) throw new Error("you left before it arrived");
        bringNpc(npc, player);
        npc.nameTag = shop.name;
        rememberSpot(shop.id, npc);
    });

    if (reach.kind === "here") return { how: "here" };
    if (reach.kind === "fetched") return { how: "fetched", from: reach.from };
    if (reach.kind === "stuck") return { how: "stuck", why: reach.why, ...(reach.last ? { last: reach.last } : {}) };

    const last = reach.last ? { last: reach.last } : {};

    if (!mayMake || !player.isValid) return { how: "none", ...last };

    spawnShopNpc(player, shop);

    return { how: "made", ...last };
}

/** The sentence that says how bringing a shop's NPC went, with what to do next when it did not. */
export function broughtText(shop: ShopRef, brought: Brought): string {

    switch (brought.how) {

        case "here":
            return `${shop.name}'s NPC is in front of you.`;

        case "fetched":
            return `${shop.name}'s NPC came from ${describeDestination(brought.from)} and is in front of you.`;

        case "made":
            return brought.last
                ? `${shop.name}'s NPC was not at ${describeDestination(brought.last)} any more, so a new one is in front of you.`
                : `Made a new NPC for ${shop.name} in front of you. None was loaded and nothing remembered where one was: if an old one is somewhere else you now have two (/rae:shop_list shows how many are loaded).`;

        case "none":
            return brought.last
                ? `${shop.name}'s NPC is not at ${describeDestination(brought.last)} any more. /rae:shop_place ${shop.id} makes a new one here.`
                : `No NPC of ${shop.name} is loaded and nothing remembers where it was. Go near it and try again, or /rae:shop_place ${shop.id} makes a new one here.`;

        case "stuck":
            return `${shop.name}'s NPC${brought.last ? ` was last at ${describeDestination(brought.last)} and` : ""} could not be brought (${brought.why}). Go near it and try again, or /rae:shop_place ${shop.id} true makes a new one here anyway.`;
    }
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

    forgetSpot(shopId);

    return [removed, released];
}
