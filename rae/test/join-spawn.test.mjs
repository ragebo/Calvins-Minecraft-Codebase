import { test } from "node:test";
import { fake, world, load, checks } from "./helpers.mjs";

// Joining the world is not a respawn: a player who joins goes to the world's own spawn point, even if they still carry a role tag from before. A respawn
// after a death still goes to a random spawn of their side.

await load("main.js");
const { OUTLAW_SPAWNS, LAW_SPAWNS } = await load("config/world.js");
const { resetAllSystems } = await load("core/registry.js");

const WORLD_SPAWN = { x: 5, y: 66, z: -7 };
const same = (a, b) => a !== undefined && a.x === b.x && a.y === b.y && a.z === b.z;

function join(player, initialSpawn) {
    world.afterEvents.playerSpawn.emit({ player, initialSpawn });
    fake.advance(1);
}

function scene(tags) {
    fake.reset();
    resetAllSystems();
    // The fake world has no spawn point of its own; the real one answers this.
    world.getDefaultSpawnLocation = () => WORLD_SPAWN;
    return fake.makePlayer("Joiner", { tags });
}

test("a player who joins with an outlaw tag goes to the world spawn, not to an outlaw spawn", () => {
    const { check, done } = checks();
    const p = scene(["outlaw"]);
    join(p, true);
    check("one teleport, to the world spawn", p.teleports.length === 1 && same(p.teleports[0], WORLD_SPAWN), JSON.stringify(p.teleports));
    check("not an outlaw spawn", !OUTLAW_SPAWNS.some((s) => same(p.teleports.at(-1), s)));
    done();
});

test("a player who joins with a law tag, or no role at all, goes to the world spawn too", () => {
    const { check, done } = checks();
    const law = scene(["law"]);
    join(law, true);
    check("law: the world spawn", law.teleports.length === 1 && same(law.teleports[0], WORLD_SPAWN) && !LAW_SPAWNS.some((s) => same(law.teleports[0], s)), JSON.stringify(law.teleports));

    const none = scene([]);
    join(none, true);
    check("no role: the world spawn", none.teleports.length === 1 && same(none.teleports[0], WORLD_SPAWN), JSON.stringify(none.teleports));
    done();
});

test("a respawn after a death still goes to a random spawn of the player's side", () => {
    const { check, done } = checks();
    const p = scene(["outlaw"]);
    join(p, false);
    check("an outlaw spawn", p.teleports.length === 1 && OUTLAW_SPAWNS.some((s) => same(p.teleports[0], s)), JSON.stringify(p.teleports));
    done();
});
