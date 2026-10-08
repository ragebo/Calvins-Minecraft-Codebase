import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, world, load, checks, strip } from "./helpers.mjs";
import { buttonsOf, close, fill, press, problems, script, titleOf, ui } from "./robbery-ui.mjs";
import { L, SITE, at, buildSite, ok, added, say } from "./robbery-fixtures.mjs";

// Tellers: an NPC or villager a builder bound to a robbery, who is held up by keeping a gun AIMED at it for a few seconds. A hold-up
// is a touch of the teller's element, so it can start the robbery, open a vault door that waits for it, pay out and spawn guards.
// What the REAL game does with the aim ray on an NPC or a villager, and with a cancelled click on a villager, is unmeasured:
// docs/test-cards/ROBBERY-TELLER.md is what measures it.

const { PlayerPermissionLevel } = fakeApi;
const S = await load("core/robberystore.js");
const E = await load("core/robberyedit.js");
const F = await load("core/robberyforms.js");
const Run = await load("core/robberyrun.js");
const T = await load("core/robberyteller.js");
const Aim = await load("core/aim.js");
const M = await load("logic/robberymeta.js");
const state = await load("core/state.js");
const configoverrides = await load("core/configoverrides.js");
const { resetAllSystems } = await load("core/registry.js");
await load("systems/robberyrun.js");
await load("systems/robberyteller.js");
await load("systems/shoptalk.js");
const { ROBBERY: R } = await load("config/balance.js");

const overworld = fake.dimension("overworld");

const TELLER = [100, 65, 172];                            // the block its feet are in
const STAND = { x: 100.5, y: 65, z: 168.5 };              // where the robber stands, inside the area
const REVOLVER = "bountysys:revolver";

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

/**
 * The bank: a teller (done when held up), a vault door that waits for the teller, and a safe that waits for the door and wins.
 * `onDone` and `holdSeconds` change what the teller does; `req` gives it something to wait for.
 */
function bankWithTeller({ holdSeconds = 2, onDone, req = [] } = {}) {
    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    r = ok(L.setArea(r, SITE.area.min, SITE.area.max));
    const teller = added(L.addElement(r, {
        kind: "teller", name: "Teller", cells: [TELLER], holdSeconds, req,
        onDone: onDone ?? [say("Take it! Take it all!", "actor"), { kind: "reward", coins: 0, bounty: 100, to: "actor" }]
    }));
    r = teller.robbery;
    const door = added(L.addElement(r, { kind: "door", name: "Vault door", cells: [SITE.doorLow, SITE.doorHigh], req: [teller.element.id] }));
    r = door.robbery;
    // The safe has a lock: an element that only waits opens by itself the moment what it waits for is done, and this one must stay armed.
    r = added(L.addElement(r, { kind: "switch", name: "Safe", cells: [SITE.keypad], req: [door.element.id], locks: [{ kind: "key", item: "minecraft:iron_pickaxe", consume: false }], onDone: [{ kind: "end", result: "win" }] })).robbery;
    return { r, teller: teller.element };
}

function setup(options) {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    ui.responses.length = 0;
    ui.shown.length = 0;
    problems.length = 0;
    R.holdUpNeedsAim = true;
    fake.addObjective("coins");
    fake.addObjective("bounty");
    buildSite();
    const built = bankWithTeller(options);
    assert.equal(S.saveRobbery(built.r).ok, true);
    return built;
}

/** An NPC standing in the teller's spot, marked as the teller of the element. */
function npcFor(element, where = { x: 100.5, y: 65, z: 172.5 }) {
    const npc = fake.makeEntity({ typeId: "minecraft:npc", location: where, dimension: overworld });
    T.markTeller(npc, { robbery: "bank", element: element.id });
    return npc;
}

function robber(name = "Ada", role = "outlaw") {
    const player = fake.makePlayer(name, { location: { ...STAND }, inventory: true });
    // The fake hands out the same ids again after a reset, and who is aiming is module state: a test starts with nobody aiming.
    Aim.noteAiming(player.id, undefined);
    state.update(player, { role });
    return player;
}

/** Points the player's gun at the entity: the aim is on record and the entity is in their view. */
function aimAt(player, entity) {
    Aim.noteAiming(player.id, REVOLVER);
    player.aimEntities = entity ? [entity] : [];
}

