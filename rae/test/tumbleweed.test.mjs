import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fake, load, checks } from "./helpers.mjs";

// Tumbleweeds are ambience: a wind system spawns a few near players, blows them along, and sweeps them away
// again. Nothing in the round depends on them (systems/guns.ts's own test covers the one place gameplay
// touches them at all: a shot's ray is told to ignore them).
//
// The handler's own cadence (TUMBLEWEED.tickInterval) is read once, when systems/tumbleweed.js registers its
// onTick handler at import time, so overriding it per test has no effect — CADENCE below is that fixed,
// real cadence, and every test advances in multiples of it. Everything else in TUMBLEWEED is read fresh on
// every run and can be overridden freely.

const { TUMBLEWEED, TUMBLEWEED_ENTITY_ID, TUMBLEWEED_ROLL_PROPERTY } = await load("config/balance.js");
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
    // Spawning is desert-only now; every test but the one specifically about that gate assumes this and
    // overrides it away only for its own duration (matching how getBlockFromRay overrides work elsewhere).
    overworld().getBiome = () => ({ id: "minecraft:desert" });

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

test("a rolling tumbleweed moves in the configured wind direction and faces the way it's travelling", (t) => {
    t.mock.method(Math, "random", () => 0);   // no jitter direction, and gustChance 0 is never beaten by 0 < 0
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0, windHeadingDegrees: 0, windStrength: 1, jitter: 0, gustChance: 0 });

    try {
        const entity = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 5, y: 64, z: 5 });
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

        // Yaw faces the direction it's actually travelling (pure +Z here, so 0 degrees), not spinning on its own.
        check("yaw faces the direction of travel", Math.abs(entity.getRotation().y) < 1e-6, JSON.stringify(entity.getRotation()));
        check("pitch is left at 0 (the actual tumble is the roll property/animation, not this)", entity.getRotation().x === 0, JSON.stringify(entity.getRotation()));
    } finally {
        restore();
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The rolling animation: a bountysys:roll entity property, driven every tick (not just every handler run,
// so BountySys_RP/animations/tumbleweed.animation.json reads it as smooth rolling rather than a step every
// TUMBLEWEED.tickInterval ticks) in proportion to how far it actually moved (rolling without slipping:
// angle = distance / radius). Entity.setRotation's pitch does nothing visible on this headless model
// (confirmed by a real playtest of that first attempt) -- this is the real mechanism instead.
// ---------------------------------------------------------------------------------------------------------

test("the roll property advances in proportion to real distance moved", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 1, windHeadingDegrees: 0, windStrength: 0.05, jitter: 0, gustChance: 0 });

    try {
        runHandler(1);   // spawns one and folds it into `known` within that same run
        const [weed] = weeds();
        check("(setup) one spawned", weed !== undefined);
        if (!weed) return done();

        const before = weed.getProperty(TUMBLEWEED_ROLL_PROPERTY);
        const startZ = weed.location.z;

        fake.advance(5);   // the roll handler is guaranteed to run on every one of these, unlike the slower one

        const moved = weed.location.z - startZ;
        const expectedDelta = (moved / TUMBLEWEED.radius) * (180 / Math.PI);
        const actualDelta = weed.getProperty(TUMBLEWEED_ROLL_PROPERTY) - before;

        check("it actually moved (a meaningful check needs it to)", moved > 0, String(moved));
        check("the roll advanced by (distance moved / radius) in degrees, not a fixed rate", Math.abs(actualDelta - expectedDelta) < 1e-6, `delta=${actualDelta} expected=${expectedDelta} (moved ${moved})`);
    } finally {
        restore();
    }
    done();
});

test("the roll property stays within [0, 360) even after far more than one full turn's worth of travel", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 1, windHeadingDegrees: 0, windStrength: 2, jitter: 0, gustChance: 0, despawnDistance: 100000 });

    try {
        runHandler(1);
        const [weed] = weeds();
        check("(setup) one spawned", weed !== undefined);
        if (!weed) return done();

        fake.advance(50 * CADENCE);   // far enough to have turned many full circles at this speed (despawnDistance
                                       // is neutralized above so travelling this far doesn't remove it mid-test)

        const synced = weed.getProperty(TUMBLEWEED_ROLL_PROPERTY);
        check("wrapped into [0, 360), not left to grow unbounded (setProperty throws outside a property's declared range in the real game)", typeof synced === "number" && synced >= 0 && synced < 360, String(synced));
    } finally {
        restore();
    }
    done();
});

