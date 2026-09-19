import { test } from "node:test";
import { fake, world, load, checks, strip } from "./helpers.mjs";

await load("systems/compass.js");
const { listSystems } = await load("core/registry.js");

const COMPASS = "bountysys:law_compass";
const INTERVAL = 4, RETARGET = 20, SWITCH_COOLDOWN = 10;
const S = { x: 0, y: 0, z: 1 }, W = { x: -1, y: 0, z: 0 };

// One refresh of the compass loop. The loop runs every INTERVAL ticks, so advancing by
// INTERVAL fires it exactly once.
const pass = () => fake.advance(INTERVAL);
const advance = (ticks) => fake.advance(ticks);
const use = (player, typeId = COMPASS) => world.afterEvents.itemUse.emit({ itemStack: { typeId }, source: player });
const lastBar = (p) => p.actionBar.at(-1);
const resetSystem = () => listSystems().find((s) => s.name === "compass").reset();
const cellsIn = (readout) => strip(readout).match(/« ([=+*]{21}) »/)?.[1];
const removeFromWorld = (p) => { fake.players.splice(fake.players.indexOf(p), 1); };
const addToWorld = (p) => { fake.players.push(p); };

function scene() {
    fake.reset();
    resetSystem();
    const sheriff = fake.makePlayer("Sheriff", { tags: ["law"], holding: COMPASS });
    const near = fake.makePlayer("Near", { tags: ["outlaw"], location: { x: 10, y: 64, z: 0 } });
    const far = fake.makePlayer("Far", { tags: ["outlaw"], location: { x: 0, y: 64, z: 50 } });
    const jailed = fake.makePlayer("Jailed", { tags: ["outlaw", "in_jail"], location: { x: 1, y: 64, z: 1 } });
    const dead = fake.makePlayer("Dead", { tags: ["outlaw", "eliminated"], location: { x: 2, y: 64, z: 2 } });
    const nether = fake.makePlayer("Nether", { tags: ["outlaw"], location: { x: 3, y: 64, z: 3 }, dimension: fake.dimension("nether") });
    fake.setScore("bounty", "Near", 0);
    fake.setScore("bounty", "Far", 300);
    fake.setScore("bounty", "Nether", 999);
    fake.setScore("bounty", "Jailed", 500);
    fake.setScore("bounty", "Dead", 500);
    return { sheriff, near, far, jailed, dead, nether };
}

test("interval is registered at the configured cadence", () => {
    // 4 ticks: the compass follows the camera, far finer than the shared 20-tick loop.
    const { sheriff } = scene();
    const before = sheriff.actionBar.length;
    advance(INTERVAL - 1);
    const afterThree = sheriff.actionBar.length;
    advance(1);
    const { check, done } = checks();
    check("nothing before the fourth tick", afterThree === before);
    check("one readout on the fourth tick", sheriff.actionBar.length === before + 1);
    done();
});

test("target selection: nearest, bounty, ties, filters", () => {
    const { check, done } = checks();
    const { sheriff, near, far } = scene();

    pass();
    let r = lastBar(sheriff);
    check("nearest picks Near (10m), ignoring jailed / eliminated / other-dimension",
        strip(r).includes("NEAREST") && strip(r).includes("Near") && strip(r).includes("10m"), r);
    check("Near is due east while facing south -> marker in the far-left cell", cellsIn(r)?.indexOf("*") === 0, String(cellsIn(r)));

    sheriff.isSneaking = true;
    use(sheriff);
    pass();
    r = lastBar(sheriff);
    check("bounty mode -> Far with 300 coins (not Nether's 999 or Jailed's 500)",
        strip(r).includes("TOP BOUNTY") && strip(r).includes("Far") && strip(r).includes("300 coins") && strip(r).includes("50m"), strip(r));
    check("Far is dead ahead -> aligned green marker", r.includes("§a*"));
    check("switch gave feedback (sound + message)", sheriff.privateSounds.some((s) => s.id === "random.click") && sheriff.messages.some((m) => m.includes("highest bounty")));

    // ties and ordering rules, re-decided after the lock window
    advance(SWITCH_COOLDOWN); sheriff.isSneaking = true; use(sheriff); sheriff.isSneaking = false; // -> nearest
    advance(SWITCH_COOLDOWN); sheriff.isSneaking = true; use(sheriff); sheriff.isSneaking = false; // -> bounty
    fake.setScore("bounty", "Far", 0);
    advance(RETARGET); pass();
    r = lastBar(sheriff);
    check("bounty mode, everyone at 0 -> falls back to nearest and says no bounty", strip(r).includes("Near") && strip(r).includes("no bounty"), strip(r));
    fake.setScore("bounty", "Far", 100); fake.setScore("bounty", "Near", 100);
    advance(RETARGET); pass();
    check("equal non-zero bounties -> nearer one wins", strip(lastBar(sheriff)).includes("Near") && strip(lastBar(sheriff)).includes("100 coins"));
    fake.setScore("bounty", "Near", 40);
    advance(RETARGET); pass();
    check("higher bounty beats closer distance", strip(lastBar(sheriff)).includes("Far"));
    done();
});

