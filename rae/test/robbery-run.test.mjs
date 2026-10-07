import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeUi, world, load, checks, strip } from "./helpers.mjs";
import { L, SITE, bank, buildSite, ok, say } from "./robbery-fixtures.mjs";

// core/robberyrun.ts: playing a robbery. The contract: only what a player may do happens; a lock is paid for only when it
// opens; every block a run changes is noted BEFORE it changes, so a normal end, a manual reset, a round reset and a
// reload all put the site back through the one janitor; nothing is left running when its robbery is deleted; and when
// nothing is running the shared loop does no work at all.

const S = await load("core/robberystore.js");
const Run = await load("core/robberyrun.js");
const state = await load("core/state.js");
const director = await load("core/director.js");
const round = await load("core/round.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

const overworld = fake.dimension("overworld");
const IN_AREA = { x: 100, y: 65, z: 170 };
const OUTSIDE = { x: 500, y: 65, z: 500 };

const originalRandom = Math.random;
Math.random = () => 0.4;                       // the hidden pick target is always 40

/** Let the pick form's promise chain run (it awaits the form, which the fake answers at once). */
async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

const guess = (value) => fakeUi.uiFake.responses.push({ canceled: false, formValues: [value] });
const closeForm = () => fakeUi.uiFake.responses.push({ canceled: true, cancelationReason: "UserClosed" });

function setup(settings = {}, extra = {}) {
    fake.reset();
    resetAllSystems();                         // some system's reset reads the player list, which core/players caches for the tick...
    fake.advance(1);                           // ...so move to a new tick before any player exists, or the test sees a stale (empty) list
    S.forgetLoaded();
    fakeUi.uiFake.responses.length = 0;
    fakeUi.uiFake.shown.length = 0;
    R.pickGuessCooldownTicks = 0;

    fake.addObjective("coins");
    fake.addObjective("bounty");
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12]]);
    buildSite();

    const built = bank("bank", extra);
    let robbery = built.r;
    if (Object.keys(settings).length > 0) robbery = ok(L.setSettings(robbery, settings));

    const saved = S.saveRobbery(robbery);
    assert.equal(saved.ok, true, saved.reason);

    return { ...built, r: robbery };
}

function outlaw(name = "Ada", at = IN_AREA, coins = 0) {
    const player = fake.makePlayer(name, { location: { ...at } });
    state.update(player, { role: "outlaw" });
    fake.setScore("coins", player, coins);
    return player;
}

function lawman(name = "Sheriff", at = IN_AREA) {
    const player = fake.makePlayer(name, { location: { ...at } });
    state.update(player, { role: "law" });
    return player;
}

const ref = (pos) => S.boundAt("overworld", pos[0], pos[1], pos[2]);
const touch = (player, pos) => Run.touch(player, ref(pos));
const openBit = (pos) => fake.blockAt("overworld", { x: pos[0], y: pos[1], z: pos[2] }).permutation.getState("open_bit");
const contents = () => {
    const container = fake.blockAt("overworld", { x: SITE.box[0], y: SITE.box[1], z: SITE.box[2] }).getComponent("minecraft:inventory").container;
    const out = [];
    for (let i = 0; i < container.size; i++) if (container.getItem(i)) out.push(`${container.getItem(i).typeId.replace("minecraft:", "")}x${container.getItem(i).amount}`);
    return out;
};
const said = (player) => player.messages.map(strip);
const bar = (player) => player.actionBar.map(strip);
const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player);
const bountyOf = (player) => world.scoreboard.getObjective("bounty").getScore(player) ?? 0;

/** Plays the keypad: two correct picks (the target is always 40). */
async function openKeypad(player) {
    guess(40); guess(40);
    touch(player, SITE.keypad);
    await settle();
}

// ---------------------------------------------------------------------------------------------------------

test("a robbery that is not finished, or does not exist, cannot be started, and says why", () => {
    setup();
    const { check, done } = checks();

    check("an unknown id", Run.startRobbery("nope").ok === false && /no robbery/.test(Run.startRobbery("nope").reason));

    const empty = ok(L.newRobbery("empty", "Empty", "overworld"));
    S.saveRobbery(empty);
    const refused = Run.startRobbery("empty");
    check("an empty robbery is unfinished", refused.ok === false && /not finished/.test(refused.reason) && /no elements/.test(refused.reason), JSON.stringify(refused));
    done();
});

