import { test } from "node:test";
import { fake, system, load, checks, strip } from "./helpers.mjs";

// Characterization of how the three scripted events (fort raid, ranch raid, train robbery) take
// turns. While one runs, a request for another is refused with a fixed line and must start nothing.
// When it ends, or the round is reset, the next request goes through.
//
// Everything is driven through the PUBLIC script events (bounty:fort, bounty:ranch, bounty:train),
// the way command blocks in the world call them, and judged by what players see in chat and what
// the world gets (mobs, commands, explosions). It never asks the exclusion module for its state,
// so it holds however that module is built.

const { TRAIN } = await load("config/balance.js");
const { FORT_AREA, RANCH_AREA, TRAIN_START, TRAIN_END } = await load("config/world.js");
await load("systems/raids.js");
await load("systems/train.js");
const { resetAllSystems } = await load("core/registry.js");

const PASS = 20;                                        // ticks between passes of the 20-tick loops (fort, ranch)
const IDS = ["fort", "ranch", "train"];

const middle = (area) => ({ x: (area.min.x + area.max.x) / 2, y: area.min.y + 1, z: (area.min.z + area.max.z) / 2 });
const FORT_INSIDE = middle(FORT_AREA);
const RANCH_INSIDE = middle(RANCH_AREA);
const OUTSIDE = { x: 0, y: 64, z: 0 };                  // in neither area

// The train's timetable, derived from the config the way train.ts does: it makes STEPS moves, one
// more pass finds the end of the track and opens the vault, and the cleanup follows a fixed delay.
const DX = TRAIN_END.x - TRAIN_START.x, DY = TRAIN_END.y - TRAIN_START.y, DZ = TRAIN_END.z - TRAIN_START.z;
const STEPS = Math.max(1, Math.round(Math.sqrt(DX * DX + DY * DY + DZ * DZ) / TRAIN.stepSize));
const VAULT_OPENS = (STEPS + 1) * TRAIN.moveIntervalTicks;          // ticks after the start
const CLEANED_UP = VAULT_OPENS + TRAIN.cleanupDelayTicks;

const overworld = fake.dimension("overworld");
// A vault chest for the train's finish to fill; the fake world has no blocks.
overworld.getBlock = () => ({ getComponent: (id) => (id === "minecraft:inventory" ? { container: {} } : undefined) });

const chat = () => fake.chat.map(strip);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const advanceUntil = (done, limit) => { for (let i = 0; i < limit && !done(); i++) fake.advance(1); return done(); };

/**
 * What each event looks like from outside: the line players see when it really starts (with one
 * player inside its area), and how to make it end the way it would in the game.
 */
const EVENTS = {
    fort: {
        label: "fort raid",
        trigger: "bounty:fort",
        startLine: "Raid started! 1 player(s).",
        end(people) {
            people.fortGuy.location = OUTSIDE;              // everyone leaves; the raid notices on its next pass
            fake.advance(PASS);
            people.fortGuy.location = FORT_INSIDE;
            return chat().includes("[DEBUG] Fort raid ended");
        }
    },
    ranch: {
        label: "ranch raid",
        trigger: "bounty:ranch",
        startLine: "Raid Started! 1 outlaw(s).",
        end(people) {
            people.ranchGuy.location = OUTSIDE;
            fake.advance(PASS);
            people.ranchGuy.location = RANCH_INSIDE;
            return chat().includes("Raid ended early.");
        }
    },
    train: {
        label: "train robbery",
        trigger: "bounty:train",
        startLine: "The train is moving out!",
        end() {
            return advanceUntil(() => chat().includes("The train has been cleaned up."), CLEANED_UP + PASS);
        }
    }
};

/** Sends the public script event for `id`, the way a command block does, and returns what it said (colour codes kept). */
function request(id) {
    const from = fake.chat.length;
    system.afterEvents.scriptEventReceive.emit({ id: EVENTS[id].trigger });
    return fake.chat.slice(from);
}

// The robbery has one line of its own, for a second start while it is still moving.
const TRAIN_MOVING = "§cA train robbery is already in progress.";

