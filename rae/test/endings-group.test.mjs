import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, load, checks, strip } from "./helpers.mjs";

// core/endings.ts + systems/endings.ts (tasks/endings, Task 3): a GROUP ending, run through the same events the boat always used. The boat's own
// behavior is pinned by test/round-flow.test.mjs ("boat win: ..."), which must keep passing unchanged; this file is what is new: more than one ending,
// each with its own place, price and words, switched on and off, refused for the same reasons, and found by id.

await load("main.js");
const round = await load("core/round.js");
const store = await load("core/endingstore.js");
const state = await load("core/state.js");
const L = await load("logic/endings.js");
const { listSystems } = await load("core/registry.js");
const { BOAT_NPC } = await load("config/world.js");
const { ECONOMY } = await load("config/balance.js");

const PIER = { x: 200, y: 64, z: 300 };
const FAR = { x: 5000, y: 64, z: 5000 };

const scriptEvent = (id, sourceEntity, message = "", extra = {}) => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message, ...extra });
const ending = (player, id) => scriptEvent("rae:ending", player, id);
const said = () => fake.chat.map(strip);
const coinsOf = (name) => world.scoreboard.getObjective("coins").getScore(name) ?? 0;
const tp = () => fake.dimension("overworld").commands.filter((c) => c.startsWith("tp @a[tag=winner]"));
const ended = () => round.getPhase() === "ENDED";

function scene() {
    fake.reset();
    round.resetRound();
    store.forgetEndings();
    round.startRound();
    round.beginActive();
    fake.addObjective("coins");
    fake.addObjective("bounty");
}

function cast(...specs) {
    const players = specs.map(([name, options]) => fake.makePlayer(name, options));
    fake.advance(1);
    return players;
}

function addPier(patch = {}) {
    const made = L.newEnding("group", "pier", "The Pier", PIER);
    assert.ok(made.ok, made.reason);
    const edited = L.edit(made.value, {
        radius: 10, price: 100, winSpot: { x: 210, y: 70, z: 310 },
        texts: { headline: "§bTHE GANG SAILED!", detail: "§7They paid {coins} coins ({count} of them).", gather: "§cEveryone to the pier!", outlawsOnly: "§cThe pier is for outlaws." },
        ...patch
    });
    assert.ok(edited.ok, edited.reason);
    assert.equal(store.saveEnding(edited.value).ok, true);
}

const at = (x, z) => ({ x, y: 64, z });

test("a second group ending works beside the boat: its own place, price, words and win spot", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a, b] = cast(["A", { tags: ["outlaw"], location: at(PIER.x + 2, PIER.z) }], ["B", { tags: ["outlaw"], location: at(PIER.x - 3, PIER.z + 1) }]);
    fake.setScore("coins", "A", 150);
    fake.setScore("coins", "B", 90);

    ending(a, "pier");

    check("its headline is announced", said().includes("THE GANG SAILED!"), said().join(" | "));
    check("its detail has the amount and the number of members filled in", said().includes("They paid 200 coins (2 of them)."), said().join(" | "));
    check("the price is per member: 2 x 100 taken, in order", coinsOf("A") === 0 && coinsOf("B") === 40, `(A=${coinsOf("A")} B=${coinsOf("B")})`);
    check("both are winners", a.tags.has("winner") && b.tags.has("winner"));
    check("they are taken to the pier's own win spot", tp().length === 1 && tp()[0] === "tp @a[tag=winner] 210 70 310", tp().join(" | "));
    check("the round ended as an outlaw win, and says by which ending", round.getPhase() === "ENDED" && round.lastEnd() === "outlaw_win" && round.lastEndDetail() === "pier", `${round.getPhase()} ${round.lastEnd()} ${round.lastEndDetail()}`);
    done();
});

test("the boat and the pier do not interfere: a gang at one cannot use the other", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(BOAT_NPC.x, BOAT_NPC.z) }]);
    fake.setScore("coins", "A", 10_000);

    ending(a, "pier");

    check("at the boat, asking for the pier: told to gather, in the pier's words", said().includes("Everyone to the pier!"), said().join(" | "));
    check("nothing was taken and nobody won", coinsOf("A") === 10_000 && !a.tags.has("winner") && !ended());

    ending(a, "boat");
    check("the boat works from where they stand", said().includes("THE OUTLAWS HAVE ESCAPED!") && ended(), said().join(" | "));
    check("and paid the boat's price", coinsOf("A") === 10_000 - ECONOMY.boatEscapePerOutlaw, String(coinsOf("A")));
    done();
});

test("the price follows the outlaws in play at the moment: an eliminated one is no longer owed for", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a, b, c] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }], ["B", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }], ["C", { tags: ["outlaw", "eliminated"], location: at(FAR.x, FAR.z) }]);
    fake.setScore("coins", "A", 1000);

    ending(a, "pier");

    check("two in play: 200 taken, not 300", coinsOf("A") === 800, String(coinsOf("A")));
    check("the eliminated one is no winner", b.tags.has("winner") && !c.tags.has("winner"));
    done();
});

