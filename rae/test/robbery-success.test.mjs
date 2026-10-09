import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, load, checks, strip } from "./helpers.mjs";
import { close, press, problems, script, titleOf, ui } from "./robbery-ui.mjs";
import { L, SITE, added, at, buildSite, ok, pay, say } from "./robbery-fixtures.mjs";

// A SUCCESS does not close the vault, and a RESET never closes it on somebody. The contract: a win decides the outcome and starts the
// reset countdown but shuts nothing (the doors and chests that are left can still be worked, including the ones that waited on the
// element that won); a fail does shut them; whichever comes first is the only outcome; and when the countdown runs out the site waits
// until nobody is standing in the robbery's area, whoever they are, so a door never shuts behind a player. The exceptions are the
// operator's own stop and reset, which put the site back at once, and a robbery with no area, which has no "inside".

const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const F = await load("core/robberyforms.js");
const Run = await load("core/robberyrun.js");
const Players = await load("core/players.js");
const state = await load("core/state.js");
const { resetAllSystems } = await load("core/registry.js");
const { ROBBERY: R } = await load("config/balance.js");

fake.entityTypes.add("pillager");

Math.random = () => 0.4;                        // the hidden pick target is always 40

/** Lets a pick form's promise chain run (the fake answers the form at once). */
async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

const PICK = { kind: "pick", hits: 1, tolerance: 10, strikes: 3, jamSeconds: 20 };

const CASH = SITE.box;                     // waits for the vault door, no lock: opens by itself
const GOLD = [107, 65, 176];                // waits for the vault door, costs 25 coins
const DEPOSIT = [107, 65, 177];             // waits for the gold
const ALARM = [103, 66, 173];               // a button
const SPOT = [105, 65, 172];                // where guards appear
const IN_AREA = { x: 100, y: 65, z: 170 };
const OUTSIDE = { x: 500, y: 65, z: 500 };

const WIN = { kind: "end", result: "win" };
const FAIL = { kind: "end", result: "fail" };

/**
 * A keypad that opens a vault door, which is where the robbery is WON; behind the door a chest that fills by itself, one that costs
 * 25 coins, and a third that waits for the second. `door` and `gold` are what those two do when they are done.
 */
function vault({ settings = {}, area = true, door = [WIN], gold = [], goldLocks = [pay], alarm = false, hooks = {} } = {}) {
    let r = ok(L.newRobbery("vault", "The Vault", "overworld"));
    if (area) r = ok(L.setArea(r, SITE.area.min, SITE.area.max));
    r = ok(L.setSettings(r, { failWhenEmptySeconds: 0, timeLimitSeconds: 0, resetAfterSeconds: 10, cooldownSeconds: 0, ...settings }));

    const keypad = added(L.addElement(r, { kind: "switch", name: "Keypad", cells: [SITE.keypad] }));
    r = keypad.robbery;
    const vaultDoor = added(L.addElement(r, { kind: "door", name: "Vault door", cells: [SITE.doorLow, SITE.doorHigh], req: [keypad.element.id], onDone: door }));
    r = vaultDoor.robbery;
    const cash = added(L.addElement(r, { kind: "chest", name: "Cash", cells: [CASH], items: [["minecraft:gold_ingot", 4]], req: [vaultDoor.element.id] }));
    r = cash.robbery;
    const goldBox = added(L.addElement(r, { kind: "chest", name: "Gold", cells: [GOLD], items: [["minecraft:diamond", 2]], locks: goldLocks, req: [vaultDoor.element.id], onDone: gold }));
    r = goldBox.robbery;
    r = added(L.addElement(r, { kind: "chest", name: "Deposit boxes", cells: [DEPOSIT], items: [["minecraft:emerald", 3]], req: [goldBox.element.id] })).robbery;

    if (alarm) r = added(L.addElement(r, { kind: "switch", name: "Alarm", cells: [ALARM], onDone: [FAIL] })).robbery;

    for (const [hook, effects] of Object.entries(hooks)) r = ok(L.setHook(r, hook, effects));

    return r;
}