test("starting takes the director's slot, runs the start effects, and refuses a second start", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const sheriff = lawman("Sheriff", OUTSIDE);

    const started = Run.startRobbery("bank", { by: ada });
    check("it starts", started.ok === true, JSON.stringify(started));
    check("it holds the director's slot", director.activeEvent() === "robbery:bank", String(director.activeEvent()));
    check("the start effect reached the law", said(sheriff).some((m) => /Alarm! Someone is in the bank/.test(m)), said(sheriff).join("|"));
    check("the robber heard the start bell", ada.privateSounds.some((s) => s.id === R.cues.start.id));
    check("it is listed as running", Run.runningIds().join() === "bank");

    const again = Run.startRobbery("bank", { by: ada });
    check("a second start says it is under way", again.ok === false && /already under way/.test(again.reason), JSON.stringify(again));
    done();
});

test("an exclusive robbery will not start while another event holds the slot, and says so privately", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    director.registerEvent({ id: "fort", label: "fort raid", start: () => true });
    director.requestEvent("fort");
    const chatBefore = fake.chat.length;

    const refused = Run.startRobbery("bank", { by: ada });
    check("refused, naming what is running", refused.ok === false && /fort is in progress/.test(refused.reason), JSON.stringify(refused));
    check("nothing was announced to the whole world", fake.chat.length === chatBefore, fake.chat.join("|"));
    check("and nothing is running", Run.runningIds().length === 0);

    director.finishEvent("fort");
    done();
});

test("a robbery that is not exclusive runs beside another event and leaves the slot alone", () => {
    setup({ exclusive: false });
    const { check, done } = checks();

    director.registerEvent({ id: "ranch", label: "ranch raid", start: () => true });
    director.requestEvent("ranch");

    check("it starts anyway", Run.startRobbery("bank", { by: outlaw() }).ok === true);
    check("and the slot is still the ranch's", director.activeEvent() === "ranch");
    director.finishEvent("ranch");
    done();
});

