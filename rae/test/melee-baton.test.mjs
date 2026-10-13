import { test } from "node:test";
import { checks, load, fakeApi } from "./helpers.mjs";
import { MELEE, fake, fresh, hit, dies, armed, resetMelee, debug, lines, meleeLines } from "./melee-fixtures.mjs";

// The baton's stun (tasks/melee/plan.md, Task 5): a baton hit has a 25% chance to stun its target for half a second, 10 ticks: slowness
// at its largest on anything, and for a player a movement lock as well. A stun is not refreshed while it lasts, always ends (even if the
// target dies or leaves), and never lets go of a player the start sequence is holding. Whether slowness 255 and the lock really stop a
// player in the real game is for docs/test-cards/MELEE.md.

const { InputPermissionCategory } = fakeApi;
const { stunnedNow } = await load("core/melee.js");
const { previewShot } = await load("core/startsequence.js");
const round = await load("core/round.js");

const B = MELEE.baton;
const mob = () => fake.makeEntity({ typeId: "minecraft:pillager" });
const moving = (player) => player.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement);
const slowness = (entity) => entity.effects.filter((e) => e.id === "slowness");

/** Runs `body` with the dice rigged: Math.random answers `roll`. */
function withDice(roll, body) {
    const real = Math.random;
    Math.random = () => roll;
    try { return body(); } finally { Math.random = real; }
}

const strike = (target, roll = 0, options = {}) => withDice(roll, () => hit({ attacker: options.attacker ?? armed("Baton", "baton"), target, damage: 1, ...options }));

const SHOT = { version: 1, id: "s1", name: "One", start: { x: 0, y: 70, z: 0, pitch: 0, yaw: 0 }, end: { x: 10, y: 70, z: 10, pitch: 0, yaw: 0 } };

test("the stun is on the table: a quarter of hits, half a second, the largest slowness", () => {
    const { check, done } = checks();
    check("a quarter", B.stunChance === 0.25);
    check("10 ticks", B.stunTicks === 10);
    check("slowness at 255", B.slownessAmplifier === 255);
    done();
});

test("with the dice at 0 the stun applies; at 0.25 and above it does not", () => {
    const { check, done } = checks();
    fresh();
    const a = mob(); strike(a, 0);
    check("0: stunned", slowness(a).length === 1);
    check("0.2499: stunned", (() => { const t = mob(); strike(t, 0.2499); return slowness(t).length === 1; })());
    check("0.25: not", (() => { const t = mob(); strike(t, 0.25); return slowness(t).length === 0; })());
    check("0.5: not", (() => { const t = mob(); strike(t, 0.5); return slowness(t).length === 0; })());
    check("0.9999: not", (() => { const t = mob(); strike(t, 0.9999); return slowness(t).length === 0; })());
    done();
});

test("a stun is slowness at its largest for exactly 10 ticks, without particles", () => {
    const { check, done } = checks();
    fresh();
    const target = mob();
    strike(target);
    const effect = slowness(target)[0];
    check("the effect", effect !== undefined);
    check("for 10 ticks", effect?.duration === 10, String(effect?.duration));
    check("at 255", effect?.amplifier === 255, String(effect?.amplifier));
    check("no particles", effect?.showParticles === false);
    check("one target stunned", stunnedNow() === 1);
    fake.advance(9);
    check("still stunned a tick before the end", stunnedNow() === 1);
    fake.advance(1);
    check("let go at 10 ticks", stunnedNow() === 0);
    done();
});

test("a player is also locked in place, for the same 10 ticks, and gets their movement back", () => {
    const { check, done } = checks();
    fresh();
    const victim = fake.makePlayer("Victim");
    check("free to start with", moving(victim));
    strike(victim);
    check("locked", !moving(victim));
    check("slowed", slowness(victim).length === 1);
    fake.advance(9);
    check("still locked a tick before the end", !moving(victim));
    fake.advance(1);
    check("free again at 10 ticks", moving(victim));
    done();
});

test("a mob is not locked (only a player has input to lock)", () => {
    const { check, done } = checks();
    fresh();
    const target = mob();
    let touched = false;
    target.inputPermissions = { setPermissionCategory() { touched = true; } };
    strike(target);
    fake.advance(20);
    check("no lock call", !touched);
    done();
});

test("a second stun while one lasts is ignored; one after it ends works", () => {
    const { check, done } = checks();
    fresh();
    const target = mob();
    strike(target);
    fake.advance(5);
    strike(target);
    check("one effect only", slowness(target).length === 1, String(slowness(target).length));
    fake.advance(5);
    check("the first one ended on time, not extended by the second hit", stunnedNow() === 0);
    strike(target);
    check("a hit after it ended stuns again", slowness(target).length === 2);
    done();
});

test("a target that dies while stunned is let go at once; one that leaves leaves nothing odd behind", () => {
    const { check, done } = checks();
    fresh();

    const victim = fake.makePlayer("Victim");
    strike(victim);
    check("locked", !moving(victim));
    dies(victim, undefined);
    check("its death ends the stun and frees the input at once", stunnedNow() === 0 && moving(victim), `${stunnedNow()} ${moving(victim)}`);
    check("and takes the slowness off", slowness(victim).length === 0);
    lines.length = 0;

    const leaver = fake.makePlayer("Leaver");
    strike(leaver);
    leaver.remove();
    let threw = false;
    try { fake.advance(20); } catch { threw = true; }
    check("a player who left: nothing thrown, nothing kept, nothing reported", !threw && stunnedNow() === 0 && lines.length === 0, lines.join(" | "));

    const slain = mob();
    strike(slain);
    slain.remove();
    dies(slain, undefined);
    check("a mob whose handle is already gone when its death is announced: let go, nothing reported", stunnedNow() === 0 && lines.length === 0, lines.join(" | "));

    const gone = mob();
    strike(gone);
    gone.remove();
    try { fake.advance(20); } catch { threw = true; }
    check("a mob that was removed: the same", !threw && stunnedNow() === 0 && lines.length === 0, lines.join(" | "));
    done();
});

