import { test } from "node:test";
import { checks, load, world } from "./helpers.mjs";
import { MELEE, fake, fresh, hit, armed, resetMelee, debug, lines, meleeLines } from "./melee-fixtures.mjs";
import { L, at, ok, added } from "./robbery-fixtures.mjs";

// The sledgehammer (tasks/melee/plan.md, Task 7): a swing at a block from the configured list breaks it, with drops, once per 1.5 seconds. It
// never breaks anything a robbery has bound (whether or not that robbery protects its blocks, is running, or the swinger is an operator), nor
// anything outside the list. A swing at something living hits it for 8 (Task 2) and breaks nothing behind it. Whether the game agrees that a
// script's setblock-destroy drops the block's items, and whether it sends a swing event for a left-click on a block, is for docs/test-cards/MELEE.md.

const S = await load("core/robberystore.js");
const H = MELEE.sledgehammer;
const overworld = () => fake.dimension("overworld");

const DESK = { x: 0, y: 64, z: 3 };
const SECOND = { x: 1, y: 64, z: 3 };

const smith = (name = "Smith", options = {}) => {
    const player = fake.makePlayer(name, { holding: MELEE.weapons.sledgehammer.id, location: { x: 0, y: 64, z: 0 }, ...options });
    return player;
};

const NEAR_THE_HOLD = { x: 12, y: 64, z: 8 };

/** Puts a block in the world and points the swinger at it. */
function aimAt(player, pos, typeId) {
    fake.placeBlock("overworld", pos, typeId);
    player.aimAt = { ...pos };
}

const swing = (player, source = "Mine") => world.afterEvents.playerSwingStart.emit({ swingSource: source, heldItemStack: { typeId: player.holding }, player });
const broken = () => overworld().commands.filter((c) => /^setblock .* air destroy$/.test(c));
const command = (pos) => `setblock ${pos.x} ${pos.y} ${pos.z} air destroy`;
const clear = () => { overworld().commands.length = 0; };

function setup() {
    fresh();
    S.forgetLoaded();
    overworld().commands.length = 0;
}

test("the sledgehammer is on the table: four blocks of reach, a second and a half, and a list that is all wood, glass and hay", () => {
    const { check, done } = checks();
    check("4 blocks", H.reach === 4);
    check("30 ticks", H.cooldownTicks === 30);
    for (const id of ["minecraft:glass", "minecraft:glass_pane", "minecraft:red_stained_glass", "minecraft:lime_stained_glass_pane", "minecraft:oak_planks", "minecraft:spruce_planks",
        "minecraft:crimson_planks", "minecraft:oak_fence", "minecraft:fence_gate", "minecraft:birch_fence_gate", "minecraft:wooden_door", "minecraft:spruce_door",
        "minecraft:trapdoor", "minecraft:jungle_trapdoor", "minecraft:hay_block"]) {
        check(`${id} can be broken`, H.breakable.includes(id));
    }
    for (const id of ["minecraft:iron_door", "minecraft:iron_trapdoor", "minecraft:copper_door", "minecraft:nether_brick_fence", "minecraft:stone", "minecraft:chest", "minecraft:bedrock", "minecraft:obsidian", "minecraft:iron_bars"]) {
        check(`${id} cannot`, !H.breakable.includes(id));
    }
    check("no id twice", new Set(H.breakable).size === H.breakable.length);
    done();
});

test("every id on the list is a block the game has", async () => {
    const { check, done } = checks();
    let known;
    try {
        const data = await import("@minecraft/vanilla-data");
        known = new Set(Object.values(data.MinecraftBlockTypes));
    } catch {
        return;                                                    // the data package is not installed here: nothing to compare with
    }
    for (const id of H.breakable) check(`${id} is a real block`, known.has(id));
    done();
});

test("a swing at a block on the list breaks it: setblock destroy, so it drops as when mined", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");

    swing(player);
    check("one command", broken().length === 1, JSON.stringify(broken()));
    check("destroying that block, in the swinger's dimension", broken()[0] === command(DESK), broken()[0]);
    done();
});

