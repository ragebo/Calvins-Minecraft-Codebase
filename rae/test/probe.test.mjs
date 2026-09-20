import { test } from "node:test";
import { fake, system, load, checks, strip } from "./helpers.mjs";

// `/scriptevent rae:probe_damage` measures how the engine treats repeated hits, on a cow it spawns.
// These tests can't say what the real engine does. They check that the probe MEASURES correctly: they
// give it targets that behave each of the two possible ways and see that it reports each one, and that
// it sequences, cleans up and stops the way a tool that spawns entities has to.

const { DAMAGE_PROBE: P } = await load("config/balance.js");
await load("systems/probe.js");
const { resetAllSystems } = await load("core/registry.js");
const { listScriptEvents } = await load("core/events.js");

const overworld = fake.dimension("overworld");
const HEALTH = 10;

/**
 * A target that follows one of two behaviours.
 *   stacks   every hit lands
 *   vanilla  for 10 ticks after a hit, a hit no bigger than the last one is ignored (returns false) and a
 *            bigger one deals only the difference
 */
function makeTarget(model, type, location) {
    const entity = fake.makeEntity({ typeId: type, location });
    let health = HEALTH, lastTick = -100, lastAmount = 0;

    entity.getComponent = (id) => (id === "minecraft:health" ? { get currentValue() { return health; } } : undefined);
    entity.applyDamage = (amount, options) => {
        entity.damage.push({ amount, ...options });
        if (model === "vanilla" && fake.tick - lastTick < 10) {
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

/** Runs the probe to the end against targets of `model`; returns everything a test wants to look at. */
function runProbe(model, { spawn } = {}) {
    fake.reset();
    resetAllSystems();

    const spawned = [];
    const warnings = [];
    const originalSpawn = overworld.spawnEntity;
    const originalWarn = console.warn;

    overworld.spawnEntity = spawn ?? ((type, location) => {
        const target = makeTarget(model, type, location);
        spawned.push({ type, location, target });
        return target;
    });
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
        const p = fake.makePlayer("Calvin", { location: { x: 0, y: 64, z: 0 }, facing: { x: 0, y: 0, z: 1 } });
        system.afterEvents.scriptEventReceive.emit({ id: "rae:probe_damage", sourceEntity: p, message: "" });
        fake.advance(3000);
        return { p, spawned, warnings, lines: p.messages.map(strip) };
    } finally {
        overworld.spawnEntity = originalSpawn;
        console.warn = originalWarn;
    }
}

const lineFor = (lines, letter) => lines.find((l) => l.startsWith(`${letter}:`)) ?? "";

test("rae:probe_damage is a registered script event", () => {
    const { check, done } = checks();
    check("registered", listScriptEvents().includes("rae:probe_damage"), listScriptEvents().join());
    done();
});

test("against a target where every hit lands, it reports that they add up, and no scenario loses damage", () => {
    const { check, done } = checks();
    const { lines } = runProbe("stacks");
    const n = P.hits, u = P.unitDamage;

    check("A: all hits counted", lineFor(lines, "A").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "A"));
    check("A: every call returned true", lineFor(lines, "A").includes(`returned ${Array(n).fill("true").join(", ")}`), lineFor(lines, "A"));
    check("B: one summed hit", lineFor(lines, "B").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "B"));
    check("C: spaced hits", lineFor(lines, "C").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "C"));
    check("D: the double tap", lineFor(lines, "D").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "D"));
    check("E: a small hit then a bigger one, both land", lineFor(lines, "E").includes(`dealt ${3 * u} of ${3 * u}`), lineFor(lines, "E"));
    check("F: override", lineFor(lines, "F").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "F"));
    check("the reading says they add up", lines.some((l) => l.startsWith("Reading:") && l.includes("ADD UP")), lines.join(" | "));
    check("and warns about nothing", !lines.some((l) => l.includes("lost damage")), lines.join(" | "));
    done();
});

test("against a target with the vanilla hit window, it shows the pellets being swallowed and says what to do", () => {
    const { check, done } = checks();
    const { lines } = runProbe("vanilla");
    const n = P.hits, u = P.unitDamage;

    check("A: only one hit counted", lineFor(lines, "A").includes(`dealt ${u} of ${n * u}`), lineFor(lines, "A"));
    check("A: applyDamage says so: true, then false for every other hit", lineFor(lines, "A").includes(`returned true, ${Array(n - 1).fill("false").join(", ")}`), lineFor(lines, "A"));
    check("B: one summed hit lands in full", lineFor(lines, "B").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "B"));
    check("C: hits spaced past the window all land", lineFor(lines, "C").includes(`dealt ${n * u} of ${n * u}`), lineFor(lines, "C"));
    check("D: the second shot inside the window is lost", lineFor(lines, "D").includes(`dealt ${n * u / 2} of ${n * u}`), lineFor(lines, "D"));
    check("E: only the excess of the bigger hit lands", lineFor(lines, "E").includes(`dealt ${2 * u} of ${3 * u}`), lineFor(lines, "E"));
    check("F: override behaves the same here", lineFor(lines, "F").includes(`dealt ${u} of ${n * u}`), lineFor(lines, "F"));
    check("the reading says they do NOT add up and to sum them", lines.some((l) => l.startsWith("Reading:") && l.includes("do NOT add up") && l.includes("Sum the pellets")), lines.join(" | "));
    check("it warns that a double tap loses damage", lines.some((l) => l.includes("lost damage") && l.includes(`${P.doubleTapTicks} ticks`)), lines.join(" | "));
    done();
});

