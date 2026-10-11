import { test } from "node:test";
import { fake, world, load, checks, strip } from "./helpers.mjs";

// Loads every system exactly as the game does, so handler ORDER across files matters here.
await load("main.js");
const { JAIL_SITES, OUTLAW_SPAWNS, LAW_SPAWNS } = await load("config/world.js");
const { resetAllSystems } = await load("core/registry.js");

const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const isJail = (spot) => JAIL_SITES.some((s) => sameSpot(s.jail, spot));
const isOutlawSpawn = (spot) => OUTLAW_SPAWNS.some((s) => sameSpot(s, spot));

function kill(victim, killer) {
    world.afterEvents.entityDie.emit({ deadEntity: victim, damageSource: { damagingEntity: killer } });
}
function respawn(player) {
    world.afterEvents.playerSpawn.emit({ player, initialSpawn: false });
    fake.advance(1);                                     // system.run callbacks (teleports, messages)
}
function scene() {
    fake.reset();
    resetAllSystems();                                   // player state is kept by player id, and the same ids come back in every scene
    fake.addObjective("coins"); fake.addObjective("bounty");
    const law = fake.makePlayer("Sheriff", { tags: ["law"] });
    const outlaw = fake.makePlayer("Bandit", { tags: ["outlaw"] });
    const other = fake.makePlayer("Other", { tags: ["outlaw"] });   // keeps the law-win check from ending the round
    fake.setScore("bounty", "Bandit", 120);
    return { law, outlaw, other };
}

test("law kills an outlaw: they are captured, and respawn in JAIL (not at an outlaw spawn)", () => {
    const { check, done } = checks();
    const { law, outlaw } = scene();

    kill(outlaw, law);
    const chat = fake.chat.map(strip).join(" | ");
    check("capture is announced", chat.includes("captured by the law and sent to jail"), chat);
    check("the bounty was collected by the killer", chat.includes("collected a bounty of"), chat);

    respawn(outlaw);
    const last = outlaw.teleports.at(-1);
    check("they were teleported somewhere", last !== undefined);
    check("the FINAL teleport is a jail site, not an outlaw spawn",
        last !== undefined && isJail(last) && !isOutlawSpawn(last), `final=${JSON.stringify(last)} teleports=${JSON.stringify(outlaw.teleports)}`);
    check("they are marked as jailed", outlaw.tags.has("in_jail") && outlaw.tags.has("jailed"), [...outlaw.tags].join());
    done();
});

test("a second capture eliminates: spectator, and NO respawn teleport", () => {
    const { check, done } = checks();
    const { law, outlaw } = scene();

    kill(outlaw, law); respawn(outlaw);                  // first capture -> jail
    outlaw.teleports.length = 0;
    kill(outlaw, law);                                   // captured again while jailed
    respawn(outlaw);

    const commands = fake.dimension("overworld").commands.concat(outlaw.commands);
    check("eliminated tag set", outlaw.tags.has("eliminated"), [...outlaw.tags].join());
    check("an eliminated player is not teleported to a spawn", outlaw.teleports.length === 0, JSON.stringify(outlaw.teleports));
    done();
});

test("a normal death (no law killer) respawns an outlaw at an outlaw spawn", () => {
    const { check, done } = checks();
    const { outlaw } = scene();
    world.afterEvents.entityDie.emit({ deadEntity: outlaw, damageSource: { damagingEntity: undefined } });
    respawn(outlaw);
    const last = outlaw.teleports.at(-1);
    check("respawn teleport happened", last !== undefined);
    check("to an outlaw spawn", last !== undefined && isOutlawSpawn(last), JSON.stringify(last));
    done();
});

test("law respawns at a law spawn", () => {
    const { law } = scene();
    respawn(law);
    const last = law.teleports.at(-1);
    const { check, done } = checks();
    check("law respawn teleport happened", last !== undefined);
    check("to a law spawn", last !== undefined && LAW_SPAWNS.some((s) => sameSpot(s, last)), JSON.stringify(last));
    done();
});

