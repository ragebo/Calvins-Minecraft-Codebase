import { test } from "node:test";
import { fake, system, load, checks, strip } from "./helpers.mjs";

// Characterization of the ranch raid's clock. The raid advances once every 20 ticks, counted from
// the moment the raid starts, and its timer is in those passes ("seconds"). Waves and the safe
// unlock are driven by that timer. This pins the cadence and every way the loop can end, against
// the compiled game code, so it survives however the loop is scheduled.

const { RANCH } = await load("config/balance.js");
const { RANCH_AREA, RANCH_SAFE_TRIGGER } = await load("config/world.js");
const LOAD_TICK = fake.tick;                            // the shared 20-tick loop's handlers count from here
await load("systems/raids.js");
const { listSystems } = await load("core/registry.js");
const { getActiveEvent } = await load("core/eventLock.js");

const PASS = 20;                                        // ticks per raid pass; the timer counts in these
const INSIDE = {
    x: (RANCH_AREA.min.x + RANCH_AREA.max.x) / 2,
    y: RANCH_AREA.min.y + 1,
    z: (RANCH_AREA.min.z + RANCH_AREA.max.z) / 2
};
const OUTSIDE = { x: 0, y: 64, z: 0 };
const PER_WAVE = 2;                                     // one raider: 1 + ceil(1) pillagers, floor(0.5) witches, floor(1/2) golems

const overworld = fake.dimension("overworld");

const log = [];
const realRunCommand = overworld.runCommand;
overworld.runCommand = (command) => { log.push({ tick: fake.tick, command }); return realRunCommand.call(overworld, command); };

const chat = () => fake.chat.map(strip);
const defenders = () => overworld.getEntities({ tags: ["ranch_defender"] });
const errors = () => fake.chat.filter((m) => m.includes("§c["));
const unlockCommand = `setblock ${RANCH_SAFE_TRIGGER.x} ${RANCH_SAFE_TRIGGER.y} ${RANCH_SAFE_TRIGGER.z} redstone_block`;
const regenCommand = `effect @s regeneration ${RANCH.regenTicks} 0 true`;
const healTicks = () => log.filter((l) => l.command === regenCommand).map((l) => l.tick);

/**
 * When, in passes after the start, each milestone happens for a raid that starts with this many
 * raiders and never changes size: the timer loses one per pass, and reinforcements stretch it.
 */
function timeline(raiders) {
    let original = RANCH.startTimeBase + raiders * RANCH.startTimePerRaider;
    let timer = original, wave = 1;
    const at = { wave2: null, wave3: null, unlock: null };
    for (let pass = 1; at.unlock === null; pass++) {
        const desired = RANCH.reinforceTimeBase + raiders * RANCH.reinforceTimePerRaider;
        if (desired > original) { timer += desired - original; original = desired; }
        timer--;
        if (wave === 1 && timer <= Math.floor(original * RANCH.wave2Threshold)) { wave = 2; at.wave2 = pass; }
        if (wave === 2 && timer <= Math.floor(original * RANCH.wave3Threshold)) { wave = 3; at.wave3 = pass; }
        if (timer <= 0) at.unlock = pass;
    }
    return at;
}

/** A quiet world with the raid systems reset, off the 20-tick grid the shared loop runs on. */
function scene() {
    fake.advance(1000);                                 // let anything left over play out
    fake.reset();
    for (const name of ["raids", "event-lock"]) listSystems().find((s) => s.name === name).reset();
    fake.advanceTo(Math.ceil(fake.tick / PASS) * PASS + 7);
    log.length = 0;
}

const startRaid = () => { const t0 = fake.tick; system.afterEvents.scriptEventReceive.emit({ id: "bounty:ranch" }); return t0; };

test("config sanity: the numbers this test derives from", () => {
    const { check, done } = checks();
    const t = timeline(1);
    check("wave 2 comes before wave 3, which comes before the unlock", t.wave2 < t.wave3 && t.wave3 < t.unlock, JSON.stringify(t));
    check("wave 2 and 3 are not the very first pass (or the first-pass spawn would hide the cadence)", t.wave2 > 1, JSON.stringify(t));
    done();
});

