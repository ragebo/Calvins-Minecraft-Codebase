import { test } from "node:test";
import { fake, system, world, fakeApi, load, checks, strip } from "./helpers.mjs";

// `/scriptevent rae:robbery_probe` records how the game reports a right-click on a chest, door, button or lever, and
// whether `cancel` stops it, before the robbery framework is built on any of that. These tests cannot say what the
// REAL game reports. They check that the probe records what it is told correctly, judges "did the click do its
// thing" the way its report says, drives the world only when asked, never throws into the game, and switches
// itself off. Block interaction events are acted out with small fake blocks.

const { PlayerPermissionLevel, ItemStack, CommandPermissionLevel, CustomCommandStatus } = fakeApi;
const { ROBBERY: R } = await load("config/balance.js");
await load("systems/robberyprobe.js");
const { resetAllSystems } = await load("core/registry.js");

const logs = [];
const errors = [];
const realWarn = console.warn;
const realError = console.error;
console.warn = (...args) => logs.push(args.join(" "));
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; console.error = realError; });

const lines = () => logs.filter((l) => l.startsWith("[robbery-probe]")).map((l) => l.slice("[robbery-probe] ".length));
const results = () => lines().filter((l) => l.startsWith("RESULT ")).map((l) => l.slice("RESULT ".length));
const say = (player, message) => system.afterEvents.scriptEventReceive.emit({ id: "rae:robbery_probe", sourceEntity: player, message });
const text = (player) => player.messages.map(strip).join("\n");

// ---------------------------------------------------------------------------------------------------------
// Fake blocks: the parts the probe reads (type, position, states, neighbours, a container)
// ---------------------------------------------------------------------------------------------------------

const blocks = new Map();
const key = (x, y, z) => `${x},${y},${z}`;

function makeContainer(size = 27) {
    const slots = new Array(size).fill(undefined);
    return {
        size,
        get emptySlotsCount() { return slots.filter((s) => s === undefined).length; },
        getItem(i) { return slots[i]; },
        setItem(i, stack) { slots[i] = stack; },
        addItem(stack) { const i = slots.findIndex((s) => s === undefined); if (i === -1) return stack; slots[i] = stack; return undefined; },
        clearAll() { slots.fill(undefined); }
    };
}

function putBlock(typeId, x, y, z, states = {}, withContainer = false) {
    const block = {
        typeId, isValid: true, location: { x, y, z }, dimension: fake.dimension("overworld"), states: { ...states },
        container: withContainer ? makeContainer() : undefined,
        get permutation() {
            const make = (s) => ({ getAllStates: () => ({ ...s }), withState: (k, v) => make({ ...s, [k]: v }) });
            return make(block.states);
        },
        setPermutation(p) { block.states = p.getAllStates(); },
        above() { return blocks.get(key(x, y + 1, z)); },
        below() { return blocks.get(key(x, y - 1, z)); },
        getComponent(id) { return id === "minecraft:inventory" && block.container ? { container: block.container } : undefined; }
    };
    blocks.set(key(x, y, z), block);
    return block;
}

/** A two-block door: [lower, upper]. */
function putDoor(typeId, x, y, z) {
    return [
        putBlock(typeId, x, y, z, { upper_block_bit: false, open_bit: false }),
        putBlock(typeId, x, y + 1, z, { upper_block_bit: true, open_bit: false })
    ];
}

const overworld = fake.dimension("overworld");
const realGetBlock = overworld.getBlock;
overworld.getBlock = (loc) => blocks.get(key(Math.floor(loc.x), Math.floor(loc.y), Math.floor(loc.z))) ?? realGetBlock(loc);

/** What the engine does to a door when it is clicked: both halves swing. */
function swing([lower, upper]) {
    const open = !lower.states.open_bit;
    lower.states.open_bit = open;
    upper.states.open_bit = open;
}

function fresh(options = {}) {
    resetAllSystems();
    fake.reset();
    blocks.clear();
    logs.length = 0;
    errors.length = 0;
    return fake.makePlayer("Ada", { location: { x: 0, y: 64, z: 0 }, permission: PlayerPermissionLevel.Operator, ...options });
}