test("each kind on the list breaks: glass, a pane, a fence, a gate, a door, a trapdoor, hay", () => {
    const { check, done } = checks();
    setup();
    for (const id of ["minecraft:glass", "minecraft:glass_pane", "minecraft:blue_stained_glass", "minecraft:oak_fence", "minecraft:fence_gate", "minecraft:wooden_door", "minecraft:trapdoor", "minecraft:hay_block"]) {
        resetMelee();
        clear();
        const player = smith(`Smith-${id}`);
        aimAt(player, DESK, id);
        swing(player);
        check(id, broken().length === 1, JSON.stringify(broken()));
    }
    done();
});

test("a block off the list, air, or nothing in sight is left alone and costs no cooldown", () => {
    const { check, done } = checks();
    setup();
    const player = smith();

    for (const id of ["minecraft:stone", "minecraft:iron_door", "minecraft:chest", "minecraft:bedrock", "minecraft:air"]) {
        aimAt(player, DESK, id);
        swing(player);
    }
    player.aimAt = undefined;
    swing(player);
    check("nothing broken", broken().length === 0, JSON.stringify(broken()));

    aimAt(player, DESK, "minecraft:oak_planks");
    swing(player);
    check("and the first real swing is not held up by them", broken().length === 1);
    done();
});

test("a block beyond the reach of the swinger is left alone, even if the ray found it", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, { x: 0, y: 64, z: 4 }, "minecraft:oak_planks");
    swing(player);
    check("4.6 blocks away: nothing", broken().length === 0, JSON.stringify(broken()));

    aimAt(player, DESK, "minecraft:oak_planks");
    swing(player);
    check("3 blocks away: it breaks", broken().length === 1);
    done();
});

test("reach is measured to the point on the block the swinger is looking at, not to the block's corner", () => {
    const { check, done } = checks();
    setup();
    const player = smith();

    // 3.9 blocks to the block's corner, 4.3 to the top face's centre, which is what the ray hit.
    aimAt(player, { x: 2, y: 64, z: 3 }, "minecraft:oak_planks");
    swing(player);
    check("out of reach", broken().length === 0, JSON.stringify(broken()));

    // 3.5 to the corner, 3.85 to the face: in.
    aimAt(player, { x: 1, y: 64, z: 3 }, "minecraft:oak_planks");
    swing(player);
    check("in reach", broken().length === 1, JSON.stringify(broken()));
    done();
});

test("the cooldown is the configured one at the time of the swing", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    const original = H.cooldownTicks;
    try {
        H.cooldownTicks = 60;
        aimAt(player, DESK, "minecraft:oak_planks");
        swing(player);
        aimAt(player, SECOND, "minecraft:oak_planks");
        fake.advance(30);
        swing(player);
        check("30 ticks later it is still cooling", broken().length === 1);
        fake.advance(30);
        swing(player);
        check("60 ticks later it works", broken().length === 2);
    } finally { H.cooldownTicks = original; }
    done();
});

test("the swing asks the engine for the block and for the entities as far as the hammer reaches", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");
    const asked = { block: [], entities: [] };
    const realBlock = player.getBlockFromViewDirection.bind(player);
    const realEntities = player.getEntitiesFromViewDirection.bind(player);
    player.getBlockFromViewDirection = (options) => { asked.block.push(options); return realBlock(options); };
    player.getEntitiesFromViewDirection = (options) => { asked.entities.push(options); return realEntities(options); };

    swing(player);
    check("the block ray reaches as far as the hammer", asked.block.length === 1 && asked.block[0]?.maxDistance === H.reach, JSON.stringify(asked.block));
    check("so does the entity ray", asked.entities.length === 1 && asked.entities[0]?.maxDistance === H.reach, JSON.stringify(asked.entities));
    done();
});

test("a robbery in the Nether keeps the Nether's blocks, and only those", () => {
    const { check, done } = checks();
    setup();
    let r = ok(L.newRobbery("nether", "Nether Fort", "nether"));
    r = added(L.addElement(r, { kind: "switch", name: "Lever", cells: [[DESK.x, DESK.y, DESK.z]], locks: [] })).robbery;
    S.saveRobbery(r);

    const nether = fake.dimension("nether");
    const delver = fake.makePlayer("Delver", { holding: MELEE.weapons.sledgehammer.id, location: { x: 0, y: 64, z: 0 }, dimension: nether });
    fake.placeBlock("nether", DESK, "minecraft:oak_planks");
    delver.aimAt = { ...DESK };
    swing(delver);
    check("in the Nether the bound block stays", nether.commands.filter((c) => /^setblock/.test(c)).length === 0, JSON.stringify(nether.commands));

    const free = { x: 1, y: 64, z: 3 };
    fake.placeBlock("nether", free, "minecraft:oak_planks");
    fake.advance(60);
    delver.aimAt = { ...free };
    swing(delver);
    check("and the block beside it breaks, in the Nether", nether.commands.some((c) => c === command(free)), JSON.stringify(nether.commands));
    check("not in the overworld", broken().length === 0);
    done();
});

