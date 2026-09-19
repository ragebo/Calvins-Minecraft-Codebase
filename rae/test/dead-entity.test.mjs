import { test } from "node:test";
import { fake, world, load, checks, strip } from "./helpers.mjs";

// What happens when a player dies. In an entityDie handler the dead player's entity handle may
// already be INVALID: every call on it (hasTag, addTag, teleport, ...) throws InvalidEntityError, and
// only `id`, `typeId`, `isValid` and `scoreboardIdentity` still read (see CLAUDE.md, engine gotchas).
// The game must capture, eliminate, pay bounties and apply the death penalty either way.
//
// Loads every system exactly as the game does, so handler ORDER across files matters here.

await load("main.js");
const { JAIL_SITES, OUTLAW_SPAWNS } = await load("config/world.js");
const { ECONOMY } = await load("config/balance.js");
const { resetAllSystems } = await load("core/registry.js");

// A test marked with this fails on the code before ARCH-03 step 4 (with an invalid dead handle
// jail:capture gave up, economy-rules read the dead player's name, and endgame's law-win check threw
// from hasTag()). It is the point of the exercise; the step that fixes it removes the marker.
const TODO = "fails until ARCH-03 step 4: the dead player's state must be read without touching their entity";

const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const isJail = (spot) => JAIL_SITES.some((s) => sameSpot(s.jail, spot));
const isOutlawSpawn = (spot) => OUTLAW_SPAWNS.some((s) => sameSpot(s, spot));
const chat = () => fake.chat.map(strip);
const said = (text) => chat().some((m) => m.includes(text));
const errorLines = () => fake.chat.filter((m) => m.includes("§c["));         // [DEATH ERROR], [SPAWN ERROR], [RESET ERROR], ...
const coinsOf = (name) => world.scoreboard.getObjective("coins").getScore(name) ?? 0;
const bountyOf = (name) => world.scoreboard.getObjective("bounty").getScore(name) ?? 0;
const droppedItems = () => fake.entities.filter((e) => e.typeId === "minecraft:item").length;
const commands = () => fake.dimension("overworld").commands;

const emitDeath = (victim, killer) => world.afterEvents.entityDie.emit({ deadEntity: victim, damageSource: { damagingEntity: killer } });
const emitSpawn = (player, initialSpawn = false) => {
    world.afterEvents.playerSpawn.emit({ player, initialSpawn });
    fake.advance(1);                                     // system.run callbacks (teleports, messages)
};

/**
 * The handle the engine may hand a death handler: every call throws, `id`, `typeId`, `isValid` and
 * `scoreboardIdentity` still read. Player.name is documented as able to throw, so here it does too.
 */
function goneWith(player) {
    const name = player.name;
    Object.defineProperty(player, "name", {
        configurable: true,
        get() {
            if (!player.isValid) throw new Error("InvalidEntityError: Failed to call function due to Entity being invalid (has the Entity been removed?).");
            return name;
        }
    });
    player.isValid = false;
}

/** The victim dies with an invalid handle. */
function dieGone(victim, killer) {
    goneWith(victim);
    emitDeath(victim, killer);
}

/** The player is back: a valid handle again, and the spawn event the game fires for their respawn. */
function comeBack(player) {
    player.isValid = true;
    emitSpawn(player);
}

/**
 * Everyone joins before anything happens, as in a real game: each player gets their join spawn, which
 * is when the game learns who they are. Tags given here are what a world saved mid-round, or a command
 * block, would have left on them.
 */
function scene(...specs) {
    fake.reset();
    resetAllSystems();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    const players = specs.map(([name, options]) => fake.makePlayer(name, options));
    for (const player of players) emitSpawn(player, true);
    for (const player of players) { player.teleports.length = 0; player.messages.length = 0; }
    fake.chat.length = 0;
    return players;
}

// ---------------------------------------------------------------------------
// Capture and elimination by law, whatever state the dead handle is in
// ---------------------------------------------------------------------------

