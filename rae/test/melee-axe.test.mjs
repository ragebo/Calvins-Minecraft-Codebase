import { test } from "node:test";
import { checks, load, world, system } from "./helpers.mjs";
import { MELEE, fake, fresh, hit, armed, resetMelee, debug, lines, meleeLines } from "./melee-fixtures.mjs";

// The axe (tasks/melee/plan.md, Task 6): a swing hits every living thing within 3 blocks that is within 90 degrees of where the wielder looks
// (a half circle in front of them), 6 damage each as its own hit, then a one-second cooldown. A click that hits something and the swing
// the game also reports for it are ONE attack. The swing is looked at a tick after it arrives, because the hit that goes with it may come
// in the same tick, and the game's own hit on the target in front is kept (it is the one with the knockback) while the sweep takes the rest.
// How the real game orders those events, and whether it honors a cancel, is for docs/test-cards/MELEE.md.

const A = MELEE.axe;
const AXE_DAMAGE = MELEE.weapons.axe.damage;

/** A mob at an offset from the wielder (who stands at the origin facing +Z), alive with 20 health. */
function mob(x, z, options = {}) {
    const entity = fake.makeEntity({ typeId: options.typeId ?? "minecraft:pillager", location: { x, y: 64, z } });
    if (options.alive !== false && !options.noHealth) {
        entity.getComponent = (id) => id === "minecraft:health" ? { currentValue: options.hp ?? 20, effectiveMax: 20 } : undefined;
    }
    return entity;
}

const amounts = (entity) => entity.damage.map((d) => d.amount);

/** Makes an entity announce each hit it takes as a hurt event, the way the real engine is expected to for a script's damage. Returns what was announced. */
function announcing(entity) {
    const announced = [];
    entity.applyDamage = (amount, options) => {
        entity.damage.push({ amount, ...options });
        announced.push(hit({ attacker: options.damagingEntity, target: entity, damage: 1 }));
        return true;
    };
    return announced;
}
const wielder = (name = "Axeman", at = { x: 0, y: 64, z: 0 }) => {
    const player = fake.makePlayer(name, { holding: MELEE.weapons.axe.id, location: at });
    player.facing = { x: 0, y: 0, z: 1 };
    return player;
};
const swing = (player, source = "Attack") => world.afterEvents.playerSwingStart.emit({ swingSource: source, heldItemStack: { typeId: player.holding }, player });
const sweepOf = (player) => { swing(player); fake.advance(A.swingDelayTicks); };

test("the axe is on the table: three blocks, a half circle, a second, a tick to look", () => {
    const { check, done } = checks();
    check("3 blocks", A.reach === 3);
    check("90 degrees either side", A.coneHalfAngleDegrees === 90);
    check("20 ticks", A.cooldownTicks === 20);
    check("a swing is the same attack as a hit within 2 ticks", A.sameAttackTicks === 2);
    check("a swing is looked at 1 tick after it arrives", A.swingDelayTicks === 1);
    done();
});

test("a swing at the air sweeps everything in front within reach, each for the axe's 6", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const front = mob(0, 2), right = mob(2, 0), left = mob(-2, 0), diagonal = mob(1.5, 1.5);
    const behind = mob(0, -2), farAhead = mob(0, 3.5), behindRight = mob(2, -0.5);

    sweepOf(player);
    check("in front", JSON.stringify(amounts(front)) === `[${AXE_DAMAGE}]`, JSON.stringify(amounts(front)));
    check("to the right (exactly 90 degrees counts)", amounts(right).length === 1);
    check("to the left (exactly 90 degrees counts)", amounts(left).length === 1);
    check("diagonally ahead", amounts(diagonal).length === 1);
    check("behind: not hit", amounts(behind).length === 0);
    check("out of reach: not hit", amounts(farAhead).length === 0);
    check("behind to the right: not hit", amounts(behindRight).length === 0);
    check("each hit is an ordinary attack naming the wielder", front.damage[0]?.cause === "entityAttack" && front.damage[0]?.damagingEntity === player, JSON.stringify(front.damage[0]));
    done();
});

test("reach is measured in three dimensions and a boundary is decided one way", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const exactly = mob(0, 3), barely = mob(0, 3.01), high = mob(0, 2, {}), tall = mob(0, 1);
    high.location = { x: 0, y: 64 + 2.5, z: 2 };       // about 3.2 blocks away once the height counts
    tall.location = { x: 0, y: 64 + 2.5, z: 1 };

    sweepOf(player);
    check("exactly 3 blocks away is in reach", amounts(exactly).length === 1);
    check("a hair further is not", amounts(barely).length === 0);
    check("height counts toward the distance (2.5 up and 2 ahead is out)", amounts(high).length === 0);
    check("and 2.5 up and 1 ahead (2.7 away) is in", amounts(tall).length === 1);
    done();
});

