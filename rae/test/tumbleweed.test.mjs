import { test } from "node:test";
import { fake, load, checks } from "./helpers.mjs";

// Tumbleweeds are ambience: a wind system spawns a few near players, blows them along, and sweeps them away
// again. Nothing in the round depends on them (systems/guns.ts's own test covers the one place gameplay
// touches them at all: a shot's ray is told to ignore them).
//
// The handler's own cadence (TUMBLEWEED.tickInterval) is read once, when systems/tumbleweed.js registers its
// onTick handler at import time, so overriding it per test has no effect — CADENCE below is that fixed,
// real cadence, and every test advances in multiples of it. Everything else in TUMBLEWEED is read fresh on
// every run and can be overridden freely.

const { TUMBLEWEED, TUMBLEWEED_ENTITY_ID } = await load("config/balance.js");
await load("main.js");
const { resetAllSystems, listSystems } = await load("core/registry.js");
const { tumbleweedsEnabled, toggleTumbleweeds } = await load("core/ambience.js");

const CADENCE = TUMBLEWEED.tickInterval;

const overworld = () => fake.dimension("overworld");
const weeds = () => overworld().getEntities({ type: TUMBLEWEED_ENTITY_ID });
const distance = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

/** Advances enough ticks to guarantee at least `n` handler runs, whatever tick the shared handler's phase happens to be on. */
function runHandler(n = 1) {
    fake.advance((n + 1) * CADENCE);
}

/** A clean world with one player, tumbleweeds on, and TUMBLEWEED restored to its committed values afterwards. */
function scene(overrides = {}) {
    fake.reset();
    resetAllSystems();
    if (!tumbleweedsEnabled()) toggleTumbleweeds();

    const saved = { ...TUMBLEWEED };
    Object.assign(TUMBLEWEED, overrides);

    const player = fake.makePlayer("Rancher", { location: { x: 0, y: 64, z: 0 } });
    fake.advance(1);

    return { player, restore: () => Object.assign(TUMBLEWEED, saved) };
}

test("tops up to maxActive and never spawns past it", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 3 });

    try {
        runHandler(1);
        check("at most the cap after one run", weeds().length <= 3, String(weeds().length));
        runHandler(6);
        check("reached the cap and stayed there", weeds().length === 3, String(weeds().length));
    } finally {
        restore();
    }
    done();
});

test("turning it off stops new spawns, but leaves the ones already rolling alone", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 3 });

    try {
        runHandler(6);
        check("(setup) reached the cap", weeds().length === 3, String(weeds().length));

        const before = weeds();
        toggleTumbleweeds();
        check("reports off", !tumbleweedsEnabled());

        before[0].remove();
        runHandler(3);
        check("no new one replaced it while off", weeds().length === 2, String(weeds().length));
        check("the other two are the very ones from before, untouched", before.slice(1).every((w) => w.isValid));

        toggleTumbleweeds();
        check("back on", tumbleweedsEnabled());
        runHandler(3);
        check("tops back up once it is on again", weeds().length === 3, String(weeds().length));
    } finally {
        restore();
        if (!tumbleweedsEnabled()) toggleTumbleweeds();
    }
    done();
});

test("a rolling tumbleweed moves in the configured wind direction and keeps spinning, not sideways and not standing still", (t) => {
    t.mock.method(Math, "random", () => 0);   // no jitter direction, and gustChance 0 is never beaten by 0 < 0
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0, windHeadingDegrees: 0, windStrength: 1, jitter: 0, gustChance: 0, spinDegrees: 15 });

    try {
        const entity = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 5, y: 64, z: 5 });
        const startRotation = entity.getRotation().y;
        const totalTicks = 5 * CADENCE;

        fake.advance(totalTicks);

        // windHeadingDegrees 0 points toward +Z. Velocity is refreshed to the same constant vector every
        // handler run and applied every tick in between (no drag in the fake's default physics), so the
        // total displacement after `totalTicks` ticks of a steady wind is (close to) windStrength * totalTicks.
        // Velocity is 0 until the first handler run happens to land (up to one CADENCE away, depending on
        // the shared handler's phase), so the shortfall from a perfect totalTicks-worth of movement is at
        // most one CADENCE.
        check("moved toward +Z by roughly windStrength * ticks elapsed", Math.abs(entity.location.z - 5 - totalTicks) < 1.5 * CADENCE + 1, JSON.stringify(entity.location));
        check("no sideways drift (no jitter, wind is pure +Z)", Math.abs(entity.location.x - 5) < 1e-6, JSON.stringify(entity.location));

        const spun = ((entity.getRotation().y - startRotation) % 360 + 360) % 360;
        check("it spun by a whole number of spinDegrees steps, and at least once", spun > 0 && Math.abs(spun % 15) < 1e-6, JSON.stringify({ spun }));
    } finally {
        restore();
    }
    done();
});