for (const [label, die] of [["a valid handle", (v, k) => emitDeath(v, k)], ["an INVALID handle", dieGone]]) {

    test(`law kills an outlaw with ${label}: announced, bounty collected, and they respawn in jail`, () => {
        const { check, done } = checks();
        const [sheriff, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }], ["Other", { tags: ["outlaw"] }]);
        fake.setScore("bounty", "Bandit", 120);

        die(bandit, sheriff);

        check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
        check("the capture is announced", said("Bandit was captured by the law and sent to jail!"), chat().join(" | "));
        check("the bounty is announced", said("Sheriff collected a bounty of 120 coins from Bandit!"), chat().join(" | "));
        check("the killer is paid", coinsOf("Sheriff") === 120, `(${coinsOf("Sheriff")})`);
        check("the bounty is cleared", bountyOf("Bandit") === 0, `(${bountyOf("Bandit")})`);

        comeBack(bandit);

        const last = bandit.teleports.at(-1);
        check("no handler failed on the respawn either", errorLines().length === 0, errorLines().join(" | "));
        check("they are marked as jailed", bandit.tags.has("in_jail") && bandit.tags.has("jailed"), [...bandit.tags].join());
        check("the pending-jail marker is gone", !bandit.tags.has("send_to_jail"), [...bandit.tags].join());
        check("the FINAL teleport is a jail site, not an outlaw spawn", last !== undefined && isJail(last) && !isOutlawSpawn(last), JSON.stringify(bandit.teleports));
        check("they are told", bandit.messages.some((m) => strip(m).includes("You have been captured!")), JSON.stringify(bandit.messages));
        check("they are still an outlaw", bandit.tags.has("outlaw"), [...bandit.tags].join());
        done();
    });

    test(`a second capture with ${label} eliminates: announced, spectator on respawn, no teleport`, () => {
        const { check, done } = checks();
        const [sheriff, bandit] = scene(
            ["Sheriff", { tags: ["law"] }],
            ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }],
            ["Other", { tags: ["outlaw"] }]);

        die(bandit, sheriff);

        check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
        check("the elimination is announced", said("Bandit has been permanently eliminated!"), chat().join(" | "));
        check("this was not a first capture", !said("sent to jail"), chat().join(" | "));

        comeBack(bandit);

        check("no handler failed on the respawn either", errorLines().length === 0, errorLines().join(" | "));
        check("the eliminated tag is on them", bandit.tags.has("eliminated"), [...bandit.tags].join());
        check("they are put in spectator mode", commands().includes("gamemode spectator @s"), JSON.stringify(commands()));
        check("they are told", bandit.messages.some((m) => strip(m).includes("You have been permanently eliminated.")), JSON.stringify(bandit.messages));
        check("an eliminated player is not teleported to a spawn", bandit.teleports.length === 0, JSON.stringify(bandit.teleports));
        done();
    });

    test(`the law wins when the last outlaw is eliminated with ${label}, as the death is processed`, () => {
        const { check, done } = checks();
        const [sheriff, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw", "jailed"] }]);   // free, but already captured once
        check("(setup) no win yet", !said("THE LAW HAS WON!"), chat().join(" | "));

        die(bandit, sheriff);

        check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
        check("the law win is announced at once", chat().filter((m) => m.includes("THE LAW HAS WON!")).length === 1, chat().join(" | "));

        comeBack(bandit);

        check("still announced once after the respawn", chat().filter((m) => m.includes("THE LAW HAS WON!")).length === 1, chat().join(" | "));
        check("the sheriff is tagged winner", sheriff.tags.has("winner"), [...sheriff.tags].join());
        done();
    });
}

test("an outlaw who dies to something other than law respawns at an outlaw spawn, not in jail", () => {
    const { check, done } = checks();
    const [, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }], ["Other", { tags: ["outlaw"] }]);
    fake.setScore("bounty", "Bandit", 120);

    emitDeath(bandit, undefined);
    emitSpawn(bandit);

    const last = bandit.teleports.at(-1);
    check("no capture is announced", !said("captured") && !said("bounty"), chat().join(" | "));
    check("the bounty is still on their head", bountyOf("Bandit") === 120);
    check("they respawn at an outlaw spawn", last !== undefined && isOutlawSpawn(last), JSON.stringify(bandit.teleports));
    check("they are not jailed", !bandit.tags.has("in_jail") && !bandit.tags.has("jailed"), [...bandit.tags].join());
    done();
});

test("a law player killed by law does not capture anyone, and law killing law is no capture", () => {
    const { check, done } = checks();
    const [sheriff, deputy] = scene(["Sheriff", { tags: ["law"] }], ["Deputy", { tags: ["law"] }], ["Other", { tags: ["outlaw"] }]);
    emitDeath(deputy, sheriff);
    emitSpawn(deputy);
    check("nothing is announced", !said("captured") && !said("eliminated"), chat().join(" | "));
    check("the deputy is not jailed and respawns as law", !deputy.tags.has("in_jail") && !deputy.tags.has("send_to_jail") && deputy.tags.has("law"), [...deputy.tags].join());
    done();
});