test("the roll stops advancing once it stops actually moving, even though the animation keeps being driven every tick", () => {
    const { check, done } = checks();
    // windStrength/jitter/gustChance all zeroed: maxActive: 0 only stops NEW spawns, and pushOne still runs
    // on this existing one every handler run regardless — with the wind inert, that's just a harmless
    // velocity no-op, leaving the teleports below as the only thing that actually moves it.
    const { restore } = scene({ maxActive: 0, windStrength: 0, jitter: 0, gustChance: 0 });

    try {
        const entity = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 0, y: 64, z: 0 });

        // Move it by hand, one tick at a time, so the every-tick roll handler sees real progress each time.
        for (let i = 0; i < 5; i++) {
            entity.teleport({ x: entity.location.x + 0.1, y: entity.location.y, z: entity.location.z });
            fake.advance(1);
        }
        const rolledSoFar = entity.getProperty(TUMBLEWEED_ROLL_PROPERTY);
        check("(setup) it actually rolled from real movement", typeof rolledSoFar === "number" && rolledSoFar > 0, String(rolledSoFar));

        fake.advance(10);   // now left alone: the roll handler still runs on every one of these regardless

        check("the roll property is unchanged now that it isn't actually moving", entity.getProperty(TUMBLEWEED_ROLL_PROPERTY) === rolledSoFar, `${entity.getProperty(TUMBLEWEED_ROLL_PROPERTY)} vs ${rolledSoFar}`);
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
        // scene()'s own fake.advance(1) can itself land on a due tick for the shared handler (its tick
        // count runs for the whole file, never reset per test) and spawn one before this test's setup even
        // starts. With maxAgeTicks this aggressive, that stray's unknown age would make the timing below
        // unpredictable, so clear whatever's there first and let this test's own runHandler(1) be the one
        // true "spawned by the system itself" moment it's named for.
        for (const stray of weeds()) stray.remove();

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

test("a fresh spawn lands within the configured distance of the player it spawned near, lifted above their height for real gravity to settle", (t) => {
    t.mock.method(Math, "random", () => 0.99);   // deterministic, and safely above hopChance so a hop can't sneak in and move its y
    const { check, done } = checks();
    const { player, restore } = scene({ maxActive: 1 });

    try {
        runHandler(1);
        const [weed] = weeds();
        check("one spawned", weed !== undefined);
        if (!weed) return done();

        const d = distance(player.location, weed.location);
        check("within a generous multiple of the configured range", d >= TUMBLEWEED.spawnDistanceMin * 0.3 && d <= TUMBLEWEED.spawnDistanceMax * 1.5, String(d));
        check("spawned spawnLift above the player, for gravity to settle from there (this file has no gravity of its own to simulate that)", weed.location.y === player.location.y + TUMBLEWEED.spawnLift, `${weed.location.y} vs player ${player.location.y} + ${TUMBLEWEED.spawnLift}`);
    } finally {
        restore();
    }
    done();
});

test("it has real physics on: gravity and collision, so the engine (not a script) settles and stops it", () => {
    const { check, done } = checks();

    // The fake doesn't simulate gravity or block collision at all, so this is the one part of the fix a
    // fake test can check: that the entity is actually configured to have the engine do it, in the game the
    // fake stands in for. Whether it looks right is a real-game question (the test card).
    const file = path.resolve(import.meta.dirname, "..", "..", "your_pack_name_BP", "entities", "tumbleweed.json");
    const physics = JSON.parse(readFileSync(file, "utf8"))["minecraft:entity"].components["minecraft:physics"];
    check("has_gravity and has_collision are both on", physics?.has_gravity === true && physics?.has_collision === true, JSON.stringify(physics));
    done();
});

test("a horizontal nudge every run does not fight whatever vertical velocity gravity already gave it, when it doesn't bounce", (t) => {
    t.mock.method(Math, "random", () => 0.99);   // above hopChance: isolates this from the bounce, tested separately below
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0 });

    try {
        const entity = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 0, y: 64, z: 0 });
        entity.applyImpulse({ x: 0, y: -0.5, z: 0 });   // stands in for gravity, which the fake does not simulate
        runHandler(1);
        check("the downward velocity this test gave it survived the wind nudge", entity.getVelocity().y === -0.5, JSON.stringify(entity.getVelocity()));
    } finally {
        restore();
    }
    done();
});