test("despawns once farther than despawnDistance from every player", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0, despawnDistance: 20, maxAgeTicks: 100000 });

    try {
        const near = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 5, y: 64, z: 0 });
        const far = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 500, y: 64, z: 0 });

        runHandler(1);

        check("the nearby one is untouched", near.isValid);
        check("the far one is gone", !far.isValid);
    } finally {
        restore();
    }
    done();
});

test("despawns once older than maxAgeTicks, spawned by the system itself so it carries the age it really would", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 1, maxAgeTicks: 5, despawnDistance: 100000 });

    try {
        runHandler(1);
        check("(setup) one spawned", weeds().length === 1, String(weeds().length));
        const born = weeds()[0].getDynamicProperty("bornTick");

        // Stop it being replaced the instant it despawns (maxActive: 1 would top it right back up in the
        // very same run), so the count really does reach zero rather than staying at a freshly-born one.
        TUMBLEWEED.maxActive = 0;

        runHandler(3);
        check(`the tick it was born on was recorded (${born})`, typeof born === "number");
        check("gone once older than maxAgeTicks, and nothing replaced it", weeds().length === 0, String(weeds().length));
    } finally {
        restore();
    }
    done();
});

test("a fresh spawn lands within the configured distance of the player it spawned near, not at the origin or nowhere", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { player, restore } = scene({ maxActive: 1 });

    try {
        runHandler(1);
        const [weed] = weeds();
        check("one spawned", weed !== undefined);
        if (!weed) return done();

        const d = distance(player.location, weed.location);
        check("within a generous multiple of the configured range", d >= TUMBLEWEED.spawnDistanceMin * 0.3 && d <= TUMBLEWEED.spawnDistanceMax * 1.5, String(d));
    } finally {
        restore();
    }
    done();
});

test("hugs the ground: with no block collision to rest it, a ray straight down decides its height every run", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0 });
    const dim = overworld();
    const original = dim.getBlockFromRay;
    const GROUND_Y = 70;
    let surface = GROUND_Y;

    try {
        // faceLocation.y: 0 makes groundY() (block.location.y + faceLocation.y) equal `surface` exactly.
        dim.getBlockFromRay = (origin) => ({ block: { location: { x: Math.floor(origin.x), y: surface, z: Math.floor(origin.z) } }, faceLocation: { x: 0.5, y: 0, z: 0.5 } });

        // Spawned well above the "ground" this fake ray reports.
        const entity = dim.spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 0, y: 64, z: 0 });
        runHandler(1);
        check("snapped onto the found surface plus groundOffset", Math.abs(entity.location.y - (surface + TUMBLEWEED.groundOffset)) < 1e-6, String(entity.location.y));

        surface = GROUND_Y + 3;   // a slope: the next run should follow it, not just snap once and stop looking
        runHandler(1);
        check("follows a change in terrain height on the next run", Math.abs(entity.location.y - (surface + TUMBLEWEED.groundOffset)) < 1e-6, String(entity.location.y));
    } finally {
        dim.getBlockFromRay = original;
        restore();
    }
    done();
});

test("with no ground found (open air, a void, an unloaded chunk), its height is left alone rather than guessed at", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0 });

    try {
        // The fake's getBlockFromRay finds nothing by default, exactly this case.
        const entity = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 0, y: 64, z: 0 });
        runHandler(1);
        check("its height is untouched", entity.location.y === 64, String(entity.location.y));
    } finally {
        restore();
    }
    done();
});

test("the system is registered, owns no tags, and a round reset does not touch existing tumbleweeds or the toggle", () => {
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 1 });

    try {
        const tumbleweed = listSystems().find((s) => s.name === "tumbleweed");
        check("registered", tumbleweed !== undefined);
        check("no owned tags (nothing for a round reset to strip from players)", (tumbleweed?.ownedTags ?? []).length === 0);

        runHandler(1);
        check("(setup) one exists", weeds().length === 1, String(weeds().length));
        toggleTumbleweeds();

        resetAllSystems();

        check("still there after a round reset", weeds().length === 1);
        check("the toggle survived the reset too", !tumbleweedsEnabled());
    } finally {
        restore();
        if (!tumbleweedsEnabled()) toggleTumbleweeds();
    }
    done();
});