const click = (player, block, extra = {}) => {
    const event = { block, player, blockFace: "Up", faceLocation: { x: 0, y: 0, z: 0 }, isFirstEvent: true, itemStack: undefined, cancel: false, ...extra };
    world.beforeEvents.playerInteractWithBlock.emit(event);
    return event;
};

const aimAt = (player, block) => { player.getBlockFromViewDirection = () => (block ? { block } : undefined); };

// ---------------------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------------------

function emitEverything(player, chest, button, plate) {
    click(player, chest, { itemStack: { typeId: "bountysys:robbery_wand" } });
    world.afterEvents.playerInteractWithBlock.emit({ block: chest, player, blockFace: "Up", isFirstEvent: true, itemStack: { typeId: "bountysys:robbery_wand" } });
    world.afterEvents.blockContainerOpened.emit({ block: chest, openSource: { entity: player } });
    world.afterEvents.blockContainerClosed.emit({ block: chest, closeSource: { entity: player } });
    world.afterEvents.buttonPush.emit({ block: button, source: player });
    world.afterEvents.leverAction.emit({ block: button, isPowered: true, player });
    world.afterEvents.pressurePlatePush.emit({ block: plate, previousRedstonePower: 0, redstonePower: 15, source: player });
    world.afterEvents.pressurePlatePop.emit({ block: plate, previousRedstonePower: 15, redstonePower: 0 });
    world.afterEvents.tripWireTrip.emit({ block: plate, isPowered: true, sources: [player] });
    world.afterEvents.itemStartUseOn.emit({ block: chest, blockFace: "Up", itemStack: { typeId: "bountysys:robbery_wand" }, source: player });
    world.afterEvents.playerPlaceBlock.emit({ block: chest, player });
    world.beforeEvents.playerBreakBlock.emit({ block: chest, player, itemStack: undefined, cancel: false });
    world.beforeEvents.explosion.emit({ dimension: overworld, getImpactedBlocks: () => [chest, button], cancel: false });
    world.afterEvents.itemUse.emit({ itemStack: { typeId: "bountysys:robbery_wand" }, source: player });
    world.afterEvents.playerSwingStart.emit({ swingSource: "Attack", heldItemStack: { typeId: "bountysys:robbery_wand" }, player });
}

test("nothing is logged until `log on`, and every kind of block event writes one line once it is", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);
    const button = putBlock("minecraft:stone_button", 5, 64, 3);
    const plate = putBlock("minecraft:stone_pressure_plate", 7, 64, 3);
    aimAt(p, chest);

    emitEverything(p, chest, button, plate);
    check("silent by default", lines().length === 0, lines().join("\n"));

    say(p, "log on");
    check("it says logging is on", /Logging on/.test(text(p)), text(p));
    emitEverything(p, chest, button, plate);
    const all = lines().join("\n");

    for (const name of [
        "before minecraft:chest", "after minecraft:chest", "containerOpened minecraft:chest", "containerClosed minecraft:chest",
        "buttonPush minecraft:stone_button", "leverAction", "pressurePlatePush minecraft:stone_pressure_plate",
        "pressurePlatePop", "tripWireTrip", "itemStartUseOn minecraft:chest", "placed minecraft:chest",
        "before break minecraft:chest", "before explosion impacted=2", "itemUse bountysys:robbery_wand aimed=minecraft:chest",
        "swing source=Attack aimed=minecraft:chest"
    ]) check(`logs "${name}"`, all.includes(name), all);

    check("the held item and sneaking are recorded on a click", /before minecraft:chest at 3,64,3 face=Up first=true held=bountysys:robbery_wand sneak=false cancel=false/.test(all), all);

    say(p, "log off");
    const count = lines().length;
    emitEverything(p, chest, button, plate);
    check("off again: silent", lines().length === count, `${count} -> ${lines().length}`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------------------------------------

test("`cancel on` sets cancel in the interact before-event and nothing else; `cancel off` stops", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);

    check("default: a click is not cancelled", click(p, chest).cancel === false);

    say(p, "cancel on");
    check("it warns that cancel is on", /Cancel ON for interact/.test(text(p)), text(p));
    check("interact cancelled", click(p, chest).cancel === true);

    const breakEvent = { block: chest, player: p, cancel: false };
    world.beforeEvents.playerBreakBlock.emit(breakEvent);
    check("breaking is NOT cancelled by the interact switch", breakEvent.cancel === false);

    say(p, "cancel off");
    check("interact allowed again", click(p, chest).cancel === false);

    say(p, "cancel break on");
    const broken = { block: chest, player: p, cancel: false };
    world.beforeEvents.playerBreakBlock.emit(broken);
    check("break cancelled", broken.cancel === true);

    say(p, "cancel explode on");
    const blast = { dimension: overworld, getImpactedBlocks: () => [], cancel: false };
    world.beforeEvents.explosion.emit(blast);
    check("explosion cancelled", blast.cancel === true);

    say(p, "cancel sideways on");
    check("an unknown kind is refused with the usage", /Usage/.test(text(p)), text(p));
    done();
});

