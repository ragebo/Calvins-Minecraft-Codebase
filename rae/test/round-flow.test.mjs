import { test } from "node:test";
import { fake, world, system, load, checks, strip } from "./helpers.mjs";

// Characterization of the round from start to finish: role assignment, the law win and the outlaw
// boat win. Everything is driven through public entry points only (script events, deaths, spawns)
// and judged by the game's outputs (tags, chat, titles, teleports), so it holds however the code
// keeps its state. Loads every system exactly as the game does: handler ORDER across files matters.

await load("main.js");
const { LAW_SPAWNS, OUTLAW_SPAWNS, BOAT_NPC, BOAT_WIN_TELEPORT } = await load("config/world.js");
const { ECONOMY, BOAT } = await load("config/balance.js");
const { resetAllSystems } = await load("core/registry.js");

const scriptEvent = (id, sourceEntity) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message: "" });
const kill = (victim, killer) => world.afterEvents.entityDie.emit({ deadEntity: victim, damageSource: { damagingEntity: killer } });
const respawn = (player) => {
    world.afterEvents.playerSpawn.emit({ player, initialSpawn: false });
    fake.advance(1);                                     // system.run callbacks (teleports, messages)
};
const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const isOneOf = (list, spot) => list.some((s) => sameSpot(s, spot));
const tagsOf = (p) => [...p.tags].sort().join(",");
const chatLines = () => fake.chat.map(strip);
const overworld = () => fake.dimension("overworld");

/** An empty world: no players, no leftover module state from an earlier test, scoreboards in place. */
function scene() {
    fake.reset();
    resetAllSystems();
    fake.addObjective("coins");
    fake.addObjective("bounty");
}

/** Creates the players, then lets a tick pass so anything cached per tick starts from this scene. */
function cast(...specs) {
    const players = specs.map(([name, options]) => fake.makePlayer(name, options));
    fake.advance(1);
    return players;
}

// ---------------------------------------------------------------------------
// Role assignment: bounty:start_round
// ---------------------------------------------------------------------------

test("start_round: law = ceil(players / 4), everyone else outlaw, each player carries exactly one role", () => {
    const { check, done } = checks();
    for (const [count, expectedLaw] of [[2, 1], [3, 1], [4, 1], [5, 2], [8, 2], [9, 3], [12, 3], [13, 4]]) {
        scene();
        const players = cast(...Array.from({ length: count }, (_, i) => [`P${i}`]));
        scriptEvent("bounty:start_round");
        const law = players.filter((p) => p.tags.has("law"));
        const outlaws = players.filter((p) => p.tags.has("outlaw"));
        check(`${count} players: ${expectedLaw} law`, law.length === expectedLaw, `(got ${law.length})`);
        check(`${count} players: the rest are outlaws`, outlaws.length === count - expectedLaw, `(got ${outlaws.length})`);
        check(`${count} players: nobody is both, nobody is neither`, players.every((p) => p.tags.has("law") !== p.tags.has("outlaw")));
        fake.advance(60);                                // let the title timer finish so nothing outlives the scene
    }
    done();
});

test("start_round: a single player is refused and nothing is touched", () => {
    const { check, done } = checks();
    scene();
    const [solo] = cast(["Solo", { tags: ["outlaw", "jailed"] }]);
    scriptEvent("bounty:start_round");
    check("the refusal is announced", chatLines().includes("Not enough players to start."), chatLines().join(" | "));
    check("their tags are left alone", tagsOf(solo) === "jailed,outlaw", tagsOf(solo));
    check("no title, no teleport", solo.titles.length === 0 && solo.teleports.length === 0);
    done();
});

test("start_round: 'Rolling...' at once, the role title and 'Roles Assigned!' exactly 60 ticks later", () => {
    const { check, done } = checks();
    scene();
    const players = cast(["A"], ["B"], ["C"], ["D"], ["E"]);       // 2 law, 3 outlaws
    scriptEvent("bounty:start_round");

    check("everyone is told Rolling... immediately", players.every((p) => p.titles.map(strip).join("|") === "Rolling..."), players.map((p) => p.titles.join("|")).join(" / "));
    check("no announcement yet", !chatLines().includes("Roles Assigned!"));

    fake.advance(59);
    check("still Rolling... at tick 59", players.every((p) => p.titles.length === 1) && !chatLines().includes("Roles Assigned!"));

    fake.advance(1);
    const law = players.filter((p) => p.tags.has("law"));
    const outlaws = players.filter((p) => p.tags.has("outlaw"));
    check("law see LAWMAN", law.length === 2 && law.every((p) => strip(p.titles.at(-1)) === "LAWMAN" && p.titles.length === 2), law.map((p) => p.titles.join("|")).join(" / "));
    check("outlaws see OUTLAW", outlaws.length === 3 && outlaws.every((p) => strip(p.titles.at(-1)) === "OUTLAW" && p.titles.length === 2), outlaws.map((p) => p.titles.join("|")).join(" / "));
    check("Roles Assigned! is announced once", chatLines().filter((m) => m === "Roles Assigned!").length === 1, chatLines().join(" | "));
    done();
});

