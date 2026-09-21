import { test } from "node:test";
import { fake, world, load, checks, leftClick, pressQ } from "./helpers.mjs";

// The shotguns fire a ray per pellet. Pellets that land on the same target are now added up and dealt as
// ONE hit: several applyDamage calls on one target in one tick can be swallowed by its post-hit
// invulnerability (vanilla ignores a repeat hit that is not bigger than the last). The rays are scripted
// here, so what is judged is what the guns system does with them.

const { GUNS, AMMO } = await load("config/guns.js");
await load("systems/guns.js");
const { listSystems } = await load("core/registry.js");

const shotguns = [GUNS.pump_shotgun, GUNS.double_barrel_shotgun];
const overworld = () => fake.dimension("overworld");
const resetGuns = () => listSystems().find((s) => s.name === "guns").reset();
const use = (p) => leftClick(p);

function armed(gun) {
    fake.reset();
    resetGuns();
    const p = fake.makePlayer("Deputy", { location: { x: 1, y: 64, z: 2 }, holding: gun.itemId });
    p.giveAmmo(AMMO[gun.ammo].itemId, 64);
    fake.advance(200);
    return p;
}

/**
 * Fires one shot with the rays answered by `answer(index, shooter)`, an array of { entity, distance }.
 * Returns the shooter and every ray the gun cast.
 */
function shoot(gun, answer, { block } = {}) {
    const p = armed(gun);
    const dim = overworld();
    const rays = [];
    const originalRay = dim.getEntitiesFromRay;
    const originalBlock = dim.getBlockFromRay;

    dim.getEntitiesFromRay = (origin, direction, options) => {
        rays.push({ origin, direction, options });
        return answer(rays.length - 1, p);
    };
    if (block) dim.getBlockFromRay = () => block;

    try { use(p); } finally { dim.getEntitiesFromRay = originalRay; dim.getBlockFromRay = originalBlock; }

    return { p, rays };
}

const mob = (id) => fake.makeEntity({ typeId: "minecraft:pillager", id });
const total = (entity) => entity.damage.reduce((sum, d) => sum + d.amount, 0);

/** A target that follows the vanilla hit window: 10 ticks in which a hit no bigger than the last one counts for nothing. */
function vanillaTarget(id) {
    const entity = mob(id);
    let health = 100, lastTick = -100, lastAmount = 0;
    entity.lost = () => 100 - health;
    entity.applyDamage = (amount, options) => {
        entity.damage.push({ amount, ...options });
        if (fake.tick - lastTick < 10) {
            if (amount <= lastAmount) return false;
            health -= amount - lastAmount;
            lastAmount = amount;
            return true;
        }
        health -= amount;
        lastTick = fake.tick;
        lastAmount = amount;
        return true;
    };
    return entity;
}

test("every pellet on one target is dealt as ONE hit of the summed damage, by the shooter", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const target = mob(`t-${gun.id}`);
        const { p, rays } = shoot(gun, () => [{ entity: target, distance: 3 }]);

        check(`${gun.id}: one ray per pellet`, rays.length === gun.pelletCount, String(rays.length));
        check(`${gun.id}: one damage call, not one per pellet`, target.damage.length === 1, String(target.damage.length));
        check(`${gun.id}: the amount is every pellet's damage added up`, target.damage[0]?.amount === gun.pelletDamage * gun.pelletCount, String(target.damage[0]?.amount));
        check(`${gun.id}: an attack by the shooter`, target.damage[0]?.cause === "entityAttack" && target.damage[0]?.damagingEntity === p);
    }
    done();
});