test("a forgotten `cancel on` switches itself off after the safety timeout, and a round reset clears it at once", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);

    say(p, "cancel on");
    fake.advance(R.probeCancelAutoOffTicks - 1);
    check("still on just before the timeout", click(p, chest).cancel === true);
    fake.advance(1);
    check("off at the timeout", click(p, chest).cancel === false);
    check("and it says so in the log", lines().some((l) => /switched itself off/.test(l)), lines().join("\n"));

    say(p, "cancel on");
    resetAllSystems();
    check("a round reset switches it off", click(p, chest).cancel === false);
    logs.length = 0;
    fake.advance(R.probeCancelAutoOffTicks);
    check("and leaves no timer behind to log later", !lines().some((l) => /switched itself off/.test(l)), lines().join(", "));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Judging whether a click did its thing, and the report
// ---------------------------------------------------------------------------------------------------------

test("a door that swings counts as 'happened'; a cancelled click that leaves it alone makes cancel EFFECTIVE", () => {
    const { check, done } = checks();
    const p = fresh();
    const door = putDoor("minecraft:wooden_door", 10, 64, 10);
    say(p, "log on");

    click(p, door[0]);
    swing(door);                                   // the engine opens it, as it does for a normal click
    fake.advance(R.probeEvaluateTicks);

    say(p, "cancel on");
    click(p, door[0]);                             // cancelled: the engine leaves it alone
    fake.advance(R.probeEvaluateTicks);

    say(p, "report");
    const row = results().find((r) => r.startsWith("matrix = wooden_door [hand]"));
    check("the row exists", row !== undefined, results().join("\n"));
    check("normal 1/1, cancelled 0/1", /normal 1\/1 \| cancelled 0\/1/.test(row ?? ""), row);
    check("verdict: effective", /cancel EFFECTIVE/.test(row ?? ""), row);
    check("the chat summary carries the same row", /wooden_door \[hand\].*cancel EFFECTIVE/.test(text(p)), text(p));
    done();
});

test("a container that opens anyway makes cancel INEFFECTIVE; the same click without cancel is the baseline", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);
    const opened = () => world.afterEvents.blockContainerOpened.emit({ block: chest, openSource: { entity: p } });
    say(p, "log on");

    click(p, chest); opened(); fake.advance(R.probeEvaluateTicks);
    say(p, "cancel on");
    click(p, chest); opened(); fake.advance(R.probeEvaluateTicks);     // the GUI opened despite cancel

    say(p, "report");
    const row = results().find((r) => r.startsWith("matrix = chest [hand]"));
    check("both outcomes counted", /normal 1\/1 \| cancelled 1\/1/.test(row ?? ""), row);
    check("verdict: ineffective", /cancel INEFFECTIVE/.test(row ?? ""), row);
    check("the container event is on the row", /container.*before|before.*container/.test(row ?? ""), row);
    done();
});