test("the sweep follows where the wielder looks: facing east, the east is the front", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    player.facing = { x: 1, y: 0, z: 0 };
    const east = mob(2, 0), west = mob(-2, 0);
    sweepOf(player);
    check("east is hit", amounts(east).length === 1);
    check("west is not", amounts(west).length === 0);

    resetMelee();
    const looking = wielder("Looker");
    looking.facing = { x: 0, y: -1, z: 0 };            // straight down: no direction to measure, so all around counts
    const near = mob(1, 1), nearBehind = mob(-1, -1);
    sweepOf(looking);
    check("looking straight down sweeps all around", amounts(near).length === 1 && amounts(nearBehind).length === 1);
    done();
});

test("things that are not living, the wielder, and anything that cannot be hurt are skipped", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const dropped = mob(0, 1, { typeId: "minecraft:item", noHealth: true });
    const frame = mob(0, 1.5, { typeId: "minecraft:item_frame", noHealth: true });
    const dead = mob(0, 2, { hp: 0 });
    const alive = mob(0, 2.5);
    const creative = fake.makePlayer("Creative", { location: { x: 0.5, y: 64, z: 1 } });
    creative.getGameMode = () => "Creative";
    const spectator = fake.makePlayer("Spectator", { location: { x: -0.5, y: 64, z: 1 } });
    spectator.getGameMode = () => "Spectator";
    const survivor = fake.makePlayer("Survivor", { location: { x: 0, y: 64, z: 1.2 } });

    const dim = fake.dimension("overworld");
    const realGet = dim.getEntities;
    dim.getEntities = (options) => [...realGet(options), ...fake.players];                // the engine's list includes players
    try { sweepOf(player); } finally { dim.getEntities = realGet; }

    check("a dropped item", amounts(dropped).length === 0);
    check("an item frame (no health)", amounts(frame).length === 0);
    check("a dead one", amounts(dead).length === 0);
    check("the wielder", player.damage.length === 0);
    check("a creative player", creative.damage.length === 0);
    check("a spectator", spectator.damage.length === 0);
    check("a living mob is hit", amounts(alive).length === 1);
    check("a survival player is hit", amounts(survivor).length === 1, JSON.stringify(amounts(survivor)));
    done();
});

test("a click that hits something is one attack: the game's own hit takes 6, the sweep takes the rest, and the swing that goes with it adds nothing", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const primary = mob(0, 2), other = mob(1, 1), behind = mob(0, -2);

    swing(player);                                                              // the swing event arrives with the click ...
    const event = hit({ attacker: player, target: primary, damage: 1 });         // ... and so does the hit, in the same tick
    fake.advance(A.swingDelayTicks + 3);

    check("the game's hit is set to 6", event.damage === AXE_DAMAGE && event.cancel === false, `${event.damage} ${event.cancel}`);
    check("the sweep did not hit the primary again (the game's own hit is its 6)", amounts(primary).length === 0, JSON.stringify(amounts(primary)));
    check("the sweep hit the other one in the cone, once", JSON.stringify(amounts(other)) === `[${AXE_DAMAGE}]`, JSON.stringify(amounts(other)));
    check("and not the one behind", amounts(behind).length === 0);
    done();
});

test("a hit that comes after the swing's own sweep is not doubled: the sweep already dealt it, so the game's hit is cancelled", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const primary = mob(0, 2);
    announcing(primary);                                      // the engine reports the sweep's own hit as a hurt, so that flag is used up at once

    swing(player);
    fake.advance(A.swingDelayTicks);                          // the sweep ran: the primary took its 6
    check("the primary took the sweep's 6", JSON.stringify(amounts(primary)) === `[${AXE_DAMAGE}]`);
    const late = hit({ attacker: player, target: primary, damage: 1 });
    check("the same click's hit, arriving late, is cancelled", late.cancel === true);

    const behind = mob(0, -2);
    const second = hit({ attacker: player, target: behind, damage: 1 });          // behind: the sweep did not reach it, so it is dealt once
    check("a target the sweep did not reach still takes the hit, at 6", second.cancel === false && second.damage === AXE_DAMAGE, `${second.cancel} ${second.damage}`);
    const again = hit({ attacker: player, target: behind, damage: 1 });
    check("and a second hit on it in the same click is cancelled", again.cancel === true);

    const newcomer = mob(0, 1);
    hit({ attacker: player, target: mob(0, -2.5), damage: 1 });
    fake.advance(2);
    check("one sweep per click: something that stepped into the cone since is left alone", amounts(newcomer).length === 0, JSON.stringify(amounts(newcomer)));
    done();
});