test("pellets split between two targets: one hit each, each for its own pellets", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const a = mob(`a-${gun.id}`);
        const b = mob(`b-${gun.id}`);
        shoot(gun, (i) => [{ entity: i % 2 === 0 ? a : b, distance: 3 }]);

        const forA = Math.ceil(gun.pelletCount / 2);
        const forB = Math.floor(gun.pelletCount / 2);
        check(`${gun.id}: A took one hit for ${forA} pellets`, a.damage.length === 1 && a.damage[0].amount === forA * gun.pelletDamage, JSON.stringify(a.damage));
        check(`${gun.id}: B took one hit for ${forB} pellets`, b.damage.length === 1 && b.damage[0].amount === forB * gun.pelletDamage, JSON.stringify(b.damage));
    }
    done();
});

test("pellets that miss add nothing, and a shot that misses entirely deals nothing", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const target = mob(`t-${gun.id}`);
        const hitting = Array.from({ length: gun.pelletCount }, (_, i) => i).filter((i) => i % 4 === 0).length;
        shoot(gun, (i) => (i % 4 === 0 ? [{ entity: target, distance: 3 }] : []));
        check(`${gun.id}: only the pellets that landed count`, target.damage.length === 1 && target.damage[0].amount === hitting * gun.pelletDamage, JSON.stringify(target.damage));

        const bystander = mob(`b-${gun.id}`);
        let threw = null;
        try { shoot(gun, () => []); } catch (e) { threw = e; }
        check(`${gun.id}: a full miss doesn't throw`, threw === null, String(threw));
        check(`${gun.id}: and hurts nobody`, bystander.damage.length === 0);
    }
    done();
});

test("the shooter is never hit, and the closest thing on a ray takes the pellet", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;
    const near = mob("near");
    const far = mob("far");
    const { p } = shoot(gun, (_, shooter) => [
        { entity: far, distance: 6 },
        { entity: shooter, distance: 0.5 },
        { entity: near, distance: 2 }
    ]);

    check("the closest target took every pellet", total(near) === gun.pelletDamage * gun.pelletCount, String(total(near)));
    check("the one behind it took none", far.damage.length === 0);
    check("the shooter took none", p.damage.length === 0);
    done();
});

test("rays stop at the gun's range, or at the first block if that is nearer", () => {
    const { check, done } = checks();
    const gun = GUNS.double_barrel_shotgun;

    const open = shoot(gun, () => []);
    check("open air: the gun's range", open.rays.every((r) => r.options.maxDistance === gun.range), JSON.stringify(open.rays.map((r) => r.options.maxDistance)));

    // The shooter's head is at (1, 65.6, 2); a block face 3 blocks straight ahead of it.
    const walled = shoot(gun, () => [], { block: { block: { location: { x: 1, y: 65.6, z: 5 } }, faceLocation: { x: 0, y: 0, z: 0 } } });
    check("a wall 3 blocks away: the rays stop there", walled.rays.every((r) => Math.abs(r.options.maxDistance - 3) < 1e-9), JSON.stringify(walled.rays.map((r) => r.options.maxDistance)));
    done();
});

test("a target that became invalid between the rays and the damage is skipped, without an error", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const target = mob(`gone-${gun.id}`);
        let threw = null;
        try {
            shoot(gun, (i) => {
                if (i === gun.pelletCount - 1) target.isValid = false;      // removed by something that ran meanwhile
                return [{ entity: target, distance: 3 }];
            });
        } catch (e) { threw = e; }

        check(`${gun.id}: no error`, threw === null, String(threw));
        check(`${gun.id}: nothing was dealt to it`, target.damage.length === 0);
    }
    done();
});

test("against a target that ignores repeat hits in the vanilla window, the whole blast still lands", () => {
    const { check, done } = checks();
    for (const gun of shotguns) {
        const target = vanillaTarget(`v-${gun.id}`);
        shoot(gun, () => [{ entity: target, distance: 2 }]);

        // One pellet at a time, this target would lose all but the first pellet's damage.
        check(`${gun.id}: it lost the full ${gun.pelletCount * gun.pelletDamage}, not one pellet's ${gun.pelletDamage}`, target.lost() === gun.pelletCount * gun.pelletDamage, `lost ${target.lost()}`);
    }
    done();
});
