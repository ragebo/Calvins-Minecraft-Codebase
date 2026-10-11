import { test } from "node:test";
import { fake, load, checks, world } from "./helpers.mjs";

// core/economy.ts: the coins and bounty scoreboards are made when they are missing. A payout into a world that never had
// `/scoreboard objectives add coins dummy` typed used to be dropped without a word while the player was told "+N coins".

const E = await load("core/economy.js");

const realWarn = console.warn;
const realError = console.error;
const said = [];
const failed = [];
console.warn = (...args) => said.push(args.join(" "));
console.error = (...args) => failed.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; console.error = realError; });

function fresh() {
    fake.reset();
    said.length = 0;
    failed.length = 0;
}

test("paying coins into a world with no coins scoreboard makes it and pays", () => {
    const { check, done } = checks();
    fresh();
    const ann = fake.makePlayer("Ann");

    check("there is no scoreboard to begin with", world.scoreboard.getObjective("coins") === undefined);
    E.addCoins(ann, 25);

    check("it was made", world.scoreboard.getObjective("coins") !== undefined);
    check("and the player was paid", E.getCoins(ann) === 25, String(E.getCoins(ann)));
    check("the bounty one was made with it: the two are set up together, as the manual steps always did", world.scoreboard.getObjective("bounty") !== undefined);
    done();
});

test("a bounty is added the same way, and a bounty is cleared without making anything", () => {
    const { check, done } = checks();
    fresh();
    const ann = fake.makePlayer("Ann");

    E.clearBounty(ann);
    check("clearing a bounty that nobody keeps made nothing", world.scoreboard.getObjective("bounty") === undefined);

    E.addBounty(ann, 40);
    check("adding one made the scoreboard and kept it", E.getBounty(ann) === 40 && world.scoreboard.getObjective("coins") !== undefined, String(E.getBounty(ann)));
    done();
});

test("reading a balance never changes the world, and neither does taking nothing", () => {
    const { check, done } = checks();
    fresh();
    const ann = fake.makePlayer("Ann");

    check("a balance with no scoreboard is zero", E.getCoins(ann) === 0 && E.getBounty(ann) === 0);
    check("taking from nothing takes nothing", E.takeCoins(ann, 10) === 0);
    check("and none of that made a scoreboard", world.scoreboard.getObjective("coins") === undefined && world.scoreboard.getObjective("bounty") === undefined);
    done();
});

test("ensureScoreboards makes what is missing, says so once, and leaves what is there alone", () => {
    const { check, done } = checks();
    fresh();
    world.scoreboard.addObjective("coins");
    world.scoreboard.getObjective("coins").setScore("Ann", 7);

    const made = E.ensureScoreboards();

    check("only the missing one was made", made.join() === "bounty", made.join());
    check("the existing one kept its scores", world.scoreboard.getObjective("coins").getScore("Ann") === 7);
    check("it was logged", said.some((line) => /Made the missing scoreboard: bounty\./.test(line)), said.join(" | "));

    said.length = 0;
    check("a second call makes nothing and logs nothing", E.ensureScoreboards().length === 0 && said.length === 0, said.join(" | "));
    done();
});

test("a game that refuses to make it is told to an operator once, and a payout is dropped as it always was", () => {
    const { check, done } = checks();
    fresh();
    const ann = fake.makePlayer("Ann");

    const realAdd = world.scoreboard.addObjective;
    world.scoreboard.addObjective = () => { throw new Error("the game said no"); };

    try {
        E.addCoins(ann, 5);
        E.addCoins(ann, 5);
        E.setCoins(ann, 9);

        check("nothing was paid", E.getCoins(ann) === 0);
        check("it did not throw, and said so exactly once", failed.filter((line) => /Could not make the coins scoreboard: the game said no/.test(line)).length === 1, failed.join(" | "));
    } finally {
        world.scoreboard.addObjective = realAdd;
    }

    E.addCoins(ann, 5);
    check("when the game lets it, the next payout makes the scoreboard and goes through", E.getCoins(ann) === 5, String(E.getCoins(ann)));
    done();
});