test("the occasional bounce adds an upward kick on top of existing velocity, only while it isn't already rising", (t) => {
    t.mock.method(Math, "random", () => 0);   // guarantees the hop's own chance roll succeeds whenever it's eligible
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0 });

    try {
        const falling = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 0, y: 64, z: 0 });
        falling.applyImpulse({ x: 0, y: -0.5, z: 0 });        // resting/falling (y <= 0): eligible for a hop

        const rising = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 10, y: 64, z: 0 });
        rising.applyImpulse({ x: 0, y: 0.3, z: 0 });          // still airborne from an earlier hop: not eligible

        runHandler(1);   // guarantees 1 or 2 handler runs within the window (never more), not exactly 1

        // Each eligible run adds exactly one hopStrength on top of what was already there — never resets it
        // to a fixed value — so after 1 or 2 runs it's somewhere between one hop's worth and two.
        const fallingY = falling.getVelocity().y;
        check("still falling: the hop's kick is added on top of the existing -0.5, not overwriting it", fallingY >= -0.5 + TUMBLEWEED.hopStrength - 1e-9 && fallingY <= -0.5 + 2 * TUMBLEWEED.hopStrength + 1e-9, String(fallingY));
        check("already rising: not hopped again, so a lucky streak can't stack into one big launch", Math.abs(rising.getVelocity().y - 0.3) < 1e-9, JSON.stringify(rising.getVelocity()));
    } finally {
        restore();
    }
    done();
});

test("no hop and no visible roll while stuck against something, judged by how far it actually moved, not by velocity", (t) => {
    t.mock.method(Math, "random", () => 0);   // would always hop and roll if the stuck check didn't suppress it
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 0 });

    try {
        const entity = overworld().spawnEntity(TUMBLEWEED_ENTITY_ID, { x: 0, y: 64, z: 0 });

        // fake.advance(CADENCE) always crosses exactly one due tick: due runs recur every CADENCE ticks,
        // so any CADENCE-long window contains exactly one, never zero or two. The first run records its
        // "last position" as (0, 0) — wherever it was the INSTANT it ran, before that run's own push had
        // any effect — then the push moves it somewhere else by the time this call returns.
        fake.advance(CADENCE);
        check("(setup) it actually made progress on the first run", entity.location.x !== 0 || entity.location.z !== 0, JSON.stringify(entity.location));

        // Simulate a wall: put it right back at (0, 0) — exactly what the first run recorded as its
        // position — with velocity reset (the fake has no real collision to hold it there otherwise), as
        // if a block had stopped it cold the instant it started moving.
        entity.teleport({ x: 0, y: entity.location.y, z: 0 });
        const rotationBefore = entity.getRotation();

        fake.advance(CADENCE);   // exactly the next due run

        check("no hop: y velocity stayed at 0, not bumped up", entity.getVelocity().y === 0, JSON.stringify(entity.getVelocity()));
        check("no roll: rotation is unchanged", entity.getRotation().x === rotationBefore.x && entity.getRotation().y === rotationBefore.y, JSON.stringify(entity.getRotation()));
    } finally {
        restore();
    }
    done();
});

test("only spawns where the candidate spot is in a desert biome; nothing spawns if nobody's near one", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 1 });
    const dim = overworld();
    const original = dim.getBiome;

    try {
        dim.getBiome = () => ({ id: "minecraft:plains" });
        runHandler(3);
        check("nothing spawns outside a desert biome", weeds().length === 0, String(weeds().length));

        dim.getBiome = () => ({ id: "minecraft:desert" });
        runHandler(1);
        check("spawns once the candidate spot is in a desert biome", weeds().length === 1, String(weeds().length));

        dim.getBiome = () => ({ id: "minecraft:desert_hills" });
        weeds()[0].remove();
        runHandler(1);
        check("desert_hills counts too", weeds().length === 1, String(weeds().length));
    } finally {
        dim.getBiome = original;
        restore();
    }
    done();
});

test("a biome lookup that throws (an unloaded chunk) is treated as 'not desert', not a crash", (t) => {
    t.mock.method(Math, "random", () => 0);
    const { check, done } = checks();
    const { restore } = scene({ maxActive: 1 });
    const dim = overworld();
    const original = dim.getBiome;

    try {
        dim.getBiome = () => { throw new Error("LocationInUnloadedChunkError: chunk not loaded"); };
        runHandler(3);
        check("no crash, and nothing spawned", weeds().length === 0, String(weeds().length));
    } finally {
        dim.getBiome = original;
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