test("a robbery needs its blocks loaded to start", () => {
    setup();
    const { check, done } = checks();

    fake.setUnloaded("overworld", [{ from: { x: 100, y: 0, z: 150 }, to: { x: 110, y: 100, z: 180 } }]);
    const refused = Run.startRobbery("bank", { by: outlaw() });

    check("refused, naming a block", refused.ok === false && /not loaded/.test(refused.reason), JSON.stringify(refused));
    check("and the director's slot was not taken", director.activeEvent() === null);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The whole bank
// ---------------------------------------------------------------------------------------------------------

test("the bank, part one: touching the keypad starts the robbery, and its pick opens the vault door by itself", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    const sheriff = lawman("Sheriff", OUTSIDE);

    // The first touch is on the keypad, which has no requirement: it starts the robbery by itself.
    await openKeypad(ada);

    check("touching the keypad started the robbery", Run.runningIds().join() === "bank");
    check("the law was told", said(sheriff).some((m) => /Alarm/.test(m)));
    check("two correct picks opened the keypad", said(ada).some((m) => /Found it! .*1\/2/.test(m)) && Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done");
    check("the vault door, locked by nothing but the keypad, swung open by itself (both halves)", openBit(SITE.doorLow) === true && openBit(SITE.doorHigh) === true);
    check("its blocks were noted for cleanup first", S.isDirtyAt("overworld", SITE.doorLow) && S.isDirtyAt("overworld", SITE.doorHigh));
    check("the lockbox is now up for a try", Run.viewOf("bank").elements.find((e) => e.name === "Lockbox").state === "armed");
    check("the chest is still empty", contents().length === 0);
    check("the keypad took no payment", coinsOf(ada) === 100);
    done();
});

test("the bank, part two: the lockbox takes a pick and 25 coins, the win lands after its delay, and a minute later the site is put back", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);
    const sheriff = lawman("Sheriff", OUTSIDE);

    await openKeypad(ada);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();

    check("the lockbox is done", Run.viewOf("bank").elements.find((e) => e.name === "Lockbox").state === "done");
    check("25 coins were taken, after the pick", coinsOf(ada) === 75, String(coinsOf(ada)));
    check("the chest holds the table's loot and the fixed diamonds", contents().join() === "gold_ingotx12,diamondx2", contents().join());
    check("the chest is noted for cleanup", S.isDirtyAt("overworld", SITE.box));
    check("a 250 bounty went to the robber", bountyOf(ada) === 250, String(bountyOf(ada)));
    check("the run is not over yet: the win is 3 seconds away", Run.viewOf("bank").phase === "running");

    // 3. The win lands after its delay.
    fake.advance(59);
    check("one tick short of 3 seconds: still running", Run.viewOf("bank").phase === "running");
    fake.advance(10);
    const view = Run.viewOf("bank");
    check("the win ended it", view.phase === "ended" && view.result === "win", JSON.stringify(view));
    check("the win hook paid the area 100 coins", coinsOf(ada) === 175, String(coinsOf(ada)));
    check("and told everyone, with a sound", said(sheriff).some((m) => /The bank is empty/.test(m)) && sheriff.privateSounds.some((s) => s.id === "random.levelup"));
    check("the director's slot was released at the end", director.activeEvent() === null);
    check("a chest opened this run is let through to the player", Run.interactionDecision(ref(SITE.box)) === "pass");
    check("a door that is open stays shut to clicks", Run.interactionDecision(ref(SITE.doorLow)) === "cancel");

    // 4. A minute later the site is put back.
    fake.advance(60 * 20 - 20);
    check("before the minute is up the door is still open", openBit(SITE.doorLow) === true);
    fake.advance(40);
    check("the door is shut again, both halves", openBit(SITE.doorLow) === false && openBit(SITE.doorHigh) === false);
    check("the chest is empty again", contents().length === 0);
    check("nothing is left noted", S.dirtyCount() === 0);
    check("the run is gone", Run.viewOf("bank") === undefined && Run.runningIds().length === 0);
    check("and it is on cooldown", Run.startRobbery("bank", { by: ada }).ok === false && /closed for another/.test(Run.startRobbery("bank", { by: ada }).reason));
    check("an unlocked chest no longer passes clicks once reset", Run.interactionDecision(ref(SITE.box)) === "cancel");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------------------------------------

test("a pick lock: a miss pings and keeps trying, a hit counts, and closing the form walks away without a cost", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    guess(90); guess(41); closeForm();
    touch(ada, SITE.keypad);
    await settle();

    check("a miss said so and pinged cold", said(ada).some((m) => /no luck/.test(m)) && ada.privateSounds.some((s) => s.id === R.cues.ping.id && s.pitch < 1));
    check("a hit counted one of two", said(ada).some((m) => /Found it! .*1\/2/.test(m)));
    check("the keypad is not open", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "armed");
    check("the form was shown three times", fakeUi.uiFake.shown.length === 3, String(fakeUi.uiFake.shown.length));

    guess(40);
    touch(ada, SITE.keypad);
    await settle();
    check("progress was kept when the form was closed: one more hit opens it", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done");
    done();
});

test("three misses in a row jam the lock: progress is lost, onFail runs, it is refused until the jam ends", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const sheriff = lawman("Sheriff", IN_AREA);

    guess(41);                                  // one hit banked
    guess(95); guess(96); guess(97);            // then three misses
    touch(ada, SITE.keypad);
    await settle();

    check("the third miss jammed it", said(ada).some((m) => /The lock jams/.test(m)) && ada.privateSounds.some((s) => s.id === R.cues.jam.id));
    check("the element's onFail ran", said(sheriff).concat(said(ada)).some((m) => /Too noisy/.test(m)));
    check("it reads as jammed", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "jammed");

    touch(ada, SITE.keypad);
    check("touching it now is refused with the time left", bar(ada).some((m) => /jammed for another 0:20/.test(m)), bar(ada).join("|"));

    fake.advance(20 * 20 - 1);
    check("a tick short of 20 seconds: still jammed", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "jammed");
    fake.advance(1);

    guess(40);
    touch(ada, SITE.keypad);
    await settle();
    check("after the jam, the lost progress means one hit is not enough (two were needed)", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "armed");
    done();
});

test("two players working one lock share its progress: one opens it while the other's form is open, or jams it under them", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada");
    const bob = outlaw("Bob");

    // Ada's form is open; while it is, Bob gets the keypad open another way. Her submission then finds it done.
    fakeUi.uiFake.responses.push((form) => { Run.activateElement("bank", "Keypad", bob); return { canceled: false, formValues: [40] }; });
    touch(ada, SITE.keypad);
    await settle();
    check("she is told someone else got it", said(ada).some((m) => /Someone else got it open/.test(m)), said(ada).join("|"));
    check("and her guess did not count: the keypad is done once, by Bob", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done");

    // A fresh run: both pick, and their misses add up. Responses are taken in the order the forms are shown: A1, B1, A2, B2, A3, B3.
    setup();
    const cara = outlaw("Cara");
    const dan = outlaw("Dan");
    for (let i = 0; i < 6; i++) guess(95);
    touch(cara, SITE.keypad);
    touch(dan, SITE.keypad);
    await settle();

    check("the third miss, whoever made it, jammed the one lock", said(cara).some((m) => /The lock jams/.test(m)), said(cara).join("|"));
    check("and the other player, whose form was still open, is told it is jammed", bar(dan).some((m) => /The lock is jammed/.test(m)), bar(dan).join("|"));
    done();
});

test("touching a lock twice in a row opens one form, not two", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    closeForm();
    closeForm();
    touch(ada, SITE.keypad);                    // the first touch starts the robbery and opens the slider
    touch(ada, SITE.keypad);                    // a double click: the slider is already up for her
    await settle();

    check("one form was shown", fakeUi.uiFake.shown.length === 1, String(fakeUi.uiFake.shown.length));
    check("and she can open it again once it is closed", (() => { closeForm(); touch(ada, SITE.keypad); return fakeUi.uiFake.shown.length === 2; })());
    await settle();
    done();
});

