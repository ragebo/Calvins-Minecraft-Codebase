// Shared helpers for tests. Tests run the COMPILED game code (.test-build/) under the fake API.
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const build = path.resolve(import.meta.dirname, "..", ".test-build");

// Import the fake through the same path the compiled code resolves, so both share one instance.
export const fakeApi = await import(pathToFileURL(path.join(build, "node_modules/@minecraft/server/index.js")).href);
export const fakeUi = await import(pathToFileURL(path.join(build, "node_modules/@minecraft/server-ui/index.js")).href);
export const { fake, world, system } = fakeApi;

/** Loads a compiled game module, e.g. `await load("systems/compass.js")`. */
export const load = (relative) => import(pathToFileURL(path.join(build, relative)).href);

/**
 * Collects every failed expectation in a test instead of stopping at the first, then
 * fails once with the full list. Usage: const { check, done } = checks(); ...; done();
 */
export function checks() {
    const failures = [];
    return {
        check(name, condition, detail = "") { if (!condition) failures.push(`${name} ${detail}`.trim()); },
        done() { assert.equal(failures.length, 0, `\n  ${failures.join("\n  ")}`); }
    };
}

export const strip = (text) => text.replace(/§./g, "");
export const approx = (a, b, epsilon = 1e-6) => Math.abs(a - b) < epsilon;

const GAME_DATA = process.env.RAE_GAME_DATA ?? "C:/XboxGames/Minecraft for Windows/Content/data/resource_packs";

/**
 * Every sound id the installed game's own sounds.json files reference, or null when the
 * game isn't installed here (CI). Use it to verify a sound id really exists in this build.
 */
export function knownGameSounds() {
    if (!existsSync(GAME_DATA)) return null;
    const found = new Set();
    const walk = (node) => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node && typeof node === "object") {
            for (const [key, value] of Object.entries(node)) {
                if (key === "sound" && typeof value === "string") found.add(value); else walk(value);
            }
        }
    };
    for (const dir of readdirSync(GAME_DATA)) {
        const file = path.join(GAME_DATA, dir, "sounds.json");
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        try {
            const json = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
            walk(json);
            for (const name of Object.keys(json.individual_named_sounds?.sounds ?? {})) found.add(name);
        } catch { /* a malformed vanilla file shouldn't fail our tests */ }
    }
    return found;
}

// ---------------------------------------------------------------------------------------------------------
// Player input, as the real game reported it (content log, 2026-09-20). Each helper emits the events in the
// order the game sent them, so a test exercises the same sequence a player causes.
// ---------------------------------------------------------------------------------------------------------

const heldStack = (player) => (player.holding ? { typeId: player.holding } : undefined);

/** A left-click. `source` is what the game reports: Attack (at the air or a mob), Mine (at a block). */
export function leftClick(player, source = "Attack") {
    world.afterEvents.playerSwingStart.emit({ swingSource: source, heldItemStack: heldStack(player), player });
}

/** Presses and holds right-click with the held item: itemUse, then itemStartUse. */
export function aimStart(player, useDuration = 24000) {
    const itemStack = heldStack(player);
    world.afterEvents.itemUse.emit({ itemStack, source: player });
    world.afterEvents.itemStartUse.emit({ itemStack, source: player, useDuration });
}

/** Lets go of right-click: itemReleaseUse and itemStopUse, in the same tick. */
export function aimStop(player, useDuration = 23980) {
    const itemStack = heldStack(player);
    world.afterEvents.itemReleaseUse.emit({ itemStack, source: player, useDuration });
    world.afterEvents.itemStopUse.emit({ itemStack, source: player, useDuration });
}

/**
 * Presses Q with the held item: it drops as an item entity, its slot empties, and the arm swings with source
 * DropItem, in that order and in one tick. Returns the dropped item entity.
 */
export function pressQ(player, typeId = player.holding) {
    const stack = fake.makeItemStack(typeId);
    const slot = player.selectedSlotIndex ?? 0;
    const dropped = fake.makeEntity({ typeId: "minecraft:item", itemStack: stack, location: player.location });
    world.afterEvents.entityItemDrop.emit({ entity: player, items: [dropped] });
    world.afterEvents.playerInventoryItemChange.emit({ player, slot, itemStack: undefined, beforeItemStack: stack });
    world.afterEvents.playerSwingStart.emit({ swingSource: "DropItem", heldItemStack: stack, player });
    return dropped;
}
