import { test } from "node:test";
import { fake, system, world, fakeApi, checks } from "./helpers.mjs";

// The test double itself. Every robbery test leans on the pieces added to test/fake/minecraft-server.mjs for that work
// (the block store, restricted execution, the validating command registry), so they are pinned here: if someone
// "fixes" the fake, the tests that trust it would pass for the wrong reason.

const { BlockPermutation, BlockVolume, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, ItemStack, PlayerPermissionLevel } = fakeApi;
const overworld = fake.dimension("overworld");

test("a placed block reads back: type, states, and a door starts shut", () => {
    fake.reset();
    const { check, done } = checks();

    fake.placeBlock("overworld", { x: 1, y: 70, z: 2 }, "minecraft:iron_door", { upper_block_bit: false });
    const block = overworld.getBlock({ x: 1.4, y: 70.9, z: 2.2 });

    check("the type", block.typeId === "minecraft:iron_door");
    check("states given are kept", block.permutation.getState("upper_block_bit") === false);
    check("a door gets open_bit false when none is given", block.permutation.getState("open_bit") === false);
    check("an empty place is air", overworld.getBlock({ x: 9, y: 70, z: 9 }).typeId === "minecraft:air");
    done();
});

test("setPermutation with withState changes the block; withState leaves the original permutation alone", () => {
    fake.reset();
    const { check, done } = checks();

    const block = fake.placeBlock("overworld", { x: 0, y: 70, z: 0 }, "minecraft:iron_door");
    const shut = block.permutation;
    block.setPermutation(shut.withState("open_bit", true));

    check("the block is open now", overworld.getBlock({ x: 0, y: 70, z: 0 }).permutation.getState("open_bit") === true);
    check("the old permutation is untouched", shut.getState("open_bit") === false);
    check("matches() compares type and the states asked about", block.permutation.matches("minecraft:iron_door", { open_bit: true }) && !block.permutation.matches("minecraft:iron_door", { open_bit: false }));
    done();
});

test("a block in an unloaded chunk has no handle, and its handle goes invalid when the chunk unloads", () => {
    fake.reset();
    const { check, done } = checks();

    const block = fake.placeBlock("overworld", { x: 5, y: 70, z: 5 }, "minecraft:chest");
    check("loaded: the handle is valid", block.isValid === true && overworld.getBlock({ x: 5, y: 70, z: 5 }) !== undefined);

    fake.setUnloaded("overworld", [{ from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 100, z: 10 } }]);
    check("unloaded: getBlock answers undefined", overworld.getBlock({ x: 5, y: 70, z: 5 }) === undefined);
    check("and the old handle is no longer valid", block.isValid === false);
    check("outside the box is still loaded", overworld.getBlock({ x: 50, y: 70, z: 5 }) !== undefined);

    fake.reset();
    check("reset loads everything again", overworld.getBlock({ x: 5, y: 70, z: 5 }) !== undefined);
    check("and clears the blocks", overworld.getBlock({ x: 5, y: 70, z: 5 }).typeId === "minecraft:air");
    done();
});

test("only chests and barrels have a container; it stacks, reports what did not fit, and clears", () => {
    fake.reset();
    const { check, done } = checks();

    const chest = fake.placeBlock("overworld", { x: 0, y: 70, z: 0 }, "minecraft:chest");
    const stone = fake.placeBlock("overworld", { x: 1, y: 70, z: 0 }, "minecraft:stone");
    check("stone has no inventory", stone.getComponent("minecraft:inventory") === undefined);

    const container = chest.getComponent("minecraft:inventory").container;
    check("a single chest has 27 slots", container.size === 27 && container.emptySlotsCount === 27);

    check("a stack goes in whole", container.addItem(new ItemStack("minecraft:gold_ingot", 40)) === undefined);
    check("the next stack tops it up to 64 and spills the rest into a new slot", container.addItem(new ItemStack("minecraft:gold_ingot", 40)) === undefined
        && container.getItem(0).amount === 64 && container.getItem(1).amount === 16, `${container.getItem(0)?.amount} ${container.getItem(1)?.amount}`);

    for (let i = 0; i < 40; i++) container.addItem(new ItemStack("minecraft:iron_ingot", 64));
    const leftover = container.addItem(new ItemStack("minecraft:iron_ingot", 5));
    check("a full chest hands back what did not fit", leftover?.amount === 5, JSON.stringify(leftover));

    // A handle fetched again sees the same contents: the container belongs to the block, not to the handle.
    check("the contents belong to the block", overworld.getBlock({ x: 0, y: 70, z: 0 }).getComponent("minecraft:inventory").container.getItem(0).amount === 64);

    container.clearAll();
    check("clearAll empties it", container.emptySlotsCount === 27);
    done();
});

