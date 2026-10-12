import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, fakeApi, load, checks } from "./helpers.mjs";

// The start commands (core/startsequence.ts, called from core/game.ts's begin()): the operator's list of vanilla commands, run as the server
// before anything else at the start of a game, after the roles exist (so a selector like @a[tag=law] already matches). A command that throws is
// reported and never stops the rest or the start; a start that is refused runs none (a bag must not be emptied for a game that never began).

const { PlayerPermissionLevel } = fakeApi;
const game = await load("core/game.js");
const store = await load("core/startstore.js");
const round = await load("core/round.js");
const S = await load("core/startsequence.js");
const { START } = await load("config/balance.js");

/**
 * Wraps the overworld's runCommand for the length of `body`: every command is recorded with what the world looked like at that moment (who had
 * a role tag, where players stood), and the ones in `failing` throw. Puts the real one back whatever happens.
 */
function watching(failing, body) {
    const dim = fake.dimension("overworld");
    const real = dim.runCommand;
    const seen = [];

    dim.runCommand = (command) => {
        seen.push({
            command,
            roles: fake.players.map((p) => [p.tags.has("law"), p.tags.has("outlaw")]),
            spots: fake.players.map((p) => `${p.location.x},${p.location.y},${p.location.z}`)
        });
        if (failing.some((word) => command.includes(word))) throw new Error(`Syntax error: unexpected "${command}"`);
        return real.call(dim, command);
    };

    try { body(seen); } finally { dim.runCommand = real; }
}

function scene(...names) {
    fake.reset();
    store.forgetLoaded();
    round.resetRound();
    fake.addObjective("coins");
    fake.addObjective("bounty");

    const made = names.map((n) => fake.makePlayer(n, n.startsWith("Op") ? { permission: PlayerPermissionLevel.Operator } : {}));
    fake.advance(1);

    return made;
}

test("with the defaults, a Start sends the seven default commands in order, as the server, in the overworld", () => {
    const { check, done } = checks();
    scene("Ada", "Bob");

    watching([], (seen) => {
        check("a random round started", game.startRandomRound() === true);
        check("the default list, in order", seen.map((s) => s.command).join(" | ") === START.defaultCommands.join(" | "), seen.map((s) => s.command).join(" | "));
    });

    fake.advance(1200);
    done();
});

test("the commands run after the roles exist and before anyone is sent anywhere", async () => {
    const { check, done } = checks();
    scene("Ada", "Bob");

    // Put them somewhere no spawn is, so "not moved yet" is something a spawn teleport would change.
    fake.players[0].teleport({ x: 7, y: 70, z: 7 });
    fake.players[1].teleport({ x: -7, y: 70, z: -7 });
    const where = fake.players.map((p) => `${p.location.x},${p.location.y},${p.location.z}`);

    watching([], (seen) => {
        game.startRandomRound();

        const first = seen[0];
        check("roles are already assigned when the first command runs", first.roles.every(([law, outlaw]) => law !== outlaw), JSON.stringify(first.roles));
        check("nobody has been teleported yet", first.spots.join(" | ") === where.join(" | "), `${first.spots.join(" | ")} against ${where.join(" | ")}`);
    });

    // The law player is placed when her spawn screen is answered, which is through a promise; the outlaw at once.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    check("and afterwards they have been", fake.players.every((p, i) => `${p.location.x},${p.location.y},${p.location.z}` !== where[i]));

    fake.advance(1200);
    done();
});

test("a command is sent without its leading slash, whatever way it was saved", () => {
    const { check, done } = checks();
    scene("Ada", "Bob");
    store.saveStartCommands(["/say hello", "  /say again  "]);

    watching([], (seen) => {
        game.startRandomRound();
        check("both without the slash, trimmed", seen.map((s) => s.command).join("|") === "say hello|say again", seen.map((s) => s.command).join("|"));
    });

    fake.advance(1200);
    done();
});

test("a command that throws is reported to whoever pressed Start, and the rest still run and the round still starts", () => {
    const { check, done } = checks();
    const [, , op] = scene("Ada", "Bob", "Op");
    store.saveStartCommands(["say one", "bogus thing", "say three"]);

    watching(["bogus"], (seen) => {
        check("the round started", game.startRandomRound(op) === true);
        check("all three were tried, in order", seen.map((s) => s.command).join("|") === "say one|bogus thing|say three", seen.map((s) => s.command).join("|"));
    });

    check("the round is under way", round.getPhase() === "SETUP");
    check("the operator was told which one and why", op.messages.some((m) => m.includes("Start command 2") && m.includes("bogus thing") && m.includes("Syntax error")), op.messages.join(" || "));
    check("the others were not told", fake.players.filter((p) => p !== op).every((p) => !p.messages.some((m) => m.includes("Start command"))));

    fake.advance(1200);
    done();
});