test("a held right-click repeats the event; only the first of each press is judged", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);
    say(p, "log on");

    click(p, chest);
    click(p, chest, { isFirstEvent: false });
    click(p, chest, { isFirstEvent: false });
    fake.advance(R.probeEvaluateTicks);

    say(p, "report");
    const row = results().find((r) => r.startsWith("matrix = chest [hand]"));
    check("one judged click, not three", /normal 0\/1/.test(row ?? ""), row);
    done();
});

test("an event with no click of its own is credited to the click just before it, or marked unattributed", () => {
    const { check, done } = checks();
    const p = fresh();
    const lever = putBlock("minecraft:lever", 4, 64, 4);
    const button = putBlock("minecraft:stone_button", 6, 64, 4);
    say(p, "log on");

    click(p, lever, { itemStack: { typeId: "minecraft:stick" } });
    world.afterEvents.leverAction.emit({ block: lever, isPowered: true, player: p });
    world.afterEvents.buttonPush.emit({ block: button, source: p });         // nobody clicked it: a redstone arrow, say

    say(p, "report");
    const rows = results().filter((r) => r.startsWith("matrix"));
    check("the lever event is on the stick row", rows.some((r) => /^matrix = lever \[stick\]: .*lever/.test(r)), rows.join("\n"));
    check("the button push is marked as having no click", rows.some((r) => /stone_button \[\(no click seen\)\]/.test(r)), rows.join("\n"));
    done();
});

test("`report` with nothing recorded says so, and `clear` forgets what was seen", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);

    say(p, "report");
    check("nothing yet", /Nothing recorded/.test(text(p)), text(p));

    say(p, "log on");
    click(p, chest);
    say(p, "report");
    check("a click makes a row", /chest \[hand\]/.test(text(p)), text(p));
    say(p, "clear");
    p.messages.length = 0;
    say(p, "report");
    check("cleared", /Nothing recorded/.test(text(p)), text(p));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The restricted-mode battery
// ---------------------------------------------------------------------------------------------------------

test("`restricted on` tries a fixed list of APIs inside the before event and logs one RESULT for each", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);

    say(p, "restricted on");
    click(p, chest);

    const found = results().filter((r) => r.startsWith("restricted[before interact]"));
    check("ten APIs tried", found.length === 10, found.join("\n"));
    for (const name of ["Player.sendMessage", "world.setDynamicProperty", "LootTableManager.getLootTable", "Dimension.spawnParticle", "Block.setPermutation", "Dimension.runCommand", "Entity.addTag", "Dimension.spawnEntity"]) {
        check(`tries ${name}`, found.some((r) => r.includes(name)), found.join("\n"));
    }

    say(p, "restricted off");
    logs.length = 0;
    click(p, chest);
    check("off again: no more", results().filter((r) => r.startsWith("restricted")).length === 0);
    done();
});

test("an API that throws inside the battery is logged with the engine's own error text, not thrown", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);
    const realRun = overworld.runCommand;
    overworld.runCommand = () => { const e = new Error("restricted-execution: runCommand is not allowed here"); e.name = "InvalidStateError"; throw e; };

    try {
        say(p, "restricted on");
        click(p, chest);
    } finally {
        overworld.runCommand = realRun;
    }

    const row = results().find((r) => r.includes("Dimension.runCommand"));
    check("the failure and its text are in the log", /THREW InvalidStateError: restricted-execution/.test(row ?? ""), row);
    check("the rest of the battery still ran", results().filter((r) => r.startsWith("restricted")).length === 10);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// bench, door, container, loot, structure, view, tick, itemprop
// ---------------------------------------------------------------------------------------------------------