function setup(options = {}) {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;

    fake.addObjective("coins");
    fake.addObjective("bounty");
    buildSite();
    for (const pos of [GOLD, DEPOSIT]) fake.placeBlock("overworld", at(pos), "minecraft:chest");
    fake.placeBlock("overworld", at(ALARM), "minecraft:stone_button");

    const saved = S.saveRobbery(vault(options));
    assert.equal(saved.ok, true, saved.reason);
}

function person(name, role, where = IN_AREA, coins = 0) {
    const player = fake.makePlayer(name, { location: { ...where } });
    state.update(player, { role });
    fake.setScore("coins", player, coins);
    return player;
}

const outlaw = (name = "Ada", where = IN_AREA, coins = 0) => person(name, "outlaw", where, coins);
const lawman = (name = "Sheriff", where = IN_AREA) => person(name, "law", where);

const ref = (pos) => S.boundAt("overworld", pos[0], pos[1], pos[2]);
const touch = (player, pos) => Run.touch(player, ref(pos));
const openBit = (pos) => fake.blockAt("overworld", at(pos)).permutation.getState("open_bit");
const doorOpen = () => openBit(SITE.doorLow) === true && openBit(SITE.doorHigh) === true;
const doorShut = () => openBit(SITE.doorLow) === false && openBit(SITE.doorHigh) === false;
const stateOf = (name) => Run.viewOf("vault")?.elements.find((e) => e.name === name)?.state;
const said = (player) => player.messages.map(strip);
const bar = (player) => player.actionBar.map(strip);
const coinsOf = (player) => world.scoreboard.getObjective("coins").getScore(player);
const guards = () => fake.entities.filter((e) => e.isValid && e.hasTag(R.guardTag));

function contents(pos) {
    const container = fake.blockAt("overworld", at(pos)).getComponent("minecraft:inventory").container;
    const out = [];
    for (let i = 0; i < container.size; i++) if (container.getItem(i)) out.push(`${container.getItem(i).typeId.replace("minecraft:", "")}x${container.getItem(i).amount}`);
    return out;
}

const allEmpty = () => [CASH, GOLD, DEPOSIT].every((pos) => contents(pos).length === 0);
/** One janitor pass, plus the loop's rhythm. */
const aPass = () => fake.advance(R.janitorEvery + R.tickEvery);
/** The reset countdown (10 seconds in these robberies) has run out, and a couple of passes beyond it. */
const pastReset = () => fake.advance(10 * 20 + R.janitorEvery * 2);

// ---------------------------------------------------------------------------------------------------------
// A success shuts nothing
// ---------------------------------------------------------------------------------------------------------

test("a success on the vault door fills the chests that waited on it, and the rest of the vault can still be worked", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);

    touch(ada, SITE.keypad);                    // no lock: starts the robbery, opens the keypad, which opens the door, which WINS

    const view = Run.viewOf("vault");
    check("the robbery is a success", view.result === "win" && view.phase === "ended", JSON.stringify(view));
    check("and it is still open to loot", view.open === true && view.waitingForPlayers === false, JSON.stringify(view));
    check("the vault door is open", doorOpen());
    check("the chest that only waited on the door filled itself, AFTER the success", contents(CASH).join() === "gold_ingotx4", contents(CASH).join());
    check("the chest with a price is up for a try, not shut", stateOf("Gold") === "armed", String(stateOf("Gold")));
    check("and the one behind it is still sealed", stateOf("Deposit boxes") === "sealed", String(stateOf("Deposit boxes")));

    touch(ada, GOLD);                           // after the success
    check("paying for the second chest still works: the coins go and the loot comes", coinsOf(ada) === 75 && contents(GOLD).join() === "diamondx2", `${coinsOf(ada)} ${contents(GOLD).join()}`);
    check("which opens the one behind it", stateOf("Deposit boxes") === "done" && contents(DEPOSIT).join() === "emeraldx3", `${stateOf("Deposit boxes")} ${contents(DEPOSIT).join()}`);
    check("every chest opened this run lets the player in", [CASH, GOLD, DEPOSIT].every((pos) => Run.interactionDecision(ref(pos)) === "pass"));
    check("the site is noted for cleanup, door and all three chests", S.dirtyCount() === 5, String(S.dirtyCount()));
    done();
});

