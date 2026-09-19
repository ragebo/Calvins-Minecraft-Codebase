import { test } from "node:test";
import { fake, world, load, checks, strip } from "./helpers.mjs";

// Loads every system exactly as the game does, so handler ORDER across files matters here.
await load("main.js");
const { JAIL_SITES, OUTLAW_SPAWNS, LAW_SPAWNS } = await load("config/world.js");

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
