import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, system, world, load, checks, strip } from "./helpers.mjs";

// systems/npcprobe.ts: a measurement, not a feature. What matters is that it records what the real game does with a vanilla NPC
// (does a click reach a script, does cancel stop it, can a script point an NPC at a dialogue scene, what does a scene's button
// report, does a spawned NPC keep its mark) as RESULT lines in the content log, that it can never break a click, and that a
// forgotten `cancel` switches itself off.

const { PlayerPermissionLevel } = fakeApi;
await load("systems/npcprobe.js");
const { listScriptEvents } = await load("core/events.js");
const { resetAllSystems } = await load("core/registry.js");
const { SHOP } = await load("config/balance.js");

const emit = (event) => system.afterEvents.scriptEventReceive.emit(event);
const op = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
const probe = (player, message) => emit({ id: "rae:npc_probe", message, sourceEntity: player, sourceType: "Entity" });

function setup() {
    fake.reset();
    resetAllSystems();
    fake.advance(1);
    probe(op(), "clear");
}

/** Everything the probe wrote to the content log while `fn` ran. */
function logged(fn) {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args.join(" "));
    try { fn(); } finally { console.warn = original; }
    return lines;
}

const results = (lines) => lines.filter((l) => l.includes("[npc-probe] RESULT"));
const hasResult = (lines, fragment) => results(lines).some((l) => l.includes(fragment));

const click = (player, target, { cancel = false } = {}) => {
    const event = { player, target, itemStack: undefined, cancel };
    world.beforeEvents.playerInteractWithEntity.emit(event);
    if (!event.cancel) world.afterEvents.playerInteractWithEntity.emit({ player, target, itemStack: undefined });
    return event;
};

test("the probe's script event is registered", () => {
    assert.ok(listScriptEvents().includes("rae:npc_probe"));
});

test("only an operator may use it, and a command with no player does nothing", () => {
    setup();
    const { check, done } = checks();
    const mem = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });

    const lines = logged(() => {
        probe(mem, "spawn");
        emit({ id: "rae:npc_probe", message: "spawn", sourceType: "Block" });
    });
    fake.advance(1);

    check("the member was told", mem.messages.map(strip).some((m) => /for operators/.test(m)));
    check("no NPC was made", fake.entities.filter((e) => e.typeId === SHOP.npcType).length === 0);
    check("the missing player is noted", lines.some((l) => /needs a player/.test(l)), lines.join(" | "));
    done();
});

test("log records every click on an NPC the game reports, before and after, and nothing else", () => {
    setup();
    const { check, done } = checks();
    const player = op();
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });
    const cow = fake.makeEntity({ typeId: "minecraft:cow" });

    probe(player, "log on");
    const lines = logged(() => { click(player, npc); click(player, cow); });
    check("an NPC click is logged before and after", lines.filter((l) => /click BEFORE/.test(l)).length === 1 && lines.filter((l) => /click AFTER/.test(l)).length === 1, lines.join(" | "));
    check("a cow click is not", !lines.some((l) => l.includes("fake-entity") && l.includes(cow.id)));

    probe(player, "log off");
    const quiet = logged(() => click(player, npc));
    check("with log off nothing is written", quiet.length === 0, quiet.join(" | "));

    const report = logged(() => probe(player, "report"));
    check("the counts are kept even when not logging", hasResult(report, "clicks on NPCs seen: before / after / cancelled = 2 / 2 / 0"), report.join(" | "));
    done();
});

test("cancel stops the click and counts it, so the report can say whether the game still opened its screen", () => {
    setup();
    const { check, done } = checks();
    const player = op();
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });

    probe(player, "cancel on");
    const event = click(player, npc);
    check("the event was cancelled", event.cancel === true);

    probe(player, "cancel off");
    check("with cancel off a click is not cancelled", click(player, npc).cancel === false);

    const report = logged(() => probe(player, "report"));
    check("one cancelled, and the cancelled click had no after event", hasResult(report, "= 2 / 1 / 1"), report.join(" | "));
    done();
});

