import { test } from "node:test";
import { fake, world, system, fakeUi, load, checks, strip } from "./helpers.mjs";

// Characterization of the jail: which site a prisoner is sent to, who counts as being in jail, who may
// pick the lock, and what a breakout opens and frees. Driven through public entry points only
// (script events, deaths, spawns, the lockpick menu) and judged by tags, teleports, chat and commands.
// Loads every system exactly as the game does, so handler ORDER across files matters here.

await load("main.js");
const { JAIL_SITES } = await load("config/world.js");
const { JAILBREAK } = await load("config/balance.js");
const { resetAllSystems, listSystems } = await load("core/registry.js");
const state = await load("core/state.js");
const { uiFake } = fakeUi;

const scriptEvent = (id, sourceEntity) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message: "" });
const kill = (victim, killer) => world.afterEvents.entityDie.emit({ deadEntity: victim, damageSource: { damagingEntity: killer } });
const respawn = (player) => {
    world.afterEvents.playerSpawn.emit({ player, initialSpawn: false });
    fake.advance(1);                                     // system.run callbacks (teleports, messages)
};
const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const chat = () => fake.chat.map(strip);
const overworld = () => fake.dimension("overworld");
const settle = () => new Promise((resolve) => setImmediate(resolve));   // the form resolves on a promise

// The slider's hidden target is Math.random() * 100. With Math.random at 0.5 it sits at 50.
const HIT = 50;
const pick = (slider) => ({ canceled: false, formValues: [slider] });
const CLOSE = { canceled: true };

/** What the next lockpick forms answer. A form beyond the queue is closed, so a scenario that goes differently can't loop. */
function answers(...responses) {
    const queue = [...responses];
    uiFake.responses = Object.assign([], { shift: () => queue.shift() ?? CLOSE });
}

/** The player opens the lockpick menu and answers it; resolves once everything that set off has run. */
async function attempt(player, ...responses) {
    answers(...responses);
    scriptEvent("bounty:lockpick", player);
    await settle();
}

function scene() {
    fake.reset();
    resetAllSystems();
    uiFake.shown.length = 0;
    fake.addObjective("coins");
    fake.addObjective("bounty");
}

const cast = (...specs) => {
    const players = specs.map(([name, options]) => fake.makePlayer(name, options));
    fake.advance(1);
    return players;
};

/** The killer captures the outlaw: death, then respawn. Returns where they were last teleported. */
function capture(law, outlaw) {
    kill(outlaw, law);
    respawn(outlaw);
    return outlaw.teleports.at(-1);
}

const setblocks = () => overworld().commands.filter((c) => c.startsWith("setblock"));
const doorOf = (site) => `setblock ${site.doorTrigger.x} ${site.doorTrigger.y} ${site.doorTrigger.z} redstone_block`;

// ---------------------------------------------------------------------------
// Which site: rolled for the first prisoner, shared while anyone is held, re-rolled once empty
// ---------------------------------------------------------------------------

test("jail site: the first prisoner rolls one, later prisoners share it, and once the jail is empty the next one re-rolls", async (t) => {
    let roll = 0;
    t.mock.method(Math, "random", () => roll);
    const { check, done } = checks();
    scene();
    const [sheriff, a, b, c, r1, r2, r3, r4] = cast(
        ["Sheriff", { tags: ["law"] }],
        ["A", { tags: ["outlaw"] }], ["B", { tags: ["outlaw"] }], ["C", { tags: ["outlaw"] }],
        ["R1", { tags: ["outlaw"] }], ["R2", { tags: ["outlaw"] }], ["R3", { tags: ["outlaw"] }], ["R4", { tags: ["outlaw"] }]);

    roll = 0;                                            // -> JAIL_SITES[0]
    check("the first prisoner goes to the rolled site", sameSpot(capture(sheriff, a) ?? {}, JAIL_SITES[0].jail), JSON.stringify(a.teleports));

    roll = 0.99;                                         // a re-roll would now pick JAIL_SITES[1]
    check("the second prisoner shares it", sameSpot(capture(sheriff, b) ?? {}, JAIL_SITES[0].jail), JSON.stringify(b.teleports));

    roll = 0.5;                                          // the lock's hidden target is 50
    await attempt(r1, pick(HIT));
    await attempt(r2, pick(HIT));
    check("(setup) the breakout emptied the jail", chat().some((m) => m.includes("The jailbreak succeeded!")) && !a.tags.has("in_jail") && !b.tags.has("in_jail"), [...a.tags].join());
    check("it opened the door of the site that was in use", setblocks().length === 1 && setblocks()[0] === doorOf(JAIL_SITES[0]), JSON.stringify(setblocks()));

    roll = 0.99;                                         // -> JAIL_SITES[1]
    check("with the jail empty the next prisoner re-rolls", sameSpot(capture(sheriff, c) ?? {}, JAIL_SITES[1].jail), JSON.stringify(c.teleports));

    roll = 0.5;
    await attempt(r3, pick(HIT));
    await attempt(r4, pick(HIT));
    check("the second breakout opens the door of the new site", setblocks().length === 2 && setblocks()[1] === doorOf(JAIL_SITES[1]), JSON.stringify(setblocks()));
    done();
});