const started = (id, lines) => lines.map(strip).includes(EVENTS[id].startLine);
const refusal = (wanted, running) => `§cCan't start a ${EVENTS[wanted].label} — ${running} is already in progress.`;
const refused = (lines) => lines.some((line) => line.startsWith("§cCan't start") || line === TRAIN_MOVING);
const footprint = () => ({ mobs: overworld.spawned.length, commands: overworld.commands.length, explosions: overworld.explosions.length });

/** A quiet world with every system reset: one player standing in the fort, one outlaw in the ranch. */
function scene() {
    fake.advance(TRAIN.bridgeRestoreDelayTicks + TRAIN.cleanupDelayTicks);      // let leftover timeouts play out
    fake.reset();
    resetAllSystems();
    fake.advanceTo(Math.ceil(fake.tick / PASS) * PASS + 3);
    return {
        fortGuy: fake.makePlayer("FortGuy", { location: FORT_INSIDE }),
        ranchGuy: fake.makePlayer("RanchGuy", { tags: ["outlaw"], location: RANCH_INSIDE })
    };
}

test("config sanity: the areas are apart and the train has a timetable", () => {
    const { check, done } = checks();
    const inside = (area, p) => p.x >= area.min.x && p.x <= area.max.x && p.y >= area.min.y && p.y <= area.max.y && p.z >= area.min.z && p.z <= area.max.z;
    check("the fort point is in the fort only", inside(FORT_AREA, FORT_INSIDE) && !inside(RANCH_AREA, FORT_INSIDE));
    check("the ranch point is in the ranch only", inside(RANCH_AREA, RANCH_INSIDE) && !inside(FORT_AREA, RANCH_INSIDE));
    check("the outside point is in neither", !inside(FORT_AREA, OUTSIDE) && !inside(RANCH_AREA, OUTSIDE));
    check("the train reaches the end of the track after at least one move", STEPS >= 1 && CLEANED_UP > VAULT_OPENS, `(${STEPS} steps)`);
    done();
});

// ---------------------------------------------------------------------------
// Every pair: A running, B requested
// ---------------------------------------------------------------------------

for (const running of IDS) {
    for (const wanted of IDS) {

        const what = running === wanted ? `a second ${wanted} start` : `${wanted} requested`;

        test(`${running} is running, ${what}: refused with the fixed line and nothing starts; once ${running} has ended, ${wanted} starts`, () => {
            const { check, done } = checks();
            const people = scene();

            const first = request(running);
            check(`(setup) ${running} starts`, started(running, first) && !refused(first), JSON.stringify(first));

            // A second robbery while the first is moving gets the robbery's own line; every other pair, the shared one.
            const expected = running === "train" && wanted === "train" ? TRAIN_MOVING : refusal(wanted, running);
            const before = footprint();
            const said = request(wanted);
            check("the refusal is the only thing said", same(said, [expected]), JSON.stringify(said));
            check(`${wanted} did not start`, !started(wanted, said));
            check("nothing was spawned, run or blown up", same(footprint(), before), `${JSON.stringify(before)} -> ${JSON.stringify(footprint())}`);

            const again = request(wanted);
            check("asking again gets the same answer and still starts nothing", same(again, [expected]) && same(footprint(), before), JSON.stringify(again));

            check(`${running} ends the way it would in the game`, EVENTS[running].end(people), chat().slice(-6).join(" | "));

            const then = request(wanted);
            check(`${wanted} starts once ${running} has ended`, started(wanted, then), JSON.stringify(then));
            check("...and is not refused", !refused(then), JSON.stringify(then));
            done();
        });
    }
}

// ---------------------------------------------------------------------------
// Events that never really start must not keep the slot
// ---------------------------------------------------------------------------

test("a fort raid with nobody inside says so and does not keep the slot", () => {
    const { check, done } = checks();
    for (const next of ["ranch", "train"]) {
        const people = scene();
        people.fortGuy.location = OUTSIDE;

        // The refusal line is unchanged. It is followed by one line per player saying why they don't
        // count (what each says is pinned in raid-explain.test.mjs).
        const said = request("fort").map(strip);
        check("it says nobody is inside first", said[0] === "No one is inside the area.", JSON.stringify(said));
        check("then only says why, for the two players", said.length === 3 && said.slice(1).every((line) => line.startsWith("  ")), JSON.stringify(said));
        check("nothing was spawned", overworld.spawned.length === 0);

        const then = request(next);
        check(`${next} starts right after`, started(next, then), JSON.stringify(then));
        check(`...and is not refused`, !refused(then), JSON.stringify(then));
    }
    done();
});