test("guesses faster than the cooldown are not scored, so the slider cannot be mashed", async () => {
    setup();
    R.pickGuessCooldownTicks = 15;
    const { check, done } = checks();
    const ada = outlaw();

    guess(95); guess(95); guess(95); guess(95);
    touch(ada, SITE.keypad);
    await settle();

    const misses = said(ada).filter((m) => /no luck/.test(m)).length;
    R.pickGuessCooldownTicks = 0;
    check("only the first of four same-tick guesses was scored", misses === 1, String(misses));
    check("so it is nowhere near a jam", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "armed");
    done();
});

test("a key lock: the key must be carried, is used up only if it says so, and is checked before anything else", async () => {
    setup({}, { keypadLocks: [{ kind: "key", item: "minecraft:iron_pickaxe", consume: true }] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    check("without the key: told what is needed", bar(ada).some((m) => /need the iron pickaxe/.test(m)), bar(ada).join("|"));
    check("nothing started the lock", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state !== "done");

    ada.container.setItem(3, fake.makeItemStack("minecraft:iron_pickaxe", 2));
    touch(ada, SITE.keypad);
    await settle();

    check("with it, the keypad opened", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done");
    check("one pickaxe was used up", ada.container.getItem(3)?.amount === 1, String(ada.container.getItem(3)?.amount));
    done();
});

test("a key that is not consumed stays in the inventory", async () => {
    setup({}, { keypadLocks: [{ kind: "key", item: "minecraft:iron_pickaxe", consume: false }] });
    const { check, done } = checks();
    const ada = outlaw();

    ada.container.setItem(0, fake.makeItemStack("minecraft:iron_pickaxe", 1));
    touch(ada, SITE.keypad);
    await settle();

    check("opened", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done");
    check("and still carried", ada.container.getItem(0)?.amount === 1);
    done();
});

test("a pay lock needs the coins up front and takes them only when it opens; a failed pick costs nothing", async () => {
    setup({}, { keypadLocks: [{ kind: "pay", coins: 40 }] });
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_AREA, 10);
    const rich = outlaw("Rich", IN_AREA, 100);

    touch(poor, SITE.keypad);
    check("too few coins: told the price and what they have", bar(poor).some((m) => /costs 40 coins and you have 10/.test(m)), bar(poor).join("|"));
    check("nothing was taken", coinsOf(poor) === 10);

    touch(rich, SITE.keypad);
    await settle();
    check("enough coins: done, and charged", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done" && coinsOf(rich) === 60, String(coinsOf(rich)));
    done();
});

test("a lock with a pick and a price: a failed pick costs nothing, a coin spent elsewhere in the meantime stops the opening", async () => {
    setup({}, { keypadLocks: [{ kind: "pick", hits: 1, tolerance: 10, strikes: 3, jamSeconds: 20 }, { kind: "pay", coins: 30 }] });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 50);

    guess(95); closeForm();
    touch(ada, SITE.keypad);
    await settle();
    check("a miss then walking away: no charge", coinsOf(ada) === 50, String(coinsOf(ada)));

    // The form is open; meanwhile the player's coins disappear (spent, robbed): the opening must notice.
    guess(40);
    touch(ada, SITE.keypad);
    fake.setScore("coins", ada, 0);
    await settle();
    check("the unlock found no coins left and did not open", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "armed", JSON.stringify(Run.viewOf("bank").elements));
    check("and said why", bar(ada).some((m) => /costs 30 coins/.test(m)), bar(ada).join("|"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------------------

test("only outlaws may work an element, and a refusal is one line on the action bar", () => {
    setup();
    const { check, done } = checks();
    const sheriff = lawman("Sheriff", IN_AREA);
    const bystander = fake.makePlayer("Bystander", { location: { ...IN_AREA } });
    const jailed = outlaw("Jailed");
    state.update(jailed, { inJail: true });
    const out = outlaw("Out");
    state.update(out, { eliminated: true });

    touch(sheriff, SITE.keypad);
    touch(bystander, SITE.keypad);
    touch(jailed, SITE.keypad);
    touch(out, SITE.keypad);

    check("law: only outlaws", bar(sheriff).some((m) => /Only outlaws/.test(m)));
    check("no role: only outlaws", bar(bystander).some((m) => /Only outlaws/.test(m)));
    check("jailed: not from jail", bar(jailed).some((m) => /from jail/.test(m)));
    check("eliminated: out of the round", bar(out).some((m) => /out of the round/.test(m)));
    check("none of them started anything", Run.runningIds().length === 0);
    check("each was refused with a thud, not chat", sheriff.privateSounds.some((s) => s.id === R.cues.denied.id) && sheriff.messages.length === 0);
    done();
});

test("with outlawsOnly off anyone alive may; a test run lets everyone in and sets no cooldown", async () => {
    setup({ outlawsOnly: false });
    const { check, done } = checks();
    const sheriff = lawman("Sheriff", IN_AREA);

    guess(40); guess(40);
    touch(sheriff, SITE.keypad);
    await settle();
    check("a law player opened the keypad", Run.viewOf("bank")?.elements.find((e) => e.name === "Keypad").state === "done");

    setup();
    const bystander = fake.makePlayer("Bystander", { location: { ...IN_AREA } });
    check("a test run starts for anyone", Run.startRobbery("bank", { by: bystander, test: true }).ok === true);
    check("and says so", said(bystander).some((m) => /Test run/.test(m)));

    guess(40); guess(40);
    touch(bystander, SITE.keypad);
    await settle();
    check("a player with no role could play it", Run.viewOf("bank").elements.find((e) => e.name === "Keypad").state === "done");

    Run.stopRobbery("bank");
    Run.resetSiteNow("bank");
    check("a test run leaves no cooldown", Run.cooldownLeftSeconds("bank") === 0 && Run.startRobbery("bank", { by: bystander }).ok === true);
    done();
});

test("an element that waits on another is sealed, and an element nobody can start by touch says it will not budge", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.doorLow);
    check("the vault door cannot start a robbery: it waits on the keypad", bar(ada).some((m) => /will not budge/.test(m)), bar(ada).join("|"));
    check("so nothing started", Run.runningIds().length === 0);

    Run.startRobbery("bank", { by: ada });
    touch(ada, SITE.box);
    check("once running, the lockbox is sealed until the door is open", bar(ada).some((m) => /sealed tight/.test(m)), bar(ada).join("|"));
    done();
});

test("with autoStart off, touching does not start it, but the start command does", () => {
    setup({ autoStart: false });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    check("touching alone does nothing", Run.runningIds().length === 0 && bar(ada).some((m) => /will not budge/.test(m)));
    check("the command starts it", Run.startRobbery("bank", { by: ada }).ok === true && Run.runningIds().join() === "bank");
    done();
});

test("roundOnly: it cannot be robbed outside a round, and can during one", () => {
    setup({ roundOnly: true });
    const { check, done } = checks();
    const ada = outlaw();

    const refused = Run.startRobbery("bank", { by: ada });
    check("refused outside a round", refused.ok === false && /during a round/.test(refused.reason), JSON.stringify(refused));

    round.startRound();
    round.beginActive();
    check("allowed while a round is active", Run.startRobbery("bank", { by: ada }).ok === true);
    round.resetRound();
    done();
});

test("the game's own handling is stopped for bound blocks, except a chest that was unlocked", () => {
    setup();
    const { check, done } = checks();

    check("a bound button is cancelled", Run.interactionDecision(ref(SITE.keypad)) === "cancel");
    check("a bound door is cancelled", Run.interactionDecision(ref(SITE.doorLow)) === "cancel");
    check("a bound chest that is still locked is cancelled", Run.interactionDecision(ref(SITE.box)) === "cancel");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Ending, resetting, recovering
// ---------------------------------------------------------------------------------------------------------

test("the time limit fails the run, tells the actor, and puts the site back after the reset time", async () => {
    setup({ timeLimitSeconds: 100, resetAfterSeconds: 5, failWhenEmptySeconds: 0 });
    const { check, done } = checks();
    const ada = outlaw();

    await openKeypad(ada);
    check("the door is open", openBit(SITE.doorLow) === true);

    fake.advance(100 * 20 - 10);
    check("a moment before the limit it is still running", Run.viewOf("bank").phase === "running");
    fake.advance(20);

    const view = Run.viewOf("bank");
    check("the limit failed it", view.phase === "ended" && view.result === "fail", JSON.stringify(view));
    check("the actor was told why", said(ada).some((m) => /Time is up/.test(m)), said(ada).join("|"));
    check("and it is on cooldown", Run.cooldownLeftSeconds("bank") > 0);

    fake.advance(5 * 20 + 20);
    check("after the reset time the door is shut", openBit(SITE.doorLow) === false && openBit(SITE.doorHigh) === false);
    check("and the run is gone", Run.viewOf("bank") === undefined);
    done();
});

test("fail-when-empty: nobody in the area for long enough ends it; someone inside keeps it alive", async () => {
    setup({ failWhenEmptySeconds: 30, timeLimitSeconds: 0 });
    const { check, done } = checks();
    const ada = outlaw();

    await openKeypad(ada);
    fake.advance(25 * 20);
    check("with her inside it is still going", Run.viewOf("bank").phase === "running");

    ada.teleport({ ...OUTSIDE });
    fake.advance(20 * 20);
    check("20 seconds away: not yet", Run.viewOf("bank").phase === "running");
    fake.advance(15 * 20);
    check("past 30 seconds away: failed", Run.viewOf("bank").result === "fail", JSON.stringify(Run.viewOf("bank")));
    done();
});

test("stopping a run ends it without win or fail effects and puts the site back at once; no cooldown", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const sheriff = lawman("Sheriff", OUTSIDE);

    await openKeypad(ada);
    check("the door is open", openBit(SITE.doorLow) === true);

    check("stop works on a running one", Run.stopRobbery("bank").ok === true);
    check("and refuses when nothing is running", Run.stopRobbery("bank").ok === false);
    check("no win or fail hook fired", !said(sheriff).some((m) => /The bank is empty/.test(m)));
    check("the director's slot is free", director.activeEvent() === null);

    fake.advance(R.janitorEvery + R.tickEvery);
    check("the janitor put the door back within a pass", openBit(SITE.doorLow) === false && openBit(SITE.doorHigh) === false);
    check("no cooldown for a stop", Run.cooldownLeftSeconds("bank") === 0);
    done();
});

test("a manual site reset cleans now, ends the run, clears the cooldown, and reports what could not be reached", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);

    await openKeypad(ada);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();
    check("the site is dirty: door and chest", S.dirtyCount() === 3, String(S.dirtyCount()));

    fake.setUnloaded("overworld", [{ from: { x: SITE.box[0], y: 0, z: SITE.box[2] }, to: { x: SITE.box[0], y: 100, z: SITE.box[2] } }]);
    const partial = Run.resetSiteNow("bank");
    check("the door was put back, the chest in the unloaded chunk was not", partial.cleaned === 2 && partial.left === 1, JSON.stringify(partial));
    check("the run is gone and may start again", Run.viewOf("bank") === undefined);
    check("but it will not start while a block is still waiting", /still being put back|not loaded/.test(Run.startRobbery("bank", { by: ada }).reason ?? ""));

    fake.setUnloaded("overworld", []);
    fake.advance(R.janitorEvery + R.tickEvery);
    check("when the chunk loads the janitor finishes the job", contents().length === 0 && S.dirtyCount() === 0);
    done();
});

test("a round reset drops every run at once, frees the slot, and the janitor still puts the site back", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    await openKeypad(ada);
    check("running, door open", Run.runningIds().length === 1 && openBit(SITE.doorLow) === true);

    resetAllSystems();
    check("no run is left", Run.runningIds().length === 0 && Run.viewOf("bank") === undefined);
    check("the notes survive: the site is still dirty", S.dirtyCount() === 2);
    check("the director is free", director.activeEvent() === null);

    fake.advance(R.janitorEvery + R.tickEvery);
    check("the janitor shut the door", openBit(SITE.doorLow) === false && openBit(SITE.doorHigh) === false && S.dirtyCount() === 0);
    check("and it can be started again", Run.startRobbery("bank", { by: ada }).ok === true);
    done();
});

test("crash recovery: the run is lost but the cleanup list is not, so a reload still puts the site back", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);

    await openKeypad(ada);
    guess(40); guess(40);
    touch(ada, SITE.box);
    await settle();
    check("door open and chest full before the 'crash'", openBit(SITE.doorLow) === true && contents().length === 2);

    resetAllSystems();                          // the run state is gone, as after a script reload
    S.forgetLoaded();                           // and everything read from the world is read again
    check("the cleanup list is read back from the world", S.dirtyCount() === 3);

    fake.advance(R.janitorEvery + R.tickEvery);
    check("the vault door is shut and the lockbox empty", openBit(SITE.doorLow) === false && contents().length === 0 && S.dirtyCount() === 0);
    done();
});

test("a block in an unloaded chunk waits for the janitor, and is put back once the chunk loads", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    await openKeypad(ada);
    Run.stopRobbery("bank");
    fake.setUnloaded("overworld", [{ from: { x: 100, y: 0, z: 160 }, to: { x: 110, y: 100, z: 180 } }]);

    fake.advance(R.janitorEvery * 3);
    check("still noted while its chunk is away", S.dirtyCount() === 2);

    fake.setUnloaded("overworld", []);
    fake.advance(R.janitorEvery + R.tickEvery);
    check("put back as soon as it loaded", openBit(SITE.doorLow) === false && S.dirtyCount() === 0);
    done();
});