test("jail site: an eliminated prisoner is never released, so they keep the jail occupied and later prisoners share its site", (t) => {
    let roll = 0;
    t.mock.method(Math, "random", () => roll);
    const { check, done } = checks();
    scene();
    const [sheriff, a, b] = cast(["Sheriff", { tags: ["law"] }], ["A", { tags: ["outlaw"] }], ["B", { tags: ["outlaw"] }]);

    roll = 0;
    capture(sheriff, a);                                 // jailed at site 0
    capture(sheriff, a);                                 // second capture: eliminated (and still in_jail)
    check("(setup) A is eliminated", a.tags.has("eliminated") && a.tags.has("in_jail"), [...a.tags].join());

    roll = 0.99;                                         // a re-roll would pick site 1
    check("the next prisoner is sent to the same site", sameSpot(capture(sheriff, b) ?? {}, JAIL_SITES[0].jail), JSON.stringify(b.teleports));
    done();
});

test("bounty:test_capture jails the caller at the active site, even with no role", (t) => {
    let roll = 0;
    t.mock.method(Math, "random", () => roll);
    const { check, done } = checks();
    scene();
    const [p, q] = cast(["P"], ["Q", { tags: ["outlaw"] }]);

    roll = 0;
    scriptEvent("bounty:test_capture", p);
    check("the tags are set at once", p.tags.has("jailed") && p.tags.has("in_jail"), [...p.tags].join());
    check("nothing else about them changes", p.tags.size === 2, [...p.tags].join());
    check("the teleport waits for the next tick", p.teleports.length === 0);
    fake.advance(1);
    check("then they are at the rolled site", p.teleports.length === 1 && sameSpot(p.teleports[0], JAIL_SITES[0].jail), JSON.stringify(p.teleports));
    check("and told", p.messages.map(strip).includes("[TEST] You've been sent to jail for testing."), JSON.stringify(p.messages));

    roll = 0.99;
    scriptEvent("bounty:test_capture", q);
    fake.advance(1);
    check("a second caller shares the site", sameSpot(q.teleports.at(-1) ?? {}, JAIL_SITES[0].jail), JSON.stringify(q.teleports));
    check("and keeps their role", q.tags.has("outlaw") && q.tags.has("in_jail"), [...q.tags].join());
    done();
});

test("bounty:test_capture from something that is not a player does nothing", () => {
    const { check, done } = checks();
    scene();
    const [p] = cast(["P"]);
    scriptEvent("bounty:test_capture", undefined);
    fake.advance(1);
    check("nobody was jailed", p.tags.size === 0 && p.teleports.length === 0, [...p.tags].join());
    done();
});

// ---------------------------------------------------------------------------
// Who may pick the lock
// ---------------------------------------------------------------------------

const jailedFor = (...specs) => {
    scene();
    const [sheriff, prisoner, ...rest] = cast(["Sheriff", { tags: ["law"] }], ["Prisoner", { tags: ["outlaw"] }], ...specs);
    scriptEvent("bounty:test_capture", prisoner);
    fake.advance(1);
    return { sheriff, prisoner, rest };
};
const formsShown = () => uiFake.shown.length;

test("lockpick: law may not attempt it", async () => {
    const { check, done } = checks();
    const { sheriff } = jailedFor();
    await attempt(sheriff, CLOSE);
    check("they are told", sheriff.messages.map(strip).includes("Only outlaws can attempt this."), JSON.stringify(sheriff.messages));
    check("no menu opens", formsShown() === 0);
    done();
});

test("lockpick: nobody in jail means nothing to pick", async () => {
    const { check, done } = checks();
    scene();
    const [free] = cast(["Free", { tags: ["outlaw"] }]);
    await attempt(free, CLOSE);
    check("they are told", free.messages.map(strip).includes("No one is currently jailed."), JSON.stringify(free.messages));
    check("no menu opens", formsShown() === 0);
    done();
});

