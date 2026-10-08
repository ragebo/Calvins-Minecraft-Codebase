import { type Entity, type Player } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { sameDimension, type Pos } from "../logic/robbery.js";
import { warn } from "./log.js";
import { dimensionOf } from "./robberyworld.js";

/**
 * A teller is any entity (an NPC is best: it stands still and cannot be hurt; a villager wanders and can be shot) that a builder
 * looked at and bound to a robbery's `teller` element. The entity carries two tags: `rbt` (so one query finds every teller) and
 * `rbt:<robbery>:<element>` (which element it is the teller of). A tag, not a dynamic property, because a tag works on every kind of
 * entity and stays with it through leaving the world.
 *
 * Nothing searches for tellers. A hold-up finds one through a player's own view (`aimedTeller`), reads the tag, and the store says
 * whether that element still exists. A tag left on an entity whose element was deleted while it was out of reach is harmless: the
 * store does not know the element, so nothing happens.
 *
 * Everything here that changes the world (a tag) is refused in a before-event or a custom-command callback: call it from
 * `system.run`, a form's answer or a tick. Reading is allowed anywhere.
 */

const SOURCE = "robbery";

export interface TellerKey {
    readonly robbery: string;
    readonly element: string;
}

const DIMENSION_NAMES = ["overworld", "nether", "the_end"] as const;

const tagFor = (key: TellerKey): string => `${R.tellerTagPrefix}${key.robbery}:${key.element}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/** What this entity is the teller of, or undefined when it is not one (or cannot be read). */
export function tellerOf(entity: Entity): TellerKey | undefined {

    try {
        if (!entity.hasTag(R.tellerTag)) return undefined;

        for (const tag of entity.getTags()) {
            if (!tag.startsWith(R.tellerTagPrefix)) continue;
            const [robbery, element] = tag.slice(R.tellerTagPrefix.length).split(":");
            if (robbery && element) return { robbery, element };
        }
    } catch {
        // an entity that cannot be read is not ours to judge
    }

    return undefined;
}

export const isTeller = (entity: Entity): boolean => tellerOf(entity) !== undefined;

/** Why this entity cannot be a teller, or undefined when it can. */
export function whyNotATeller(entity: Entity): string | undefined {

    try {
        if (entity.typeId === "minecraft:player") return "a player cannot be a teller";
        if (entity.typeId === "minecraft:item" || entity.typeId === "minecraft:xp_orb") return "a dropped item cannot be a teller";
        return undefined;
    } catch {
        return "the game could not say what it is";
    }
}

/** Marks an entity as the teller of an element, in place of anything it was the teller of before. */
export function markTeller(entity: Entity, key: TellerKey): void {

    unmarkTeller(entity);

    entity.addTag(R.tellerTag);
    entity.addTag(tagFor(key));
}

/** Takes every teller mark off an entity. */
export function unmarkTeller(entity: Entity): void {

    try {
        for (const tag of entity.getTags()) if (tag === R.tellerTag || tag.startsWith(R.tellerTagPrefix)) entity.removeTag(tag);
    } catch (err) {
        warn(SOURCE, `could not take the teller mark off an entity: ${errorText(err)}`);
    }
}

/** Takes one element's mark off every loaded entity that carries it (the element was deleted or moved). Answers how many. */
export function unmarkElement(key: TellerKey): number {

    let cleared = 0;

    for (const name of DIMENSION_NAMES) {

        const dim = dimensionOf(name);
        if (!dim) continue;

        try {
            for (const entity of dim.getEntities({ tags: [tagFor(key)] })) {
                unmarkTeller(entity);
                cleared++;
            }
        } catch (err) {
            warn(SOURCE, `could not look for the teller of ${key.robbery}/${key.element}: ${errorText(err)}`);
        }
    }

    return cleared;
}

/** The block an entity's feet are in: where a teller stands. */
export function homeOf(entity: Entity): Pos {
    const at = entity.location;
    return [Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)];
}

/** The dimension an entity is in, as a robbery names it. */
export const dimensionNameOf = (entity: Entity): string => sameDimension(entity.dimension.id);

/** The entities a player is looking at within `reach`, nearest first. An unreadable aim is the same as aiming at nothing. */
function inView(player: Player, reach: number): Entity[] {

    try {
        return player.getEntitiesFromViewDirection({ maxDistance: reach }).sort((a, b) => a.distance - b.distance).map((hit) => hit.entity);
    } catch {
        return [];
    }
}

/** The nearest thing that could be a teller the player is looking at within `reach`. */
export function aimedEntity(player: Player, reach: number): Entity | undefined {
    return inView(player, reach).find((entity) => whyNotATeller(entity) === undefined);
}

/** The nearest teller the player is looking at within the hold-up reach, with the element it is the teller of. */
export function aimedTeller(player: Player): { readonly entity: Entity; readonly key: TellerKey } | undefined {

    for (const entity of inView(player, R.holdUpReach)) {
        const key = tellerOf(entity);
        if (key) return { entity, key };
    }

    return undefined;
}