test("a robbery deleted while it is running is dropped, frees the slot, and its changes are still cleaned", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    await openKeypad(ada);
    S.deleteRobbery("bank");
    fake.advance(R.tickEvery);

    check("the run is gone", Run.runningIds().length === 0);
    check("the director is free", director.activeEvent() === null);

    fake.advance(R.janitorEvery + R.tickEvery);
    check("and the open door was shut by the janitor anyway", openBit(SITE.doorLow) === false && S.dirtyCount() === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Effects and commands
// ---------------------------------------------------------------------------------------------------------

test("delayed effects fire at their time and in order, and an effect for a player who left is skipped", async () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const bob = outlaw("Bob");

    let r = S.getRobbery("bank");
    r = ok(L.setHook(r, "start", [
        say("one", "all"), say("two", "all", { delaySeconds: 2 }), say("three", "all", { delaySeconds: 1 }),
        { kind: "say", text: "for Ada only", channel: "chat", to: "actor", delaySeconds: 3 }
    ]));
    S.saveRobbery(r);

    Run.startRobbery("bank", { by: ada });
    check("the undelayed one is immediate", said(bob).join("|") === "one", said(bob).join("|"));

    // The loop looks every R.tickEvery ticks, so an effect is never early and at most that late.
    fake.advance(19);
    check("a tick before its second is up, 'three' has not come", said(bob).join("|") === "one", said(bob).join("|"));
    fake.advance(1 + R.tickEvery);
    check("by a second and one loop pass later: three", said(bob).join("|") === "one|three", said(bob).join("|"));
    fake.advance(20);
    check("by two seconds and a pass: two", said(bob).join("|") === "one|three|two", said(bob).join("|"));

    ada.remove();
    fake.advance(20 + R.tickEvery);
    check("an effect for the actor who left is skipped without an error", said(bob).length === 3 && fake.chat.length === 0);
    done();
});

test("rewards and messages reach the right audience: area, outlaws, law, all, actor", () => {
    setup();
    const { check, done } = checks();
    const inside = outlaw("Inside", IN_AREA);
    const away = outlaw("Away", OUTSIDE);
    const lawIn = lawman("LawIn", IN_AREA);
    const lawAway = lawman("LawAway", OUTSIDE);

    const all = (to) => ({ kind: "say", text: `to-${to}`, channel: "chat", to });
    let r = S.getRobbery("bank");
    r = ok(L.setHook(r, "start", ["actor", "area", "outlaws", "law", "all"].map(all)));
    S.saveRobbery(r);

    const started = Run.startRobbery("bank", { by: inside });

    const got = (p) => said(p).sort().join(",");
    check("it started", started.ok === true, started.reason);
    check("the actor hears actor, area, outlaws and all", got(inside) === "to-actor,to-all,to-area,to-outlaws", got(inside));
    check("an outlaw away from the area hears outlaws and all", got(away) === "to-all,to-outlaws", got(away));
    check("area is outlaws-only by default, so law inside does not hear it", got(lawIn) === "to-all,to-law", got(lawIn));
    check("law away hears law and all", got(lawAway) === "to-all,to-law", got(lawAway));
    done();
});

test("effect channels: chat, the action bar and the title", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    let r = S.getRobbery("bank");
    r = ok(L.setHook(r, "start", [
        { kind: "say", text: "in chat", channel: "chat", to: "actor" },
        { kind: "say", text: "on the bar", channel: "bar", to: "actor" },
        { kind: "say", text: "as a title", channel: "title", to: "actor", sound: "random.levelup" }
    ]));
    S.saveRobbery(r);

    Run.startRobbery("bank", { by: ada });

    check("chat", said(ada).includes("in chat"));
    check("action bar", bar(ada).includes("on the bar"));
    check("title", ada.titles.map(strip).includes("as a title"));
    check("the sound went with the line", ada.privateSounds.some((s) => s.id === "random.levelup"));
    done();
});

