import { test } from "node:test";
import { fake, system, load, checks, strip } from "./helpers.mjs";

// Characterization of the train robbery's pace. The train moves on its own cadence
// (TRAIN.moveIntervalTicks, counted from the moment the robbery starts), which is finer than
// the 20-tick shared loop. Halving its speed would be visible in game, so this pins it.
// It runs against the compiled game code, so it survives however the loop is scheduled.

const { TRAIN } = await load("config/balance.js");
const { TRAIN_START, TRAIN_END } = await load("config/world.js");
await load("systems/train.js");
const { listSystems } = await load("core/registry.js");
const { getActiveEvent } = await load("core/eventLock.js");

// Structure names are saved in the world with /structure save; they are not config.
const TRAIN_STRUCTURE = "mystructure:train";
const BACKUP_PREFIX = "mystructure:track_backup_";

const INTERVAL = TRAIN.moveIntervalTicks;

// The stops along the track, computed the same way train.ts does from the config.
const DX = TRAIN_END.x - TRAIN_START.x, DY = TRAIN_END.y - TRAIN_START.y, DZ = TRAIN_END.z - TRAIN_START.z;
const STEPS = Math.max(1, Math.round(Math.sqrt(DX * DX + DY * DY + DZ * DZ) / TRAIN.stepSize));
const stop = (i) => ({
    x: Math.round(TRAIN_START.x + DX * (i / STEPS)),
    y: Math.round(TRAIN_START.y + DY * (i / STEPS)),
    z: Math.round(TRAIN_START.z + DZ * (i / STEPS))
});

// Interval runs after the start: STEPS moves, then one more that finds the end of the track.
const MOVES = STEPS;
const FINISH_PASS = STEPS + 1;

const overworld = fake.dimension("overworld");

// Every command with the tick it ran on (the fake only keeps the text).
const log = [];
const realRunCommand = overworld.runCommand;
overworld.runCommand = (command) => { log.push({ tick: fake.tick, command }); return realRunCommand.call(overworld, command); };

// A vault chest for the finish to fill; the fake world has no blocks.
overworld.getBlock = () => ({ getComponent: (id) => (id === "minecraft:inventory" ? { container: {} } : undefined) });

/** The structure commands, parsed: { tick, kind: place | restore | backup, index?, at }. */
function structureCommands() {
    const parsed = [];
    for (const { tick, command } of log) {
        const m = /^structure (load|save) "([^"]+)" (-?\d+) (-?\d+) (-?\d+)/.exec(command);
        if (!m) continue;
        const [, verb, name, x, y, z] = m;
        const at = { x: Number(x), y: Number(y), z: Number(z) };
        if (verb === "load" && name === TRAIN_STRUCTURE) { parsed.push({ tick, kind: "place", at }); continue; }
        if (name.startsWith(BACKUP_PREFIX)) {
            parsed.push({ tick, kind: verb === "load" ? "restore" : "backup", index: Number(name.slice(BACKUP_PREFIX.length)), at });
        }
    }
    return parsed;
}

const at = (tick) => structureCommands().filter((c) => c.tick === tick);
const chat = () => fake.chat.map(strip);
const guards = () => overworld.getEntities({ tags: ["train_guard"] });
const errors = () => fake.chat.filter((m) => m.includes("§c["));

/** A quiet world with the train system reset, started from a tick that is off both the 10 and the 20 grid. */
function scene() {
    fake.advance(TRAIN.bridgeRestoreDelayTicks + TRAIN.cleanupDelayTicks);      // let any leftover timeouts play out
    fake.reset();
    for (const name of ["train", "event-lock"]) listSystems().find((s) => s.name === name).reset();
    fake.advanceTo(Math.ceil(fake.tick / 20) * 20 + 3);
    log.length = 0;
}

function startRobbery() {
    const t0 = fake.tick;
    system.afterEvents.scriptEventReceive.emit({ id: "bounty:train" });
    return t0;
}

test("config sanity: the numbers this test derives from", () => {
    const { check, done } = checks();
    check("the move interval is a whole number of ticks, at least 1", Number.isInteger(INTERVAL) && INTERVAL >= 1, `(${INTERVAL})`);
    check("the track has at least one move", MOVES >= 1, `(${MOVES})`);
    done();
});

test("start places the train, then it moves every moveIntervalTicks, restoring the old spot before placing the new one", () => {
    const { check, done } = checks();
    scene();
    const t0 = startRobbery();

    check("departure is announced", chat().includes("The train is moving out!"), chat().join(" | "));
    check("the bridge is blown at the start", overworld.explosions.length === 1 && overworld.filled.length === 1);
    check("start: the first stop is backed up, then the train placed there",
        JSON.stringify(at(t0).map((c) => [c.kind, c.at])) === JSON.stringify([["backup", stop(0)], ["place", stop(0)]]),
        JSON.stringify(at(t0)));

    // Nothing moves before the first interval elapses...
    fake.advance(INTERVAL - 1);
    check("nothing moves before the first interval", structureCommands().length === 2, `(${structureCommands().length} commands)`);

    // ...then one move every INTERVAL ticks, counted from the start (not from a fixed grid).
    fake.advanceTo(t0 + FINISH_PASS * INTERVAL - 1);
    for (let i = 1; i <= MOVES; i++) {
        const tick = t0 + i * INTERVAL;
        const moves = at(tick);
        check(`move ${i} runs exactly ${i * INTERVAL} ticks after the start`, moves.length === 3, `(${moves.length} commands at tick +${tick - t0})`);
        check(`move ${i}: restore the previous spot, back up the next, then place the train (in that order)`,
            JSON.stringify(moves.map((c) => [c.kind, c.index ?? null, c.at])) ===
            JSON.stringify([["restore", i - 1, stop(i - 1)], ["backup", i, stop(i)], ["place", null, stop(i)]]),
            JSON.stringify(moves));
    }
    const ticks = [...new Set(structureCommands().map((c) => c.tick - t0))];
    check("no train command runs on any other tick",
        JSON.stringify(ticks) === JSON.stringify(Array.from({ length: MOVES + 1 }, (_, i) => i * INTERVAL)), JSON.stringify(ticks));
    check("no errors so far", errors().length === 0, errors().join(" | "));

    // A second start while it is running is refused and must not add a second mover.
    system.afterEvents.scriptEventReceive.emit({ id: "bounty:train" });
    check("a second start is refused", chat().includes("A train robbery is already in progress."));
    check("...and the lock is still held", getActiveEvent() === "train");
    done();
});