test("a round reset ends every stun at once: effect gone, input back", () => {
    const { check, done } = checks();
    fresh();
    const victim = fake.makePlayer("Victim");
    const target = mob();
    strike(victim);
    strike(target);
    check("two stunned", stunnedNow() === 2);
    resetMelee();
    check("none after the reset", stunnedNow() === 0);
    check("the player moves again", moving(victim));
    check("the slowness is taken off both", slowness(victim).length === 0 && slowness(target).length === 0);
    fake.advance(20);
    check("and the old timers change nothing", moving(victim) && stunnedNow() === 0);
    done();
});

test("a slowness the engine will not take off is reported once, and the player still gets their input back", () => {
    const { check, done } = checks();
    fresh();
    const victim = fake.makePlayer("Victim");
    strike(victim);
    victim.removeEffect = () => { throw new Error("the engine refused"); };
    let threw = false;
    try { resetMelee(); } catch { threw = true; }
    check("nothing thrown", !threw);
    check("one report naming it", meleeLines().length === 1 && /ending a stun failed: the engine refused/.test(meleeLines()[0]), meleeLines().join(" | "));
    check("the input is back all the same", moving(victim) && stunnedNow() === 0);
    done();
});

test("a reset followed by a new stun is not cut short by the old stun's timer", () => {
    const { check, done } = checks();
    fresh();
    const victim = fake.makePlayer("Victim");
    strike(victim);
    fake.advance(4);
    resetMelee();
    strike(victim);
    fake.advance(6);
    check("the new stun is still on when the old timer would have fired", stunnedNow() === 1 && !moving(victim));
    fake.advance(4);
    check("and ends on its own time", stunnedNow() === 0 && moving(victim));
    done();
});

test("no stun while a start is under way", () => {
    const { check, done } = checks();
    fresh();
    round.resetRound();
    round.startRound();
    const phase = round.getPhase();
    const victim = fake.makePlayer("Victim");
    const target = mob();
    strike(victim);
    strike(target);
    const seen = { stunned: stunnedNow(), slowed: slowness(victim).length + slowness(target).length, moving: moving(victim) };
    round.resetRound();

    check("the round is in its set-up", phase === "SETUP", phase);
    check("nobody was stunned", seen.stunned === 0 && seen.slowed === 0, JSON.stringify(seen));
    check("and nobody was locked", seen.moving);
    done();
});

test("a stun's end never releases a player the start sequence is holding", () => {
    const { check, done } = checks();
    fresh();
    round.resetRound();

    const stunnedFirst = fake.makePlayer("First");
    strike(stunnedFirst);
    previewShot(stunnedFirst, SHOT);                       // the sequence takes hold of them while the stun runs
    fake.advance(10);
    check("stunned, then held: the stun ends but they stay locked", stunnedNow() === 0 && !moving(stunnedFirst));

    const heldFirst = fake.makePlayer("Second");
    previewShot(heldFirst, SHOT);
    strike(heldFirst);
    fake.advance(10);
    check("held, then stunned: the stun ends but they stay locked", stunnedNow() === 0 && !moving(heldFirst));

    round.resetRound();
    check("and the sequence's own reset still lets them go", moving(stunnedFirst) && moving(heldFirst));
    done();
});

test("only a baton hit that landed stuns: other weapons, fists, and a hit that dealt nothing never do", () => {
    const { check, done } = checks();
    fresh();
    const target = mob();
    for (const weapon of ["knife", "machete", "axe", "sledgehammer"]) strike(target, 0, { attacker: armed(`P-${weapon}`, weapon) });
    strike(target, 0, { attacker: fake.makePlayer("Fist") });
    strike(target, 0, { dealt: 0 });
    strike(target, 0, { cause: "override" });
    check("nothing stunned", slowness(target).length === 0 && stunnedNow() === 0, String(slowness(target).length));

    const gone = mob();
    gone.remove();
    let threw = false;
    try { strike(gone); } catch { threw = true; }
    check("a target already removed: no exception, no stun", !threw && stunnedNow() === 0);
    done();
});

test("an effect the engine refuses is reported once, and leaves no stun and no lock behind", () => {
    const { check, done } = checks();
    fresh();
    const victim = fake.makePlayer("Victim");
    victim.addEffect = () => { throw new Error("the engine refused"); };
    let threw = false;
    try { strike(victim); strike(victim); } catch { threw = true; }
    check("no exception", !threw);
    check("one report, from the stun itself, naming the cause", meleeLines().length === 1 && /a stun failed: the engine refused/.test(meleeLines()[0]), meleeLines().join(" | "));
    check("no stun is kept and the input is free", stunnedNow() === 0 && moving(victim));
    done();
});

test("with rae:melee_debug on, a stun and a refused stun are logged", () => {
    const { check, done } = checks();
    fresh();
    debug(true);
    const target = mob();
    lines.length = 0;
    strike(target);
    check("the stun is logged", meleeLines().some((l) => /stun/.test(l) && /minecraft:pillager/.test(l) && /10 ticks/.test(l)), meleeLines().join(" | "));
    lines.length = 0;
    strike(target);
    check("so is the one that was ignored", meleeLines().some((l) => /stun/.test(l) && /already/.test(l)), meleeLines().join(" | "));
    done();
});