test("activate completes an element from outside: locks skipped, requirements respected, starts the robbery if needed", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    const waiting = Run.activateElement("bank", "Vault door", ada);
    check("an element that waits on another is refused, naming it", waiting.ok === false && /waits on Keypad/.test(waiting.reason), JSON.stringify(waiting));

    const keypad = Run.activateElement("bank", "e1", ada);
    check("the keypad (by id) completes without a pick, starting the robbery", keypad.ok === true && Run.runningIds().join() === "bank", JSON.stringify(keypad));
    check("and the vault door followed", openBit(SITE.doorLow) === true);
    check("a second activate says it is done", Run.activateElement("bank", "Keypad", ada).ok === false);
    check("an unknown element is refused", Run.activateElement("bank", "nothing", ada).ok === false);
    check("an unknown robbery too", Run.activateElement("ghost", "e1", ada).ok === false);
    done();
});

test("a lock-less element with a requirement completes by itself, and a chain of them cascades", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    let r = S.getRobbery("bank");
    const extra = L.addElement(r, { kind: "switch", name: "Alarm", cells: [[110, 70, 110]], req: ["e2"], onDone: [say("alarm!", "all")] });
    r = extra.robbery;
    const extra2 = L.addElement(r, { kind: "switch", name: "Siren", cells: [[111, 70, 110]], req: [extra.element.id], onDone: [say("siren!", "all")] });
    S.saveRobbery(extra2.robbery);
    fake.placeBlock("overworld", { x: 110, y: 70, z: 110 }, "minecraft:lever");
    fake.placeBlock("overworld", { x: 111, y: 70, z: 110 }, "minecraft:lever");

    Run.activateElement("bank", "Keypad", ada);

    check("opening the keypad opened the door, which tripped the alarm, which tripped the siren", fake.players.every((p) => said(p).includes("alarm!") && said(p).includes("siren!")), said(ada).join("|"));
    check("in that order", said(ada).indexOf("alarm!") < said(ada).indexOf("siren!"));
    done();
});