const elementState = (name) => Run.viewOf("bank")?.elements.find((e) => e.name === name)?.state;
const said = (player) => player.messages.map(strip);
const bar = (player) => player.actionBar.map(strip);
const denials = (player) => player.privateSounds.filter((s) => s.id === R.cues.denied.id).length;
const openBit = (pos) => fake.blockAt("overworld", at(pos)).permutation.getState("open_bit");
const seconds = (n) => n * 20;

// ---------------------------------------------------------------------------------------------------------
// The element as data
// ---------------------------------------------------------------------------------------------------------

test("a teller is one block with a hold-up time, and is saved and read back exactly", () => {
    const { check, done } = checks();

    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    r = added(L.addElement(r, { kind: "teller", name: "Teller", cells: [TELLER], holdSeconds: 3, onDone: [say("Hands up!", "area")] })).robbery;
    r = added(L.addElement(r, { kind: "teller", name: "Manager", cells: [[101, 65, 172]] })).robbery;

    const saved = L.serialize(r);
    const back = L.parse(saved);

    check("it reads back as it was", back.ok === true && JSON.stringify(back.value) === JSON.stringify(r), saved.slice(0, 220));
    check("with its time", back.ok && back.value.elements[0].holdSeconds === 3);
    check("a teller made without a time gets the default", back.ok && back.value.elements[1].holdSeconds === R.defaultHoldSeconds);
    check("it is saved in the short form", /"k":"tl"/.test(saved) && /"hs":3/.test(saved), saved);
    check("and teller is one of the kinds", L.ELEMENT_KINDS.includes("teller") && L.kindLabel("teller") === "Teller");
    done();
});

test("a teller that makes no sense is refused with a sentence", () => {
    const { check, done } = checks();
    const base = ok(L.newRobbery("bank", "The Bank", "overworld"));
    const make = (extra) => L.addElement(base, { kind: "teller", name: "Teller", cells: [TELLER], ...extra });
    const why = (result) => (result.ok ? "" : result.reason);

    check("a good one is fine", make({}).ok === true);
    check("it stands on exactly one block: none", /at least one block/.test(why(make({ cells: [] }))));
    check("not two", /at most 1 block/.test(why(make({ cells: [TELLER, [101, 65, 172]] }))));
    check("a hold-up takes at least a second", /hold-up time must be a whole number from 1 to/.test(why(make({ holdSeconds: 0 }))));
    check("and at most the limit", make({ holdSeconds: R.maxHoldSeconds }).ok === true && make({ holdSeconds: R.maxHoldSeconds + 1 }).ok === false);
    check("whole seconds", make({ holdSeconds: 1.5 }).ok === false);

    const withDoor = ok(L.addElement(base, { kind: "switch", name: "Plate", cells: [TELLER] }).robbery ? { ok: true, robbery: L.addElement(base, { kind: "switch", name: "Plate", cells: [TELLER] }).robbery } : { ok: false });
    check("it cannot stand on a block another element is bound to", L.addElement(withDoor, { kind: "teller", name: "Teller", cells: [TELLER] }).ok === false);
    done();
});

test("a teller's hold-up time can be changed, and nothing else has one", () => {
    const { check, done } = checks();
    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    const teller = added(L.addElement(r, { kind: "teller", name: "Teller", cells: [TELLER] }));
    r = added(L.addElement(teller.robbery, { kind: "switch", name: "Plate", cells: [SITE.keypad] })).robbery;

    const changed = L.updateElement(r, teller.element.id, { holdSeconds: 5 });
    check("changed", changed.ok && changed.robbery.elements[0].holdSeconds === 5);
    check("but not out of range", L.updateElement(r, teller.element.id, { holdSeconds: 99 }).ok === false);

    const plate = r.elements.find((e) => e.name === "Plate");
    const refused = L.updateElement(r, plate.id, { holdSeconds: 5 });
    check("a switch has none", refused.ok === false && /only a teller has a hold-up time/.test(refused.reason), refused.reason);
    done();
});

test("a teller that does nothing and that nothing waits for is on the unfinished list", () => {
    const { check, done } = checks();
    const problemsOf = (r) => L.whyNotRunnable(r).filter((p) => /teller/.test(p));

    let r = ok(L.newRobbery("bank", "The Bank", "overworld"));
    const teller = added(L.addElement(r, { kind: "teller", name: "Teller", cells: [TELLER] }));

    check("a bare teller does nothing", problemsOf(teller.robbery).length === 1 && /nothing set to happen when it is held up, and nothing waiting for it/.test(problemsOf(teller.robbery)[0]), problemsOf(teller.robbery).join("; "));

    const withEffect = ok(L.updateElement(teller.robbery, teller.element.id, { onDone: [say("Hands up!", "area")] }));
    check("an effect is enough", problemsOf(withEffect).length === 0);

    const withWaiter = added(L.addElement(teller.robbery, { kind: "switch", name: "Vault", cells: [SITE.keypad], req: [teller.element.id] })).robbery;
    check("so is something waiting for it", problemsOf(withWaiter).length === 0);
    done();
});