test("`bench` lays out the test blocks along +X from in front of the player, and only an operator may", () => {
    const { check, done } = checks();
    const p = fresh();
    const member = fake.makePlayer("Ben", { permission: PlayerPermissionLevel.Member });
    const placed = (x, y, z) => overworld.blocks.get(key(x, y, z));
    overworld.blocks.clear();

    say(member, "bench");
    check("a member is refused", /Operators only/.test(text(member)), text(member));
    check("and nothing was placed", overworld.blocks.size === 0);

    // Under the fake, blocks have no permutation to set, so the stateful ones fall back to the plain type.
    const realGetBlock = overworld.getBlock;
    overworld.getBlock = realGetBlock;
    blocks.clear();

    say(p, "bench");
    const base = { x: 2, y: 64, z: 3 };
    check("chest first", placed(base.x, base.y, base.z) === "minecraft:chest", String(placed(base.x, base.y, base.z)));
    check("trapped chest one gap along", placed(base.x + R.probeBenchSpacing, base.y, base.z) === "minecraft:trapped_chest");
    check("a button has stone to sit on", placed(base.x + 5 * R.probeBenchSpacing, base.y, base.z) === "minecraft:stone" && placed(base.x + 5 * R.probeBenchSpacing, base.y, base.z + 1) === "minecraft:stone_button");
    check("a door has two halves", placed(base.x + 8 * R.probeBenchSpacing, base.y, base.z) === "minecraft:wooden_door" && placed(base.x + 8 * R.probeBenchSpacing, base.y + 1, base.z) === "minecraft:wooden_door");
    check("one RESULT per placement", results().filter((r) => r.startsWith("bench ")).length === 13, results().join("\n"));
    check("the player is told the order", /in the order: chest, trapped_chest, barrel/.test(text(p)), text(p));
    done();
});

test("`door open both` sets open_bit on both halves, `lower` only the lower, and samples the state afterwards", () => {
    const { check, done } = checks();
    const p = fresh();
    const door = putDoor("minecraft:iron_door", 10, 64, 10);
    aimAt(p, door[1]);                                          // looking at the UPPER half: the probe must still find the lower

    say(p, "door open both");
    check("both halves open", door[0].states.open_bit === true && door[1].states.open_bit === true, JSON.stringify([door[0].states, door[1].states]));

    say(p, "door close both");
    say(p, "door open lower");
    check("lower only: lower open, upper still closed", door[0].states.open_bit === true && door[1].states.open_bit === false, JSON.stringify([door[0].states, door[1].states]));

    fake.advance(Math.max(...R.probeDoorSampleTicks));      // let the earlier commands' samples fire before counting
    logs.length = 0;
    say(p, "door open both");
    fake.advance(Math.max(...R.probeDoorSampleTicks));
    const samples = results().filter((r) => r.startsWith("door +"));
    check("one sample per configured delay", samples.length === R.probeDoorSampleTicks.length, samples.join("\n"));
    check("a sample reads both halves", /lower open=true upper open=true/.test(samples[0] ?? ""), samples.join("\n"));
    check("the block states are logged", results().some((r) => r.startsWith("door states of minecraft:iron_door")));
    done();
});

test("`door` with nothing in sight says so; a member may not drive a door", () => {
    const { check, done } = checks();
    const p = fresh();
    aimAt(p, undefined);
    say(p, "door open both");
    check("asks to look at a door", /Look at a door/.test(text(p)), text(p));

    const member = fake.makePlayer("Ben", { permission: PlayerPermissionLevel.Member });
    say(member, "door open both");
    check("a member is refused", /Operators only/.test(text(member)), text(member));
    done();
});

test("`container` reads the size, fills a slot, adds an item, reads it back and empties it again", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3, {}, true);
    aimAt(p, chest);

    say(p, "container");
    const all = results().join("\n");
    check("size 27", /container size = ok \(27\)/.test(all), all);
    check("setItem and addItem worked", /container setItem\(0\) = ok/.test(all) && /container addItem = ok/.test(all), all);
    check("slot 0 reads back what was set", /container readback slot 0 = ok \(minecraft:gold_nugget x3\)/.test(all), all);
    check("it was emptied again", chest.container.emptySlotsCount === 27 && /container emptySlotsCount cleared = ok \(27\)/.test(all), all);
    done();
});