test("what is left keeps its rules after a success: a price is still charged, and a sealed chest stays sealed", () => {
    setup();
    const { check, done } = checks();
    const poor = outlaw("Poor", IN_AREA, 10);

    touch(poor, SITE.keypad);
    touch(poor, GOLD);
    check("too poor for the price: nothing was taken and nothing came", coinsOf(poor) === 10 && contents(GOLD).length === 0, `${coinsOf(poor)} ${contents(GOLD).join()}`);
    check("and she was told why", bar(poor).some((m) => /costs 25 coins/.test(m)), bar(poor).join("|"));

    touch(poor, DEPOSIT);
    check("a chest that waits on another stays sealed, success or not", stateOf("Deposit boxes") === "sealed" && contents(DEPOSIT).length === 0);
    check("and says so", bar(poor).some((m) => /sealed/.test(m)), bar(poor).join("|"));
    done();
});

test("an element can be activated from outside after a success, and not after a failure", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    check("after a success, the gold can be activated by a command or an NPC", Run.whyCannotActivate("vault", "Gold") === undefined, String(Run.whyCannotActivate("vault", "Gold")));
    check("and it works", Run.activateElement("vault", "Gold").ok === true && contents(GOLD).join() === "diamondx2");

    setup({ door: [FAIL], gold: [WIN] });          // the door FAILS it (the gold chest could have won it, but it is never reached)
    const bea = outlaw("Bea");
    touch(bea, SITE.keypad);
    check("after a failure it says it is over", Run.whyCannotActivate("vault", "Gold") === "it is over", String(Run.whyCannotActivate("vault", "Gold")));
    check("and the chest that waited on that door did not fill itself after the failure", contents(CASH).length === 0, contents(CASH).join());
    done();
});

test("a pick form that is still open when the run fails unlocks nothing and takes nothing", async () => {
    setup({ door: [], gold: [WIN], goldLocks: [PICK, pay], settings: { timeLimitSeconds: 30 } });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);

    touch(ada, SITE.keypad);                    // opens the door; the gold chest would win it
    check("under way", Run.viewOf("vault").phase === "running" && stateOf("Gold") === "armed");

    // Her form is open; while it is, the time limit runs out. Her guess is right (the target is always 40), but too late.
    ui.responses.push(() => { fake.advance(31 * 20); return { canceled: false, formValues: [40] }; });
    touch(ada, GOLD);
    await settle();

    check("the run failed while the form was open", Run.viewOf("vault").result === "fail", JSON.stringify(Run.viewOf("vault")));
    check("her right guess unlocked nothing", stateOf("Gold") === "armed" && contents(GOLD).length === 0, `${stateOf("Gold")} ${contents(GOLD).join()}`);
    check("and she was not charged for it", coinsOf(ada) === 100, String(coinsOf(ada)));
    done();
});