test("mode switching: debounce, plain use, isolation between trackers, reset", () => {
    const { check, done } = checks();
    const { sheriff, near, far } = scene();

    sheriff.isSneaking = true;
    use(sheriff);
    pass();
    check("first use switches to bounty", strip(lastBar(sheriff)).includes("TOP BOUNTY"));
    use(sheriff);
    pass();
    check("second use inside the cooldown is ignored", strip(lastBar(sheriff)).includes("TOP BOUNTY"));
    advance(SWITCH_COOLDOWN);
    use(sheriff);
    pass();
    check("after the cooldown, use switches back to nearest", strip(lastBar(sheriff)).includes("NEAREST") && strip(lastBar(sheriff)).includes("Near"));

    sheriff.isSneaking = false;
    const before = sheriff.messages.length;
    use(sheriff);
    pass();
    check("plain use only reports the mode, no switch", sheriff.messages.length === before + 1 && strip(lastBar(sheriff)).includes("NEAREST"));

    const beforeOther = sheriff.messages.length;
    use(sheriff, "bountysys:revolver");
    check("other items don't trigger the compass handler", sheriff.messages.length === beforeOther);

    // two trackers keep separate targets and modes
    const deputy = fake.makePlayer("Deputy", { tags: ["law"], holding: COMPASS, location: { x: 0, y: 64, z: 45 } });
    resetSystem();
    advance(RETARGET); pass();
    check("each tracker gets their own nearest (Sheriff -> Near, Deputy -> Far)",
        strip(lastBar(sheriff)).includes("Near") && strip(lastBar(deputy)).includes("Far"), `${strip(lastBar(sheriff))} | ${strip(lastBar(deputy))}`);
    deputy.isSneaking = true; use(deputy); deputy.isSneaking = false;
    pass();
    check("one tracker's mode switch doesn't affect the other", strip(lastBar(deputy)).includes("TOP BOUNTY") && strip(lastBar(sheriff)).includes("NEAREST"));
    deputy.remove();

    sheriff.isSneaking = true; advance(SWITCH_COOLDOWN); use(sheriff); sheriff.isSneaking = false; pass();
    check("(setup) sheriff is in bounty mode", strip(lastBar(sheriff)).includes("TOP BOUNTY"));
    resetSystem();
    pass();
    check("system reset returns players to the default mode", strip(lastBar(sheriff)).includes("NEAREST"));
    done();
});

test("target lock: held for the window, live bearing every pass, bounded staleness", () => {
    const { check, done } = checks();
    const { sheriff, near, far } = scene();

    pass();
    check("(setup) locked onto Near", strip(lastBar(sheriff)).includes("Near"));

    far.location = { x: 2, y: 64, z: 2 };               // Far walks right up to the sheriff: now clearly nearest
    pass();
    check("target stays locked inside the lock window (no re-decision yet)", strip(lastBar(sheriff)).includes("Near"));
    advance(RETARGET); pass();
    check("re-decides once the lock window has passed", strip(lastBar(sheriff)).includes("Far"));
    far.location = { x: 0, y: 64, z: 50 };
    advance(RETARGET); pass();
    check("(setup) back to Near", strip(lastBar(sheriff)).includes("Near"));

    const beforeMove = cellsIn(lastBar(sheriff));
    near.location = { x: -10, y: 64, z: 0 };            // east -> west while still locked
    pass();
    const afterMove = cellsIn(lastBar(sheriff));
    check("bearing follows the locked target every pass (east -> west flips the marker)",
        beforeMove.indexOf("*") === 0 && afterMove.indexOf("*") === 20 && strip(lastBar(sheriff)).includes("Near"), `${beforeMove} -> ${afterMove}`);
    near.location = { x: 10, y: 64, z: 0 };

    sheriff.facing = W;                                 // facing west: east is now directly behind
    pass();
    const lit = (lastBar(sheriff).match(/§e[«»]/g) ?? []).length;
    check("turning the camera moves the marker on the very next pass (off the bar, one chevron lit)", cellsIn(lastBar(sheriff)).indexOf("*") === -1 && lit === 1, strip(lastBar(sheriff)));
    sheriff.facing = S;

    // A real disconnect both invalidates the handle AND removes them from the player list.
    removeFromWorld(near);
    near.isValid = false;
    pass();
    check("an invalid target is dropped on the next pass, not after the window", !strip(lastBar(sheriff)).includes("Near") && strip(lastBar(sheriff)).includes("Far"), strip(lastBar(sheriff)));
    near.isValid = true;
    addToWorld(near);
    advance(RETARGET); pass();

    near.tags.add("in_jail");
    pass();
    check("a jailed target may linger for up to one lock window (documented trade-off)", strip(lastBar(sheriff)).includes("Near"));
    advance(RETARGET); pass();
    check("...but is dropped at the next re-decision", strip(lastBar(sheriff)).includes("Far") && !strip(lastBar(sheriff)).includes("Near"));
    near.tags.delete("in_jail");
    advance(RETARGET); pass();

    sheriff.holding = null; pass();
    far.location = { x: 1, y: 64, z: 1 };
    advance(60); sheriff.holding = COMPASS; pass();
    check("picking the compass up again after a while re-decides", strip(lastBar(sheriff)).includes("Far"));
    done();
});

