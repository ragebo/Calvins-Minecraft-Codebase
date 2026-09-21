import { test } from "node:test";
import { fake, load, checks, leftClick } from "./helpers.mjs";

// A shotgun has no bullet to watch, so a shot is drawn with particles: a flash and smoke at the muzzle, a trail along
// every pellet's path, and a puff where a pellet ends on something. Whether the particles LOOK right is for the game
// (docs/test-cards/SHOTGUN-EFFECTS.md); these tests check where they are spawned, how many, and that a wrong id or a
// silly config value can never break a shot.

const { GUNS, AMMO } = await load("config/guns.js");
await load("systems/guns.js");
const { listSystems } = await load("core/registry.js");

const shotguns = [GUNS.pump_shotgun, GUNS.double_barrel_shotgun];
const others = Object.values(GUNS).filter((g) => g.kind !== "hitscan");
const overworld = () => fake.dimension("overworld");
const resetGuns = () => listSystems().find((s) => s.name === "guns").reset();

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const HEAD = { x: 1, y: 64 + 1.6, z: 2 };                 // the fake's player stands at (1, 64, 2), head 1.6 up, facing +Z

function armed(gun) {
    fake.reset();
    resetGuns();
    warnings.length = 0;
    const p = fake.makePlayer("Deputy", { location: { x: 1, y: 64, z: 2 }, holding: gun.itemId });
    p.giveAmmo(AMMO[gun.ammo].itemId, 64);
    fake.advance(200);
    overworld().particles.length = 0;
    return p;
}

/** Fires once with the spread at zero (every pellet flies straight ahead) and the rays answered as given. */
function shoot(gun, { entityAt, block } = {}) {
    const p = armed(gun);
    const dim = overworld();
    const spread = gun.spreadDegrees;
    const originalRay = dim.getEntitiesFromRay;
    const originalBlock = dim.getBlockFromRay;

    gun.spreadDegrees = 0;
    if (entityAt !== undefined) dim.getEntitiesFromRay = () => [{ entity: fake.makeEntity({ typeId: "minecraft:pillager" }), distance: entityAt }];
    if (block) dim.getBlockFromRay = () => block;

    try { leftClick(p); } finally { gun.spreadDegrees = spread; dim.getEntitiesFromRay = originalRay; dim.getBlockFromRay = originalBlock; }
    return { p, particles: [...dim.particles] };
}

const byId = (particles, id) => particles.filter((q) => q.id === id);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test("a shot draws the muzzle flash and smoke just in front of the barrel", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const { particles } = shoot(gun);
        const fx = gun.effects;
        const expected = { x: HEAD.x, y: HEAD.y - 0.2, z: HEAD.z + fx.muzzleDistance };
        const muzzle = particles.slice(0, fx.muzzle.length);

        check(`${gun.id}: one particle per configured muzzle effect, in order`, muzzle.map((q) => q.id).join() === fx.muzzle.join(), muzzle.map((q) => q.id).join());
        check(`${gun.id}: all at the barrel (${fx.muzzleDistance} blocks ahead of the eyes, a little below)`, muzzle.every((q) => near(q.location.x, expected.x) && near(q.location.y, expected.y) && near(q.location.z, expected.z)), JSON.stringify(muzzle.map((q) => q.location)));
        check(`${gun.id}: the shot has both a flash and smoke`, fx.muzzle.some((id) => id.includes("flame")) && fx.muzzle.some((id) => id.includes("smoke")), fx.muzzle.join());
    }
    done();
});