test("`container` on a block with no inventory says so instead of throwing", () => {
    const { check, done } = checks();
    const p = fresh();
    aimAt(p, putBlock("minecraft:stone", 3, 64, 3));
    say(p, "container");
    check("told", /no readable container/.test(text(p)), text(p));
    check("no crash, and the component answer is in the log", results().some((r) => r.startsWith("container component on minecraft:stone")));
    done();
});

test("`loot` makes loot from a table that exists and reports one that does not", () => {
    const { check, done } = checks();
    const p = fresh();
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 5], ["minecraft:gold_block", 1]]);

    say(p, "loot");
    const all = results().join("\n");
    check("the pack's own table is found and generates", /loot table chests\/gold_2 = ok \(found\)/.test(all) && /loot generate chests\/gold_2 = ok \(minecraft:gold_ingotx5, minecraft:gold_blockx1\)/.test(all), all);
    check("a vanilla path that the fake lacks is NOT FOUND, not an error", /loot table chests\/simple_dungeon = ok \(NOT FOUND\)/.test(all), all);
    check("a missing table cannot generate", /loot generate chests\/__no_such_table__ = THREW Error: table not found/.test(all), all);

    results().length = 0;
    logs.length = 0;
    say(p, "loot chests/other");
    check("a path given by hand is the only one tried", results().length === 2 && results().every((r) => r.includes("chests/other")), results().join("\n"));
    done();
});

test("`structure sizes` finds the largest cube the game accepts, cleaning up after itself", () => {
    const { check, done } = checks();
    const p = fresh();
    fake.structureMax = 64;

    say(p, "structure sizes");
    const found = results().filter((r) => r.startsWith("structure "));
    check("every configured size was tried", found.length === R.probeStructureSizes.length, found.join("\n"));
    check("sizes up to the limit are ok", found.filter((r) => /= ok/.test(r)).length === R.probeStructureSizes.filter((n) => n <= 64).length, found.join("\n"));
    check("bigger ones carry the engine's text", found.some((r) => /96x96x96 = THREW .*exceed the maximum size/.test(r)), found.join("\n"));
    check("nothing is left behind", fake.structures.size === 0, [...fake.structures].join());
    check("saved in World mode without entities", fake.structureLog.every((e) => e.options.saveMode === "World" && e.options.includeEntities === false), JSON.stringify(fake.structureLog[0]));
    done();
});

test("`structure save`, `verify`, `place` and `unloaded` act on the persist test structure", () => {
    const { check, done } = checks();
    const p = fresh();

    say(p, "structure save 4 3 5");
    check("saved under the probe id", fake.structures.has("rae:probe_persist"));
    check("with the right corners", JSON.stringify(fake.structureLog.at(-1)?.to) === JSON.stringify({ x: 3, y: 66, z: 4 }), JSON.stringify(fake.structureLog.at(-1)));

    say(p, "structure save 4 3 5");
    check("saving again replaces it instead of failing", results().filter((r) => r.startsWith("structure save")).every((r) => /= ok/.test(r)), results().join("\n"));

    say(p, "structure verify");
    check("verify reads it back and lists the world structures", results().some((r) => /structure get rae:probe_persist = ok \(rae:probe_persist\)/.test(r)) && results().some((r) => /structure world ids = ok \(rae:probe_persist\)/.test(r)), results().join("\n"));

    say(p, "structure place");
    check("placed 8 blocks east", fake.structureLog.at(-1)?.op === "place" && fake.structureLog.at(-1)?.location.x === 8, JSON.stringify(fake.structureLog.at(-1)));

    say(p, "structure unloaded");
    check("the far-away probe is reported and removed", results().some((r) => r.startsWith("structure from an unloaded area")) && !fake.structures.has("rae:probe_far"));

    say(p, "structure save 0 3 5");
    check("a bad size gets the usage line", /structure save <width>/.test(text(p)), text(p));
    done();
});