test("only an outlaw, and only in an active round, may use an ending, told in the ending's own words", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [sheriff, a] = cast(["Sheriff", { tags: ["law"], location: at(PIER.x, PIER.z) }], ["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);

    ending(sheriff, "pier");
    check("the law is told by the pier's words", sheriff.messages.map(strip).includes("The pier is for outlaws."), JSON.stringify(sheriff.messages));
    check("nothing else happens", !ended() && coinsOf("A") === 1000);

    // A world with no round: the players are made after the reset, as the boat's own test does it.
    fake.reset();
    round.resetRound();
    store.forgetEndings();
    addPier();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    const [idle] = cast(["Idle", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "Idle", 1000);
    ending(idle, "pier");
    check("outside a round: told so, nothing spent", idle.messages.map(strip).includes("No round is running.") && coinsOf("Idle") === 1000 && !idle.tags.has("winner"), JSON.stringify(idle.messages));
    done();
});

test("an ending that is off, one that does not exist, and no id at all each say so and do nothing", () => {
    scene();
    addPier({ enabled: false });
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);
    const heard = () => a.messages.map(strip);

    ending(a, "pier");
    check("off", heard().some((m) => /switched off/.test(m)), JSON.stringify(heard()));

    ending(a, "nowhere");
    check("unknown", heard().some((m) => /no ending nowhere/.test(m)), JSON.stringify(heard()));

    ending(a, "");
    check("no id: told how to use it, and which exist", heard().some((m) => /rae:ending <id>/.test(m) && /boat/.test(m)), JSON.stringify(heard()));

    check("nothing happened", !ended() && coinsOf("A") === 1000 && !a.tags.has("winner"));
    done();
});

test("two attempts in the same tick: the first wins and the second is refused without taking a coin", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a, b] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }], ["B", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 500);
    fake.setScore("coins", "B", 500);

    ending(a, "pier");
    const afterFirst = [coinsOf("A"), coinsOf("B")].join();
    ending(b, "pier");

    check("one announcement", said().filter((m) => m === "THE GANG SAILED!").length === 1);
    check("the second took nothing", [coinsOf("A"), coinsOf("B")].join() === afterFirst, `${afterFirst} -> ${coinsOf("A")},${coinsOf("B")}`);
    check("the second was told no round is running", b.messages.map(strip).includes("No round is running."));
    done();
});

test("bounty:escape still works, as the boat; and it does not work once the boat has been deleted", () => {
    scene();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(BOAT_NPC.x, BOAT_NPC.z) }]);
    fake.setScore("coins", "A", 1000);

    scriptEvent("bounty:escape", a);
    check("the old event is the boat", said().includes("THE OUTLAWS HAVE ESCAPED!") && ended() && round.lastEndDetail() === "boat");

    scene();
    store.removeEnding("boat");
    const [b] = cast(["B", { tags: ["outlaw"], location: at(BOAT_NPC.x, BOAT_NPC.z) }]);
    fake.setScore("coins", "B", 1000);
    scriptEvent("bounty:escape", b);
    check("with no boat ending it says so and does nothing", !ended() && coinsOf("B") === 1000 && b.messages.map(strip).some((m) => /no ending boat/.test(m)), JSON.stringify(b.messages));
    done();
});

test("an operator's change to the boat is what the next attempt uses", () => {
    scene();
    const { check, done } = checks();
    const boat = store.getEnding("boat");
    const dearer = L.edit(boat, { price: 400, texts: { headline: "§6THE FERRY LEAVES!" } });
    assert.ok(dearer.ok);
    assert.equal(store.saveEnding(dearer.value).ok, true);

    const [a] = cast(["A", { tags: ["outlaw"], location: at(BOAT_NPC.x, BOAT_NPC.z) }]);
    fake.setScore("coins", "A", 1000);
    scriptEvent("bounty:escape", a);

    check("the new words are said", said().includes("THE FERRY LEAVES!"), said().join(" | "));
    check("the new price is taken", coinsOf("A") === 600, String(coinsOf("A")));
    done();
});

test("an ending run from an NPC's dialogue button finds the player who pressed it", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });
    fake.setScore("coins", "A", 500);

    scriptEvent("rae:ending", npc, "pier", { initiator: a, sourceType: "NPCDialogue" });

    check("it ran for the player who pressed the button", ended() && a.tags.has("winner"), said().join(" | "));
    done();
});

test("a solo ending is not run by the group engine (it has its own, later)", () => {
    scene();
    const { check, done } = checks();
    const made = L.newEnding("solo", "tower", "Tower", PIER);
    assert.ok(made.ok);
    assert.equal(store.saveEnding(made.value).ok, true);
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);

    ending(a, "tower");

    check("nothing is taken and nobody wins", coinsOf("A") === 1000 && !a.tags.has("winner") && !ended());
    check("the player is told", a.messages.map(strip).some((m) => /not ready/.test(m)), JSON.stringify(a.messages));
    done();
});