test("cancel switches itself off after its safety timeout, and a round reset switches it off too", () => {
    setup();
    const { check, done } = checks();
    const player = op();
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });

    probe(player, "cancel on");
    check("on", click(player, npc).cancel === true);

    const lines = logged(() => fake.advance(SHOP.probeCancelAutoOffTicks + 1));
    check("it said so", lines.some((l) => /cancel switched itself off/.test(l)), lines.join(" | "));
    check("and clicks are no longer cancelled", click(player, npc).cancel === false);

    probe(player, "cancel on");
    resetAllSystems();
    check("a round reset also switches it off", click(player, npc).cancel === false);
    done();
});

test("the before handler touches nothing the engine forbids in restricted execution, even while cancelling and logging", () => {
    setup();
    const player = op();
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });
    probe(player, "log on");
    probe(player, "cancel on");
    fake.strictBefore = true;
    try {
        assert.doesNotThrow(() => logged(() => click(player, npc)));
    } finally {
        fake.strictBefore = false;
    }
});

test("spawn makes a marked, named NPC and logs the answer to every question the shop depends on", () => {
    setup();
    const { check, done } = checks();
    const player = op();

    const lines = logged(() => { probe(player, "spawn"); fake.advance(1); });

    const npcs = fake.entities.filter((e) => e.typeId === SHOP.npcType);
    check("one NPC", npcs.length === 1);
    const npc = npcs[0];
    check("it carries the probe tag, a property and a name", npc?.hasTag(SHOP.probeTag) && npc.getDynamicProperty(SHOP.probeProperty) === 1 && npc.nameTag === "Probe 1");

    check("RESULT spawn", hasResult(lines, "spawn = ok id="));
    check("RESULT tag", hasResult(lines, "tag = ok"));
    check("RESULT dynamic property", hasResult(lines, "dynamic property = ok"));
    check("RESULT nameTag set and read back", hasResult(lines, "nameTag set = ok") && hasResult(lines, 'nameTag read back = "ok (Probe 1)"'), results(lines).join(" | "));
    check("RESULT dialogue change right after spawning", hasResult(lines, "dialogue change right after spawning = ok"));
    check("RESULT the NPC component", hasResult(lines, "NPC component = ok"));
    check("the dialogue change was sent to the probe scene", fake.dimension("overworld").commands.includes(`dialogue change @s ${SHOP.probeScene}`));
    done();
});

test("a second dialogue change is tried 10 ticks after the spawn, in case the first needed the NPC to settle", () => {
    setup();
    const player = op();
    probe(player, "spawn");
    fake.advance(1);

    const lines = logged(() => fake.advance(SHOP.sceneRetryTicks));
    assert.ok(hasResult(lines, "dialogue change 10 ticks after spawning = ok"), lines.join(" | "));
});

test("when the engine refuses a step the probe logs the engine's own words and carries on", () => {
    setup();
    const { check, done } = checks();
    const player = op();

    const realSpawn = player.dimension.spawnEntity;
    player.dimension.spawnEntity = () => { throw new Error("the chunk is not loaded"); };
    let failed;
    try {
        failed = logged(() => { probe(player, "spawn"); fake.advance(1); });
    } finally {
        player.dimension.spawnEntity = realSpawn;
    }
    check("spawn THREW is a finding, not a crash", hasResult(failed, "spawn = THREW Error: the chunk is not loaded"), results(failed).join(" | "));
    check("the player is told to look in the log", player.messages.map(strip).some((m) => /could not be made/.test(m)));

    // A command the engine refuses: the NPC is made, the refusal is recorded.
    player.dimension.spawnEntity = (type, location) => {
        const entity = realSpawn.call(player.dimension, type, location);
        entity.runCommand = () => { throw new Error("dialogue: no such scene"); };
        return entity;
    };
    let refused;
    try {
        refused = logged(() => { probe(player, "spawn"); fake.advance(SHOP.sceneRetryTicks + 1); });
    } finally {
        player.dimension.spawnEntity = realSpawn;
    }
    check("a refused dialogue change is logged both times", results(refused).filter((l) => l.includes("dialogue change") && l.includes("THREW Error: dialogue: no such scene")).length === 2, results(refused).join(" | "));
    done();
});