test("a double chest is one 54-slot container seen from both halves", () => {
    fake.reset();
    const { check, done } = checks();

    const a = fake.placeBlock("overworld", { x: 0, y: 70, z: 0 }, "minecraft:chest");
    const b = fake.placeBlock("overworld", { x: 1, y: 70, z: 0 }, "minecraft:chest");
    fake.pairChests("overworld", { x: 0, y: 70, z: 0 }, { x: 1, y: 70, z: 0 });

    a.getComponent("minecraft:inventory").container.addItem(new ItemStack("minecraft:gold_ingot", 3));
    const other = b.getComponent("minecraft:inventory").container;

    check("54 slots", other.size === 54);
    check("an item put in through one half is there through the other", other.getItem(0)?.typeId === "minecraft:gold_ingot");
    done();
});

test("fillBlocks is recorded as before and also writes the block store", () => {
    fake.reset();
    const { check, done } = checks();

    overworld.fillBlocks(new BlockVolume({ x: 0, y: 70, z: 0 }, { x: 2, y: 71, z: 0 }), BlockPermutation.resolve("minecraft:iron_block"));

    check("recorded", overworld.filled.length === 1);
    check("six blocks written", ["0,70,0", "1,70,0", "2,70,0", "0,71,0", "1,71,0", "2,71,0"].every((k) => overworld.blocks.get(k) === "minecraft:iron_block"));
    check("nothing outside the volume", overworld.blocks.get("3,70,0") === undefined);
    done();
});

test("strict before events run restricted: world changes throw, reads and messages do not, and it ends cleanly", () => {
    fake.reset();
    const { check, done } = checks();

    const player = fake.makePlayer("Ada");
    const block = fake.placeBlock("overworld", { x: 0, y: 70, z: 0 }, "minecraft:chest");
    const outcome = {};
    const attempt = (name, fn) => { try { fn(); outcome[name] = "ok"; } catch (err) { outcome[name] = String(err); } };

    const handler = () => {
        attempt("setPermutation", () => block.setPermutation(block.permutation));
        attempt("spawnEntity", () => overworld.spawnEntity("minecraft:cow", { x: 0, y: 70, z: 0 }));
        attempt("runCommand", () => overworld.runCommand("say hi"));
        attempt("addTag", () => player.addTag("x"));
        attempt("playSound", () => player.playSound("random.orb"));
        attempt("setActionBar", () => player.onScreenDisplay.setActionBar("hi"));
        attempt("addItem", () => block.getComponent("minecraft:inventory").container.addItem(new ItemStack("minecraft:stick", 1)));
        attempt("sendMessage", () => player.sendMessage("hi"));
        attempt("setDynamicProperty", () => world.setDynamicProperty("k", "v"));
        attempt("getBlock", () => overworld.getBlock({ x: 0, y: 70, z: 0 }));
        attempt("getLootTable", () => world.getLootTableManager().getLootTable("chests/none"));
    };

    world.beforeEvents.playerInteractWithBlock.subscribe(handler);

    // Off by default: nothing about the older tests changes.
    world.beforeEvents.playerInteractWithBlock.emit({});
    check("not strict by default: a world change is allowed", outcome.setPermutation === "ok" && outcome.spawnEntity === "ok");

    fake.strictBefore = true;
    world.beforeEvents.playerInteractWithBlock.emit({});

    for (const name of ["setPermutation", "spawnEntity", "runCommand", "addTag", "playSound", "setActionBar", "addItem"]) {
        check(`${name} is refused`, /cannot be used in restricted execution/.test(outcome[name]), outcome[name]);
    }
    for (const name of ["sendMessage", "setDynamicProperty", "getBlock", "getLootTable"]) {
        check(`${name} is allowed`, outcome[name] === "ok", outcome[name]);
    }

    check("restricted ended with the event", fake.restricted === 0);
    block.setPermutation(block.permutation);
    check("so a deferred system.run may change the world", true);

    world.beforeEvents.playerInteractWithBlock.unsubscribe(handler);
    done();
});