test("start_round: every player is teleported once, to the spawn list of their role", () => {
    const { check, done } = checks();
    scene();
    const players = cast(["A"], ["B"], ["C"], ["D"], ["E"], ["F"]);
    scriptEvent("bounty:start_round");
    for (const p of players) {
        const role = p.tags.has("law") ? "law" : "outlaw";
        const spot = p.teleports.at(-1);
        check(`${p.name} (${role}) is teleported exactly once`, p.teleports.length === 1, `(${p.teleports.length})`);
        check(`${p.name} lands on a ${role} spawn`, spot !== undefined && isOneOf(role === "law" ? LAW_SPAWNS : OUTLAW_SPAWNS, spot), JSON.stringify(spot));
    }
    fake.advance(60);
    done();
});

test("start_round: the previous round's tags are wiped before roles are dealt", () => {
    const { check, done } = checks();
    scene();
    const players = cast(
        ["A", { tags: ["law", "winner"] }],
        ["B", { tags: ["outlaw", "jailed", "in_jail", "escort_vulnerable"] }],
        ["C", { tags: ["outlaw", "eliminated", "send_to_jail"] }],
        ["D", { tags: ["native"] }]
    );
    scriptEvent("bounty:start_round");
    const leftovers = ["winner", "jailed", "in_jail", "escort_vulnerable", "eliminated", "send_to_jail", "native"];
    for (const p of players) {
        check(`${p.name} carries no leftover tag`, leftovers.every((t) => !p.tags.has(t)), tagsOf(p));
        check(`${p.name} has exactly one role`, p.tags.has("law") !== p.tags.has("outlaw"), tagsOf(p));
    }
    check("one law, three outlaws", players.filter((p) => p.tags.has("law")).length === 1 && players.filter((p) => p.tags.has("outlaw")).length === 3);
    fake.advance(60);
    done();
});

test("bounty:teleport sends only players who have a role, to their own spawns", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, bandit, bystander] = cast(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw"] }], ["Bystander"]);
    scriptEvent("bounty:teleport");
    check("law goes to a law spawn", sheriff.teleports.length === 1 && isOneOf(LAW_SPAWNS, sheriff.teleports[0]), JSON.stringify(sheriff.teleports));
    check("the outlaw goes to an outlaw spawn", bandit.teleports.length === 1 && isOneOf(OUTLAW_SPAWNS, bandit.teleports[0]), JSON.stringify(bandit.teleports));
    check("someone with no role is not moved", bystander.teleports.length === 0, JSON.stringify(bystander.teleports));
    done();
});

test("rae:reset clears every role and status tag, and the next round can start clean", () => {
    const { check, done } = checks();
    scene();
    const players = cast(
        ["A", { tags: ["law", "winner"] }],
        ["B", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["C", { tags: ["outlaw", "eliminated"] }],
        ["D", { tags: ["outlaw", "escort_vulnerable", "send_to_jail", "native"] }]
    );
    scriptEvent("rae:reset");
    check("the reset is announced", chatLines().includes("All systems reset."), chatLines().join(" | "));
    for (const p of players) check(`${p.name} has no tags left`, p.tags.size === 0, tagsOf(p));
    done();
});

// ---------------------------------------------------------------------------
// The law win: every outlaw eliminated or in jail
// ---------------------------------------------------------------------------

const lawWins = () => chatLines().filter((m) => m.includes("THE LAW HAS WON!")).length;

test("law win: the last free outlaw is eliminated by a second capture", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, bandit] = cast(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }]);
    kill(bandit, sheriff);
    respawn(bandit);
    check("the law win is announced exactly once", lawWins() === 1, chatLines().join(" | "));
    check("with its explanation", chatLines().some((m) => m.includes("Every outlaw is captured or eliminated")), chatLines().join(" | "));
    check("the surviving law is a winner", sheriff.tags.has("winner"), tagsOf(sheriff));
    check("the eliminated outlaw is not", !bandit.tags.has("winner") && bandit.tags.has("eliminated"), tagsOf(bandit));
    done();
});