const gamemodeCommands = () => fake.dimension("overworld").commands.filter((command) => command.startsWith("gamemode "));

test("an eliminated player gets their game mode back when the next round resets, and is not left a spectator", () => {
    const { check, done } = checks();
    const { law, outlaw } = scene();
    outlaw.getGameMode = () => "Adventure";

    kill(outlaw, law); respawn(outlaw);
    kill(outlaw, law); respawn(outlaw);

    check("they were put in spectator", gamemodeCommands().at(-1) === "gamemode spectator @s", gamemodeCommands().join(" | "));
    check("what they were before is remembered", outlaw.getDynamicProperty("rae:gamemode_before_spectator") === "adventure");

    fake.dimension("overworld").commands.length = 0;
    resetAllSystems();

    check("the reset gave them adventure back", gamemodeCommands().join() === "gamemode adventure @s", gamemodeCommands().join(" | "));
    check("and forgot it", outlaw.getDynamicProperty("rae:gamemode_before_spectator") === undefined);

    fake.dimension("overworld").commands.length = 0;
    resetAllSystems();
    check("a second reset does nothing to them", gamemodeCommands().length === 0, gamemodeCommands().join(" | "));
    done();
});

test("a reset leaves alone a player the round never made a spectator (an operator testing in spectator keeps it)", () => {
    const { check, done } = checks();
    const { other } = scene();
    other.getGameMode = () => "Spectator";
    fake.advance(1);                                     // players() is one snapshot per tick: let the reset below really see this player

    fake.dimension("overworld").commands.length = 0;
    resetAllSystems();

    check("no game mode command at all", gamemodeCommands().length === 0, gamemodeCommands().join(" | "));
    check("(and they were in the reset's reach: a remembered mode would have been given back)", (other.setDynamicProperty("rae:gamemode_before_spectator", "survival"), resetAllSystems(), gamemodeCommands().join() === "gamemode survival @s"), gamemodeCommands().join(" | "));
    done();
});

test("a player who was offline when the round reset is let out of spectator when they next spawn", () => {
    const { check, done } = checks();
    const { outlaw } = scene();

    outlaw.setDynamicProperty("rae:gamemode_before_spectator", "survival");   // left while eliminated; the reset could not reach them
    fake.dimension("overworld").commands.length = 0;

    respawn(outlaw);

    check("they are given survival back", gamemodeCommands().join() === "gamemode survival @s", gamemodeCommands().join(" | "));
    check("and it is forgotten", outlaw.getDynamicProperty("rae:gamemode_before_spectator") === undefined);
    done();
});

test("when the game refuses the command, the remembered mode is kept and the next reset tries again", () => {
    const { check, done } = checks();
    const { outlaw } = scene();
    outlaw.setDynamicProperty("rae:gamemode_before_spectator", "adventure");
    fake.advance(1);                                     // players() is one snapshot per tick, and scene() reset before these players existed

    const overworldDim = fake.dimension("overworld");
    const realRun = overworldDim.runCommand;
    const realError = console.error;
    const failures = [];
    console.error = (...args) => failures.push(args.join(" "));
    overworldDim.runCommand = () => { throw new Error("the game said no"); };

    try {
        resetAllSystems();
    } finally {
        overworldDim.runCommand = realRun;
        console.error = realError;
    }

    check("the failure was reported, not thrown out of the reset", failures.some((m) => /could not give a player their game mode back: the game said no/.test(m)), failures.join(" | "));
    check("what was remembered is still there", outlaw.getDynamicProperty("rae:gamemode_before_spectator") === "adventure");

    overworldDim.commands.length = 0;
    resetAllSystems();
    check("the next reset gives it back and forgets it", gamemodeCommands().join() === "gamemode adventure @s" && outlaw.getDynamicProperty("rae:gamemode_before_spectator") === undefined, gamemodeCommands().join(" | "));
    done();
});