test("a chunk that unloaded between the ray and the break is not touched", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");
    const dim = overworld();
    const real = dim.isChunkLoaded;
    let asked = 0;
    dim.isChunkLoaded = () => ++asked === 1;                  // loaded for the ray's look at the block, not for the break
    try { swing(player); } finally { dim.isChunkLoaded = real; }
    check("nothing broken", broken().length === 0, JSON.stringify(broken()));
    swing(player);
    check("and no cooldown was spent on it", broken().length === 1);
    done();
});

test("the list is read at the swing: a block added to it breaks, a block removed from it does not", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    const original = [...H.breakable];
    try {
        aimAt(player, DESK, "minecraft:stone");
        swing(player);
        check("stone is not on the list", broken().length === 0);

        H.breakable.push("minecraft:stone");
        swing(player);
        check("stone breaks once it is", broken().length === 1);

        H.breakable.splice(0, H.breakable.length, "minecraft:glass");
        fake.advance(60);
        aimAt(player, SECOND, "minecraft:oak_planks");
        clear();
        swing(player);
        check("planks do not once they are gone", broken().length === 0);
    } finally { H.breakable.splice(0, H.breakable.length, ...original); }
    done();
});

test("the cooldown: a second swing inside 1.5 seconds breaks nothing and says how long is left; after it, it breaks again", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");
    swing(player);
    check("the first swing breaks", broken().length === 1);

    aimAt(player, SECOND, "minecraft:oak_planks");
    fake.advance(10);
    swing(player);
    check("20 ticks left: nothing", broken().length === 1, JSON.stringify(broken()));
    check("the action bar says so (1.0 second)", player.actionBar.some((line) => /Sledgehammer/.test(line) && /1\.0/.test(line)), JSON.stringify(player.actionBar));

    fake.advance(19);
    swing(player);
    check("a tick before the end: nothing", broken().length === 1);

    fake.advance(1);
    swing(player);
    check("at 30 ticks: it breaks", broken().length === 2, JSON.stringify(broken()));
    done();
});

test("the cooldown is each swinger's own, and a round reset gives it back", () => {
    const { check, done } = checks();
    setup();
    const ada = smith("Ada");
    const bo = smith("Bo");
    aimAt(ada, DESK, "minecraft:oak_planks");
    aimAt(bo, SECOND, "minecraft:oak_planks");

    swing(ada);
    swing(bo);
    check("both broke their own", broken().length === 2, JSON.stringify(broken()));

    aimAt(ada, { x: -1, y: 64, z: 3 }, "minecraft:oak_planks");
    swing(ada);
    check("Ada is cooling", broken().length === 2);
    resetMelee();
    swing(ada);
    check("a reset gave it back", broken().length === 3);
    done();
});

test("a swing at something living hits it for 8 and breaks nothing: not the block in front of it, not the one behind", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    const mob = fake.makeEntity({ typeId: "minecraft:pillager", location: { x: 0, y: 64, z: 2 } });
    mob.getComponent = (id) => id === "minecraft:health" ? { currentValue: 20, effectiveMax: 20 } : undefined;
    player.aimEntities = [mob];                                    // 2 blocks away
    aimAt(player, DESK, "minecraft:oak_planks");                   // 3.6 blocks away: behind the mob

    const event = hit({ attacker: player, target: mob, damage: 1 });
    swing(player);
    check("the hit is the hammer's 8", event.damage === 8 && event.cancel === false);
    check("the block behind it is left alone", broken().length === 0, JSON.stringify(broken()));

    aimAt(player, { x: 0, y: 64, z: 1 }, "minecraft:oak_planks"); // 1.7 blocks away: in front of the mob
    swing(player);
    check("a block in front of the mob is what the swing hit, and it breaks", broken().length === 1, JSON.stringify(broken()));
    done();
});