test("the results reach the content log as well as chat", () => {
    const { check, done } = checks();
    const { lines, warnings } = runProbe("vanilla");

    check("every chat line is also logged", lines.every((line) => warnings.some((w) => w === `[probe] ${line}`)), JSON.stringify({ lines: lines.length, warnings: warnings.length }));
    done();
});

test("one cow per scenario, in front of the player, of the configured type, all removed afterwards", () => {
    const { check, done } = checks();
    const { p, spawned } = runProbe("vanilla");

    check("six scenarios, six targets", spawned.length === 6, String(spawned.length));
    check("each is the configured type", spawned.every((s) => s.type === P.targetType));
    check("each is placed in front of the player", spawned.every((s) => s.location.x === 0 && s.location.y === 64 && s.location.z === P.distanceInFront), JSON.stringify(spawned[0]?.location));
    check("all were removed at the end", spawned.every((s) => !s.target.isValid));
    check("the damage was done by the player", spawned.every((s) => s.target.damage.every((d) => d.damagingEntity === p)));
    check("F used the override cause, the others an attack", spawned[5].target.damage.every((d) => d.cause === "override") && spawned.slice(0, 5).every((s) => s.target.damage.every((d) => d.cause === "entityAttack")));
    done();
});

test("from a command block there is no one to stand in front of: it logs a warning and spawns nothing", () => {
    const { check, done } = checks();
    fake.reset();
    resetAllSystems();
    const spawned = [];
    const warnings = [];
    const originalSpawn = overworld.spawnEntity;
    const originalWarn = console.warn;
    overworld.spawnEntity = (type) => { spawned.push(type); return makeTarget("stacks", type); };
    console.warn = (...args) => warnings.push(args.join(" "));

    let threw = null;
    try {
        system.afterEvents.scriptEventReceive.emit({ id: "rae:probe_damage", sourceEntity: undefined, message: "" });
        fake.advance(100);
    } catch (e) { threw = e; } finally { overworld.spawnEntity = originalSpawn; console.warn = originalWarn; }

    check("no error", threw === null, String(threw));
    check("nothing spawned", spawned.length === 0);
    check("one warning saying why", warnings.length === 1 && warnings[0].includes("has to be run by a player"), JSON.stringify(warnings));
    done();
});

test("asking again while it runs is refused, and starts nothing more", () => {
    const { check, done } = checks();
    fake.reset();
    resetAllSystems();
    const spawned = [];
    const originalSpawn = overworld.spawnEntity;
    const originalWarn = console.warn;
    overworld.spawnEntity = (type, location) => { const t = makeTarget("stacks", type, location); spawned.push(t); return t; };
    console.warn = () => {};

    try {
        const p = fake.makePlayer("Calvin", { location: { x: 0, y: 64, z: 0 } });
        const ask = () => system.afterEvents.scriptEventReceive.emit({ id: "rae:probe_damage", sourceEntity: p, message: "" });
        ask();
        fake.advance(10);
        ask();
        check("told it is already running", p.messages.map(strip).includes("The damage probe is already running."), p.messages.map(strip).join(" | "));

        fake.advance(3000);
        check("the run still finished, with one cow per scenario", spawned.length === 6, String(spawned.length));

        ask();
        fake.advance(3000);
        check("and once it is over, it can be run again", spawned.length === 12, String(spawned.length));
    } finally { overworld.spawnEntity = originalSpawn; console.warn = originalWarn; }
    done();
});

// Scenario C spaces its hits 12 ticks apart, so a cow is alive for a long stretch of the run: 100 ticks in,
// scenarios A and B are over and C is under way.
const MID_RUN = 100;