test("a pick form that is open when the run is WON still unlocks: the take is not cut off", async () => {
    setup({ door: [{ ...WIN, delaySeconds: 3 }], goldLocks: [PICK, pay] });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);

    touch(ada, SITE.keypad);                    // the door opens now and wins in three seconds
    check("under way, the gold chest up for a try", Run.viewOf("vault").phase === "running" && stateOf("Gold") === "armed");

    // Her form is open; while it is, the win lands. Her guess is right, and it still counts.
    ui.responses.push(() => { fake.advance(4 * 20); return { canceled: false, formValues: [40] }; });
    touch(ada, GOLD);
    await settle();

    check("the robbery was won while the form was open", Run.viewOf("vault").result === "win", JSON.stringify(Run.viewOf("vault")));
    check("her guess unlocked it and she paid", stateOf("Gold") === "done" && contents(GOLD).join() === "diamondx2" && coinsOf(ada) === 75, `${stateOf("Gold")} ${contents(GOLD).join()} ${coinsOf(ada)}`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// A failure still shuts it
// ---------------------------------------------------------------------------------------------------------

test("a failure shuts what is left: an alarm, and nothing after it can be opened", () => {
    setup({ alarm: true });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, ALARM);                          // starts the robbery, and the alarm fails it
    const view = Run.viewOf("vault");
    check("it failed, and is not open", view.result === "fail" && view.open === false, JSON.stringify(view));

    touch(ada, SITE.keypad);
    check("the keypad will not open now", stateOf("Keypad") !== "done" && doorShut());
    check("and says it is over", bar(ada).some((m) => /over for now/.test(m)), bar(ada).join("|"));
    done();
});

test("a failure by the time limit shuts what is left, but what was already opened stays open until the reset", () => {
    setup({ door: [], gold: [WIN], settings: { timeLimitSeconds: 30 } });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 100);

    touch(ada, SITE.keypad);                    // the door opens and the cash chest fills; the gold chest is what would win it
    check("under way, not won", Run.viewOf("vault").phase === "running" && contents(CASH).length === 1);

    fake.advance(31 * 20);
    const view = Run.viewOf("vault");
    check("the time limit failed it", view.result === "fail" && view.open === false, JSON.stringify(view));

    touch(ada, GOLD);
    check("the gold chest can no longer be bought", coinsOf(ada) === 100 && contents(GOLD).length === 0 && stateOf("Gold") === "armed");
    check("a chest that was already opened still lets her in", Run.interactionDecision(ref(CASH)) === "pass");
    check("the door she opened has not shut yet", doorOpen());
    done();
});

test("whichever comes first is the only outcome: a late alarm, the time limit and an empty area do not undo a success", () => {
    setup({
        alarm: true,
        gold: [WIN],
        settings: { timeLimitSeconds: 30, failWhenEmptySeconds: 5, resetAfterSeconds: 120 },
        hooks: { win: [{ kind: "reward", coins: 100, bounty: 0, to: "outlaws" }], fail: [say("The bank was lost!", "all")] }
    });
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 25);

    touch(ada, SITE.keypad);
    check("won at the door, and the win hook paid once", Run.viewOf("vault").result === "win" && coinsOf(ada) === 125, `${Run.viewOf("vault").result} ${coinsOf(ada)}`);

    touch(ada, GOLD);                           // its own win effect fires a second time
    check("a second win does not pay the win hook again (125 - 25 for the price)", coinsOf(ada) === 100, String(coinsOf(ada)));

    fake.advance(40 * 20);
    check("past the time limit it is still a success", Run.viewOf("vault").result === "win", String(Run.viewOf("vault").result));

    touch(ada, ALARM);                          // pressed on the way out: its effect is "fail"
    check("a late alarm changes nothing", Run.viewOf("vault").result === "win" && !said(ada).some((m) => /The bank was lost/.test(m)), said(ada).join("|"));

    ada.teleport({ ...OUTSIDE });
    fake.advance(10 * 20);
    check("an empty area for longer than the limit changes nothing either", Run.viewOf("vault").result === "win", String(Run.viewOf("vault")?.result));
    check("and it is not put back early", doorOpen());
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The reset waits for people to leave
// ---------------------------------------------------------------------------------------------------------

test("the countdown runs out with a robber still inside: nothing is put back, and what is left can still be worked", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw("Ada", IN_AREA, 25);

    touch(ada, SITE.keypad);
    check("noted for cleanup: both halves of the door and the cash chest", S.dirtyCount() === 3, String(S.dirtyCount()));

    fake.advance(9 * 20);
    check("before the countdown is out nothing is due", Run.viewOf("vault").waitingForPlayers === false && doorOpen());

    pastReset();
    const view = Run.viewOf("vault");
    check("the countdown has run out, but she is inside: the door is still open", doorOpen());
    check("and the chest still holds its gold", contents(CASH).join() === "gold_ingotx4", contents(CASH).join());
    check("the view says it is waiting for her", view.waitingForPlayers === true && view.resetInSeconds === 0 && view.open === true, JSON.stringify(view));

    touch(ada, GOLD);
    check("she can still buy the second chest, well after the countdown", contents(GOLD).join() === "diamondx2" && coinsOf(ada) === 0, `${contents(GOLD).join()} ${coinsOf(ada)}`);

    fake.advance(5 * 60 * 20);
    check("it does not give up on its own, however long she stays", doorOpen() && Run.viewOf("vault").waitingForPlayers === true);

    ada.teleport({ ...OUTSIDE });
    aPass();
    check("the pass after she leaves, the door is shut", doorShut());
    check("every chest is empty again", allEmpty());
    check("nothing is left noted", S.dirtyCount() === 0, String(S.dirtyCount()));
    check("and the run is finished with, so it can start again", Run.viewOf("vault") === undefined);
    done();
});