test("a chest with no loot table or items still opens; a robbery can be viewed element by element", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    Run.activateElement("bank", "Keypad", ada);
    const view = Run.viewOf("bank");

    check("keypad done, door done, lockbox armed", view.elements.map((e) => `${e.name}:${e.state}`).join() === "Keypad:done,Vault door:done,Lockbox:armed", view.elements.map((e) => `${e.name}:${e.state}`).join());
    check("the view says running, not a test", view.phase === "running" && view.test === false && view.resetInSeconds === undefined);
    done();
});

test("when nothing is running and nothing is waiting, the shared loop reads nothing after its first look", () => {
    setup();
    const { check, done } = checks();
    outlaw();

    // Other systems poll players on their own; what must be silent is the robbery loop's own reading of the world.
    let reads = 0;
    const realGet = world.getDynamicProperty;
    const realIds = world.getDynamicPropertyIds;
    world.getDynamicProperty = (key) => { if (String(key).startsWith("rae:robbery:")) reads++; return realGet.call(world, key); };
    world.getDynamicPropertyIds = () => { reads++; return realIds.call(world); };

    try {
        fake.advance(10);                        // its first look at the cleanup list
        const warm = reads;
        fake.advance(400);
        check("no robbery property was read again in 400 idle ticks", reads === warm, `${warm} -> ${reads}`);
        check("and it found nothing to do", Run.runningIds().length === 0 && S.dirtyCount() === 0);
    } finally {
        world.getDynamicProperty = realGet;
        world.getDynamicPropertyIds = realIds;
    }
    done();
});