test("nobody to track, not holding, roles", () => {
    const { check, done } = checks();
    const { sheriff, near, far, jailed, dead, nether } = scene();

    for (const p of [near, far]) removeFromWorld(p);
    advance(RETARGET); pass();
    check("no free outlaws -> friendly message", strip(lastBar(sheriff)).includes("No outlaws to track"));
    addToWorld(near); addToWorld(far);
    pass();
    check("outlaws reappearing are picked up on the very next pass (no stale 'none' lock)", strip(lastBar(sheriff)).includes("Near"));

    sheriff.holding = "minecraft:stick";
    const n = sheriff.actionBar.length;
    pass();
    check("not holding the compass -> action bar untouched", sheriff.actionBar.length === n);
    sheriff.holding = null;
    pass();
    check("empty hand -> action bar untouched", sheriff.actionBar.length === n);
    sheriff.holding = COMPASS;

    const rando = fake.makePlayer("Rando", { tags: ["outlaw"], holding: COMPASS });
    use(rando);
    check("non-law using the compass is turned away", rando.messages.some((m) => m.includes("Only law")));
    pass();
    check("non-law never gets a readout", rando.actionBar.length === 0);
    const ghost = fake.makePlayer("Ghost", { tags: ["law", "eliminated"], holding: COMPASS });
    pass();
    check("eliminated law gets no readout", ghost.actionBar.length === 0);
    done();
});

test("cost: steady passes are cheap, and bounty is only looked up in bounty mode", () => {
    const { check, done } = checks();
    const { sheriff } = scene();
    for (const p of [...fake.players]) if (p.tags.has("outlaw")) p.remove();
    for (let i = 0; i < 10; i++) fake.makePlayer(`C${i}`, { tags: ["outlaw"], location: { x: 10 + i, y: 64, z: 5 } });

    let scoreboardCalls = 0;
    const original = world.scoreboard.getObjective;
    world.scoreboard.getObjective = (id) => { scoreboardCalls++; return original.call(world.scoreboard, id); };
    try {
        resetSystem(); advance(1000);

        // Find a re-decision pass (the only kind that queries outlaws); the pass right after it must reuse the lock.
        const outlawQueries = () => fake.calls.dimensionGetPlayers;
        const step = () => { const before = outlawQueries(); pass(); return outlawQueries() - before; };
        for (let guard = 0; guard < 10 && step() === 0; guard++) { /* keep stepping */ }
        scoreboardCalls = 0;
        check("the pass after a re-decision reuses the lock (no outlaw query)", step() === 0);
        check("...and makes no scoreboard calls", scoreboardCalls === 0);

        // Over one whole lock window there is exactly one re-decision, and nearest mode never looks up bounties.
        fake.calls.dimensionGetPlayers = 0; scoreboardCalls = 0;
        advance(RETARGET);
        check("one lock window queries outlaws exactly once", fake.calls.dimensionGetPlayers === 1, `(${fake.calls.dimensionGetPlayers})`);
        check("nearest mode makes no scoreboard calls (bounty isn't used)", scoreboardCalls === 0, `(${scoreboardCalls})`);
    } finally {
        world.scoreboard.getObjective = original;
    }
    done();
});

test("errors: one broken player doesn't stop others, and reports are throttled", () => {
    const { check, done } = checks();
    const { sheriff } = scene();
    const broken = fake.makePlayer("Broken", { tags: ["law"], holding: COMPASS });
    broken.getViewDirection = () => { throw new Error("boom"); };

    const okCount = sheriff.actionBar.length;
    pass(); pass(); pass();
    check("one broken player doesn't stop others", sheriff.actionBar.length === okCount + 3);
    check("repeat errors are throttled to one message", fake.chat.filter((m) => m.includes("COMPASS ERROR")).length === 1, JSON.stringify(fake.chat));
    advance(201);
    pass();
    check("error reports resume after the throttle window", fake.chat.filter((m) => m.includes("COMPASS ERROR")).length === 2);
    done();
});
