/**
 * What kind of thing a block is, as far as a robbery cares: something that swings open, something that holds
 * items, something that is pressed. Decided from the block's type id alone, so it stays pure and testable.
 *
 * Vanilla ids are matched by suffix, not listed one by one: every wood, copper and stone variant of a door,
 * trapdoor, button or pressure plate follows the same naming, and a variant added by a later game version
 * should classify correctly without an edit here. Anything not recognised is "other", which is a real answer
 * (stone, a crafting table), not an error.
 */

export type BlockClass = "door" | "trapdoor" | "gate" | "container" | "button" | "lever" | "plate" | "tripwire" | "other";

/** Containers whose id doesn't end in a recognisable suffix. */
const CONTAINERS = new Set([
    "chest", "trapped_chest", "ender_chest", "barrel", "hopper", "dispenser", "dropper",
    "furnace", "blast_furnace", "smoker", "brewing_stand", "lit_furnace", "lit_blast_furnace", "lit_smoker"
]);

/** "minecraft:oak_door" -> "oak_door". An id with no namespace is returned as it is. */
export function bareId(typeId: string): string {
    const colon = typeId.indexOf(":");
    return colon === -1 ? typeId : typeId.slice(colon + 1);
}

export function classOfBlockType(typeId: string): BlockClass {

    const id = bareId(typeId);

    if (id === "lever") return "lever";
    if (id === "trip_wire" || id === "tripwire_hook") return "tripwire";
    if (id === "trapdoor" || id.endsWith("_trapdoor")) return "trapdoor";
    if (id === "fence_gate" || id.endsWith("_fence_gate")) return "gate";
    if (id.endsWith("_door")) return "door";
    if (id.endsWith("_button")) return "button";
    if (id.endsWith("_pressure_plate")) return "plate";
    if (CONTAINERS.has(id) || id.endsWith("_shulker_box") || id === "shulker_box" || id.endsWith("_chest")) return "container";

    return "other";
}

/** True for the classes that swing open and closed through an `open_bit` block state. */
export function swingsOpen(blockClass: BlockClass): boolean {
    return blockClass === "door" || blockClass === "trapdoor" || blockClass === "gate";
}