test("`view` sends a ring of particles and a floating label to the player only", () => {
    const { check, done } = checks();
    const p = fresh({ location: { x: 10, y: 64, z: 10 } });

    say(p, "view");
    check("eight particles, all private", p.privateParticles.length === 8 && p.privateParticles.every((q) => q.id === "minecraft:endrod"), JSON.stringify(p.privateParticles.slice(0, 1)));
    check("on a ring around the player", p.privateParticles.every((q) => Math.abs(Math.hypot(q.location.x - 10, q.location.z - 10) - R.probeViewRadius) < 1e-6));
    check("one floating label, visible to them alone", fake.shapes.length === 1 && fake.shapes[0].text.visibleTo[0] === p && fake.shapes[0].text.timeLeft === R.probeViewSeconds);
    check("both outcomes are in the log", results().some((r) => r.startsWith("view Player.spawnParticle = ok")) && results().some((r) => /view TextPrimitive = ok \(maxShapes=500\)/.test(r)), results().join("\n"));
    done();
});

test("`tick create`, `list` and `remove` drive a ticking area", async () => {
    const { check, done } = checks();
    const p = fresh();

    say(p, "tick create");
    await Promise.resolve();
    check("created", fake.tickingAreas.has("rae:probe_tick"));
    check("capacity and the outcome are logged", results().some((r) => r === "ticking hasCapacity = ok (true)") && results().some((r) => r === "ticking create rae:probe_tick = ok (resolved)"), results().join("\n"));

    say(p, "tick list");
    check("listed", results().some((r) => /ticking areas = ok \(rae:probe_tick\)/.test(r)), results().join("\n"));

    say(p, "tick remove");
    check("removed", !fake.tickingAreas.has("rae:probe_tick"));

    say(p, "tick sideways");
    check("an unknown verb gets the usage", /tick create \| list \| remove/.test(text(p)), text(p));
    done();
});