test("the sweep asks the engine for what is within reach of the wielder's feet", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder("Axeman", { x: 4, y: 70, z: -3 });
    const dim = fake.dimension("overworld");
    const realGet = dim.getEntities;
    const asked = [];
    dim.getEntities = (options) => { asked.push(options); return realGet(options); };
    try { sweepOf(player); } finally { dim.getEntities = realGet; }

    check("one query", asked.length === 1, String(asked.length));
    check("centered on the wielder", JSON.stringify(asked[0]?.location) === JSON.stringify({ x: 4, y: 70, z: -3 }), JSON.stringify(asked[0]?.location));
    check("as far as the axe reaches", asked[0]?.maxDistance === A.reach, String(asked[0]?.maxDistance));
    done();
});

test("a round reset forgets a sweep's flags too: the click after it begins an attack like any other", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const primary = mob(0, 2), other = mob(1, 1);
    sweepOf(player);                                         // flags are left for primary and other: the fake never announces the sweep's hits
    resetMelee();
    fake.advance(1);

    const click = hit({ attacker: player, target: primary, damage: 1 });
    fake.advance(1);
    check("a click on a flagged target begins an attack (the hit is set to 6)", click.cancel === false && click.damage === AXE_DAMAGE);
    check("and sweeps the other one in the cone", amounts(other).length === 2, JSON.stringify(amounts(other)));
    done();
});

test("a second swing inside the cooldown does nothing but say how long is left; after it, the axe works again", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const target = mob(0, 2);

    sweepOf(player);
    check("the first swing hit", amounts(target).length === 1);

    fake.advance(8);
    swing(player);
    fake.advance(A.swingDelayTicks);
    check("a swing 10 ticks after: nothing", amounts(target).length === 1, JSON.stringify(amounts(target)));
    check("the action bar says how long is left (11 ticks: 0.6 seconds)", player.actionBar.some((line) => /0\.6/.test(line)), JSON.stringify(player.actionBar));

    fake.advance(8);
    swing(player);
    fake.advance(A.swingDelayTicks);
    check("19 ticks after the first: still cooling", amounts(target).length === 1);

    fake.advance(2);
    sweepOf(player);
    check("past the second: it works again", amounts(target).length === 2, JSON.stringify(amounts(target)));
    done();
});

test("a hit during the cooldown is cancelled in the hurt hook, with the time left on the action bar", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const first = mob(0, 2);
    const second = mob(0, -2);

    sweepOf(player);
    fake.advance(10);
    const blocked = hit({ attacker: player, target: second, damage: 1 });
    check("cancelled", blocked.cancel === true);
    fake.advance(1);
    check("the player is told how long is left (10 ticks: 0.5 seconds)", player.actionBar.some((line) => /Axe/.test(line) && /0\.5/.test(line)), JSON.stringify(player.actionBar));
    check("no damage was dealt by it", amounts(second).length === 0 && amounts(first).length === 1);

    fake.advance(20);
    const allowed = hit({ attacker: player, target: second, damage: 1 });
    check("after the cooldown the hit is allowed again, at 6", allowed.cancel === false && allowed.damage === AXE_DAMAGE);
    done();
});

test("the cooldown is each player's own, and a round reset clears it", () => {
    const { check, done } = checks();
    fresh();
    const ada = wielder("Ada");
    const bo = wielder("Bo", { x: 20, y: 64, z: 0 });
    const nearAda = mob(0, 2);
    const nearBo = mob(20, 2);

    sweepOf(ada);
    sweepOf(bo);
    check("both axes swung in the same tick, each sweeping its own", amounts(nearAda).length === 1 && amounts(nearBo).length === 1);

    fake.advance(5);
    resetMelee();
    sweepOf(ada);
    check("a reset gave the cooldown back", amounts(nearAda).length === 2, JSON.stringify(amounts(nearAda)));
    done();
});

