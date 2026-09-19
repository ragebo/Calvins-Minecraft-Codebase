import { test } from "node:test";
import { fake, world, system, fakeUi, load, checks, strip } from "./helpers.mjs";

// Per-player state is keyed on player.id, never player.name. Two players can share a display
// name, while Entity.id is unique and stable (see Entity.id in
// node_modules/@minecraft/server/index.d.ts). Each system is exercised with a pair of players
// who have the SAME name but different ids: keyed on the name they trample each other's state,
// keyed on the id they don't. The same scenario with two different names is kept as a control
// that passes either way, so a failure points at the key and not at the scenario.

const { listSystems } = await load("core/registry.js");
const resetSystem = (name) => listSystems().find((s) => s.name === name).reset();
const PAIRS = [["different names (control)", "Alice", "Bob"], ["the same name", "Dup", "Dup"]];

// ---------------------------------------------------------------------------
// guns: magazine, fire-rate window and reload lock
// ---------------------------------------------------------------------------

const { GUNS, AMMO } = await load("config/guns.js");
await load("systems/guns.js");

const gun = GUNS.revolver;                          // 6 rounds, fireRateTicks 8, reloadTicks 40
const overworld = () => fake.dimension("overworld");
const useItem = (p) => world.afterEvents.itemUse.emit({ itemStack: { typeId: p.holding }, source: p });
const shotsHeard = () => overworld().played.filter((s) => s.id === gun.sounds.fire[0].id).length;
const clicksHeard = (p) => p.privateSounds.filter((s) => s.id === "random.click").length;

/** Two players with a revolver and ammo each, standing together. The ids never match; the names are the test's choice. */
function shooters(nameA, nameB) {
    fake.reset();
    resetSystem("guns");
    const at = { x: 1, y: 64, z: 2 };
    const a = fake.makePlayer(nameA, { id: "a", holding: gun.itemId, location: at });
    const b = fake.makePlayer(nameB, { id: "b", holding: gun.itemId, location: at });
    for (const p of [a, b]) p.giveAmmo(AMMO[gun.ammo].itemId, 64);
    fake.advance(200);                              // let anything left over from an earlier test finish
    overworld().played.length = 0;
    return { a, b };
}

/** One trigger pull, then waiting out the fire-rate window. Reports what it did: "shot", a dry "click" or "nothing". */
function pull(p) {
    const shots = shotsHeard();
    const clicks = clicksHeard(p);
    useItem(p);
    fake.advance(gun.fireRateTicks);
    if (shotsHeard() > shots) return "shot";
    return clicksHeard(p) > clicks ? "click" : "nothing";
}

const pulls = (p, n) => Array.from({ length: n }, () => pull(p));

for (const [label, nameA, nameB] of PAIRS) {
    test(`guns: with ${label}, emptying one magazine leaves the other full`, () => {
        const { check, done } = checks();
        const { a, b } = shooters(nameA, nameB);

        check("A fires the whole magazine", pulls(a, gun.magazineSize).every((r) => r === "shot"));
        check("A's next pull is a dry click", pull(a) === "click");

        const before = shotsHeard();
        check("B can still fire: the shot plays to the world", pull(b) === "shot" && shotsHeard() === before + 1);
        check("B has a magazine of their own", pulls(b, gun.magazineSize - 1).every((r) => r === "shot"));
        check("B then runs dry like A", pull(b) === "click");
        done();
    });
}

for (const [label, nameA, nameB] of PAIRS) {
    test(`guns: with ${label}, one player's fire-rate window and reload don't hold up the other`, () => {
        const { check, done } = checks();
        const { a, b } = shooters(nameA, nameB);

        const before = shotsHeard();
        useItem(a); useItem(b);                     // the same tick
        fake.advance(gun.fireRateTicks);
        check("both can shoot in the same tick", shotsHeard() === before + 2, `(${shotsHeard() - before} shots heard)`);

        a.isSneaking = true; useItem(a); a.isSneaking = false;      // A starts a reload
        check("(setup) A is reloading", a.messages.some((m) => m.includes("Reloading")), JSON.stringify(a.messages));
        check("A's reload doesn't stop B firing", pull(b) === "shot");
        b.isSneaking = true; useItem(b); b.isSneaking = false;
        check("...or B starting a reload of their own", b.messages.some((m) => m.includes("Reloading")), JSON.stringify(b.messages));

        fake.advance(gun.reloadTicks + 5);
        for (const [who, p] of [["A", a], ["B", b]]) {
            check(`${who}'s magazine refills`, p.messages.some((m) => m.includes("reloaded") && m.includes(`${gun.magazineSize}/${gun.magazineSize}`)), JSON.stringify(p.messages));
        }
        done();
    });
}