test("a click that arrives after its robbery was deleted is ignored, and a failure inside a touch reaches operators, not the game", () => {
    setup();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { permission: 2 });
    const ada = outlaw();

    let threw = false;
    try { Run.touch(ada, { robbery: "ghost", element: "e1" }); } catch { threw = true; }
    check("a ref to a robbery that is gone does nothing", !threw && ada.messages.length === 0 && ada.actionBar.length === 0);

    // Make the engine fail inside a touch: the scoreboard read throws when the pay lock asks for coins.
    S.saveRobbery(bank("bank", { keypadLocks: [{ kind: "pay", coins: 5 }] }).r);
    const realGet = world.scoreboard.getObjective;
    world.scoreboard.getObjective = () => { throw new Error("scoreboard exploded"); };
    try { Run.touch(ada, ref(SITE.keypad)); } catch { threw = true; } finally { world.scoreboard.getObjective = realGet; }

    check("nothing was thrown into the game", !threw);
    check("the operator was told, in the log's format", op.messages.some((m) => /\[robbery\] touching bank\/e1 failed: .*scoreboard exploded/.test(strip(m))), op.messages.join("|"));
    check("the player was not shown the internals", !ada.messages.some((m) => /exploded/.test(m)));
    done();
});

test.after(() => { Math.random = originalRandom; });