test("anyone inside holds it, the law included, though an outlaws-only robbery would never let them take part", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const sheriff = lawman("Sheriff", IN_AREA);

    check("the robbery is outlaws-only", S.getRobbery("vault").settings.outlawsOnly === true);

    touch(ada, SITE.keypad);
    ada.teleport({ ...OUTSIDE });
    pastReset();
    check("the robber is gone but the sheriff is standing in the vault: still open", doorOpen() && Run.viewOf("vault").waitingForPlayers === true);

    sheriff.teleport({ ...OUTSIDE });
    aPass();
    check("when the sheriff leaves, it is put back", doorShut() && allEmpty() && Run.viewOf("vault") === undefined);
    done();
});

test("only somebody actually in the area holds it: not another dimension, not just outside the box, not an eliminated spectator", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    const nether = fake.makePlayer("Nether", { location: { ...IN_AREA }, dimension: fake.dimension("nether") });
    state.update(nether, { role: "outlaw" });
    const ghost = fake.makePlayer("Ghost", { tags: ["outlaw", "eliminated"], location: { ...IN_AREA } });
    const pastEdge = outlaw("Edge", { x: SITE.area.max[0] + 1, y: 65, z: 170 });
    const above = outlaw("Above", { x: 100, y: SITE.area.max[1] + 1, z: 170 });
    const beside = outlaw("Beside", { x: 100, y: 65, z: SITE.area.min[2] - 1 });

    check("(the spectator is not 'alive' as the round sees it)", !Players.alivePlayers().includes(ghost) && Players.alivePlayers().includes(ada));

    touch(ada, SITE.keypad);
    ada.teleport({ ...OUTSIDE });
    pastReset();

    check("none of them holds it: the door is shut and the chests are empty", doorShut() && allEmpty() && Run.viewOf("vault") === undefined,
        `${doorShut()} ${allEmpty()} ${JSON.stringify(Run.viewOf("vault"))}`);
    check("nobody was moved or hurt", [nether, ghost, pastEdge, above, beside].every((p) => p.isValid));
    done();
});

test("the last block of the box counts as inside, and so does standing on its far edge", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();
    const edge = outlaw("Edge", { x: SITE.area.max[0] + 0.9, y: SITE.area.max[1] + 0.9, z: SITE.area.max[2] + 0.9 });

    touch(ada, SITE.keypad);
    ada.teleport({ ...OUTSIDE });
    pastReset();
    check("standing on the far corner block holds it", doorOpen());

    edge.teleport({ x: SITE.area.min[0] - 0.1, y: 65, z: 170 });
    aPass();
    check("a step past the near edge does not", doorShut());
    done();
});

test("a robbery with no area has no inside, so it is put back on time", () => {
    setup({ area: false });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    pastReset();
    check("she is standing right there and it is put back anyway", doorShut() && allEmpty() && Run.viewOf("vault") === undefined);
    done();
});

test("a robbery with an area but nobody in it is put back the moment the countdown is out", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    ada.teleport({ ...OUTSIDE });

    fake.advance(10 * 20 - R.janitorEvery - R.tickEvery * 2);
    check("not before", doorOpen());
    fake.advance(R.janitorEvery * 3);
    check("then on time", doorShut() && Run.viewOf("vault") === undefined);
    done();
});

