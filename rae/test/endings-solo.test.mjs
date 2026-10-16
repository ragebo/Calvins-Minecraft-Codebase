import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, system, load, checks, strip } from "./helpers.mjs";

// tasks/endings, Task 5: a SOLO ending and the rule that ends a round. One outlaw at a place with the money and/or the item leaves the game for good: announced,
// off the outlaw lists, a spectator, a winner for themselves, and the round goes on. The round ends when no outlaw is left in play: every outlaw escaped is an
// outlaw win; the rest jailed or eliminated, whoever escaped before, is the law's win.

await load("main.js");
const { ItemStack } = fakeApi;
const round = await load("core/round.js");
const store = await load("core/endingstore.js");
const state = await load("core/state.js");
const P = await load("core/players.js");
const L = await load("logic/endings.js");

const TOWER = { x: 400, y: 70, z: 400 };
const PIER = { x: 200, y: 64, z: 300 };
const at = (x, z, y = 70) => ({ x, y, z });
const scriptEvent = (id, sourceEntity, message = "") => system.afterEvents.scriptEventReceive.emit({ id, sourceEntity, message });
const ending = (player, id) => scriptEvent("rae:ending", player, id);
const said = () => fake.chat.map(strip);
const heard = (player) => player.messages.map(strip);
const coinsOf = (name) => world.scoreboard.getObjective("coins").getScore(name) ?? 0;
const modes = () => fake.dimension("overworld").commands.filter((c) => c.startsWith("gamemode"));

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
    const players = specs.map(([name, options]) => fake.makePlayer(name, { inventory: true, ...options }));
    fake.advance(1);
    return players;
}

function add(kind, id, place, patch = {}) {
    const made = L.newEnding(kind, id, id[0].toUpperCase() + id.slice(1), place);
    assert.ok(made.ok, made.reason);
    const edited = L.edit(made.value, patch);
    assert.ok(edited.ok, edited.reason);
    assert.equal(store.saveEnding(edited.value).ok, true);
}

const addTower = (patch = {}) => add("solo", "tower", TOWER, {
    radius: 5, price: 100, winSpot: { x: 410, y: 80, z: 410 },
    texts: { headline: "§b{player} FLEW AWAY!", detail: "§7{player} paid {coins} coins.", gather: "§cGet to the tower.", outlawsOnly: "§cThe tower is for outlaws." }, ...patch
});
const addPier = () => add("group", "pier", PIER, { radius: 10, price: 100 });

const give = (player, type, amount) => player.container.addItem(new ItemStack(type, amount));
const held = (player, type) => { let n = 0; for (let i = 0; i < 36; i++) { const s = player.container.getItem(i); if (s?.typeId === type) n += s.amount; } return n; };
const flag = (player) => state.getRecord(player).flags.escaped === true;
const outlawNames = () => P.aliveOutlaws().map((p) => p.name).sort().join();

test("a solo escape paid in coins: taken, announced in the ending's words, escaped, taken to the win spot and made a spectator", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [a, b] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x + 1, TOWER.z) }], ["B", { tags: ["outlaw"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 150);

    ending(a, "tower");

    check("100 coins taken", coinsOf("A") === 50, String(coinsOf("A")));
    check("the headline names them", said().includes("A FLEW AWAY!"), said().join(" | "));
    check("the detail has the amount", said().includes("A paid 100 coins."), said().join(" | "));
    check("they are escaped and a winner", flag(a) && a.tags.has("winner"));
    check("they left the outlaw lists", outlawNames() === "B", outlawNames());
    check("they were taken to the win spot, alone", a.teleports.length === 1 && a.teleports[0].x === 410 && a.teleports[0].y === 80 && b.teleports.length === 0, JSON.stringify(a.teleports));
    check("and put in spectator", modes().join() === "gamemode spectator @s", modes().join());
    check("the round goes on", round.getPhase() === "ACTIVE", round.getPhase());
    check("the other outlaw is not a winner", !b.tags.has("winner"));
    done();
});

test("a solo escape paid in an item: the stack is taken when consumed, only held when not", () => {
    const { check, done } = checks();

    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 0, item: { id: "minecraft:emerald", count: 3 }, consumeItem: true });
    let [a] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    give(a, "minecraft:emerald", 5);
    ending(a, "tower");
    check("consumed: three of five taken", flag(a) && held(a, "minecraft:emerald") === 2, String(held(a, "minecraft:emerald")));

    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 0, item: { id: "minecraft:emerald", count: 3 }, consumeItem: false });
    [a] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    give(a, "minecraft:emerald", 5);
    ending(a, "tower");
    check("kept: all five still there", flag(a) && held(a, "minecraft:emerald") === 5, String(held(a, "minecraft:emerald")));
    done();
});