test("a teller is described to the builder, and a block is told it cannot be one", () => {
    const { check, done } = checks();
    const { r, teller } = bankWithTeller({ holdSeconds: 1 });

    const lines = M.describeElement(r, teller).map(strip).join("\n");
    check("where it stands and how it is held up", /At: 100, 65, 172/.test(lines) && /Held up by: keeping a gun aimed at it for 1 second$/m.test(lines), lines);
    check("in the plural for more", M.describeElement(ok(L.updateElement(r, teller.id, { holdSeconds: 3 })), { ...teller, holdSeconds: 3 }).map(strip).join("\n").includes("for 3 seconds"));
    check("its noun", M.nounOf("teller") === "teller");
    check("a block cannot be one, and the message says what to do instead", /is an NPC or a villager, not stone: look at it and use \/rae:robbery_teller/.test(M.whyBlockCannotBe("teller", "minecraft:stone") ?? ""), M.whyBlockCannotBe("teller", "minecraft:stone"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The store: a teller is not a bound block
// ---------------------------------------------------------------------------------------------------------

test("the floor under a teller is not a bound block: no click and no protection sees it", () => {
    setup();
    const { check, done } = checks();

    check("the teller's own block is not found by position", S.boundAt("overworld", TELLER[0], TELLER[1], TELLER[2]) === undefined);
    check("the vault door's is", S.boundAt("overworld", SITE.doorLow[0], SITE.doorLow[1], SITE.doorLow[2])?.kind === "door");
    check("there is a teller in the world", S.anyBoundTellers() === true);

    // A robbery with only a teller has no bound block at all, so the click handlers have nothing to do anywhere.
    let r = ok(L.newRobbery("solo", "Solo", "overworld"));
    r = added(L.addElement(r, { kind: "teller", name: "Teller", cells: [[5, 65, 5]], onDone: [say("Hands up!", "area")] })).robbery;
    S.deleteRobbery("bank");
    assert.equal(S.saveRobbery(r).ok, true);
    check("so a world with only tellers pays nothing for blocks", S.anyBoundBlocks() === false && S.anyBoundTellers() === true);

    S.deleteRobbery("solo");
    check("and a world with none says so", S.anyBoundTellers() === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The entity: marks, and what a player is looking at
// ---------------------------------------------------------------------------------------------------------

test("an entity carries a mark saying which element it is the teller of, and one mark at a time", () => {
    fake.reset();
    const { check, done } = checks();
    const npc = fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld });

    check("unmarked, it is nobody's", T.tellerOf(npc) === undefined && T.isTeller(npc) === false);

    T.markTeller(npc, { robbery: "bank", element: "e3" });
    check("marked with the general tag and its own", npc.hasTag("rbt") && npc.hasTag("rbt:bank:e3"));
    check("and it says whose", JSON.stringify(T.tellerOf(npc)) === JSON.stringify({ robbery: "bank", element: "e3" }));

    T.markTeller(npc, { robbery: "bank", element: "e4" });
    check("marked again, it is the new one's and not both", T.tellerOf(npc)?.element === "e4" && !npc.hasTag("rbt:bank:e3"));

    T.unmarkTeller(npc);
    check("unmarked it is nobody's again, and its other tags are left", T.tellerOf(npc) === undefined && !npc.hasTag("rbt"));
    done();
});

test("one element's mark comes off every entity that carries it, in every dimension, and nobody else's", () => {
    fake.reset();
    const { check, done } = checks();
    const a = fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld });
    const b = fake.makeEntity({ typeId: "minecraft:villager_v2", dimension: fake.dimension("nether") });
    const other = fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld });
    T.markTeller(a, { robbery: "bank", element: "e1" });
    T.markTeller(b, { robbery: "bank", element: "e1" });
    T.markTeller(other, { robbery: "bank", element: "e2" });

    check("two were cleared", T.unmarkElement({ robbery: "bank", element: "e1" }) === 2);
    check("the other element's stays", T.tellerOf(a) === undefined && T.tellerOf(b) === undefined && T.tellerOf(other)?.element === "e2");
    done();
});

test("a player or a dropped item cannot be a teller, and a teller stands in the block its feet are in", () => {
    fake.reset();
    const { check, done } = checks();

    check("a player", /a player cannot be a teller/.test(T.whyNotATeller(fake.makePlayer("Ada")) ?? ""));
    check("a dropped item", /a dropped item cannot be a teller/.test(T.whyNotATeller(fake.makeEntity({ typeId: "minecraft:item", dimension: overworld })) ?? ""));
    check("an NPC", T.whyNotATeller(fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld })) === undefined);
    check("a villager", T.whyNotATeller(fake.makeEntity({ typeId: "minecraft:villager_v2", dimension: overworld })) === undefined);

    const npc = fake.makeEntity({ typeId: "minecraft:npc", location: { x: -3.2, y: 64.9, z: 10.7 }, dimension: overworld });
    check("the block its feet are in, with negative coordinates rounded down", T.homeOf(npc).join() === "-4,64,10", T.homeOf(npc).join());
    done();
});