test("only a left-click swing with an axe in hand sweeps", () => {
    const { check, done } = checks();
    fresh();
    const target = mob(0, 2);
    const player = wielder();

    for (const source of ["Mine", "Interact", "Use", "Place", "None"]) { swing(player, source); fake.advance(A.swingDelayTicks); }
    check("other kinds of swing do nothing", amounts(target).length === 0);

    const knife = armed("Knifer", "knife");
    knife.location = { x: 0, y: 64, z: 0 };
    sweepOf(knife);
    const fist = fake.makePlayer("Fist", { location: { x: 0, y: 64, z: 0 } });
    sweepOf(fist);
    check("another weapon or a fist does nothing", amounts(target).length === 0);

    swing(player);
    player.holding = "minecraft:stick";                       // swapped away before the swing is looked at
    fake.advance(A.swingDelayTicks);
    check("an axe put away in the tick between does nothing", amounts(target).length === 0);

    const gone = wielder("Gone");
    swing(gone);
    gone.remove();
    let threw = false;
    try { fake.advance(A.swingDelayTicks); } catch { threw = true; }
    check("a wielder who left in the tick between: nothing thrown, nothing dealt", !threw && amounts(target).length === 0);
    done();
});

test("the sweep's own hits are not mistaken for clicks: an engine that announces them as hurts neither cancels nor repeats them", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const targets = [mob(0, 2), mob(1, 1), mob(-1, 1)];
    const announced = targets.map((target) => announcing(target));

    sweepOf(player);
    fake.advance(10);
    const events = announced.flat();
    check("each target took exactly one 6", targets.every((t) => JSON.stringify(amounts(t)) === `[${AXE_DAMAGE}]`), targets.map((t) => JSON.stringify(amounts(t))).join(" "));
    check("none of the announced hurts was cancelled", events.length === 3 && events.every((e) => e.cancel === false), events.map((e) => e.cancel).join());
    check("each was set to 6", events.every((e) => e.damage === AXE_DAMAGE));
    done();
});

test("a sweep's flag does not outlive the tick it was for: a click in the cooldown that follows is still cancelled", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const target = mob(0, 2);                                  // the engine never announces the sweep's hit as a hurt here
    sweepOf(player);
    fake.advance(6);
    const click = hit({ attacker: player, target, damage: 1 });
    check("cancelled all the same", click.cancel === true);
    done();
});

test("if the game ignores a cancel and reports the hurt anyway, one warning says so, once", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const target = mob(0, -2);
    sweepOf(player);
    fake.advance(10);

    hit({ attacker: player, target, damage: 1, cause: "entityAttack", afterToo: false });
    world.afterEvents.entityHurt.emit({ damage: 3, hurtEntity: target, damageSource: { cause: "entityAttack", damagingEntity: player } });
    check("one warning", meleeLines().length === 1 && /cancel/.test(meleeLines()[0]), meleeLines().join(" | "));

    fake.advance(2);
    hit({ attacker: player, target, damage: 1, afterToo: false });
    world.afterEvents.entityHurt.emit({ damage: 3, hurtEntity: target, damageSource: { cause: "entityAttack", damagingEntity: player } });
    check("never again", meleeLines().length === 1, meleeLines().join(" | "));
    done();
});

test("a sweep the engine will not even let begin (the wielder cannot be read) is reported once and never thrown", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const target = mob(0, 2);
    player.getViewDirection = () => { throw new Error("the engine refused"); };
    let threw = false;
    try { sweepOf(player); } catch { threw = true; }
    check("nothing thrown", !threw);
    check("one report naming the sweep and the cause", meleeLines().length === 1 && /an axe sweep failed: the engine refused/.test(meleeLines()[0]), meleeLines().join(" | "));
    check("nothing was hurt", amounts(target).length === 0);
    done();
});

test("a target the engine refuses to hurt is reported once and does not stop the rest of the sweep", () => {
    const { check, done } = checks();
    fresh();
    const player = wielder();
    const broken = mob(0, 1), fine = mob(0, 2);
    broken.applyDamage = () => { throw new Error("the engine refused"); };
    sweepOf(player);
    check("the other target was hit", amounts(fine).length === 1);
    check("one report naming the cause", meleeLines().length === 1 && /the engine refused/.test(meleeLines()[0]), meleeLines().join(" | "));
    done();
});

test("with rae:melee_debug on, a sweep and a cooldown are logged", () => {
    const { check, done } = checks();
    fresh();
    debug(true);
    const player = wielder();
    mob(0, 2); mob(1, 1);

    lines.length = 0;
    sweepOf(player);
    check("the sweep says how many it hit", meleeLines().some((l) => /axe/.test(l) && /swept 2/.test(l)), meleeLines().join(" | "));

    lines.length = 0;
    fake.advance(5);
    sweepOf(player);
    check("a swing in the cooldown says how long is left", meleeLines().some((l) => /axe/.test(l) && /cooling/.test(l)), meleeLines().join(" | "));
    done();
});