test("a handler that throws still leaves restricted mode", () => {
    fake.reset();
    const { check, done } = checks();

    const handler = () => { throw new Error("boom"); };
    world.beforeEvents.playerInteractWithBlock.subscribe(handler);
    fake.strictBefore = true;

    let thrown = false;
    try { world.beforeEvents.playerInteractWithBlock.emit({}); } catch { thrown = true; }

    check("the error reached the caller", thrown);
    check("restricted did not stick", fake.restricted === 0);
    world.beforeEvents.playerInteractWithBlock.unsubscribe(handler);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The command registry
// ---------------------------------------------------------------------------------------------------------

let register = () => {};
system.beforeEvents.startup.subscribe((event) => register(event.customCommandRegistry));

const reasonOf = (fn) => { try { fn(); return undefined; } catch (err) { return String(err.message ?? err); } };

test("registration enforces namespaces, enum-before-command and no duplicates", () => {
    fake.reset();
    const { check, done } = checks();
    const problems = {};
    const noop = () => undefined;

    register = (registry) => {
        problems.bareEnum = reasonOf(() => registry.registerEnum("bare", ["a"]));
        problems.bareCommand = reasonOf(() => registry.registerCommand({ name: "bare", permissionLevel: CommandPermissionLevel.Any }, noop));
        problems.emptyEnum = reasonOf(() => registry.registerEnum("rae:empty", []));

        registry.registerEnum("rae:kind", ["door", "chest"]);
        problems.duplicateEnum = reasonOf(() => registry.registerEnum("rae:kind", ["x"]));
        problems.enumFirst = reasonOf(() => registry.registerCommand({ name: "rae:a", permissionLevel: CommandPermissionLevel.Any, mandatoryParameters: [{ name: "rae:later", type: CustomCommandParamType.Enum }] }, noop));
        problems.noLevel = reasonOf(() => registry.registerCommand({ name: "rae:b" }, noop));

        registry.registerCommand({ name: "rae:ok", permissionLevel: CommandPermissionLevel.Any, mandatoryParameters: [{ name: "rae:kind", type: CustomCommandParamType.Enum }] }, noop);
        problems.duplicateCommand = reasonOf(() => registry.registerCommand({ name: "rae:ok", permissionLevel: CommandPermissionLevel.Any }, noop));
    };

    const started = fake.startUp();

    check("a bare enum name is refused with the engine's own words", /prefixed with a namespace/.test(problems.bareEnum), problems.bareEnum);
    check("a bare command name too", /prefixed with a namespace/.test(problems.bareCommand), problems.bareCommand);
    check("an empty enum is refused", /non-empty/.test(problems.emptyEnum), problems.emptyEnum);
    check("a second enum of the same name is refused", /already registered/.test(problems.duplicateEnum), problems.duplicateEnum);
    check("a command naming an enum that does not exist yet is refused", /not registered/.test(problems.enumFirst), problems.enumFirst);
    check("a command without a permission level is refused", /permissionLevel/.test(problems.noLevel), problems.noLevel);
    check("a second command of the same name is refused", /already registered/.test(problems.duplicateCommand), problems.duplicateCommand);
    check("the good command is registered", started.commands.has("rae:ok") && !started.commands.has("rae:a"));
    done();
});

test("registering after startup is refused", () => {
    fake.reset();
    const { check, done } = checks();
    let kept;
    register = (registry) => { kept = registry; };

    fake.startUp();

    check("enum", /startup/.test(reasonOf(() => kept.registerEnum("rae:late", ["a"]))));
    check("command", /startup/.test(reasonOf(() => kept.registerCommand({ name: "rae:late", permissionLevel: CommandPermissionLevel.Any }, () => undefined))));
    done();
});

test("run acts out typing a command: permission, argument count and types, enum membership, restricted callback", () => {
    fake.reset();
    const { check, done } = checks();
    const calls = [];

    register = (registry) => {
        registry.registerEnum("rae:kind", ["door", "chest"]);
        registry.registerCommand({
            name: "rae:make", permissionLevel: CommandPermissionLevel.GameDirectors,
            mandatoryParameters: [{ name: "rae:kind", type: CustomCommandParamType.Enum }, { name: "count", type: CustomCommandParamType.Integer }],
            optionalParameters: [{ name: "label", type: CustomCommandParamType.String }]
        }, (origin, ...args) => {
            let world_change = "allowed";
            try { overworld.runCommand("say hi"); } catch { world_change = "refused"; }
            calls.push({ args, world_change });
            return { status: CustomCommandStatus.Success, message: "made" };
        });
        registry.registerCommand({ name: "rae:anyone", permissionLevel: CommandPermissionLevel.Any }, () => ({ status: CustomCommandStatus.Success }));
    };

    const { run } = fake.startUp();
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
    const member = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });

    check("a member is turned away from an operator command", run("rae:make", { sourceEntity: member }, "door", 1).refused === "permission");
    check("anyone may run an unrestricted command", run("rae:anyone", { sourceEntity: member }).status === CustomCommandStatus.Success);
    check("a command block (no entity) counts as an operator", run("rae:make", { sourceEntity: undefined }, "door", 1)?.status === CustomCommandStatus.Success);
    check("a missing argument is a syntax error", run("rae:make", { sourceEntity: op }, "door").refused === "syntax");
    check("too many arguments are a syntax error", run("rae:make", { sourceEntity: op }, "door", 1, "x", "y").refused === "syntax");
    check("a decimal is not an Integer", run("rae:make", { sourceEntity: op }, "door", 1.5).refused === "syntax");
    check("a word that is not in the enum is a syntax error", run("rae:make", { sourceEntity: op }, "vault", 1).refused === "syntax");

    calls.length = 0;
    const good = run("rae:make", { sourceEntity: op }, "chest", 3, "front");
    check("a good command runs the callback with the typed arguments", good.message === "made" && calls.length === 1 && calls[0].args.join(",") === "chest,3,front", JSON.stringify(calls));
    check("the callback ran in restricted execution", calls[0].world_change === "refused");
    check("and restricted ended after it", fake.restricted === 0);
    done();
});