test("a player looking at things sees the nearest one that could be a teller; a hold-up sees only a teller", () => {
    fake.reset();
    const { check, done } = checks();
    const player = fake.makePlayer("Ada");
    const item = fake.makeEntity({ typeId: "minecraft:item", dimension: overworld });
    const cow = fake.makeEntity({ typeId: "minecraft:cow", dimension: overworld });
    const npc = fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld });
    T.markTeller(npc, { robbery: "bank", element: "e1" });

    player.aimEntities = [item, cow, npc];
    check("a dropped item is looked through, the cow is the first thing", T.aimedEntity(player, 12) === cow);
    check("a hold-up looks past the cow to the teller", T.aimedTeller(player)?.entity === npc && T.aimedTeller(player)?.key.element === "e1");

    player.aimEntities = [cow];
    check("a cow alone is no teller", T.aimedTeller(player) === undefined && T.aimedEntity(player, 12) === cow);

    player.aimEntities = [];
    check("nothing at all", T.aimedEntity(player, 12) === undefined && T.aimedTeller(player) === undefined);

    player.getEntitiesFromViewDirection = () => { throw new Error("no view"); };
    check("an aim the game cannot read is the same as aiming at nothing", T.aimedEntity(player, 12) === undefined && T.aimedTeller(player) === undefined);

    // The game need not list what is in view nearest first, so the nearest is found by distance.
    const near = fake.makeEntity({ typeId: "minecraft:cow", dimension: overworld });
    const far = fake.makeEntity({ typeId: "minecraft:pig", dimension: overworld });
    player.getEntitiesFromViewDirection = () => [{ entity: far, distance: 9 }, { entity: near, distance: 3 }];
    check("the nearest comes first whatever order the game lists them in", T.aimedEntity(player, 12) === near);

    // And the reach asked for is the one given, so a hold-up cannot be made from across the map.
    const asked = [];
    player.getEntitiesFromViewDirection = (options) => { asked.push(options?.maxDistance); return []; };
    T.aimedEntity(player, 7);
    T.aimedTeller(player);
    check("a binding looks as far as it was told, a hold-up as far as the hold-up reach", asked.join() === `7,${R.holdUpReach}`, asked.join());
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The hold-up
// ---------------------------------------------------------------------------------------------------------

test("a gun kept aimed at the teller holds it up: the robbery starts, the teller is done, what it was set to do happens, and the vault door that waited for it opens", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    check("nothing is running, the door is shut", Run.runningIds().length === 0 && openBit(SITE.doorLow) === false);

    aimAt(ada, npc);
    fake.advance(seconds(2) + R.holdUpEvery * 3);

    check("the robbery started by itself", Run.runningIds().join() === "bank");
    check("the teller is done", elementState("Teller") === "done", String(elementState("Teller")));
    check("it said its line", said(ada).some((m) => /Take it! Take it all!/.test(m)), said(ada).join(" | "));
    check("and put a bounty on her", world.scoreboard.getObjective("bounty").getScore(ada) === 100);
    check("the door that waited for it opened on its own", elementState("Vault door") === "done" && openBit(SITE.doorLow) === true && openBit(SITE.doorHigh) === true);
    check("and the safe behind it is armed", elementState("Safe") === "armed");
    done();
});