test("scene, name, component and open work on the probe NPC the player looks at, else the nearest, and say when there is none", () => {
    setup();
    const { check, done } = checks();
    const player = op();

    const none = logged(() => probe(player, "scene"));
    check("with no probe NPC the player is told how to make one", player.messages.map(strip).some((m) => /spawn makes one/.test(m)) && results(none).length === 0, none.join(" | "));

    probe(player, "spawn");
    fake.advance(1);
    const [npc] = fake.entities.filter((e) => e.typeId === SHOP.npcType);
    fake.dimension("overworld").commands.length = 0;

    const scene = logged(() => probe(player, "scene"));
    check("scene points it at the probe scene again", hasResult(scene, "dialogue change = ok") && fake.dimension("overworld").commands.includes(`dialogue change @s ${SHOP.probeScene}`));

    const named = logged(() => probe(player, "name Old Pete"));
    check("name sets and reads back", hasResult(named, "nameTag set = ok") && npc.nameTag === "Old Pete" && hasResult(named, 'read back = "ok (Old Pete)"'), results(named).join(" | "));

    const component = logged(() => probe(player, "component"));
    check("component answers", hasResult(component, "NPC component = "));

    const open = logged(() => probe(player, "open"));
    check("open runs dialogue open as the player on the nearest probe NPC", hasResult(open, "dialogue open = ok") && fake.dimension("overworld").commands.includes(`dialogue open @e[tag=${SHOP.probeTag},c=1] @s ${SHOP.probeScene}`), fake.dimension("overworld").commands.join(" | "));
    done();
});

test("a scene's button reports who ran it, as what, and who pressed it", () => {
    setup();
    const { check, done } = checks();
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });
    const ada = fake.makePlayer("Ada", { permission: PlayerPermissionLevel.Member });
    const opp = op();

    const button = logged(() => emit({ id: "rae:npc_probe", message: "btn A", sourceEntity: npc, initiator: ada, sourceType: "NPCDialogue" }));
    check("the NPC, the player who pressed it, and that she is not an operator", hasResult(button, "button A = fromNpc=true entity=minecraft:npc initiator=minecraft:player Ada operator=false"), results(button).join(" | "));

    const typed = logged(() => emit({ id: "rae:npc_probe", message: "btn typed", sourceEntity: opp, sourceType: "Entity" }));
    check("typed by hand it is not from an NPC", hasResult(typed, "button typed = fromNpc=false entity=minecraft:player initiator=none"), results(typed).join(" | "));

    const report = logged(() => probe(opp, "report"));
    check("the report lists the buttons pressed", hasResult(report, "buttons pressed = A | typed"), results(report).join(" | "));
    done();
});

test("report lists every probe NPC with its property and name, and clear forgets the counts", () => {
    setup();
    const { check, done } = checks();
    const player = op();

    probe(player, "spawn");
    probe(player, "spawn");
    fake.advance(1);

    const report = logged(() => probe(player, "report"));
    check("two probe NPCs found", hasResult(report, "probe NPCs found = 2"));
    check("each is listed with its property and name", results(report).filter((l) => /probe NPC fake-entity/.test(l) && /property=ok \(\d\)/.test(l) && /nameTag="ok \(Probe \d\)"/.test(l)).length === 2, results(report).join(" | "));

    const npc = fake.entities.find((e) => e.typeId === SHOP.npcType);
    click(player, npc);
    probe(player, "clear");
    const cleared = logged(() => probe(player, "report"));
    check("clear forgot the click counts", hasResult(cleared, "= 0 / 0 / 0"), results(cleared).join(" | "));
    done();
});

test("an unknown subcommand says how to use it", () => {
    setup();
    const player = op();
    probe(player, "frobnicate");
    assert.ok(player.messages.map(strip).some((m) => /Usage: \/scriptevent rae:npc_probe/.test(m)));
    probe(player, "log maybe");
    assert.ok(player.messages.map(strip).some((m) => /Usage/.test(m)));
});
