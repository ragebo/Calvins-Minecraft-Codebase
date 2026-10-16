import { test } from "node:test";
import { fake, world, load, checks } from "./helpers.mjs";

// tasks/endings, Task 4: an outlaw who escaped is not an outlaw any more. A per-player flag in the state record, and core/players.ts leaving such a
// player out of every "who is in play" answer, so the law's win, the raids and the robberies never count or target them. The spectator code the jail
// used for an elimination moved to core/spectate.ts so an escape can use it; jail's own tests (and the jail flow tests) pin that it did not change.

await load("main.js");
const round = await load("core/round.js");
const state = await load("core/state.js");
const P = await load("core/players.js");
const spectate = await load("core/spectate.js");

const ids = (list) => list.map((p) => p.name).sort().join(",");
const dim = () => fake.dimension("overworld");
const commands = () => dim().commands.filter((c) => c.startsWith("gamemode"));

function scene() {
    fake.reset();
    round.resetRound();
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

const escape = (player) => state.setFlag(player, state.ESCAPED, true);
const spawn = (player) => world.afterEvents.playerSpawn.emit({ player, initialSpawn: false });
const lawWon = () => round.getPhase() === "ENDED" && round.lastEnd() === "law_win";

test("an escaped player appears in none of the in-play queries; everyone else is unchanged", () => {
    scene();
    const { check, done } = checks();
    const [law, free, jailed, gone, out] = cast(
        ["Law", { tags: ["law"] }],
        ["Free", { tags: ["outlaw"] }],
        ["Jailed", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["Gone", { tags: ["outlaw", "eliminated"] }],
        ["Out", { tags: ["outlaw"] }]);

    check("before: everyone is where they belong", ids(P.outlaws()) === "Free,Gone,Jailed,Out" && ids(P.aliveOutlaws()) === "Free,Jailed,Out" && ids(P.freeOutlaws()) === "Free,Out", ids(P.outlaws()));

    escape(out);

    check("outlaws() leaves them out", ids(P.outlaws()) === "Free,Gone,Jailed", ids(P.outlaws()));
    check("aliveOutlaws() leaves them out", ids(P.aliveOutlaws()) === "Free,Jailed", ids(P.aliveOutlaws()));
    check("freeOutlaws() leaves them out", ids(P.freeOutlaws()) === "Free", ids(P.freeOutlaws()));
    check("alivePlayers() leaves them out", ids(P.alivePlayers()) === "Free,Jailed,Law", ids(P.alivePlayers()));
    check("the others did not move: law, prisoners, spectators", ids(P.lawPlayers()) === "Law" && ids(P.prisoners()) === "Jailed" && ids(P.spectators()) === "Gone");
    check("the escape is on the record, and nothing else about them changed", state.getRecord(out).flags.escaped === true && state.getRecord(out).role === "outlaw" && state.getRecord(out).eliminated === false && state.getRecord(out).inJail === false);
    check("law and the others are not flagged", [law, free, jailed, gone].every((p) => state.getRecord(p).flags.escaped !== true));
    done();
});

test("every query core/players.ts offers is accounted for here, so a new one cannot forget the flag", () => {
    const { check, done } = checks();
    const queries = Object.keys(P).filter((name) => typeof P[name] === "function").sort();
    check("the known set", queries.join() === "aliveOutlaws,alivePlayers,everyOutlaw,freeOutlaws,isOperator,lawPlayers,outlaws,players,prisoners,spectators", queries.join());
    done();
});

test("the flag follows a saved record that is merged in, and a round reset clears it", () => {
    scene();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"] }]);

    state.mergeRecords([{ id: a.id, role: "outlaw", eliminated: false, captures: 0, inJail: false, pendingJail: false, escortVulnerable: false, winner: false, ammo: {}, flags: { escaped: true } }]);
    check("a saved escape is back after a reload", state.getRecord(a).flags.escaped === true && P.aliveOutlaws().length === 0);

    round.resetRound();
    a.addTag("outlaw");
    fake.advance(1);
    check("a reset forgets it", state.getRecord(a).flags.escaped !== true && ids(P.aliveOutlaws()) === "A", ids(P.aliveOutlaws()));
    done();
});

test("the law's win ignores an outlaw who escaped: the rest jailed or eliminated is a law win", () => {
    scene();
    const { check, done } = checks();
    const [law, out, jailed, gone] = cast(
        ["Law", { tags: ["law"] }],
        ["Out", { tags: ["outlaw"] }],
        ["Jailed", { tags: ["outlaw", "jailed", "in_jail"] }],
        ["Gone", { tags: ["outlaw", "eliminated"] }]);

    escape(out);
    spawn(law);                                                      // the law-win check runs on every spawn and death

    check("the law has won", lawWon(), `${round.getPhase()} ${round.lastEnd()}`);
    check("announced", fake.chat.some((m) => m.includes("THE LAW HAS WON!")));
    done();
});

test("with an outlaw still free the law has not won, escaped or not", () => {
    scene();
    const { check, done } = checks();
    const [law, out] = cast(["Law", { tags: ["law"] }], ["Out", { tags: ["outlaw"] }], ["Free", { tags: ["outlaw"] }], ["Jailed", { tags: ["outlaw", "jailed", "in_jail"] }]);

    escape(out);
    spawn(law);

    check("still running", round.getPhase() === "ACTIVE", round.getPhase());
    done();
});

test("when every outlaw has escaped, the check ends the round for the outlaws, not the law", () => {
    scene();
    const { check, done } = checks();
    const [law, a, b] = cast(["Law", { tags: ["law"] }], ["A", { tags: ["outlaw"] }], ["B", { tags: ["outlaw"] }]);

    escape(a);
    escape(b);
    spawn(law);

    check("an outlaw win, not a law win", round.getPhase() === "ENDED" && round.lastEnd() === "outlaw_win", `${round.getPhase()} ${round.lastEnd()}`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// core/spectate.ts: lifted out of systems/jail.ts unchanged
// ---------------------------------------------------------------------------------------------------------

test("spectate: entering remembers the game mode and switches to spectator; leaving gives the mode back", () => {
    scene();
    const { check, done } = checks();
    const [p] = cast(["P"]);
    p.getGameMode = () => "Adventure";

    spectate.enterSpectator(p);
    check("switched to spectator", commands().join() === "gamemode spectator @s", commands().join());
    check("the mode was remembered", p.getDynamicProperty("rae:gamemode_before_spectator") === "adventure");
    check("it says so", spectate.wasPutInSpectator(p) === true);

    dim().commands.length = 0;
    spectate.leaveSpectator(p);
    check("given back", commands().join() === "gamemode adventure @s", commands().join());
    check("forgotten once given back", p.getDynamicProperty("rae:gamemode_before_spectator") === undefined && spectate.wasPutInSpectator(p) === false);
    done();
});

test("spectate: a player who is already a spectator keeps the mode remembered the first time, and survival is given back for 'spectator'", () => {
    scene();
    const { check, done } = checks();
    const [p] = cast(["P"]);
    p.getGameMode = () => "Creative";
    spectate.enterSpectator(p);
    p.getGameMode = () => "Spectator";
    spectate.enterSpectator(p);
    check("the first memory stands", p.getDynamicProperty("rae:gamemode_before_spectator") === "creative");

    const [q] = cast(["Q"]);
    q.setDynamicProperty("rae:gamemode_before_spectator", "spectator");
    dim().commands.length = 0;
    spectate.leaveSpectator(q);
    check("a player who was a spectator before is given survival", commands().join() === "gamemode survival @s", commands().join());
    done();
});

test("spectate: leaving does nothing for a player the round never put there, and nothing for one who has gone", () => {
    scene();
    const { check, done } = checks();
    const [p, gone] = cast(["P"], ["Gone"]);

    spectate.leaveSpectator(p);
    check("never put there: no command", commands().length === 0);

    gone.remove();
    let threw = false;
    try { spectate.enterSpectator(gone); spectate.leaveSpectator(gone); } catch { threw = true; }
    check("a player who left: nothing thrown and no command", !threw && commands().length === 0);
    done();
});

test("spectate: a refused game-mode change keeps the memory so the next reset or spawn tries again, and is reported", () => {
    scene();
    const { check, done } = checks();
    const [p] = cast(["P"]);
    const op = fake.makePlayer("Op", { permission: 2 });
    p.getGameMode = () => "Survival";
    spectate.enterSpectator(p);

    const real = p.runCommand;
    p.runCommand = () => { throw new Error("the game refused"); };
    const realError = console.error;
    console.error = () => {};
    try { spectate.leaveSpectator(p); } finally { console.error = realError; p.runCommand = real; }

    check("the memory is kept", p.getDynamicProperty("rae:gamemode_before_spectator") === "survival");
    check("an operator is told", op.messages.some((m) => /game mode/.test(m)), JSON.stringify(op.messages));
    done();
});

test("a flag that is set to false is not an escape", () => {
    scene();
    const { check, done } = checks();
    const [a] = cast(["A", { tags: ["outlaw"] }]);
    state.setFlag(a, state.ESCAPED, false);
    check("still an outlaw in play", ids(P.aliveOutlaws()) === "A" && ids(P.outlaws()) === "A" && ids(P.alivePlayers()) === "A");
    state.setFlag(a, "something_else", true);
    check("another flag is not an escape either", ids(P.aliveOutlaws()) === "A");
    done();
});

test("spectate: a mode the game will not report is taken to be survival; a spectator put there by hand is not remembered; a first memory outlives later changes", () => {
    scene();
    const { check, done } = checks();
    const [a, b, c] = cast(["A"], ["B"], ["C"]);

    a.getGameMode = () => { throw new Error("no mode"); };
    spectate.enterSpectator(a);
    check("unreadable counts as survival", a.getDynamicProperty("rae:gamemode_before_spectator") === "survival");

    b.getGameMode = () => "Spectator";
    spectate.enterSpectator(b);
    check("already a spectator, with nothing remembered: nothing is invented", b.getDynamicProperty("rae:gamemode_before_spectator") === undefined && !spectate.wasPutInSpectator(b));

    c.getGameMode = () => "Creative";
    spectate.enterSpectator(c);
    c.getGameMode = () => "Survival";                              // changed by hand meanwhile
    spectate.enterSpectator(c);
    check("the first memory stands", c.getDynamicProperty("rae:gamemode_before_spectator") === "creative");
    done();
});