test("only whoever pressed Start is told, even when other operators are online", () => {
    const { check, done } = checks();
    const [, , op, other] = scene("Ada", "Bob", "Op", "Op2");
    store.saveStartCommands(["bogus thing"]);

    watching(["bogus"], () => { game.startRandomRound(op); });

    check("the one who pressed it heard", op.messages.some((m) => m.includes("Start command 1")), op.messages.join(" || "));
    check("the other operator did not", !other.messages.some((m) => m.includes("Start command")), other.messages.join(" || "));

    fake.advance(1200);
    scene("Ada", "Bob", "Op", "Op2");
    store.saveStartCommands(["bogus thing"]);

    const [ada, bob, op2, other2] = fake.players;
    watching(["bogus"], () => { game.startChosenRound(new Map([[ada, "law"], [bob, "outlaw"]]), op2); });

    check("a chosen round tells only the one who started it too", op2.messages.some((m) => m.includes("Start command 1")) && !other2.messages.some((m) => m.includes("Start command")));

    fake.advance(1200);
    done();
});

test("a Start with nobody to tell (the old button) tells every operator online instead", () => {
    const { check, done } = checks();
    const [ada, , op] = scene("Ada", "Bob", "Op");
    store.saveStartCommands(["bogus thing"]);

    watching(["bogus"], () => { game.startRandomRound(); });

    check("the operator heard", op.messages.some((m) => m.includes("Start command 1") && m.includes("bogus thing")), op.messages.join(" || "));
    check("a member did not", !ada.messages.some((m) => m.includes("Start command")));

    fake.advance(1200);
    done();
});

test("the report says how many ran and which did not", () => {
    const { check, done } = checks();
    scene("Ada");
    store.saveStartCommands(["say one", "bogus thing", "say three", "bogus again"]);

    watching(["bogus"], () => {
        const report = S.runStartCommands();

        check("two ran", report.ran === 2, JSON.stringify(report));
        check("two failed, numbered from 1, with their text and reason", report.failed.length === 2 && report.failed[0].number === 2 && report.failed[0].command === "bogus thing" && report.failed[1].number === 4 && /Syntax error/.test(report.failed[0].reason), JSON.stringify(report.failed));
    });

    // A command at the longest the rules allow makes an error message longer than a line of chat should carry.
    store.saveStartCommands([`bogus${"x".repeat(190)}`]);
    watching(["bogus"], () => {
        const long = S.runStartCommands();
        check("a long reason is cut to 160 characters", long.failed.length === 1 && long.failed[0].reason.length === 160, String(long.failed[0]?.reason.length));
    });
    done();
});

test("a list saved empty runs nothing, and a list that cannot be read runs nothing", () => {
    const { check, done } = checks();
    scene("Ada", "Bob");

    store.saveStartCommands([]);
    watching([], (seen) => {
        game.startRandomRound();
        check("an empty list: no commands", seen.length === 0, seen.map((s) => s.command).join("|"));
    });

    store.resetStartCommands();
    fake.advance(1200);
    scene("Ada", "Bob");
    world.setDynamicProperty("rae:start:commands:list", "this is not a list");
    store.forgetLoaded();

    watching([], (seen) => {
        game.startRandomRound();
        check("a damaged list: no commands, never the defaults", seen.length === 0, seen.map((s) => s.command).join("|"));
    });

    fake.advance(1200);
    done();
});

test("a Start that is refused runs no commands: a bag is not emptied for a game that never began", () => {
    const { check, done } = checks();
    const [ada] = scene("Ada");

    watching([], (seen) => {
        check("one player is not enough for a random round", game.startRandomRound() === false);
        check("no commands ran", seen.length === 0, seen.map((s) => s.command).join("|"));

        const result = game.startChosenRound(new Map([[ada, "sit_out"]]));
        check("nobody playing is refused", result.ok === false);
        check("no commands ran for that either", seen.length === 0, seen.map((s) => s.command).join("|"));
    });
    done();
});

test("a chosen round runs the commands too, and tells whoever started it when one fails", () => {
    const { check, done } = checks();
    const [ada, bob, op] = scene("Ada", "Bob", "Op");
    store.saveStartCommands(["say one", "bogus thing"]);

    watching(["bogus"], (seen) => {
        const result = game.startChosenRound(new Map([[ada, "law"], [bob, "outlaw"]]), op);

        check("it started", result.ok === true);
        check("both commands were tried", seen.length === 2);
    });

    check("the one who started it was told", op.messages.some((m) => m.includes("Start command 2")), op.messages.join(" || "));
    fake.advance(1200);
    done();
});