test("an ending that asks for both takes both, and neither is taken if one is missing", () => {
    const { check, done } = checks();

    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 50, item: { id: "minecraft:emerald", count: 1 }, consumeItem: true });
    const [a, free] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 500);

    ending(a, "tower");
    check("coins but no item: refused, naming the item", !flag(a) && heard(a).some((m) => /1 of emerald/.test(m)), JSON.stringify(heard(a)));
    check("nothing taken", coinsOf("A") === 500);

    give(a, "minecraft:emerald", 1);
    fake.setScore("coins", "A", 10);
    ending(a, "tower");
    check("item but too few coins: refused, naming the coins", !flag(a) && heard(a).some((m) => /50 coins/.test(m) && /10/.test(m)), JSON.stringify(heard(a)));
    check("nothing taken", coinsOf("A") === 10 && held(a, "minecraft:emerald") === 1);

    fake.setScore("coins", "A", 80);
    ending(a, "tower");
    check("both there: both taken", flag(a) && coinsOf("A") === 30 && held(a, "minecraft:emerald") === 0);
    check("the free outlaw is untouched", !flag(free));
    done();
});

test("far from the place, a short purse and a missing item each say so in their own words and take nothing", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [far, poor] = cast(["Far", { tags: ["outlaw"], location: at(900, 900) }], ["Poor", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    fake.setScore("coins", "Far", 500);
    fake.setScore("coins", "Poor", 99);

    ending(far, "tower");
    check("too far: the ending's own words", heard(far).includes("Get to the tower."), JSON.stringify(heard(far)));

    ending(poor, "tower");
    check("one coin short: says what is needed and what they hold", heard(poor).some((m) => /100 coins/.test(m) && /99/.test(m)), JSON.stringify(heard(poor)));

    check("nobody escaped and nothing was taken", !flag(far) && !flag(poor) && coinsOf("Far") === 500 && coinsOf("Poor") === 99 && round.getPhase() === "ACTIVE");
    done();
});

test("the law, a prisoner, an eliminated outlaw and one who has already escaped cannot use it, and are told why", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const spot = at(TOWER.x, TOWER.z);
    const [sheriff, prisoner, ghost, gone] = cast(
        ["Sheriff", { tags: ["law"], location: spot }],
        ["Prisoner", { tags: ["outlaw", "jailed", "in_jail"], location: spot }],
        ["Ghost", { tags: ["outlaw", "eliminated"], location: spot }],
        ["Gone", { tags: ["outlaw"], location: spot }],
        ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    for (const name of ["Sheriff", "Prisoner", "Ghost", "Gone"]) fake.setScore("coins", name, 500);
    state.setFlag(gone, state.ESCAPED, true);

    for (const who of [sheriff, prisoner, ghost, gone]) ending(who, "tower");

    check("the law: outlaws only", heard(sheriff).includes("The tower is for outlaws."));
    check("a prisoner: not from jail", heard(prisoner).some((m) => /jail/.test(m)), JSON.stringify(heard(prisoner)));
    check("an eliminated outlaw: out of the game", heard(ghost).some((m) => /out of the game/.test(m)), JSON.stringify(heard(ghost)));
    check("an escaper: already escaped", heard(gone).some((m) => /already escaped/.test(m)), JSON.stringify(heard(gone)));
    check("nobody was charged", ["Sheriff", "Prisoner", "Ghost", "Gone"].every((n) => coinsOf(n) === 500));
    check("no new escape, no winner among them", !flag(sheriff) && !flag(prisoner) && !flag(ghost) && !gone.tags.has("winner") && round.getPhase() === "ACTIVE");
    done();
});

test("a solo ending with no win spot leaves the escaper where they stand", () => {
    scene();
    addTower({ winSpot: null });
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 100);
    ending(a, "tower");
    check("escaped, and not moved", flag(a) && a.teleports.length === 0, JSON.stringify(a.teleports));
    done();
});

test("a death anywhere makes the game look again at who is left, without waiting for a spawn", () => {
    scene();
    const { check, done } = checks();
    cast(["Law", { tags: ["law"], location: at(900, 900) }], ["Prisoner", { tags: ["outlaw", "jailed", "in_jail"], location: at(950, 950) }]);
    const zombie = fake.makeEntity({ typeId: "minecraft:zombie" });

    world.afterEvents.entityDie.emit({ deadEntity: zombie, damageSource: { damagingEntity: undefined } });

    check("the law has won, straight away", round.getPhase() === "ENDED" && round.lastEnd() === "law_win", `${round.getPhase()} ${round.lastEnd()}`);
    done();
});

test("an escaper cannot trigger a group ending either, and the others are no longer asked to include them", () => {
    scene();
    addTower();
    addPier();
    const { check, done } = checks();
    const [a, b] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["B", { tags: ["outlaw"], location: at(PIER.x, PIER.z, 64) }]);
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 500);

    ending(a, "tower");
    check("A escaped", flag(a) && round.getPhase() === "ACTIVE");

    ending(a, "pier");
    check("A cannot use the pier now", heard(a).some((m) => /already escaped/.test(m)) && round.getPhase() === "ACTIVE");

    ending(b, "pier");
    check("B, alone at the pier, pays for one and the gang is just B", round.getPhase() === "ENDED" && round.lastEnd() === "outlaw_win" && round.lastEndDetail() === "pier" && coinsOf("B") === 400, `${round.getPhase()} ${coinsOf("B")}`);
    done();
});