test("holding up the teller can set the guards loose, and they go when the site is put back", () => {
    const built = setup({ onDone: [say("Guards!", "area"), { kind: "spawn", entity: "minecraft:pillager", count: 2, at: [100, 65, 175] }] });
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();
    const guards = () => fake.entities.filter((e) => e.isValid && e.hasTag(R.guardTag));

    aimAt(ada, npc);
    fake.advance(seconds(2) + R.holdUpEvery * 3);
    check("held up, and the first guard is there", elementState("Teller") === "done" && guards().length >= 1);

    fake.advance(R.spawnGapTicks * 2 + R.tickEvery * 2);
    check("both guards, pillagers, at the spot the builder chose", guards().length === 2 && guards().every((g) => g.typeId === "minecraft:pillager" && g.location.x === 100.5 && g.location.z === 175.5), String(guards().length));

    Run.resetSiteNow("bank");
    check("a reset takes the guards and leaves the teller where it stands", guards().length === 0 && npc.isValid === true && T.isTeller(npc));
    done();
});

test("it takes the whole time: a bar fills while she aims, and nothing counts before it is full", () => {
    const built = setup({ holdSeconds: 3 });
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    aimAt(ada, npc);
    fake.advance(seconds(2));

    check("after two seconds of three it has not counted", Run.runningIds().length === 0 && elementState("Teller") === undefined);
    check("but a bar says how far it is", bar(ada).some((m) => /Holding up Teller \[#+-+\]/.test(m)), bar(ada).join(" | "));

    const lastBar = bar(ada).filter((m) => /Holding up/.test(m)).at(-1) ?? "";
    check("more than half full, not yet full", (lastBar.match(/#/g) ?? []).length >= 5 && (lastBar.match(/-/g) ?? []).length >= 1, lastBar);

    fake.advance(seconds(1) + R.holdUpEvery * 3);
    check("then it counts", elementState("Teller") === "done");
    done();
});

test("a gun that is not aimed holds nobody up, however long it is pointed", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    ada.aimEntities = [npc];                                    // she looks at the teller with a gun in hand, but never aims
    ada.container.setItem(ada.selectedSlotIndex, new fakeApi.ItemStack(REVOLVER, 1));
    check("the gun really is in her hand", ada.container.getItem(ada.selectedSlotIndex)?.typeId === REVOLVER);
    fake.advance(seconds(5));

    check("nothing happened", Run.runningIds().length === 0 && bar(ada).every((m) => !/Holding up/.test(m)));
    done();
});

test("with aiming switched off, holding any gun and looking at the teller is enough; holding something else is not", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);

    const empty = robber("Empty");
    empty.aimEntities = [npc];
    R.holdUpNeedsAim = false;

    try {
        fake.advance(seconds(3));
        check("an empty hand holds nobody up", Run.runningIds().length === 0);

        empty.container.setItem(empty.selectedSlotIndex, new fakeApi.ItemStack("minecraft:stick", 1));
        fake.advance(seconds(3));
        check("nor does a stick", Run.runningIds().length === 0);

        empty.container.setItem(empty.selectedSlotIndex, new fakeApi.ItemStack(REVOLVER, 1));
        fake.advance(seconds(2) + R.holdUpEvery * 3);
        check("a revolver does", Run.runningIds().join() === "bank" && elementState("Teller") === "done");
    } finally {
        R.holdUpNeedsAim = true;
    }
    done();
});

test("the same switch can be turned off and on in the game", () => {
    fake.reset();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    const field = configoverrides.getField("robbery.holdUpNeedsAim");

    check("it exists, is a boolean and is under Robbery", field?.kind === "boolean" && field.category === "Robbery");
    check("on by default", R.holdUpNeedsAim === true);
    check("off", configoverrides.setOverride(op, "robbery.holdUpNeedsAim", false).ok === true && R.holdUpNeedsAim === false);
    check("reset puts it back", configoverrides.resetOverride(op, "robbery.holdUpNeedsAim").ok === true && R.holdUpNeedsAim === true);
    done();
});

test("looking away for a moment does not start it over; looking away for longer does", () => {
    const built = setup({ holdSeconds: 2 });
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    aimAt(ada, npc);
    fake.advance(seconds(1));
    aimAt(ada, undefined);
    fake.advance(R.holdUpEvery * 2);                            // a glance away, shorter than the grace
    aimAt(ada, npc);
    fake.advance(seconds(1) + R.holdUpEvery * 4);
    check("a glance away, and it still counts: two seconds in all", elementState("Teller") === "done", String(elementState("Teller")));

    Run.resetSiteNow("bank");
    fake.advance(R.janitorEvery * 2);

    aimAt(ada, npc);
    fake.advance(seconds(1));
    aimAt(ada, undefined);
    fake.advance(R.holdUpGapTicks + R.holdUpEvery * 2);         // looks away for good this time
    aimAt(ada, npc);
    fake.advance(seconds(1) + R.holdUpEvery);
    check("a longer look away starts it over: only a second since", elementState("Teller") !== "done", String(elementState("Teller")));
    done();
});

test("the teller turns to face the robber, once, when the hold-up begins", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    aimAt(ada, npc);
    fake.advance(seconds(1));
    check("it turned toward her once", npc.teleportLog.filter((t) => t.facing).length === 1 && npc.teleportLog[0].facing.x === STAND.x && npc.teleportLog[0].facing.z === STAND.z, JSON.stringify(npc.teleportLog));
    check("and heard a sound of it", ada.privateSounds.some((s) => s.id === R.cues.holdUp.id));

    fake.advance(seconds(2));
    check("not again while she keeps aiming", npc.teleportLog.filter((t) => t.facing).length === 1);
    done();
});

test("a law player cannot hold up a teller of an outlaws-only robbery, and is told once and not every few ticks", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const sheriff = robber("Sheriff", "law");

    aimAt(sheriff, npc);
    fake.advance(seconds(2) + R.holdUpEvery * 3);
    check("refused", Run.runningIds().length === 0 && denials(sheriff) === 1, `${denials(sheriff)}`);

    fake.advance(R.holdUpRetryTicks - R.holdUpEvery * 4);
    check("and not again while the retry gap lasts", denials(sheriff) === 1, `${denials(sheriff)}`);
    done();
});

test("a teller already held up this run shows no bar and takes no more", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    aimAt(ada, npc);
    fake.advance(seconds(2) + R.holdUpEvery * 3);
    check("held up", elementState("Teller") === "done");

    const bars = bar(ada).filter((m) => /Holding up/.test(m)).length;
    fake.advance(R.holdUpRetryTicks * 3);
    check("no further bar, no further touch", bar(ada).filter((m) => /Holding up/.test(m)).length === bars && world.scoreboard.getObjective("bounty").getScore(ada) === 100);
    done();
});