test("every pellet leaves a trail along its path, one particle every trailSpacing blocks, up to its range", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const { particles } = shoot(gun);
        const fx = gun.effects;
        const trail = byId(particles, fx.trail).filter((q) => !fx.muzzle.includes(q.id) || true);

        // Distances spacing, 2 * spacing, ... below the range.
        const distances = [];
        for (let d = fx.trailSpacing; d < gun.range; d += fx.trailSpacing) distances.push(d);

        check(`${gun.id}: ${distances.length} particles per pellet, ${gun.pelletCount} pellets`, trail.length === distances.length * gun.pelletCount, `${trail.length} vs ${distances.length * gun.pelletCount}`);
        const zs = [...new Set(trail.map((q) => Math.round((q.location.z - HEAD.z) * 1000) / 1000))].sort((a, b) => a - b);
        check(`${gun.id}: at ${distances.join(", ")} blocks along the aim`, zs.join() === distances.join(), zs.join());
        check(`${gun.id}: on the line of the aim (spread is zero here)`, trail.every((q) => near(q.location.x, HEAD.x) && near(q.location.y, HEAD.y)));
        check(`${gun.id}: nothing beyond the range`, trail.every((q) => q.location.z - HEAD.z < gun.range));
        check(`${gun.id}: a pellet that ran out of range with nothing in the way leaves no impact puff`, byId(particles, fx.impact).length === fx.muzzle.filter((id) => id === fx.impact).length, JSON.stringify(byId(particles, fx.impact).length));
    }
    done();
});

test("a spread shot draws different paths: the trails fan out with the pellets", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;
    const p = armed(gun);
    leftClick(p);
    const trail = byId(overworld().particles, gun.effects.trail);
    const xs = new Set(trail.map((q) => Math.round(q.location.x * 100)));
    check("more than one path (not all on one line)", xs.size > gun.pelletCount, `${xs.size} different x positions`);
    const widest = Math.max(...trail.map((q) => Math.abs(q.location.x - HEAD.x)));
    check("and the fan is inside the spread cone at the range", widest <= Math.tan((gun.spreadDegrees * Math.PI) / 180) * gun.range + 1e-6, String(widest));
    done();
});

test("a pellet that hits a target ends there: the trail stops and a puff appears at the target", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const { particles } = shoot(gun, { entityAt: 5 });
        const fx = gun.effects;
        const trail = byId(particles, fx.trail);
        const impacts = byId(particles, fx.impact).filter((q) => near(q.location.z, HEAD.z + 5));

        const expectedTrail = [];
        for (let d = fx.trailSpacing; d < 5; d += fx.trailSpacing) expectedTrail.push(d);
        check(`${gun.id}: the trail covers only the first ${expectedTrail.length} points`, trail.length === expectedTrail.length * gun.pelletCount, `${trail.length}`);
        check(`${gun.id}: a puff at the target for every pellet`, impacts.length === gun.pelletCount, `${impacts.length}`);
    }
    done();
});

test("a pellet that hits a block ends at the block", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;
    // The block is at (1, 65, 9) and the ray meets it at its face point (0.5, 0.5, 0): 7 blocks and a bit from the eyes.
    const block = { block: { location: { x: 1, y: 65, z: 9 } }, faceLocation: { x: 0.5, y: 0.5, z: 0 } };
    const length = Math.hypot(1.5 - HEAD.x, 65.5 - HEAD.y, 9 - HEAD.z);
    const { particles } = shoot(gun, { block });
    const fx = gun.effects;

    const expected = [];
    for (let d = fx.trailSpacing; d < length; d += fx.trailSpacing) expected.push(d);
    check("the trail stops at the block", byId(particles, fx.trail).length === expected.length * gun.pelletCount, `${byId(particles, fx.trail).length} vs ${expected.length * gun.pelletCount}`);
    const puffs = byId(particles, fx.impact).filter((q) => near(q.location.z, HEAD.z + length, 1e-6));
    check("and a puff there for every pellet", puffs.length === gun.pelletCount, `${puffs.length}`);
    done();
});

test("the other guns draw no particles", () => {
    const { check, done } = checks();
    for (const gun of others) {
        const p = armed(gun);
        leftClick(p);
        check(`${gun.id}: none`, overworld().particles.length === 0, String(overworld().particles.length));
    }
    done();
});

