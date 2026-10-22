import { test } from "node:test";
import { fake, load, checks, world } from "./helpers.mjs";

// core/economy.ts, the bounty half: a bounty is what the law is paid for catching an outlaw, so what matters is that it ADDS to what an outlaw already has
// (every payout and robbery goes through addBounty), is kept per player, and is cleared on capture. A bounty that replaced instead of added would pass any test that
// starts from nothing, which is why these start from a bounty already there.

const E = await load("core/economy.js");

const bountyOf = (name) => world.scoreboard.getObjective("bounty").getScore(name) ?? 0;

function fresh() {
    fake.reset();
    fake.addObjective("coins");
    fake.addObjective("bounty");
}

test("addBounty adds to the bounty a player already has, and keeps adding", () => {
    const { check, done } = checks();
    fresh();
    const bandit = fake.makePlayer("Bandit");
    fake.setScore("bounty", "Bandit", 100);

    E.addBounty(bandit, 50);
    check("100 and 50 make 150, not 50", bountyOf("Bandit") === 150, String(bountyOf("Bandit")));

    E.addBounty(bandit, 25);
    check("and 25 more make 175", bountyOf("Bandit") === 175, String(bountyOf("Bandit")));
    check("getBounty reads the same number", E.getBounty(bandit) === 175);
    done();
});

test("a player with no bounty yet starts from zero", () => {
    const { check, done } = checks();
    fresh();
    const bandit = fake.makePlayer("Bandit");

    check("nothing is 0", E.getBounty(bandit) === 0);
    E.addBounty(bandit, 40);
    check("40 makes 40", E.getBounty(bandit) === 40);
    done();
});

test("a bounty belongs to one player: adding to one does not touch another", () => {
    const { check, done } = checks();
    fresh();
    const a = fake.makePlayer("A");
    fake.setScore("bounty", "A", 10);
    fake.setScore("bounty", "B", 500);

    E.addBounty(a, 5);

    check("A has 15", bountyOf("A") === 15);
    check("B still has 500", bountyOf("B") === 500);
    done();
});

test("clearing a bounty takes it to zero and nothing else, and a later bounty starts over from zero", () => {
    const { check, done } = checks();
    fresh();
    const a = fake.makePlayer("A");
    fake.setScore("bounty", "A", 300);
    fake.setScore("coins", "A", 80);

    E.clearBounty(a);

    check("the bounty is 0", bountyOf("A") === 0);
    check("the coins are untouched", E.getCoins(a) === 80);

    E.addBounty(a, 20);
    check("and a new one is just the new amount", bountyOf("A") === 20);
    done();
});

test("adding a bounty in a world that never had the scoreboard makes it", () => {
    const { check, done } = checks();
    fake.reset();
    const a = fake.makePlayer("A");

    E.addBounty(a, 30);
    E.addBounty(a, 30);

    check("two additions make 60", world.scoreboard.getObjective("bounty")?.getScore("A") === 60, String(world.scoreboard.getObjective("bounty")?.getScore("A")));
    done();
});