test("law win: every outlaw ends up in jail, and only once the last one has respawned there", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, bandit, other] = cast(
        ["Sheriff", { tags: ["law"] }],
        ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["Other", { tags: ["outlaw"] }]);
    kill(other, sheriff);
    check("captured but not yet in jail: no win yet", lawWins() === 0, chatLines().join(" | "));
    respawn(other);
    check("jailed on respawn: the law wins", lawWins() === 1, chatLines().join(" | "));
    check("the sheriff is a winner", sheriff.tags.has("winner"), tagsOf(sheriff));
    check("the prisoners are not", !bandit.tags.has("winner") && !other.tags.has("winner"));
    done();
});

test("law win: one free outlaw is enough to keep the round going", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, bandit] = cast(
        ["Sheriff", { tags: ["law"] }],
        ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["Free", { tags: ["outlaw"] }]);
    kill(bandit, sheriff);
    respawn(bandit);
    check("no win", lawWins() === 0, chatLines().join(" | "));
    check("no winner tag", !sheriff.tags.has("winner"), tagsOf(sheriff));
    done();
});

test("law win: no outlaws at all is not a win", () => {
    const { check, done } = checks();
    scene();
    const [sheriff] = cast(["Sheriff", { tags: ["law"] }], ["Deputy", { tags: ["law"] }]);
    respawn(sheriff);
    check("no win", lawWins() === 0, chatLines().join(" | "));
    check("no winner tag", !sheriff.tags.has("winner"));
    done();
});

test("law win: an eliminated law player is not a winner, the others are", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, deputy, ghost, bandit] = cast(
        ["Sheriff", { tags: ["law"] }],
        ["Deputy", { tags: ["law"] }],
        ["Ghost", { tags: ["law", "eliminated"] }],
        ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }]);
    kill(bandit, sheriff);
    respawn(bandit);
    check("the law wins", lawWins() === 1, chatLines().join(" | "));
    check("both living law are winners", sheriff.tags.has("winner") && deputy.tags.has("winner"));
    check("the eliminated one is not", !ghost.tags.has("winner"), tagsOf(ghost));
    done();
});

test("law win: announced once however many deaths and spawns follow", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, bandit, other] = cast(
        ["Sheriff", { tags: ["law"] }],
        ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["Other", { tags: ["outlaw", "jailed", "in_jail"] }]);
    kill(bandit, sheriff); respawn(bandit);              // Bandit is out, Other is still in jail: the win lands here
    check("won", lawWins() === 1, chatLines().join(" | "));
    respawn(other); respawn(sheriff);
    kill(other, sheriff); respawn(other);
    check("still announced once", lawWins() === 1, chatLines().join(" | "));
    check("and the winner is tagged once", sheriff.tags.has("winner"));
    done();
});

test("law win: a reset re-arms it", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, bandit] = cast(["Sheriff", { tags: ["law"] }], ["Bandit", { tags: ["outlaw", "jailed", "in_jail"] }]);
    kill(bandit, sheriff); respawn(bandit);
    check("(setup) the first win", lawWins() === 1);
    scriptEvent("rae:reset");
    check("the reset removed the winner tag", !sheriff.tags.has("winner"), tagsOf(sheriff));

    // A new round: the same two players, freshly tagged.
    for (const t of ["law"]) sheriff.tags.add(t);
    for (const t of ["outlaw", "jailed", "in_jail"]) bandit.tags.add(t);
    fake.chat.length = 0;
    fake.advance(1);
    kill(bandit, sheriff); respawn(bandit);
    check("the second round's win is announced again", lawWins() === 1, chatLines().join(" | "));
    done();
});

// ---------------------------------------------------------------------------
// The outlaw win: the whole gang gathers at the boat with enough money
// ---------------------------------------------------------------------------

const escape = (player) => scriptEvent("bounty:escape", player);
const atBoat = (dx = 1) => ({ x: BOAT_NPC.x + dx, y: BOAT_NPC.y, z: BOAT_NPC.z });
const farFromBoat = () => ({ x: BOAT_NPC.x + BOAT.escapeRadius + 40, y: BOAT_NPC.y, z: BOAT_NPC.z });
const coinsOf = (name) => world.scoreboard.getObjective("coins").getScore(name) ?? 0;
const escaped = () => chatLines().some((m) => m.includes("THE OUTLAWS HAVE ESCAPED!"));
const teleportCommands = () => overworld().commands.filter((c) => c.startsWith("tp @a[tag=winner]"));
const need = ECONOMY.boatEscapePerOutlaw;