// ---------------------------------------------------------------------------
// The death penalty (economy-rules.ts)
// ---------------------------------------------------------------------------

/** One item in the first slot, so a drop is visible. */
function withInventory(player) {
    player.giveAmmo("bountysys:handgun_ammo", 12);
    return player;
}

const penaltyLines = () => chat().filter((m) => m.includes("had no money") || m.includes("lost half"));

test("penalty: a law player with no money takes no penalty at all", () => {
    const { check, done } = checks();
    const [sheriff] = scene(["Sheriff", { tags: ["law"] }]);
    withInventory(sheriff);
    emitDeath(sheriff, undefined);
    check("nothing is announced", penaltyLines().length === 0, chat().join(" | "));
    check("the inventory is kept", sheriff.container.getItem(0)?.amount === 12);
    check("nothing is dropped", droppedItems() === 0, `(${droppedItems()})`);
    check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
    done();
});

test("penalty: an outlaw with no money drops their inventory", () => {
    const { check, done } = checks();
    const [, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }]);
    withInventory(bandit);
    emitDeath(bandit, undefined);
    check("it is announced", said("Bandit had no money and dropped their inventory!"), chat().join(" | "));
    check("the stack is on the ground", droppedItems() === 1, `(${droppedItems()})`);
    check("and out of their inventory", bandit.container.getItem(0) === undefined);
    check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
    done();
});

test("penalty: anyone who is not law, roles or not, drops their inventory when broke", () => {
    const { check, done } = checks();
    const [bystander] = scene(["Bystander"]);
    withInventory(bystander);
    emitDeath(bystander, undefined);
    check("it is announced", said("Bystander had no money and dropped their inventory!"), chat().join(" | "));
    check("the stack is on the ground", droppedItems() === 1 && bystander.container.getItem(0) === undefined);
    done();
});

test("penalty: money is halved for law and outlaws alike, and the inventory is kept", () => {
    const { check, done } = checks();
    const [sheriff, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }]);
    withInventory(sheriff); withInventory(bandit);
    fake.setScore("coins", "Sheriff", 100);
    fake.setScore("coins", "Bandit", 101);
    emitDeath(sheriff, undefined);
    emitDeath(bandit, undefined);
    check("the sheriff keeps the configured share", coinsOf("Sheriff") === Math.floor(100 * ECONOMY.deathCoinsKept), `(${coinsOf("Sheriff")})`);
    check("the outlaw keeps the configured share, rounded down", coinsOf("Bandit") === Math.floor(101 * ECONOMY.deathCoinsKept), `(${coinsOf("Bandit")})`);
    check("both are told", said("Sheriff died and lost half their money!") && said("Bandit died and lost half their money!"), chat().join(" | "));
    check("no inventory is dropped", droppedItems() === 0 && sheriff.container.getItem(0) !== undefined && bandit.container.getItem(0) !== undefined);
    done();
});

test("penalty with an INVALID handle: money is still halved and announced, and nothing throws", { todo: TODO }, () => {
    const { check, done } = checks();
    const [, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }]);
    fake.setScore("coins", "Bandit", 80);
    dieGone(bandit, undefined);
    check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
    check("the money is halved", coinsOf("Bandit") === Math.floor(80 * ECONOMY.deathCoinsKept), `(${coinsOf("Bandit")})`);
    check("it is announced, by name", said("Bandit died and lost half their money!"), chat().join(" | "));
    done();
});

test("penalty with an INVALID handle: a broke law player takes no penalty, and nothing throws", () => {
    const { check, done } = checks();
    const [sheriff] = scene(["Sheriff", { tags: ["law"] }]);
    dieGone(sheriff, undefined);
    check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
    check("nothing is announced", penaltyLines().length === 0, chat().join(" | "));
    done();
});

test("penalty with an INVALID handle: a broke outlaw cannot drop an inventory that can't be reached, and nothing throws", () => {
    const { check, done } = checks();
    const [, bandit] = scene(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }]);
    withInventory(bandit);
    dieGone(bandit, undefined);
    check("no handler failed", errorLines().length === 0, errorLines().join(" | "));
    check("nothing is dropped, and no false claim of it", droppedItems() === 0 && penaltyLines().length === 0, chat().join(" | "));
    done();
});