test("other swings, other weapons, other game modes: only a survival or creative player with the hammer in hand, swinging to hit or mine", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");

    for (const source of ["Interact", "Use", "Place", "Build", "None", "DropItem"]) swing(player, source);
    check("other kinds of swing do nothing", broken().length === 0);

    const axeman = armed("Axeman", "axe");
    aimAt(axeman, DESK, "minecraft:oak_planks");
    swing(axeman);
    const fist = fake.makePlayer("Fist");
    aimAt(fist, DESK, "minecraft:oak_planks");
    swing(fist);
    check("another weapon or a bare hand does nothing", broken().length === 0);

    for (const mode of ["Adventure", "Spectator", "adventure", "spectator"]) {
        const limited = smith(`Limited-${mode}`);
        limited.getGameMode = () => mode;
        aimAt(limited, DESK, "minecraft:oak_planks");
        swing(limited);
    }
    check("an adventure or spectator player may not break blocks", broken().length === 0);

    for (const [mode, source] of [["Creative", "Mine"], ["Survival", "Attack"], ["survival", "Mine"]]) {
        resetMelee();
        clear();
        const free = smith(`Free-${mode}-${source}`);
        free.getGameMode = () => mode;
        aimAt(free, DESK, "minecraft:oak_planks");
        swing(free, source);
        check(`${mode} with a ${source} swing breaks`, broken().length === 1, JSON.stringify(broken()));
    }
    done();
});

test("a block in a chunk that is not loaded, or one in another dimension, is not touched", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");
    const dim = overworld();
    const real = dim.isChunkLoaded;

    dim.isChunkLoaded = () => false;
    try { swing(player); } finally { dim.isChunkLoaded = real; }
    check("unloaded: nothing", broken().length === 0);

    // A robbery bound at the same coordinates in the Nether protects nothing in the overworld (the dimension is part of where a block is).
    let r = ok(L.newRobbery("nether", "Nether Fort", "nether"));
    r = added(L.addElement(r, { kind: "switch", name: "Lever", cells: [[DESK.x, DESK.y, DESK.z]], locks: [] })).robbery;
    S.saveRobbery(r);
    swing(player);
    check("a robbery in the Nether does not shield the overworld's block", broken().length === 1, JSON.stringify(broken()));
    done();
});

/** A robbery with a vault door, a lockbox and a switch, each bound on a block the hammer could otherwise break. */
function bindBreakables(settings = {}) {
    let r = ok(L.newRobbery("hold", "Hold-up", "overworld"));
    const door = added(L.addElement(r, { kind: "door", name: "Door", cells: [[10, 64, 10], [10, 65, 10]] }));
    r = door.robbery;
    const box = added(L.addElement(r, { kind: "chest", name: "Box", cells: [[12, 64, 10]], table: "chests/gold_2", items: [], locks: [], req: [door.element.id] }));
    r = box.robbery;
    r = added(L.addElement(r, { kind: "switch", name: "Switch", cells: [[14, 64, 10]], locks: [], onDone: [{ kind: "end", result: "win", delaySeconds: 3 }] })).robbery;
    r = ok(L.setArea(r, [0, 60, 0], [30, 80, 30]));
    if (Object.keys(settings).length > 0) r = ok(L.setSettings(r, settings));
    S.saveRobbery(r);
    fake.placeBlock("overworld", { x: 10, y: 64, z: 10 }, "minecraft:wooden_door", { upper_block_bit: false });
    fake.placeBlock("overworld", { x: 10, y: 65, z: 10 }, "minecraft:wooden_door", { upper_block_bit: true });
    fake.placeBlock("overworld", { x: 12, y: 64, z: 10 }, "minecraft:hay_block");
    fake.placeBlock("overworld", { x: 14, y: 64, z: 10 }, "minecraft:oak_planks");
    return [{ x: 10, y: 64, z: 10 }, { x: 10, y: 65, z: 10 }, { x: 12, y: 64, z: 10 }, { x: 14, y: 64, z: 10 }];
}