test("two outlaws escaping while a third is still free: the round goes on", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const spot = at(TOWER.x, TOWER.z);
    const [a, b, free] = cast(["A", { tags: ["outlaw"], location: spot }], ["B", { tags: ["outlaw"], location: spot }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    for (const n of ["A", "B", "Free"]) fake.setScore("coins", n, 500);

    ending(a, "tower");
    ending(b, "tower");

    check("both gone, one in play: still going", round.getPhase() === "ACTIVE" && flag(a) && flag(b) && !flag(free), round.getPhase());
    check("the one in play is the only outlaw the game counts", outlawNames() === "Free", outlawNames());
    done();
});

test("when the last outlaw in play escapes, the round ends as an outlaw win and says so", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const spot = at(TOWER.x, TOWER.z);
    const [a, b] = cast(["A", { tags: ["outlaw"], location: spot }], ["B", { tags: ["outlaw"], location: spot }]);
    fake.setScore("coins", "A", 500);
    fake.setScore("coins", "B", 500);

    ending(a, "tower");
    check("one gone, one in play: going on", round.getPhase() === "ACTIVE");
    ending(b, "tower");

    check("the round ended as an outlaw win", round.getPhase() === "ENDED" && round.lastEnd() === "outlaw_win", `${round.getPhase()} ${round.lastEnd()}`);
    check("with no single ending named (it was no ending's)", round.lastEndDetail() === null);
    check("and the room is told everyone got away", said().some((m) => /EVERY OUTLAW HAS ESCAPED/.test(m)), said().join(" | "));
    check("with the line under it", said().includes("Nobody is left for the law to catch."), said().join(" | "));
    check("the law is not told it won", !said().includes("THE LAW HAS WON!") && !said().some((m) => /THE LAW HAS WON/.test(m)));
    done();
});

test("when an outlaw escapes and the rest are jailed or eliminated, the law wins", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [law, out, prisoner] = cast(["Law", { tags: ["law"], location: at(900, 900) }], ["Out", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Prisoner", { tags: ["outlaw", "jailed", "in_jail"], location: at(950, 950) }], ["Ghost", { tags: ["outlaw", "eliminated"], location: at(960, 960) }]);
    fake.setScore("coins", "Out", 500);

    ending(out, "tower");

    check("the law won", round.getPhase() === "ENDED" && round.lastEnd() === "law_win", `${round.getPhase()} ${round.lastEnd()}`);
    check("announced as it always was", said().includes("THE LAW HAS WON!"), said().join(" | "));
    check("the law are the winners, and so is the escaper, for themselves", law.tags.has("winner") && out.tags.has("winner") && !prisoner.tags.has("winner"));
    check("the room is not also told everyone escaped", !said().some((m) => /EVERY OUTLAW HAS ESCAPED/.test(m)), said().join(" | "));
    done();
});

test("two outlaws using a solo ending in the same tick may both win, and the order never decides the round", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const spot = at(TOWER.x, TOWER.z);
    const [a, b, free] = cast(["A", { tags: ["outlaw"], location: spot }], ["B", { tags: ["outlaw"], location: at(TOWER.x + 2, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);

    ending(a, "tower");
    ending(b, "tower");

    check("both escaped", flag(a) && flag(b) && coinsOf("A") === 0 && coinsOf("B") === 0);
    check("the free outlaw keeps the round going", round.getPhase() === "ACTIVE" && !flag(free));
    done();
});

test("a reset gives an escaper their game mode back and forgets the escape", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"], location: at(TOWER.x, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    a.getGameMode = () => "Adventure";
    fake.setScore("coins", "A", 100);
    ending(a, "tower");
    check("escaped and a spectator", flag(a) && a.getDynamicProperty("rae:gamemode_before_spectator") === "adventure");

    fake.dimension("overworld").commands.length = 0;
    round.resetRound();

    check("given their mode back", modes().includes("gamemode adventure @s"), modes().join());
    a.addTag("outlaw");
    fake.advance(1);
    check("and not escaped any more", !flag(a) && P.aliveOutlaws().some((p) => p.name === "A"));
    done();
});

test("a solo ending set to a place in another spot works only there", () => {
    scene();
    addTower();
    const { check, done } = checks();
    const [edge, out] = cast(["Edge", { tags: ["outlaw"], location: at(TOWER.x + 5, TOWER.z) }], ["Out", { tags: ["outlaw"], location: at(TOWER.x + 5.5, TOWER.z) }], ["Free", { tags: ["outlaw"], location: at(900, 900) }]);
    fake.setScore("coins", "Edge", 100);
    fake.setScore("coins", "Out", 100);
    ending(out, "tower");
    ending(edge, "tower");
    check("exactly at the radius is in, a hair outside is out", flag(edge) && !flag(out));
    done();
});