// The slot used to leak here: the ranch took it, found nobody inside and never gave it back, so
// every other event was refused until a round reset. The ranch's start() now returns false and the
// director frees the slot at once.
test("a ranch raid with nobody inside says so and does not keep the slot", () => {
    const { check, done } = checks();
    for (const next of ["fort", "train"]) {
        const people = scene();
        people.ranchGuy.location = OUTSIDE;

        const said = request("ranch").map(strip);
        // "Ranch raid started!" is printed before the raid looks for raiders, and stays. The two lines
        // that follow say why nobody counted (raid-explain.test.mjs).
        check("it announces, then says the ranch is empty", same(said.slice(0, 2), ["Ranch raid started!", "No outlaws are inside the ranch."]), JSON.stringify(said));
        check("then only says why, for the two players", said.length === 4 && said.slice(2).every((line) => line.startsWith("  ")), JSON.stringify(said));
        check("nothing was spawned", overworld.spawned.length === 0);

        const then = request(next);
        check(`${next} starts right after`, started(next, then), JSON.stringify(then));
        check(`...and is not refused`, !refused(then), JSON.stringify(then));
    }
    done();
});

// ---------------------------------------------------------------------------
// Ways the slot is freed
// ---------------------------------------------------------------------------

for (const running of IDS) {
    test(`a round reset while ${running} runs frees the slot for every event`, () => {
        const { check, done } = checks();
        for (const wanted of IDS) {
            scene();
            const first = request(running);
            check(`(setup) ${running} starts`, started(running, first), JSON.stringify(first));
            check(`(setup) ${wanted} is refused while ${running} runs`, refused(request(wanted)));

            resetAllSystems();

            const then = request(wanted);
            check(`${wanted} starts after the reset`, started(wanted, then), JSON.stringify(then));
            check(`...and is not refused`, !refused(then), JSON.stringify(then));
        }
        done();
    });
}

test("a fort raid that is cleared frees the slot", () => {
    const { check, done } = checks();
    scene();
    check("(setup) the raid starts", started("fort", request("fort")));

    // Kill every defender, then let the raid notice: three waves in all.
    for (let wave = 0; wave < 3; wave++) {
        for (const mob of overworld.getEntities({ tags: ["raid_fort"] })) mob.kill();
        fake.advance(PASS);
    }
    check("the fort is cleared", chat().includes("The fort has been cleared! The reward chest is open."), chat().slice(-6).join(" | "));
    check("the reward chest is filled", overworld.commands.some((c) => c.startsWith("loot insert")));

    const then = request("ranch");
    check("another event starts after it", started("ranch", then) && !refused(then), JSON.stringify(then));
    done();
});

test("a train robbery keeps the slot until its cleanup, then frees it on that very tick", () => {
    const { check, done } = checks();
    scene();
    const t0 = fake.tick;
    check("(setup) the robbery starts", started("train", request("train")));

    fake.advanceTo(t0 + VAULT_OPENS);
    check("(setup) the vault car is open and the train has stopped", chat().some((m) => m.includes("The vault car is open!")));
    check("a fort raid is still refused while the guards stand", same(request("fort"), [refusal("fort", "train")]));
    check("so is another robbery, with the shared line: it is no longer moving", same(request("train"), [refusal("train", "train")]));

    fake.advanceTo(t0 + CLEANED_UP - 1);
    check("one tick before the cleanup the slot is still held", same(request("ranch"), [refusal("ranch", "train")]));
    check("the train has not been cleaned up yet", !chat().includes("The train has been cleaned up."));

    fake.advanceTo(t0 + CLEANED_UP);
    check("the train is cleaned up", chat().includes("The train has been cleaned up."));
    const then = request("ranch");
    check("and the slot is free that same tick", started("ranch", then) && !refused(then), JSON.stringify(then));
    done();
});