test("start announces and spawns wave 1 at once; waves and the safe unlock follow the timer, one pass per 20 ticks", () => {
    const { check, done } = checks();
    scene();
    const outlaw = fake.makePlayer("Bandit", { tags: ["outlaw"], location: INSIDE });
    const t0 = startRaid();
    const t = timeline(1);

    check("the raid is announced", chat().includes("Ranch raid started!") && chat().some((m) => m.startsWith("Raid Started! 1 outlaw(s).")), chat().join(" | "));
    check("wave 1 spawns immediately", overworld.spawned.length === PER_WAVE && overworld.spawned.every((e) => e.typeId === "minecraft:pillager"), `(${overworld.spawned.length} spawned)`);
    check("the spawned defenders are tagged", defenders().length === PER_WAVE);

    // Nothing happens between passes, and the first pass is a full 20 ticks after the start.
    fake.advance(PASS - 1);
    check("no pass before 20 ticks", overworld.spawned.length === PER_WAVE && log.length === healTicks().length);

    fake.advanceTo(t0 + t.wave2 * PASS - 1);
    check("wave 2 has not come the tick before it is due", overworld.spawned.length === PER_WAVE, `(${overworld.spawned.length})`);
    fake.advanceTo(t0 + t.wave2 * PASS);
    check(`wave 2 spawns on pass ${t.wave2} (${t.wave2 * PASS} ticks after the start)`, overworld.spawned.length === 2 * PER_WAVE, `(${overworld.spawned.length})`);

    fake.advanceTo(t0 + t.wave3 * PASS - 1);
    check("wave 3 has not come the tick before it is due", overworld.spawned.length === 2 * PER_WAVE, `(${overworld.spawned.length})`);
    fake.advanceTo(t0 + t.wave3 * PASS);
    check(`wave 3 spawns on pass ${t.wave3} (${t.wave3 * PASS} ticks after the start)`, overworld.spawned.length === 3 * PER_WAVE, `(${overworld.spawned.length})`);

    fake.advanceTo(t0 + t.unlock * PASS - 1);
    check("the safe stays locked until the timer runs out", !chat().includes("Safe unlocked!") && !log.some((l) => l.command === unlockCommand));
    check("the defenders are still there", defenders().length === 3 * PER_WAVE);
    check("the event lock is held during the raid", getActiveEvent() === "ranch");

    fake.advanceTo(t0 + t.unlock * PASS);
    check(`the safe unlocks on pass ${t.unlock} (${t.unlock * PASS} ticks after the start)`,
        chat().includes("Safe unlocked!") && log.some((l) => l.tick === t0 + t.unlock * PASS && l.command === unlockCommand),
        JSON.stringify(log.filter((l) => l.command === unlockCommand)));
    check("the defenders are removed", defenders().length === 0);
    check("the lock is released", getActiveEvent() === null);

    // The loop has stopped itself.
    const spawned = overworld.spawned.length, messages = fake.chat.length;
    fake.advance(PASS * 10);
    check("nothing more spawns or is said afterwards", overworld.spawned.length === spawned && fake.chat.length === messages, `(${overworld.spawned.length - spawned} spawns, ${fake.chat.length - messages} messages)`);
    check("the unlock happened exactly once", log.filter((l) => l.command === unlockCommand).length === 1);
    check("no errors in the whole raid", errors().length === 0, errors().join(" | "));
    outlaw.remove();
    done();
});

test("raiders inside get regeneration on the shared loop's grid, while the raid clock keeps its own", () => {
    const { check, done } = checks();
    scene();
    const outlaw = fake.makePlayer("Bandit", { tags: ["outlaw"], location: INSIDE });
    // Anyone standing in the ranch counts as a raider, so the second player stays outside to keep
    // this a one-raider raid (timeline(1)).
    const away = fake.makePlayer("Away", { tags: ["outlaw"], location: OUTSIDE });

    // Which player each regeneration command was run as (the fake only records the text).
    const healedBy = new Map();
    for (const player of [outlaw, away]) {
        const real = player.runCommand;
        player.runCommand = (command) => {
            if (command === regenCommand) healedBy.set(player.name, (healedBy.get(player.name) ?? 0) + 1);
            return real.call(player, command);
        };
    }

    const t0 = startRaid();
    const t = timeline(1);

    // Any 100 consecutive ticks hold exactly five ticks of a 20-tick grid.
    fake.advanceTo(t0 + 5 * PASS);
    const heals = healTicks();
    check("regeneration is refreshed once per 20 ticks", heals.length === 5, JSON.stringify(heals));
    check("...on the ticks the shared loop has always used (a multiple of 20 from the load tick)", heals.every((tick) => (tick - LOAD_TICK) % PASS === 0), JSON.stringify(heals));
    check("...and t0 is off that grid, so the raid clock is not the shared loop's",
        (t0 - LOAD_TICK) % PASS !== 0, `(t0=${t0}, load=${LOAD_TICK})`);
    check("only the outlaw inside the ranch is healed", healedBy.get("Bandit") === heals.length && !healedBy.has("Away"), JSON.stringify([...healedBy]));

    // Waves come on the raid's own grid.
    fake.advanceTo(t0 + t.wave2 * PASS);
    check("wave 2 lands off the shared grid", (fake.tick - LOAD_TICK) % PASS !== 0 && overworld.spawned.length === 2 * PER_WAVE, `(${overworld.spawned.length} spawned)`);

    // Once the raid is over, nobody is healed any more.
    fake.advanceTo(t0 + t.unlock * PASS);
    check("(setup) the raid is over", getActiveEvent() === null && chat().includes("Safe unlocked!"));
    const healed = healTicks().length;
    fake.advance(PASS * 3);
    check("regeneration stops when the raid ends", healTicks().length === healed, `(${healTicks().length - healed} more)`);
    outlaw.remove(); away.remove();
    done();
});