test("a round reset in the middle removes the live cow and stops that run, and a new run can start at once", () => {
    const { check, done } = checks();
    fake.reset();
    resetAllSystems();
    const spawned = [];
    const originalSpawn = overworld.spawnEntity;
    const originalWarn = console.warn;
    overworld.spawnEntity = (type, location) => { const t = makeTarget("vanilla", type, location); spawned.push(t); return t; };
    console.warn = () => {};

    try {
        const p = fake.makePlayer("Calvin", { location: { x: 0, y: 64, z: 0 } });
        const ask = () => system.afterEvents.scriptEventReceive.emit({ id: "rae:probe_damage", sourceEntity: p, message: "" });
        ask();
        fake.advance(MID_RUN);
        check("(setup) three cows so far and the last one is alive", spawned.length === 3 && spawned[2].isValid, `${spawned.length} cows`);
        const before = p.messages.length;

        resetAllSystems();
        check("the live cow was removed at once", !spawned[2].isValid);

        // The stopped run still has timers pending. Start a new run straight away: they must not disturb it.
        fake.advance(1);
        ask();
        check("it is not refused as already running", !p.messages.map(strip).includes("The damage probe is already running."), p.messages.map(strip).slice(before).join(" | "));

        // Long enough for the stopped run's leftover timers (its cow was due to be read 53 ticks after
        // the reset) to have fired. If they cleared the new run's "running" flag, a second run could
        // start on top of it: so asking now must still be refused.
        fake.advance(80);
        ask();
        check("while the new run is going, another ask is refused", p.messages.map(strip).includes("The damage probe is already running."), p.messages.map(strip).slice(before).join(" | "));
        fake.advance(3000);

        check("the new run made its own six cows", spawned.length === 3 + 6, String(spawned.length));
        check("and finished, once", p.messages.map(strip).filter((l) => l.startsWith("Reading:")).length === 1, p.messages.map(strip).slice(before).join(" | "));
        check("the stopped run added nothing to chat", p.messages.map(strip).slice(before).filter((l) => l.startsWith("C:")).length === 1, "(only the new run's C line)");
        check("no cow is left", spawned.every((t) => !t.isValid));
    } finally { overworld.spawnEntity = originalSpawn; console.warn = originalWarn; }
    done();
});

test("if the player leaves in the middle, it stops quietly: no more hits for them, nothing more logged, no cow left", () => {
    const { check, done } = checks();
    fake.reset();
    resetAllSystems();
    const spawned = [];
    const warnings = [];
    const originalSpawn = overworld.spawnEntity;
    const originalWarn = console.warn;
    overworld.spawnEntity = (type, location) => { const t = makeTarget("vanilla", type, location); spawned.push(t); return t; };
    console.warn = (...args) => warnings.push(args.join(" "));

    let threw = null;
    let alive = false;
    let hitsWhenLeft = -1;
    let loggedWhenLeft = -1;
    try {
        const p = fake.makePlayer("Calvin", { location: { x: 0, y: 64, z: 0 } });
        system.afterEvents.scriptEventReceive.emit({ id: "rae:probe_damage", sourceEntity: p, message: "" });
        fake.advance(MID_RUN);
        alive = spawned.length === 3 && spawned[2].isValid;
        hitsWhenLeft = spawned[2].damage.length;
        loggedWhenLeft = warnings.length;
        p.remove();
        fake.advance(3000);
    } catch (e) { threw = e; } finally { overworld.spawnEntity = originalSpawn; console.warn = originalWarn; }

    check("(setup) a cow was alive when they left, part way through its hits", alive && hitsWhenLeft > 0 && hitsWhenLeft < 8, `alive ${alive}, ${hitsWhenLeft} hits`);
    check("no error", threw === null, String(threw));
    check("it stopped part way", spawned.length === 3, String(spawned.length));
    check("no more hits were dealt on behalf of a player who is gone", spawned[2].damage.length === hitsWhenLeft, `${hitsWhenLeft} -> ${spawned[2].damage.length}`);
    check("nothing more was logged for them", warnings.length === loggedWhenLeft, `${loggedWhenLeft} -> ${warnings.length}: ${warnings.slice(loggedWhenLeft).join(" | ")}`);
    check("no cow is left", spawned.every((t) => !t.isValid));
    done();
});

test("a target that cannot be spawned, or has no health to read, ends the probe with a line saying so", () => {
    const { check, done } = checks();

    const cannot = runProbe("stacks", { spawn: () => { throw new Error("obstructed"); } });
    check("spawn failure is reported", cannot.lines.some((l) => l.includes("could not spawn") && l.includes("obstructed")), cannot.lines.join(" | "));
    check("and it stops there", cannot.lines.length === 2, cannot.lines.join(" | "));          // the announcement and the failure

    const blind = [];
    const noHealth = runProbe("stacks", { spawn: (type, location) => { const t = fake.makeEntity({ typeId: type, location }); blind.push(t); return t; } });
    check("a missing health component is reported", noHealth.lines.some((l) => l.includes("no health component")), noHealth.lines.join(" | "));
    check("and the cow is removed", blind.every((t) => !t.isValid));

    const again = runProbe("stacks");
    check("it can be run again afterwards", again.lines.some((l) => l.startsWith("Reading:")), again.lines.join(" | "));
    done();
});