test("the guards wait for the area to empty along with the site", () => {
    setup({ door: [{ kind: "spawn", entity: "minecraft:pillager", count: 2, at: SPOT }, WIN] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    fake.advance(2 * R.spawnGapTicks + R.tickEvery * 2);
    check("two guards came", guards().length === 2, String(guards().length));

    pastReset();
    check("she is inside: the guards are still there and so is the open door", guards().length === 2 && doorOpen(), `${guards().length} ${doorOpen()}`);

    ada.teleport({ ...OUTSIDE });
    aPass();
    check("when she is out they go with the site", guards().length === 0 && doorShut(), `${guards().length} ${doorShut()}`);
    check("and the robbery can start again", Run.viewOf("vault") === undefined);
    done();
});

test("a run that changed no blocks still waits with its guards for the area to empty, and is forgotten only once they are taken", () => {
    setup();
    const { check, done } = checks();

    let r = ok(L.newRobbery("lobby", "The Lobby", "overworld"));
    r = ok(L.setArea(r, SITE.area.min, SITE.area.max));
    r = ok(L.setSettings(r, { failWhenEmptySeconds: 0, timeLimitSeconds: 0, resetAfterSeconds: 10, cooldownSeconds: 0 }));
    r = added(L.addElement(r, { kind: "switch", name: "Panic button", cells: [ALARM], onDone: [{ kind: "spawn", entity: "minecraft:pillager", count: 1, at: SPOT }, WIN] })).robbery;
    assert.equal(S.saveRobbery(r).ok, true);

    const ada = outlaw();
    touch(ada, ALARM);
    check("a guard came and no block was changed", guards().length === 1 && S.dirtyCount() === 0, `${guards().length} ${S.dirtyCount()}`);

    pastReset();
    check("she is inside: the guard stays, and the run is not forgotten", guards().length === 1 && Run.viewOf("lobby")?.waitingForPlayers === true, `${guards().length} ${JSON.stringify(Run.viewOf("lobby"))}`);

    ada.teleport({ ...OUTSIDE });
    aPass();
    check("when she leaves the guard goes and the run is forgotten", guards().length === 0 && Run.viewOf("lobby") === undefined, `${guards().length} ${JSON.stringify(Run.viewOf("lobby"))}`);
    done();
});

test("a run lost to a round reset or a reload leaves its site alone while anyone is inside, then puts it back", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    resetAllSystems();                          // the run is gone; the notes of what it changed are not
    check("no run, but the site is still noted", Run.viewOf("vault") === undefined && S.dirtyCount() === 3, `${S.dirtyCount()}`);

    fake.advance(R.janitorEvery * 3);
    check("she is still standing in the vault: it is left alone", doorOpen() && contents(CASH).length === 1);

    ada.teleport({ ...OUTSIDE });
    aPass();
    check("put back once she is out", doorShut() && allEmpty() && S.dirtyCount() === 0);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The operator is not made to wait
// ---------------------------------------------------------------------------------------------------------

test("stopping a run puts the site back at once, under anyone", () => {
    setup({ door: [], gold: [WIN] });
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    check("under way, the door open", Run.viewOf("vault").phase === "running" && doorOpen());

    check("the stop works", Run.stopRobbery("vault").ok === true);
    check("a stopped run is not open to loot", Run.viewOf("vault").open === false && Run.viewOf("vault").result === "stopped", JSON.stringify(Run.viewOf("vault")));
    aPass();
    check("she is still inside and the door is shut anyway", doorShut() && allEmpty());
    done();
});

test("putting the site back by hand does it now, even when the run is waiting for the area to empty", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    pastReset();
    check("it was waiting on her", Run.viewOf("vault").waitingForPlayers === true && doorOpen());

    const result = Run.resetSiteNow("vault");
    check("put back at once: both halves of the door and the chest", result.cleaned === 3 && result.left === 0 && doorShut() && allEmpty(), JSON.stringify(result));
    check("the run is forgotten", Run.viewOf("vault") === undefined);
    done();
});

test("what a hand reset could not reach goes back as soon as its chunk loads, whoever is inside", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    fake.setUnloaded("overworld", [{ from: { x: CASH[0], y: 0, z: CASH[2] }, to: { x: CASH[0], y: 100, z: CASH[2] } }]);

    const partial = Run.resetSiteNow("vault");
    check("the door (both halves) went back, the chest in the unloaded chunk did not", partial.cleaned === 2 && partial.left === 1 && doorShut(), JSON.stringify(partial));

    fake.setUnloaded("overworld", []);
    aPass();
    check("she is inside and the chest is emptied anyway: the operator asked for it", contents(CASH).length === 0 && S.dirtyCount() === 0, `${contents(CASH).join()} ${S.dirtyCount()}`);
    done();
});

test("an operator's reset does not leak into the next robbery: its site waits for people again", () => {
    setup();
    const { check, done } = checks();
    const ada = outlaw();

    touch(ada, SITE.keypad);
    fake.setUnloaded("overworld", [{ from: { x: CASH[0], y: 0, z: CASH[2] }, to: { x: CASH[0], y: 100, z: CASH[2] } }]);
    Run.resetSiteNow("vault");
    fake.setUnloaded("overworld", []);
    aPass();
    check("the first robbery is fully put back", S.dirtyCount() === 0 && Run.viewOf("vault") === undefined);

    touch(ada, SITE.keypad);                    // a second robbery, with her still inside
    pastReset();
    check("this time it waits for her", doorOpen() && Run.viewOf("vault").waitingForPlayers === true);

    // Leave the world clean: a held site left behind would be carried into the next test by the store's memory.
    ada.teleport({ ...OUTSIDE });
    aPass();
    check("and goes back when she leaves", doorShut() && S.dirtyCount() === 0 && Run.viewOf("vault") === undefined);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// What the builder reads
// ---------------------------------------------------------------------------------------------------------

test("the words for a run: running, won and open, won and waiting, failed, stopped", () => {
    const { check, done } = checks();
    const text = (over) => Run.runStateText({ id: "vault", phase: "ended", result: "win", test: false, elapsedSeconds: 1, resetInSeconds: 5, open: true, waitingForPlayers: false, elements: [], ...over });

    check("running", text({ phase: "running", result: undefined, resetInSeconds: undefined }) === "running");
    check("won and still open", text({}) === "won, still open to loot", text({}));
    check("won and waiting for people to leave", text({ waitingForPlayers: true }) === "won, still open to loot, waiting for everyone to leave", text({ waitingForPlayers: true }));
    check("failed", text({ result: "fail", open: false }) === "failed", text({ result: "fail", open: false }));
    check("failed and waiting", text({ result: "fail", open: false, waitingForPlayers: true }) === "failed, waiting for everyone to leave");
    check("stopped", text({ result: "stopped", open: false }) === "stopped");
    check("cut short by a round", text({ result: "round", open: false }) === "cut short");
    done();
});

test("the run screen tells a builder what a robbery is doing: open to loot, how long, and who it is waiting for", async () => {
    setup();
    const { check, done } = checks();
    const ann = fake.makePlayer("Ann", { location: { ...OUTSIDE }, permission: 2 });
    const ada = outlaw();

    E.select(ann, "vault");
    touch(ada, SITE.keypad);
    check("(the robbery is there to look at)", Run.viewOf("vault")?.result === "win", `${JSON.stringify(Run.viewOf("vault"))} bar: ${bar(ada).join("|")}`);

    const body = () => strip(ui.shown.find((form) => /run it/.test(strip(titleOf(form))))?.calls.find((c) => c[0] === "body")?.[1] ?? "");

    script(press("Run it"), press("Back"), close);
    await F.openMainMenu(ann);
    check("a success says so, and when the site goes back", /Right now: won, still open to loot, put back in 0:\d\d/.test(body()), body());
    check("the screen can stop a run only while it is running", !ui.shown.some((form) => /run it/.test(strip(titleOf(form))) && form.calls.some((c) => c[0] === "button" && /Stop it/.test(strip(String(c[1]))))));

    pastReset();
    ui.responses.length = 0;
    ui.shown.length = 0;
    script(press("Run it"), press("Back"), close);
    await F.openMainMenu(ann);
    check("with a robber inside it says it is waiting for them, and gives no time", /Right now: won, still open to loot, waiting for everyone to leave$/.test(body()), body());
    check("nothing went wrong in the stand-in", problems.length === 0, problems.join("\n"));

    ada.teleport({ ...OUTSIDE });               // leave the world clean for whatever test comes next
    aPass();
    done();
});