test("guns: reset returns every player to a full magazine, an open trigger and no reload in progress", () => {
    const { check, done } = checks();
    const { a } = shooters("Alice", "Bob");

    check("(setup) A emptied the magazine", pulls(a, gun.magazineSize).every((r) => r === "shot") && pull(a) === "click");
    resetSystem("guns");
    check("the magazine is full again", pulls(a, gun.magazineSize).every((r) => r === "shot"));

    resetSystem("guns");
    const before = shotsHeard();
    useItem(a);
    resetSystem("guns");
    useItem(a);                                     // the same tick: only allowed if the fire-rate window was forgotten
    fake.advance(gun.fireRateTicks);
    check("the fire-rate window is forgotten", shotsHeard() === before + 2, `(${shotsHeard() - before} shots heard)`);

    a.isSneaking = true;
    useItem(a);                                     // A is short of rounds by now, so this starts a reload
    const reloading = a.messages.some((m) => m.includes("Reloading"));
    resetSystem("guns");
    useItem(a);                                     // a reload still in progress would swallow this silently
    a.isSneaking = false;
    check("(setup) a reload was in progress", reloading);
    check("the reload lock is forgotten", a.messages.some((m) => m.includes("Already fully loaded")), JSON.stringify(a.messages));
    fake.advance(gun.reloadTicks + 5);
    done();
});

// ---------------------------------------------------------------------------
// compass: mode, switch cooldown and target lock
// ---------------------------------------------------------------------------

await load("systems/compass.js");

const COMPASS = "bountysys:law_compass";
const pass = () => fake.advance(4);                 // exactly one refresh of the compass loop
const readout = (p) => strip(p.actionBar.at(-1) ?? "");
const useCompass = (p) => world.afterEvents.itemUse.emit({ itemStack: { typeId: COMPASS }, source: p });
const sneakUse = (p) => { p.isSneaking = true; useCompass(p); p.isSneaking = false; };

/** Two law players holding compasses 200 blocks apart, each standing 10 blocks from an outlaw of their own. */
function trackers(nameA, nameB) {
    fake.reset();
    resetSystem("compass");
    const a = fake.makePlayer(nameA, { id: "a", tags: ["law"], holding: COMPASS, location: { x: 0, y: 64, z: 0 } });
    const b = fake.makePlayer(nameB, { id: "b", tags: ["law"], holding: COMPASS, location: { x: 200, y: 64, z: 0 } });
    const nearA = fake.makePlayer("NearA", { tags: ["outlaw"], location: { x: 10, y: 64, z: 0 } });
    const nearB = fake.makePlayer("NearB", { tags: ["outlaw"], location: { x: 210, y: 64, z: 0 } });
    fake.setScore("bounty", "NearA", 0);
    fake.setScore("bounty", "NearB", 300);
    return { a, b, nearA, nearB };
}

for (const [label, nameA, nameB] of PAIRS) {
    test(`compass: with ${label}, one tracker switching to bounty mode leaves the other on nearest`, () => {
        const { check, done } = checks();
        const { a, b } = trackers(nameA, nameB);

        pass();
        check("(setup) both read NEAREST", readout(a).includes("NEAREST") && readout(b).includes("NEAREST"), `${readout(a)} | ${readout(b)}`);
        sneakUse(a);
        pass();
        check("A's readout says TOP BOUNTY", readout(a).includes("TOP BOUNTY"), readout(a));
        check("B's readout still says NEAREST", readout(b).includes("NEAREST") && !readout(b).includes("TOP BOUNTY"), readout(b));
        done();
    });
}