test("an ending with no win spot teleports nobody; a jailed survivor still has to be there and still wins", () => {
    scene();
    addPier({ winSpot: null });
    const { check, done } = checks();
    const [a, jailed] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }], ["J", { tags: ["outlaw", "jailed", "in_jail"], location: at(PIER.x + 1, PIER.z) }]);
    fake.setScore("coins", "A", 1000);

    ending(a, "pier");

    check("they won", ended() && a.tags.has("winner") && jailed.tags.has("winner"));
    check("no teleport command was run", tp().length === 0, tp().join(" | "));
    done();
});

test("the engine keeps nothing between rounds, and the next round can use an ending again", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);
    ending(a, "pier");
    check("the first round ended", ended());

    round.resetRound();
    round.startRound();
    round.beginActive();
    state.update(a, { role: "outlaw" });                       // the next round's roles
    fake.chat.length = 0;
    ending(a, "pier");

    check("the second round ends the same way", ended() && said().includes("THE GANG SAILED!"), said().join(" | "));
    check("the system is registered, with the winner tag", listSystems().some((s) => s.name === "endings" && s.ownedTags?.includes("winner")));
    done();
});

test("with no outlaw left in play there is nobody to escape, and the player is told so", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [ghost] = cast(["Ghost", { tags: ["outlaw", "eliminated"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "Ghost", 1000);

    ending(ghost, "pier");

    check("told", ghost.messages.map(strip).includes("No outlaw is left to escape."), JSON.stringify(ghost.messages));
    check("nothing happened", !ended() && coinsOf("Ghost") === 1000);
    done();
});

test("the round change a listener hears names the ending; the law's win names none; a new round forgets it", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const heard = [];
    const stop = round.onPhase("ENDED", (change) => heard.push(change.detail ?? null));
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);

    ending(a, "pier");
    check("a listener hears which ending", JSON.stringify(heard) === JSON.stringify(["pier"]), JSON.stringify(heard));
    check("and so does the round", round.lastEndDetail() === "pier");

    round.resetRound();
    check("a reset forgets it", round.lastEndDetail() === null);

    round.startRound();
    round.beginActive();
    round.endRound("law_win");
    check("the law's win names no ending", heard.length === 2 && heard[1] === null && round.lastEndDetail() === null, JSON.stringify(heard));

    round.resetRound();
    round.startRound();
    round.beginActive();
    state.update(a, { role: "outlaw" });
    ending(a, "pier");
    check("a second round ended by the pier names it again", round.lastEndDetail() === "pier", String(round.lastEndDetail()));
    round.startRound();                                          // ENDED -> SETUP, with no reset in between
    check("starting a round forgets it", round.lastEndDetail() === null);
    stop();
    done();
});

test("the winners' teleport follows the ending's own spot, to the digit", () => {
    scene();
    addPier({ winSpot: { x: -12.5, y: 71.25, z: 99 } });
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);
    ending(a, "pier");
    check("the command", tp().join("|") === "tp @a[tag=winner] -12.5 71.25 99", tp().join("|"));
    done();
});

test("an id typed with spaces around it still finds the ending", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    fake.setScore("coins", "A", 1000);
    scriptEvent("rae:ending", a, "   pier  ");
    check("it ran", ended() && a.tags.has("winner"), said().join(" | "));
    done();
});

test("an event with no player behind it, or only something that is not a player, is quietly ignored", () => {
    scene();
    addPier();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(PIER.x, PIER.z) }]);
    const op = fake.makePlayer("Op", { permission: 2 });
    fake.setScore("coins", "A", 1000);
    const zombie = fake.makeEntity({ typeId: "minecraft:zombie" });
    const realError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(" "));

    try {
        scriptEvent("rae:ending", undefined, "pier");                                          // a command block
        scriptEvent("rae:ending", zombie, "pier", { initiator: zombie, sourceType: "NPCDialogue" });
        scriptEvent("bounty:escape", undefined);
        scriptEvent("bounty:escape", zombie);
    } finally { console.error = realError; }

    check("nothing happened", !ended() && coinsOf("A") === 1000 && !a.tags.has("winner"));
    check("and nothing was reported as an error to anyone", errors.length === 0 && op.messages.length === 0, `${errors.join(" | ")} ${JSON.stringify(op.messages)}`);
    done();
});

test("a law player is told the ending is for outlaws even when no round is running (who is asked before whether a round is)", () => {
    fake.reset();
    round.resetRound();
    store.forgetEndings();
    addPier();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    const { check, done } = checks();
    const [sheriff] = cast(["Sheriff", { tags: ["law"], location: at(PIER.x, PIER.z) }]);
    ending(sheriff, "pier");
    check("told by the pier's words, not that no round is running", sheriff.messages.map(strip).join("|") === "The pier is for outlaws.", JSON.stringify(sheriff.messages));
    done();
});