test("two robbers hold up the same teller independently, and the first to finish counts", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber("Ada");
    const bea = robber("Bea");

    aimAt(ada, npc);
    fake.advance(seconds(1));
    aimAt(bea, npc);
    fake.advance(seconds(1) + R.holdUpEvery * 3);

    check("Ada had a second's start and finished first", elementState("Teller") === "done" && world.scoreboard.getObjective("bounty").getScore(ada) === 100);
    check("and Bea has not been paid for it", (world.scoreboard.getObjective("bounty").getScore(bea) ?? 0) === 0);
    done();
});

test("an entity marked as the teller of an element that is gone is just an NPC again", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    T.markTeller(npc, { robbery: "bank", element: "e99" });      // the element was deleted while this NPC was out of reach
    aimAt(ada, npc);

    let threw = null;
    try { fake.advance(seconds(4)); } catch (err) { threw = err; }

    check("nothing happens and nothing breaks", threw === null && Run.runningIds().length === 0 && bar(ada).every((m) => !/Holding up/.test(m)));
    done();
});

test("a robber in another dimension cannot hold up a teller of this one", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    ada._dimension = fake.dimension("nether");
    aimAt(ada, npc);
    fake.advance(seconds(4));

    check("nothing happens", Run.runningIds().length === 0 && bar(ada).every((m) => !/Holding up/.test(m)));
    done();
});

test("a world with no teller does no work for a robber aiming at anything", () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    const { check, done } = checks();
    const ada = robber();
    const cow = fake.makeEntity({ typeId: "minecraft:cow", dimension: overworld });
    let rays = 0;

    aimAt(ada, cow);
    ada.getEntitiesFromViewDirection = () => { rays++; return []; };
    fake.advance(seconds(3));

    check("no view ray was cast", rays === 0, String(rays));
    done();
});

test("a round reset forgets a hold-up in progress", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    aimAt(ada, npc);
    fake.advance(seconds(1) + R.holdUpEvery);
    resetAllSystems();
    aimAt(ada, npc);
    fake.advance(seconds(1) + R.holdUpEvery);

    check("a second more is not enough: the first second was forgotten", elementState("Teller") !== "done");
    done();
});