for (const [label, nameA, nameB] of PAIRS) {
    test(`compass: with ${label}, each tracker is pointed at the outlaw beside them`, () => {
        const { check, done } = checks();
        const { a, b } = trackers(nameA, nameB);

        pass();
        check("A points at NearA, 10m away", readout(a).includes("NearA") && readout(a).includes("10m"), readout(a));
        check("B points at NearB, 10m away", readout(b).includes("NearB") && readout(b).includes("10m"), readout(b));
        done();
    });
}

for (const [label, nameA, nameB] of PAIRS) {
    test(`compass: with ${label}, each tracker has their own switch cooldown`, () => {
        const { check, done } = checks();
        const { a, b } = trackers(nameA, nameB);

        sneakUse(a);
        fake.advance(1);                            // well inside A's cooldown window
        sneakUse(b);
        check("B's switch is accepted, not swallowed by A's cooldown", b.messages.some((m) => m.includes("highest bounty")), JSON.stringify(b.messages));

        const before = a.messages.length;
        sneakUse(a);                                // A pressing again is still debounced
        check("A's own repeat press is still ignored", a.messages.length === before);
        done();
    });
}

test("compass: reset forgets modes, switch cooldowns and locked targets", () => {
    const { check, done } = checks();
    const { a, nearB } = trackers("Alice", "Bob");

    pass();
    nearB.location = { x: 1, y: 64, z: 0 };         // NearB walks up to A, but A's lock holds for its window
    pass();
    check("(setup) A stays locked onto NearA inside the window", readout(a).includes("NearA"), readout(a));
    resetSystem("compass");
    pass();
    check("reset dropped the lock: A re-decides at once", readout(a).includes("NearB"), readout(a));

    sneakUse(a);                                    // nearest -> bounty
    resetSystem("compass");
    sneakUse(a);                                    // the same tick: lands on bounty only if mode AND cooldown were forgotten
    pass();
    check("reset forgot A's mode and cooldown", readout(a).includes("TOP BOUNTY"), readout(a));
    done();
});

// ---------------------------------------------------------------------------
// jailbreak: pick cooldown, escort origin, and who is paid or weakened
// ---------------------------------------------------------------------------

await load("systems/jailbreak.js");
await load("systems/jail.js");                      // owns bounty:test_capture and the jail site: systems don't import each other, so the scenes below load it
const { JAILBREAK } = await load("config/balance.js");
const { uiFake } = fakeUi;

// Math.random is pinned to 0.5 in these tests, which puts the hidden sweet spot at 50.
const HIT = 50;
const pick = (slider) => ({ canceled: false, formValues: [slider] });
const CLOSE = { canceled: true };
const scriptEvent = (id, sourceEntity) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message: "" });
const settle = () => new Promise((resolve) => setImmediate(resolve));   // the form resolves on a promise

/**
 * What the next lockpick forms answer. A form beyond the queue is closed: the game reopens the
 * menu after every pick, and the fake's default answer ("submitted, no values") would loop
 * forever whenever a scenario goes differently than expected.
 */
function answers(...responses) {
    const queue = [...responses];
    uiFake.responses = Object.assign([], { shift: () => queue.shift() ?? CLOSE });
}

/** The player opens the lockpick menu and answers it. Resolves once everything that set off has run. */
async function attempt(player, ...responses) {
    answers(...responses);
    scriptEvent("bounty:lockpick", player);
    await settle();
}

/** A fresh round with these prisoners captured through the public test event, standing at the jail. */
function scene(prisonerNames) {
    fake.reset();
    resetSystem("jailbreak");
    resetSystem("jail");
    resetSystem("state");                           // records are kept by player id, and the same ids come back in every scene
    fake.advance(1);                                // and the cached player list is per tick, so start from a fresh one
    fake.addObjective("coins");
    fake.addObjective("bounty");
    const prisoners = prisonerNames.map((name, i) => fake.makePlayer(name, { id: `prisoner-${i + 1}`, tags: ["outlaw"] }));
    for (const p of prisoners) scriptEvent("bounty:test_capture", p);
    fake.advance(1);                                // the capture teleports on the next tick
    return { prisoners, jail: { ...prisoners[0].location } };
}

const outlaw = (name, id) => fake.makePlayer(name, { id, tags: ["outlaw"] });
const coinsOf = (name) => world.scoreboard.getObjective("coins").getScore(name) ?? 0;
const jailbreakErrors = () => fake.chat.filter((m) => m.includes("[JAILBREAK ERROR]") || m.includes("[EVENT ERROR]"));
const succeeded = () => fake.chat.some((m) => m.includes("The jailbreak succeeded"));
const correctPicks = (p) => p.messages.filter((m) => m.includes("Found it")).length;