test("the finish comes one interval after the last move: vault opens, guards spawn, the mover stops, cleanup follows", () => {
    const { check, done } = checks();
    scene();
    const t0 = startRobbery();
    const finish = t0 + FINISH_PASS * INTERVAL;

    fake.advanceTo(finish - 1);
    check("before the finish: no guards, vault closed", guards().length === 0 && !chat().includes("The vault chest is full of gold!"));

    fake.advanceTo(finish);
    check("the vault is filled", chat().includes("The vault chest is full of gold!") && log.some((l) => l.tick === finish && l.command.startsWith("loot insert")));
    check("the vault car opening is announced", chat().some((m) => m.includes("The vault car is open!")));
    check("the guards spawn", guards().length === TRAIN.guardCount && overworld.spawned.every((e) => e.typeId === "minecraft:pillager"), `(${guards().length} guards)`);
    check("the finish places no train", at(finish).length === 0, JSON.stringify(at(finish)));

    // The mover has stopped itself: no more train commands until the cleanup.
    const before = structureCommands().length;
    fake.advanceTo(finish + TRAIN.cleanupDelayTicks - 1);
    check("the mover stopped itself (no train commands before the cleanup)", structureCommands().length === before, `(${structureCommands().length - before} extra)`);
    check("the lock is held until the cleanup", getActiveEvent() === "train");

    fake.advanceTo(finish + TRAIN.cleanupDelayTicks);
    const cleanup = at(finish + TRAIN.cleanupDelayTicks);
    check("cleanup restores the last stop", JSON.stringify(cleanup.map((c) => [c.kind, c.index, c.at])) === JSON.stringify([["restore", STEPS, stop(STEPS)]]), JSON.stringify(cleanup));
    check("cleanup removes the guards and says so", guards().length === 0 && chat().includes("The train has been cleaned up."));
    check("cleanup releases the lock", getActiveEvent() === null);
    check("no errors in the whole run", errors().length === 0, errors().join(" | "));

    // ...and a new robbery can start afterwards, at the same pace.
    fake.advance(3);
    log.length = 0;
    const t1 = startRobbery();
    fake.advanceTo(t1 + INTERVAL);
    check("a second robbery moves at the same pace", at(t1 + INTERVAL).length === 3, JSON.stringify(at(t1 + INTERVAL)));
    fake.advanceTo(t1 + 2 * INTERVAL);
    check("...and keeps moving", at(t1 + 2 * INTERVAL).length === 3);
    done();
});

test("resetting the system mid-robbery stops the train dead", () => {
    const { check, done } = checks();
    scene();
    const t0 = startRobbery();
    fake.advanceTo(t0 + 2 * INTERVAL);
    check("(setup) it was moving", at(t0 + 2 * INTERVAL).length === 3);

    const before = structureCommands().length;
    listSystems().find((s) => s.name === "train").reset();
    fake.advance(INTERVAL * 5);
    check("no more moves after a reset", structureCommands().length === before, `(${structureCommands().length - before} extra)`);

    // A reset train can start over (the round reset also clears the lock).
    listSystems().find((s) => s.name === "event-lock").reset();
    log.length = 0;
    fake.advance(3);
    const t1 = startRobbery();
    fake.advanceTo(t1 + INTERVAL);
    check("a robbery started after the reset moves at the normal pace", at(t1 + INTERVAL).length === 3, JSON.stringify(at(t1 + INTERVAL)));
    listSystems().find((s) => s.name === "train").reset();
    done();
});

test("a robbery that breaks stops itself, frees the lock and reports it", () => {
    const { check, done } = checks();
    scene();
    const t0 = startRobbery();
    const finish = t0 + FINISH_PASS * INTERVAL;

    // Spawning the guards at the finish is the one step with no guard of its own.
    const realSpawn = overworld.spawnEntity;
    overworld.spawnEntity = () => { throw new Error("boom"); };
    try {
        fake.advanceTo(finish - 1);
        check("(setup) still running one tick before the finish", getActiveEvent() === "train");
        fake.advanceTo(finish);
    } finally {
        overworld.spawnEntity = realSpawn;
    }
    check("the failure is reported", chat().some((m) => m.startsWith("[TRAIN ERROR] Robbery stopped:") && m.includes("boom")), chat().join(" | "));
    check("the lock is released", getActiveEvent() === null);

    const before = structureCommands().length;
    fake.advance(INTERVAL * 5);
    check("nothing runs afterwards", structureCommands().length === before, `(${structureCommands().length - before} extra)`);
    done();
});