test("every block a robbery has bound survives the hammer: a door's two halves, a chest, a switch", () => {
    const { check, done } = checks();
    setup();
    const cells = bindBreakables();
    const player = smith("Smith", { location: NEAR_THE_HOLD });

    for (const cell of cells) {
        player.aimAt = { ...cell };
        swing(player);
        fake.advance(60);
    }
    check("nothing bound was broken", broken().length === 0, JSON.stringify(broken()));

    const free = { x: 12, y: 64, z: 11 };
    aimAt(player, free, "minecraft:oak_planks");
    swing(player);
    check("a block beside them still breaks", broken().length === 1 && broken()[0] === command(free), JSON.stringify(broken()));
    done();
});

test("a robbery that does not protect its blocks still keeps the hammer off them, and an operator is held to the same", () => {
    const { check, done } = checks();
    setup();
    const cells = bindBreakables({ protect: false });
    const operator = smith("Op", { permission: 2, location: NEAR_THE_HOLD });

    for (const cell of cells) {
        operator.aimAt = { ...cell };
        swing(operator);
        fake.advance(60);
    }
    check("nothing bound was broken, not even by an operator, not even with protect off", broken().length === 0, JSON.stringify(broken()));
    done();
});

test("a robbery that is running keeps them too", async () => {
    const { check, done } = checks();
    setup();
    const cells = bindBreakables();
    const Run = await load("core/robberyrun.js");
    const state = await load("core/state.js");
    const ada = fake.makePlayer("Ada", { location: NEAR_THE_HOLD, holding: MELEE.weapons.sledgehammer.id });
    state.update(ada, { role: "outlaw" });
    const started = Run.startRobbery("hold", { by: ada });

    for (const cell of cells) {
        ada.aimAt = { ...cell };
        swing(ada);
        fake.advance(60);
    }
    check("the robbery started", started.ok === true, JSON.stringify(started));
    check("nothing bound was broken during it", broken().length === 0, JSON.stringify(broken()));
    done();
});

test("a command the engine refuses is reported once and never thrown", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");
    const dim = overworld();
    const real = dim.runCommand;
    dim.runCommand = () => { throw new Error("the engine refused"); };
    let threw = false;
    try { swing(player); fake.advance(40); swing(player); } catch { threw = true; } finally { dim.runCommand = real; }
    check("nothing thrown", !threw);
    check("one report naming the break and the cause", meleeLines().length === 1 && /a hammer break failed: the engine refused/.test(meleeLines()[0]), meleeLines().join(" | "));
    done();
});

test("something that is not alive between the swinger and the block (a dropped item) does not stop the swing", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    const dropped = fake.makeEntity({ typeId: "minecraft:item", location: { x: 0, y: 64, z: 1 } });
    player.aimEntities = [dropped];
    aimAt(player, DESK, "minecraft:oak_planks");
    swing(player);
    check("the block breaks", broken().length === 1, JSON.stringify(broken()));
    done();
});

test("a swinger the engine cannot read is skipped without a word", () => {
    const { check, done } = checks();
    setup();
    const player = smith();
    aimAt(player, DESK, "minecraft:oak_planks");
    player.getBlockFromViewDirection = () => { throw new Error("InvalidEntityError"); };
    let threw = false;
    try { swing(player); } catch { threw = true; }
    check("nothing thrown", !threw);
    check("one report, naming the swing", meleeLines().length === 1 && /a hammer swing failed/.test(meleeLines()[0]), meleeLines().join(" | "));
    done();
});

test("with rae:melee_debug on, a break, a refusal for a bound block and a cooldown are logged", () => {
    const { check, done } = checks();
    setup();
    debug(true);
    const cells = bindBreakables();
    const player = smith();

    lines.length = 0;
    aimAt(player, DESK, "minecraft:oak_planks");
    swing(player);
    check("a break says what was broken", meleeLines().some((l) => /sledgehammer/.test(l) && /broke/.test(l) && /oak_planks/.test(l)), meleeLines().join(" | "));

    lines.length = 0;
    fake.advance(10);
    aimAt(player, SECOND, "minecraft:oak_planks");
    swing(player);
    check("a swing in the cooldown says so", meleeLines().some((l) => /sledgehammer/.test(l) && /cooling/.test(l)), meleeLines().join(" | "));

    lines.length = 0;
    fake.advance(60);
    player.location = { ...NEAR_THE_HOLD };
    player.aimAt = { ...cells[0] };
    swing(player);
    check("a bound block says it is kept", meleeLines().some((l) => /sledgehammer/.test(l) && /robbery/.test(l)), meleeLines().join(" | "));
    done();
});