/**
 * The engine documents Player.name as able to throw, and an invalid (disconnected) handle is
 * when it does. The fake's plain property never throws, so give the player that behavior.
 */
function nameThrowsWhenInvalid(player) {
    const name = player.name;
    Object.defineProperty(player, "name", {
        configurable: true,
        get() {
            if (!player.isValid) throw new Error("InvalidEntityError: Failed to call function due to Entity being invalid.");
            return name;
        }
    });
}

test("jailbreak: a contributor who disconnects before the lock opens is skipped, not paid, and doesn't break the breakout", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    const { prisoners: [prisoner] } = scene(["Prisoner"]);
    const stayer = outlaw("Stayer", "stayer");
    const leaver = outlaw("Leaver", "leaver");
    nameThrowsWhenInvalid(leaver);

    await attempt(leaver, pick(HIT));
    check("(setup) the leaver's pick counted", correctPicks(leaver) === 1);
    leaver.remove();                                // disconnects before the second pick
    await attempt(stayer, pick(HIT));

    check("nothing is reported as an error", jailbreakErrors().length === 0, jailbreakErrors().join(" | "));
    check("the breakout still succeeds", succeeded());
    check("the prisoner is freed", !prisoner.hasTag("in_jail") && prisoner.hasTag("escort_vulnerable"));
    check("the contributor who stayed is paid", coinsOf("Stayer") === JAILBREAK.rescueReward, `(${coinsOf("Stayer")})`);
    check("the one who left is not", coinsOf("Leaver") === 0, `(${coinsOf("Leaver")})`);
    check("nor is the prisoner, who never picked", coinsOf("Prisoner") === 0, `(${coinsOf("Prisoner")})`);
    done();
});

test("jailbreak: an abandoned attempt weakens only the contributors still online", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    const hitsToUnlock = JAILBREAK.hitsToUnlock;
    JAILBREAK.hitsToUnlock = 3;                     // room for two contributors without the lock opening
    try {
        const { prisoners: [prisoner] } = scene(["Prisoner"]);
        const leaver = outlaw("Leaver", "leaver");
        const stayer = outlaw("Stayer", "stayer");
        nameThrowsWhenInvalid(leaver);

        await attempt(leaver, pick(HIT));
        await attempt(stayer, pick(HIT));
        leaver.remove();

        let threw = null;
        try { fake.advance(JAILBREAK.failTimeoutTicks); } catch (e) { threw = e; }
        check("the timeout throws nothing", threw === null, String(threw));
        check("nothing is reported as an error", jailbreakErrors().length === 0, jailbreakErrors().join(" | "));
        check("the attempt is called off", fake.chat.some((m) => m.includes("abandoned")));
        check("the contributor still online is weakened", stayer.effects.some((e) => e.id === "weakness"), JSON.stringify(stayer.effects));
        check("someone who never picked is not", prisoner.effects.length === 0, JSON.stringify(prisoner.effects));

        await attempt(stayer, pick(HIT));
        check("the next attempt starts from zero", stayer.messages.some((m) => m.includes("1/3")), JSON.stringify(stayer.messages));
        done();
    } finally {
        JAILBREAK.hitsToUnlock = hitsToUnlock;
    }
});

for (const [label, nameA, nameB] of PAIRS) {
    test(`jailbreak: with ${label}, one player's pick doesn't start the other's cooldown`, async (t) => {
        t.mock.method(Math, "random", () => 0.5);
        const { check, done } = checks();
        scene(["Prisoner"]);
        const a = outlaw(nameA, "a");
        const b = outlaw(nameB, "b");

        await attempt(a, pick(HIT));
        await attempt(b, pick(HIT));                // the same tick: A's cooldown is A's alone
        check("B's pick is evaluated and counts", correctPicks(b) === 1, JSON.stringify(b.messages));
        check("two correct picks open the lock", succeeded());
        done();
    });
}