test("lockpick: a prisoner cannot pick their own lock", async () => {
    const { check, done } = checks();
    const { prisoner } = jailedFor();
    await attempt(prisoner, CLOSE);
    check("they are told", prisoner.messages.map(strip).some((m) => m.includes("You can't pick your own lock")), JSON.stringify(prisoner.messages));
    check("no menu opens", formsShown() === 0);
    done();
});

test("lockpick: an eliminated outlaw is turned away without a word", async () => {
    const { check, done } = checks();
    const { rest: [ghost] } = jailedFor(["Ghost", { tags: ["outlaw", "eliminated"] }]);
    await attempt(ghost, CLOSE);
    check("no message", ghost.messages.length === 0, JSON.stringify(ghost.messages));
    check("no menu opens", formsShown() === 0);
    done();
});

test("lockpick: a free outlaw with someone in jail gets the menu", async () => {
    const { check, done } = checks();
    const { rest: [free] } = jailedFor(["Free", { tags: ["outlaw"] }]);
    await attempt(free, CLOSE);
    check("the menu opens", formsShown() === 1);
    check("without complaint", free.messages.length === 0, JSON.stringify(free.messages));
    done();
});

/** A spot beside the prisoner, `distance` blocks along x. */
const beside = (prisoner, distance) => ({ x: prisoner.location.x + distance, y: prisoner.location.y, z: prisoner.location.z });
const foundIt = (p) => p.messages.some((m) => strip(m).includes("Found it!"));
const lawNearby = (p) => p.messages.some((m) => strip(m).includes("Law is nearby"));

test("lockpick: law standing at the jail blocks the attempt", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    const { prisoner, rest: [free, guard] } = jailedFor(["Free", { tags: ["outlaw"] }], ["Guard", { tags: ["law"] }]);
    guard.location = beside(prisoner, JAILBREAK.lawBlockRadius - 1);
    await attempt(free, pick(HIT));
    check("they are told law is near", lawNearby(free), JSON.stringify(free.messages));
    check("and the pick does not count", !foundIt(free));
    done();
});

test("lockpick: eliminated law at the door, and living law far from it, do not block", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    const { prisoner, rest: [free, ghost, distant] } = jailedFor(
        ["Free", { tags: ["outlaw"] }],
        ["Ghost", { tags: ["law", "eliminated"] }],
        ["Distant", { tags: ["law"] }]);
    ghost.location = beside(prisoner, 1);
    distant.location = beside(prisoner, JAILBREAK.lawBlockRadius + 30);
    await attempt(free, pick(HIT));
    check("the pick counts", foundIt(free), JSON.stringify(free.messages));
    check("nobody is reported near", !lawNearby(free));
    done();
});

test("breakout: frees every prisoner into escort, clears their bounty and pays the rescuers", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    scene();
    const [sheriff, a, b, r1, r2] = cast(["Sheriff", { tags: ["law"] }], ["A", { tags: ["outlaw"] }], ["B", { tags: ["outlaw"] }], ["R1", { tags: ["outlaw"] }], ["R2", { tags: ["outlaw"] }]);
    capture(sheriff, a); capture(sheriff, b);
    fake.setScore("bounty", "A", 200);                   // a bounty earned in jail, for the breakout to clear
    fake.setScore("bounty", "B", 300);

    await attempt(r1, pick(HIT));
    await attempt(r2, pick(HIT));

    const bounty = (name) => world.scoreboard.getObjective("bounty").getScore(name);
    const coins = (name) => world.scoreboard.getObjective("coins").getScore(name) ?? 0;
    check("announced once", chat().filter((m) => m.includes("The jailbreak succeeded!")).length === 1, chat().join(" | "));
    check("both prisoners are out of jail and under escort", [a, b].every((p) => !p.tags.has("in_jail") && p.tags.has("escort_vulnerable")), `${[...a.tags]} / ${[...b.tags]}`);
    check("they stay marked as captured once", [a, b].every((p) => p.tags.has("jailed")));
    check("their bounties are cleared", bounty("A") === 0 && bounty("B") === 0, `(A=${bounty("A")} B=${bounty("B")})`);
    check("both are told", [a, b].every((p) => p.messages.some((m) => strip(m).includes("You've been freed!"))), JSON.stringify(a.messages));
    check("each rescuer is paid", coins("R1") === JAILBREAK.rescueReward && coins("R2") === JAILBREAK.rescueReward, `(R1=${coins("R1")} R2=${coins("R2")})`);
    check("the law is untouched", [...sheriff.tags].join() === "law");
    done();
});