test("boat win: the gang pools the coins, every surviving outlaw wins and is teleported", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, a, b, ghost] = cast(
        ["Sheriff", { tags: ["law"], location: farFromBoat() }],
        ["A", { tags: ["outlaw"], location: atBoat(1) }],
        ["B", { tags: ["outlaw"], location: atBoat(-2) }],
        ["Ghost", { tags: ["outlaw", "eliminated"], location: farFromBoat() }]);   // eliminated: neither required nor a winner
    fake.setScore("coins", "A", need + 50);
    fake.setScore("coins", "B", need);                       // 2 survivors owe 2 * boatEscapePerOutlaw between them

    escape(a);

    check("the escape is announced", escaped(), chatLines().join(" | "));
    check("with the pooled amount", chatLines().some((m) => m.includes(`The gang pooled ${2 * need} coins`)), chatLines().join(" | "));
    check("both survivors are winners", a.tags.has("winner") && b.tags.has("winner"), `${tagsOf(a)} / ${tagsOf(b)}`);
    check("the law and the eliminated outlaw are not", !sheriff.tags.has("winner") && !ghost.tags.has("winner"));
    // The price is taken from the first survivor until they run out, then from the next: A pays all
    // of (need + 50), B pays the remaining need - 50 and keeps 50.
    check("coins are taken in order until the price is paid", coinsOf("A") === 0 && coinsOf("B") === 50, `(A=${coinsOf("A")} B=${coinsOf("B")})`);
    check("winners are teleported to the win spot", teleportCommands().length === 1 && teleportCommands()[0] === `tp @a[tag=winner] ${BOAT_WIN_TELEPORT.x} ${BOAT_WIN_TELEPORT.y} ${BOAT_WIN_TELEPORT.z}`, JSON.stringify(overworld().commands));
    done();
});

test("boat win: only outlaws may use the boat", () => {
    const { check, done } = checks();
    scene();
    const [sheriff, a] = cast(["Sheriff", { tags: ["law"], location: atBoat() }], ["A", { tags: ["outlaw"], location: atBoat() }]);
    fake.setScore("coins", "A", need);
    escape(sheriff);
    check("the law is told so", sheriff.messages.map(strip).includes("Only outlaws can use the escape boat."), JSON.stringify(sheriff.messages));
    check("nothing else happens", !escaped() && !a.tags.has("winner") && teleportCommands().length === 0);
    done();
});

test("boat win: every surviving outlaw must be at the boat", () => {
    const { check, done } = checks();
    scene();
    const [a, b] = cast(["A", { tags: ["outlaw"], location: atBoat() }], ["B", { tags: ["outlaw"], location: farFromBoat() }]);
    fake.setScore("coins", "A", 10 * need);
    escape(a);
    check("the gang is told to gather", chatLines().includes("All surviving outlaws must gather at the escape boat!"), chatLines().join(" | "));
    check("no win, no coins taken", !escaped() && !a.tags.has("winner") && !b.tags.has("winner") && coinsOf("A") === 10 * need);
    done();
});

test("boat win: a jailed outlaw is still a survivor and must be at the boat too", () => {
    const { check, done } = checks();
    scene();
    const [a, prisoner] = cast(["A", { tags: ["outlaw"], location: atBoat() }], ["Prisoner", { tags: ["outlaw", "jailed", "in_jail"], location: farFromBoat() }]);
    fake.setScore("coins", "A", 10 * need);
    escape(a);
    check("blocked", chatLines().includes("All surviving outlaws must gather at the escape boat!") && !escaped(), chatLines().join(" | "));
    check("nobody wins", !a.tags.has("winner") && !prisoner.tags.has("winner"));
    done();
});

test("boat win: the gang must be able to pay", () => {
    const { check, done } = checks();
    scene();
    const [a, b] = cast(["A", { tags: ["outlaw"], location: atBoat(1) }], ["B", { tags: ["outlaw"], location: atBoat(2) }]);
    fake.setScore("coins", "A", need - 1);
    fake.setScore("coins", "B", need - 1);                   // one coin short of 2 * price in total
    escape(a);
    check("the price is stated", chatLines().includes(`The gang needs ${2 * need} coins to escape.`), chatLines().join(" | "));
    check("and the combined money", chatLines().includes(`Combined money: ${2 * need - 2}`), chatLines().join(" | "));
    check("no win, no coins taken", !escaped() && !a.tags.has("winner") && coinsOf("A") === need - 1 && coinsOf("B") === need - 1);
    check("nobody is teleported", teleportCommands().length === 0);
    done();
});

test("boat win: a lone survivor pays for one, and exactly the price is enough", () => {
    const { check, done } = checks();
    scene();
    const [a] = cast(["A", { tags: ["outlaw"], location: atBoat() }], ["Sheriff", { tags: ["law"], location: farFromBoat() }]);
    fake.setScore("coins", "A", need);
    escape(a);
    check("escaped", escaped() && a.tags.has("winner"), chatLines().join(" | "));
    check("paid the price of one, nothing more", coinsOf("A") === 0, `(${coinsOf("A")})`);
    done();
});