test("jailbreak: a player's own pick cooldown still holds, then lapses", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    scene(["Prisoner"]);
    const a = outlaw("Alice", "a");

    await attempt(a, pick(HIT));
    await attempt(a, pick(HIT));                    // the same tick: swallowed by A's own cooldown
    check("a second pick inside the cooldown doesn't count", correctPicks(a) === 1 && !succeeded(), JSON.stringify(a.messages));
    fake.advance(JAILBREAK.attemptCooldownTicks);
    await attempt(a, pick(HIT));
    check("once the cooldown has passed it does, and opens the lock", correctPicks(a) === 2 && succeeded());
    done();
});

for (const [label, nameA, nameB] of PAIRS) {
    test(`jailbreak: with ${label}, each freed prisoner is escorted from their own origin`, async (t) => {
        t.mock.method(Math, "random", () => 0.5);
        const { check, done } = checks();
        const { prisoners: [p1, p2], jail } = scene([nameA, nameB]);
        const r1 = outlaw("Rescuer1", "r1");
        const r2 = outlaw("Rescuer2", "r2");

        await attempt(r1, pick(HIT));
        await attempt(r2, pick(HIT));
        check("(setup) both prisoners are freed and under escort", [p1, p2].every((p) => !p.hasTag("in_jail") && p.hasTag("escort_vulnerable")));

        p1.location = { x: jail.x + JAILBREAK.escortSafeDistance + 10, y: jail.y, z: jail.z };   // P1 runs; P2 is still at the door
        fake.advance(20);                           // one pass of the escort loop
        check("P1 reached safety", !p1.hasTag("escort_vulnerable") && p1.messages.some((m) => m.includes("made it to safety")), JSON.stringify(p1.messages));
        check("P2 is still under escort", p2.hasTag("escort_vulnerable") && !p2.messages.some((m) => m.includes("made it to safety")), JSON.stringify(p2.messages));
        check("...and is weakened and slowed", ["weakness", "slowness"].every((id) => p2.effects.some((e) => e.id === id)), JSON.stringify(p2.effects));
        done();
    });
}

test("jailbreak: reset forgets the pick cooldown, contributors, escort origins and the abandon timer", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();

    // Cooldown and abandon timer: Alice picks, the round resets, and she picks again on the same tick.
    scene(["Prisoner"]);
    const alice = outlaw("Alice", "alice");
    await attempt(alice, pick(HIT));
    resetSystem("jailbreak");
    await attempt(alice, pick(HIT));
    check("the pick cooldown is forgotten", correctPicks(alice) === 2, JSON.stringify(alice.messages));
    resetSystem("jailbreak");
    fake.advance(JAILBREAK.failTimeoutTicks + 1);
    check("the abandon timer is cancelled", !fake.chat.some((m) => m.includes("abandoned")), JSON.stringify(fake.chat));

    // Contributors: Alice picks, the round resets, and Carol alone opens the lock. Alice must not be paid.
    scene(["Prisoner"]);
    const alice2 = outlaw("Alice", "alice");
    const carol = outlaw("Carol", "carol");
    await attempt(alice2, pick(HIT));
    resetSystem("jailbreak");
    await attempt(carol, pick(HIT));
    check("one pick after the reset doesn't open the lock: the count restarted", !succeeded());
    fake.advance(JAILBREAK.attemptCooldownTicks);
    await attempt(carol, pick(HIT));
    check("(setup) Carol opened the lock and is paid", succeeded() && coinsOf("Carol") === JAILBREAK.rescueReward, `(${coinsOf("Carol")})`);
    check("Alice's pick from before the reset earns nothing", coinsOf("Alice") === 0, `(${coinsOf("Alice")})`);

    // Escort origins: after a breakout the freed prisoner is escorted from the jail; reset forgets where from.
    const { prisoners: [prisoner] } = scene(["Prisoner"]);
    const r1 = outlaw("Rescuer1", "r1");
    const r2 = outlaw("Rescuer2", "r2");
    await attempt(r1, pick(HIT));
    await attempt(r2, pick(HIT));
    check("(setup) the freed prisoner is under escort", prisoner.hasTag("escort_vulnerable"));
    resetSystem("jailbreak");
    fake.advance(20);                               // one pass of the escort loop
    check("the escort origin is forgotten (the lost-origin fallback lets them go)", !prisoner.hasTag("escort_vulnerable"));
    done();
});