test("a teller can start a robbery that waits for another element: it will not budge", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();

    // Make the teller wait for the safe: nothing is running, and an element that waits cannot start the robbery.
    const safe = S.getRobbery("bank").elements.find((e) => e.name === "Safe");
    assert.equal(E.applyEdit("bank", (r) => L.updateElement(r, built.teller.id, { req: [safe.id] })).ok, false, "a loop is refused");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------------------------------------

test("binding an entity makes a teller where it stands, marks it, and gives it the default time", () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    E.createRobbery(op, "bank", "The Bank");
    const npc = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 12.5, y: 70, z: -3.5 }, dimension: overworld });

    const made = E.bindTeller("bank", npc, "Cashier");

    check("it worked", made.ok === true && made.moved === false, JSON.stringify(made));
    const element = S.getRobbery("bank").elements[0];
    check("a teller element called Cashier, standing in its block, with the default time", element.kind === "teller" && element.name === "Cashier" && element.cells[0].join() === "12,70,-4" && element.holdSeconds === R.defaultHoldSeconds, JSON.stringify(element));
    check("and the entity knows which", T.tellerOf(npc)?.element === element.id);

    const plain = E.bindTeller("bank", fake.makeEntity({ typeId: "minecraft:villager_v2", location: { x: 20.5, y: 70, z: 20.5 }, dimension: overworld }), "");
    check("a name left blank gets a name of its own", plain.ok && /^Teller \d+$/.test(plain.element.name), JSON.stringify(plain));
    done();
});

test("binding with the name of a teller that exists moves that teller to the new entity", () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    E.createRobbery(op, "bank", "The Bank");
    const old = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 12.5, y: 70, z: 3.5 }, dimension: overworld });
    const fresh = fake.makeEntity({ typeId: "minecraft:villager_v2", location: { x: 30.5, y: 70, z: 8.5 }, dimension: overworld });

    const first = E.bindTeller("bank", old, "Cashier");
    E.applyEdit("bank", (r) => L.updateElement(r, first.element.id, { onDone: [say("Hands up!", "area")], holdSeconds: 4 }));

    const moved = E.bindTeller("bank", fresh, "cashier");

    check("moved, not made again", moved.ok === true && moved.moved === true && S.getRobbery("bank").elements.length === 1, JSON.stringify(moved));
    const element = S.getRobbery("bank").elements[0];
    check("it stands in the new place and kept everything it was set up with", element.cells[0].join() === "30,70,8" && element.holdSeconds === 4 && element.onDone.length === 1);
    check("the old entity is an NPC again and the new one is the teller", T.tellerOf(old) === undefined && T.tellerOf(fresh)?.element === element.id);
    done();
});

test("an entity cannot be a teller twice, nor in the wrong dimension, nor be a player", () => {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    S.forgetLoaded();
    const { check, done } = checks();
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    E.createRobbery(op, "bank", "The Bank");
    const npc = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 12.5, y: 70, z: 3.5 }, dimension: overworld });
    E.bindTeller("bank", npc, "Cashier");

    const again = E.bindTeller("bank", npc, "Manager");
    check("already the teller Cashier of The Bank", again.ok === false && /already the teller Cashier of The Bank/.test(again.reason), JSON.stringify(again));

    const nether = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 1.5, y: 70, z: 1.5 }, dimension: fake.dimension("nether") });
    const wrong = E.bindTeller("bank", nether, "Guard");
    check("in the nether, for a robbery in the overworld", wrong.ok === false && /it is in the nether and The Bank is in the overworld/.test(wrong.reason), JSON.stringify(wrong));

    check("a player", E.bindTeller("bank", op, "Me").ok === false);
    check("a robbery that is not there", E.bindTeller("nowhere", npc, "x").ok === false);
    check("only the first was made", S.getRobbery("bank").elements.length === 1);
    done();
});