test("breakout: an eliminated prisoner is freed along with the rest (current behavior: their in_jail tag lingers)", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { check, done } = checks();
    scene();
    const [sheriff, a, r1, r2] = cast(["Sheriff", { tags: ["law"] }], ["A", { tags: ["outlaw"] }], ["R1", { tags: ["outlaw"] }], ["R2", { tags: ["outlaw"] }]);
    capture(sheriff, a); capture(sheriff, a);            // jailed, then eliminated while still in_jail
    await attempt(r1, pick(HIT));
    await attempt(r2, pick(HIT));
    check("the breakout goes ahead, there being a prisoner", chat().some((m) => m.includes("The jailbreak succeeded!")), chat().join(" | "));
    check("the eliminated player is swept up too", !a.tags.has("in_jail") && a.tags.has("escort_vulnerable") && a.tags.has("eliminated"), [...a.tags].join());
    done();
});

// ---------------------------------------------------------------------------
// The site lives in core/state
// ---------------------------------------------------------------------------

test("jail site: the jail keeps the site it rolls in state, and the jailbreak opens the door of whatever site state holds", async (t) => {
    let roll = 0;                                        // Math.random: 0 rolls JAIL_SITES[0]; 0.5 puts the lock's hidden target at 50
    t.mock.method(Math, "random", () => roll);
    const { check, done } = checks();
    scene();
    const [prisoner, r1, r2] = cast(["Prisoner", { tags: ["outlaw"] }], ["R1", { tags: ["outlaw"] }], ["R2", { tags: ["outlaw"] }]);

    scriptEvent("bounty:test_capture", prisoner);
    fake.advance(1);
    check("the jail put the site it rolled into state", state.getJailSite() === JAIL_SITES[0], JSON.stringify(state.getJailSite()));
    check("and sent the prisoner there", prisoner.teleports.length === 1 && sameSpot(prisoner.teleports[0], JAIL_SITES[0].jail), JSON.stringify(prisoner.teleports));

    // The jailbreak has no site of its own: whatever state holds is where it looks for the door.
    state.setJailSite(JAIL_SITES[1]);
    roll = 0.5;
    await attempt(r1, pick(HIT));
    await attempt(r2, pick(HIT));
    const commands = setblocks();
    check("the breakout succeeded", chat().some((m) => m.includes("The jailbreak succeeded!")), chat().join(" | "));
    check("it opened the door of the site state holds, and only that one", commands.includes(doorOf(JAIL_SITES[1])) && !commands.includes(doorOf(JAIL_SITES[0])), JSON.stringify(commands));
    check("the freed prisoner is under escort", prisoner.tags.has("escort_vulnerable") && !prisoner.tags.has("in_jail"), [...prisoner.tags].join());
    done();
});

test("jail site: a reset of the jail system forgets the site, so the next prisoner rolls again", (t) => {
    let roll = 0;
    t.mock.method(Math, "random", () => roll);
    const { check, done } = checks();
    scene();
    const [a, b] = cast(["A", { tags: ["outlaw"] }], ["B", { tags: ["outlaw"] }]);

    scriptEvent("bounty:test_capture", a);
    check("(setup) a site is in use", state.getJailSite() === JAIL_SITES[0]);

    listSystems().find((s) => s.name === "jail").reset();
    check("the reset cleared it", state.getJailSite() === null);

    roll = 0.99;                                         // A is still in jail, but with no site remembered the next capture must roll
    scriptEvent("bounty:test_capture", b);
    check("and the next capture rolled afresh", state.getJailSite() === JAIL_SITES[1], JSON.stringify(state.getJailSite()));
    done();
});

test("a pending jail that exists only as a tag (set before the addon loaded) is acted on when the player spawns", () => {
    const { check, done } = checks();
    scene();
    const [p] = cast(["P", { tags: ["outlaw", "send_to_jail"] }]);

    respawn(p);

    check("they are jailed, and the marker is gone", [...p.tags].sort().join() === "in_jail,jailed,outlaw", [...p.tags].join());
    check("they were sent to a jail site", p.teleports.length === 1 && JAIL_SITES.some((site) => sameSpot(site.jail, p.teleports[0])), JSON.stringify(p.teleports));
    done();
});