test("the raid ends early when everyone has left, at the next pass, and stops for good", () => {
    const { check, done } = checks();
    scene();
    const outlaw = fake.makePlayer("Bandit", { tags: ["outlaw"], location: INSIDE });
    const t0 = startRaid();

    fake.advanceTo(t0 + 2 * PASS);
    check("(setup) the raid is running", getActiveEvent() === "ranch" && !chat().includes("Raid ended early."));
    outlaw.location = OUTSIDE;

    fake.advanceTo(t0 + 3 * PASS - 1);
    check("nobody notices until the next pass", !chat().includes("Raid ended early.") && defenders().length === PER_WAVE);
    fake.advanceTo(t0 + 3 * PASS);
    check("the raid ends early on the next pass", chat().includes("Raid ended early."), chat().join(" | "));
    check("the defenders are removed", defenders().length === 0);
    check("the lock is released", getActiveEvent() === null);

    const messages = fake.chat.length, spawned = overworld.spawned.length;
    outlaw.location = INSIDE;                            // coming back does not resurrect a stopped raid
    fake.advance(PASS * 60);
    check("the loop is gone: no more messages or spawns, even when someone returns", fake.chat.length === messages && overworld.spawned.length === spawned, `(${fake.chat.length - messages} messages)`);
    check("...and the safe never unlocks", !chat().includes("Safe unlocked!"));
    outlaw.remove();
    done();
});

test("a start with nobody inside is refused, yet leaves the raid flag on (documented V1 quirk)", () => {
    const { check, done } = checks();
    scene();
    const outlaw = fake.makePlayer("Bandit", { tags: ["outlaw"], location: OUTSIDE });
    startRaid();

    check("it says so", chat().includes("No outlaws are inside the ranch."), chat().join(" | "));
    check("nothing spawns", overworld.spawned.length === 0);

    // The flag is on although the start failed, so the regeneration handler is armed.
    outlaw.location = INSIDE;
    fake.advance(PASS * 3);
    check("an outlaw walking into the ranch is healed although no raid is running", healTicks().length >= 2, JSON.stringify(healTicks()));

    // And there is no raid loop: no waves ever come.
    fake.advance(PASS * 100);
    check("no waves and no unlock come from the failed start", overworld.spawned.length === 0 && !chat().includes("Safe unlocked!"));
    outlaw.remove();
    done();
});

test("resetting the system mid-raid stops the clock and the raid flag", () => {
    const { check, done } = checks();
    scene();
    const outlaw = fake.makePlayer("Bandit", { tags: ["outlaw"], location: INSIDE });
    const t0 = startRaid();
    fake.advanceTo(t0 + 2 * PASS);
    check("(setup) the raid is running", getActiveEvent() === "ranch");

    listSystems().find((s) => s.name === "raids").reset();
    check("defenders are removed by the reset", defenders().length === 0);

    const messages = fake.chat.length, spawned = overworld.spawned.length, commands = log.length;
    fake.advance(PASS * 80);
    check("no waves, no unlock, no messages after a reset", fake.chat.length === messages && overworld.spawned.length === spawned, `(${fake.chat.length - messages} messages, ${overworld.spawned.length - spawned} spawns)`);
    check("no regeneration either: the flag is off", log.length === commands, JSON.stringify(log.slice(commands)));
    outlaw.remove();
    done();
});