test("every shot is drawn again, and an empty click or a swing that does not fire draws nothing", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;
    const p = armed(gun);

    leftClick(p);
    const first = overworld().particles.length;
    check("the first shot draws", first > 0);
    leftClick(p);
    check("a second click inside the fire rate does not fire and does not draw", overworld().particles.length === first);
    fake.advance(gun.fireRateTicks);
    leftClick(p);
    check("the next real shot draws again", overworld().particles.length === first * 2, `${overworld().particles.length} vs ${first * 2}`);

    const q = armed(gun);
    q.holding = "minecraft:stick";
    leftClick(q);
    check("a click with something else in hand draws nothing", overworld().particles.length === 0);
    done();
});

test("a wrong particle id never breaks the shot, the damage still lands, and it is reported once", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;
    const originalTrail = gun.effects.trail;
    const dim = overworld();
    const original = dim.spawnParticle;

    try {
        gun.effects.trail = "minecraft:not_a_real_particle";
        dim.spawnParticle = (id, location) => {
            if (id === "minecraft:not_a_real_particle") throw new Error(`unknown particle ${id}`);
            original.call(dim, id, location);
        };

        const p = armed(gun);
        const target = fake.makeEntity({ typeId: "minecraft:pillager" });
        const rays = dim.getEntitiesFromRay;
        dim.getEntitiesFromRay = () => [{ entity: target, distance: 4 }];
        let threw = null;
        try { leftClick(p); fake.advance(gun.fireRateTicks); leftClick(p); } catch (e) { threw = e; }
        dim.getEntitiesFromRay = rays;

        check("nothing is thrown", threw === null, threw ? String(threw) : "");
        check("both shots still hurt the target", target.damage.length === 2 && target.damage.every((d) => d.amount === gun.pelletDamage * gun.pelletCount), JSON.stringify(target.damage));
        check("the other effects still draw", byId(dim.particles, gun.effects.muzzle[0]).length >= 2);
        check("the bad id is reported once, not on every particle of every shot", warnings.filter((w) => w.includes("[gun effects] minecraft:not_a_real_particle failed")).length === 1, warnings.join("|"));
    } finally {
        gun.effects.trail = originalTrail;
        dim.spawnParticle = original;
    }
    done();
});

test("a spacing of zero, a negative number or NaN in the config cannot hang the shot", () => {
    const { check, done } = checks();
    const gun = GUNS.double_barrel_shotgun;
    const original = gun.effects.trailSpacing;

    try {
        for (const spacing of [0, -1, NaN, 1e-9]) {
            gun.effects.trailSpacing = spacing;
            const { particles } = shoot(gun);
            const trail = byId(particles, gun.effects.trail);
            const perPellet = trail.length / gun.pelletCount;
            check(`spacing ${spacing}: the shot finishes, with a bounded trail (at most ${Math.ceil(gun.range / 0.25)} points a pellet)`, perPellet <= Math.ceil(gun.range / 0.25) && perPellet > 0, `${perPellet}`);
        }
    } finally { gun.effects.trailSpacing = original; }
    done();
});

test("the effects config is sane: vanilla ids, a muzzle distance and spacing that mean something", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const fx = gun.effects;
        for (const id of [...fx.muzzle, fx.trail, fx.impact]) check(`${gun.id}: ${id} is a namespaced id`, /^minecraft:[a-z_]+$/.test(id));
        check(`${gun.id}: the muzzle is in front of the player, not inside them`, fx.muzzleDistance > 0.3 && fx.muzzleDistance < 3, String(fx.muzzleDistance));
        check(`${gun.id}: the trail spacing is between 0.25 and the range`, fx.trailSpacing >= 0.25 && fx.trailSpacing < gun.range, String(fx.trailSpacing));
        check(`${gun.id}: the cost of a shot stays small (under 150 particles)`, fx.muzzle.length + gun.pelletCount * (Math.ceil(gun.range / fx.trailSpacing) + 1) < 150, String(fx.muzzle.length + gun.pelletCount * (Math.ceil(gun.range / fx.trailSpacing) + 1)));
    }
    done();
});