test("deleting a teller turns its entity back into a plain NPC", () => {
    const built = setup();
    const { check, done } = checks();
    const npc = npcFor(built.teller);

    check("it is a teller", T.isTeller(npc));
    const removed = E.removeElementFrom("bank", built.teller.id);

    check("removed, and the vault door that waited for it no longer waits", removed.ok === true && removed.removedReferences === 1);
    check("the NPC is no teller now", T.isTeller(npc) === false && !npc.hasTag("rbt"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Clicking a teller
// ---------------------------------------------------------------------------------------------------------

function clickOn(player, target, held) {
    const event = { player, target, itemStack: held === undefined ? undefined : { typeId: held }, cancel: false };
    world.beforeEvents.playerInteractWithEntity.emit(event);
    return event;
}

test("nobody trades with, or talks to, a teller: an ordinary click is cancelled, an operator's sneaking click is not", () => {
    const built = setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const ada = robber();
    const op = fake.makePlayer("Op", { location: { ...STAND }, permission: PlayerPermissionLevel.Operator });

    check("a player's click is cancelled", clickOn(ada, npc).cancel === true);
    check("an operator's click is cancelled too", clickOn(op, npc).cancel === true);

    op.isSneaking = true;
    check("but a sneaking operator gets the game's own screen, where a skin is changed", clickOn(op, npc).cancel === false);

    const plain = fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld });
    check("an NPC that is no teller is left alone", clickOn(ada, plain).cancel === false);
    done();
});

test("the wand on a teller opens that element's screen, and only that: the shops' offer to make it a shop stays quiet", async () => {
    const built = setup();
    fake.strictBefore = true;
    const { check, done } = checks();
    const npc = npcFor(built.teller);
    const op = fake.makePlayer("Op", { location: { ...STAND }, permission: PlayerPermissionLevel.Operator });

    script(close);
    const event = clickOn(op, npc, R.wandItemId);
    fake.advance(1);
    await flush();

    check("cancelled", event.cancel === true);
    check("one screen opened, the element's", ui.shown.length === 1 && strip(titleOf(ui.shown[0])) === "Teller", ui.shown.map((f) => strip(titleOf(f))).join(" > "));
    check("and the robbery is now the one she is working on", E.selectedId(op) === "bank");

    // An NPC that is no teller still gets the shops' offer.
    ui.shown.length = 0;
    script(close);
    const plain = fake.makeEntity({ typeId: "minecraft:npc", dimension: overworld });
    clickOn(op, plain, R.wandItemId);
    fake.advance(R.wandClickGapTicks + 2);
    await flush();
    check("an NPC that is no teller still gets the shop offer", ui.shown.length >= 1 && strip(titleOf(ui.shown[0])) !== "Teller", ui.shown.map((f) => strip(titleOf(f))).join(" > "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The builder's screens
// ---------------------------------------------------------------------------------------------------------

const builder = () => fake.makePlayer("Builder", { location: { ...STAND }, permission: PlayerPermissionLevel.Operator });

test("a teller's screen has its hold-up time and a way to give it to another entity, and no blocks to change", async () => {
    const built = setup({ holdSeconds: 3 });
    const { check, done } = checks();
    const op = builder();

    script(close);
    await F.openElementMenu(op, "bank", built.teller.id);

    const form = ui.shown[0];
    const buttons = buttonsOf(form).map(strip);
    const body = strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));

    check("the time, in the button", buttons.includes("Hold-up time (3 s)"), buttons.join(" | "));
    check("a way to use another NPC or villager", buttons.includes("Use another NPC or villager"));
    check("no 'Change its blocks'", !buttons.includes("Change its blocks"));
    check("the usual ones", ["Rename", "Locks (0)", "Waits for (0)", "Delete it"].every((b) => buttons.includes(b)));
    check("and the body says how it is held up", /Held up by: keeping a gun aimed at it for 3 seconds/.test(body), body);
    done();
});

test("the hold-up time is changed in a form, and a time that makes no sense is refused", async () => {
    const built = setup();
    const { check, done } = checks();
    const op = builder();

    script(press("Hold-up time"), fill({ "Seconds a gun": "6" }), close, close);
    await F.openElementMenu(op, "bank", built.teller.id);
    check("saved", S.getRobbery("bank").elements[0].holdSeconds === 6, String(S.getRobbery("bank").elements[0].holdSeconds));

    ui.shown.length = 0;
    script(press("Hold-up time"), fill({ "Seconds a gun": "0" }), close, close);
    await F.openElementMenu(op, "bank", built.teller.id);
    check("0 is refused by the form itself, in words and before any edit is tried", said(op).some((m) => /^The hold-up time must be a whole number from 1 to \d+\.$/.test(m)) && !said(op).some((m) => /^Not changed:/.test(m)), said(op).join(" | "));
    check("and the time is as it was", S.getRobbery("bank").elements[0].holdSeconds === 6);
    check("the stand-in never lost its way", problems.length === 0, problems.join("\n"));
    done();
});

test("giving a teller to another entity is done with the command, and the screen says how", async () => {
    const built = setup();
    const { check, done } = checks();
    const op = builder();

    script(press("Use another NPC or villager"));
    await F.openElementMenu(op, "bank", built.teller.id);

    check("told what to do, with the teller's own name", said(op).some((m) => /Look at the NPC or villager that should be Teller, then run \/rae:robbery_teller Teller/.test(m)), said(op).join(" | "));
    done();
});