test("`itemprop` tries a dynamic property on the held item: fine on a one-at-a-time item, refused on a stack", () => {
    const { check, done } = checks();
    const p = fresh();

    say(p, "itemprop");
    check("an empty hand asks for an item", /Hold an item/.test(text(p)), text(p));

    const wand = new ItemStack("bountysys:robbery_wand", 1);
    wand.maxAmount = 1;
    p.container.setItem(0, wand);
    say(p, "itemprop");
    check("a max-stack-1 item takes it", results().some((r) => r === "item bountysys:robbery_wand setDynamicProperty = ok") && results().some((r) => r === "item bountysys:robbery_wand getDynamicProperty = ok (1)"), results().join("\n"));

    p.container.setItem(0, new ItemStack("minecraft:gold_ingot", 5));
    logs.length = 0;
    say(p, "itemprop");
    check("a stack refuses it, with the engine's text", /item minecraft:gold_ingot setDynamicProperty = THREW .*non-stackable/.test(results().join("\n")), results().join("\n"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The script event itself, and staying out of the game's way
// ---------------------------------------------------------------------------------------------------------

test("a member cannot turn on cancel or the restricted battery, which would change what happens for everyone", () => {
    const { check, done } = checks();
    const op = fresh();
    const member = fake.makePlayer("Ben", { permission: PlayerPermissionLevel.Member });
    const chest = putBlock("minecraft:chest", 3, 64, 3);

    say(member, "cancel on");
    say(member, "cancel break on");
    say(member, "restricted on");
    check("each is refused with the operators-only line", (text(member).match(/Operators only/g) ?? []).length === 3, text(member));
    check("nothing was switched on: an operator's click is not cancelled", click(op, chest).cancel === false);
    check("and no battery ran", results().filter((r) => r.startsWith("restricted")).length === 0);

    say(member, "log on");
    check("logging (harmless) is still open to anyone", /Logging on/.test(text(member)), text(member));
    done();
});

test("an unknown subcommand gets the usage line; with no player it only warns", () => {
    const { check, done } = checks();
    const p = fresh();
    say(p, "dance");
    check("usage", /Usage: .*rae:robbery_probe log on\|off/.test(text(p)), text(p));

    logs.length = 0;
    say(undefined, "log on");
    check("no player: one warning, and nothing turned on", logs.some((l) => /has to be run by a player/.test(l)));
    done();
});

test("a failure inside a probe handler is reported, and never thrown into the game", () => {
    const { check, done } = checks();
    const p = fresh();
    say(p, "log on");

    let threw = null;
    try {
        world.beforeEvents.playerInteractWithBlock.emit({ block: {}, player: p, isFirstEvent: true, cancel: false });
    } catch (err) {
        threw = err;
    }

    check("the event dispatch did not throw", threw === null, String(threw));
    check("the failure was reported", errors.some((e) => /\[robbery-probe\] before interact failed/.test(e)), errors.join("\n"));
    done();
});

test("a round reset turns logging, restricted mode and cancel off and forgets the matrix", () => {
    const { check, done } = checks();
    const p = fresh();
    const chest = putBlock("minecraft:chest", 3, 64, 3);

    say(p, "log on");
    say(p, "restricted on");
    say(p, "cancel on");
    click(p, chest);
    resetAllSystems();

    logs.length = 0;
    check("a click is no longer cancelled", click(p, chest).cancel === false);
    check("nothing is logged", lines().length === 0, lines().join("\n"));
    say(p, "report");
    check("and the matrix was cleared", /Nothing recorded/.test(text(p)), text(p));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The command-context probe
// ---------------------------------------------------------------------------------------------------------

function startUp() {
    const commands = new Map();
    const registry = { registerEnum() {}, registerCommand(def, callback) { commands.set(def.name, { def, callback }); } };
    system.beforeEvents.startup.emit({ customCommandRegistry: registry });
    return commands;
}

test("rae:robbery_probe_ctx is an operator command that logs who the origin is and what it may change", () => {
    const { check, done } = checks();
    const p = fresh();
    const commands = startUp();
    const command = commands.get("rae:robbery_probe_ctx");

    check("registered", command !== undefined);
    check("operator-only", command?.def.permissionLevel === CommandPermissionLevel.GameDirectors);
    check("takes one text argument", command?.def.mandatoryParameters?.length === 1);

    // From chat: the origin is the player.
    const fromChat = command.callback({ sourceType: "Entity", sourceEntity: p, initiator: undefined, sourceBlock: undefined }, "hello");
    check("chat: it succeeds", fromChat.status === CustomCommandStatus.Success, JSON.stringify(fromChat));
    check("chat: the origin line", results().some((r) => r === "ctx origin = sourceType=Entity sourceEntity=minecraft:player initiator=none sourceBlock=none"), results().join("\n"));
    check("chat: the battery ran", results().filter((r) => r.startsWith("restricted[custom command]")).length === 10);

    // From an NPC dialogue button: the NPC is the source entity and the PLAYER is the initiator.
    logs.length = 0;
    const npc = fake.makeEntity({ typeId: "minecraft:npc", location: { x: 5, y: 64, z: 5 } });
    command.callback({ sourceType: "NPCDialogue", sourceEntity: npc, initiator: p, sourceBlock: undefined }, "hello");
    check("npc: both entities are named", results().some((r) => r === "ctx origin = sourceType=NPCDialogue sourceEntity=minecraft:npc initiator=minecraft:player sourceBlock=none"), results().join("\n"));

    // From a command block: no entity at all, only a block.
    logs.length = 0;
    const block = putBlock("minecraft:command_block", 8, 64, 8);
    command.callback({ sourceType: "Block", sourceEntity: undefined, initiator: undefined, sourceBlock: block }, "hello");
    check("command block: the block is named", results().some((r) => r === "ctx origin = sourceType=Block sourceEntity=none initiator=none sourceBlock=minecraft:command_block"), results().join("\n"));

    // From somewhere with no location at all.
    logs.length = 0;
    const nowhere = command.callback({ sourceType: "Entity", sourceEntity: undefined, initiator: undefined, sourceBlock: undefined }, "hello");
    check("no location: it fails cleanly and says so", nowhere.status === CustomCommandStatus.Failure && results().some((r) => /ctx battery = skipped/.test(r)), JSON.stringify(nowhere));
    done();
});
