import { test } from "node:test";
import { fake, load, checks } from "./helpers.mjs";

// core/robberyworld.ts: everything a robbery does to blocks. The contract is that nothing throws, that a position in an
// unloaded chunk is "not now" (undefined / false, nothing written) and not an error, and that a door is always swung as a
// pair, because setting one half alone leaves the two out of step (measured in the real game).

const W = await load("core/robberyworld.js");

const overworld = fake.dimension("overworld");
const LOW = [10, 70, 10];
const HIGH = [10, 71, 10];
const openBit = (pos) => fake.blockAt("overworld", { x: pos[0], y: pos[1], z: pos[2] }).permutation.getState("open_bit");

function ironDoor() {
    fake.placeBlock("overworld", { x: LOW[0], y: LOW[1], z: LOW[2] }, "minecraft:iron_door", { upper_block_bit: false });
    fake.placeBlock("overworld", { x: HIGH[0], y: HIGH[1], z: HIGH[2] }, "minecraft:iron_door", { upper_block_bit: true });
}

const chestAt = (pos) => fake.placeBlock("overworld", { x: pos[0], y: pos[1], z: pos[2] }, "minecraft:chest");
const contents = (pos) => {
    const container = fake.blockAt("overworld", { x: pos[0], y: pos[1], z: pos[2] }).getComponent("minecraft:inventory").container;
    const out = [];
    for (let i = 0; i < container.size; i++) if (container.getItem(i)) out.push(`${container.getItem(i).typeId.replace("minecraft:", "")}x${container.getItem(i).amount}`);
    return out;
};

// ---------------------------------------------------------------------------------------------------------

test("a door is read and swung as a pair, whichever half is asked about", () => {
    fake.reset();
    const { check, done } = checks();
    ironDoor();

    check("shut to begin with", W.readDoor("overworld", [LOW, HIGH]) === "closed");
    check("opening both reports success", W.setDoor("overworld", [LOW, HIGH], true) === true);
    check("both halves are open", openBit(LOW) === true && openBit(HIGH) === true);
    check("read back as open", W.readDoor("overworld", [LOW, HIGH]) === "open");

    check("closing through the LOWER half alone still swings both", W.setDoor("overworld", [LOW], false) && openBit(LOW) === false && openBit(HIGH) === false);
    W.setDoor("overworld", [HIGH], true);
    check("opening through the UPPER half alone still swings both", openBit(LOW) === true && openBit(HIGH) === true);
    done();
});

test("a door whose halves disagree reads as mixed, and swinging it fixes both", () => {
    fake.reset();
    const { check, done } = checks();
    ironDoor();

    const upper = fake.blockAt("overworld", { x: HIGH[0], y: HIGH[1], z: HIGH[2] });
    upper.setPermutation(upper.permutation.withState("open_bit", true));

    check("mixed", W.readDoor("overworld", [LOW, HIGH]) === "mixed");
    W.setDoor("overworld", [LOW, HIGH], false);
    check("shut again, both halves", openBit(LOW) === false && openBit(HIGH) === false && W.readDoor("overworld", [LOW, HIGH]) === "closed");
    done();
});

test("a door that is already as wanted is not rewritten", () => {
    fake.reset();
    const { check, done } = checks();
    ironDoor();

    // Count the writes the code makes by wrapping the blocks the dimension hands out.
    let writes = 0;
    const original = overworld.getBlock;
    overworld.getBlock = (location) => {
        const block = original.call(overworld, location);
        if (!block) return block;
        const set = block.setPermutation;
        block.setPermutation = (permutation) => { writes++; set(permutation); };
        return block;
    };

    try {
        check("shutting a shut door succeeds", W.setDoor("overworld", [LOW, HIGH], false) === true);
        check("and writes nothing", writes === 0, String(writes));
        W.setDoor("overworld", [LOW, HIGH], true);
        check("opening it writes the two halves", writes === 2, String(writes));
        W.setDoor("overworld", [LOW, HIGH], true);
        check("opening it again writes nothing more", writes === 2, String(writes));
    } finally { overworld.getBlock = original; }
    done();
});

test("trapdoors and gates swing through the same open_bit; a block that does not swing is not touched", () => {
    fake.reset();
    const { check, done } = checks();

    fake.placeBlock("overworld", { x: 0, y: 70, z: 0 }, "minecraft:iron_trapdoor");
    fake.placeBlock("overworld", { x: 2, y: 70, z: 0 }, "minecraft:fence_gate");
    fake.placeBlock("overworld", { x: 4, y: 70, z: 0 }, "minecraft:stone");

    check("a trapdoor opens", W.setDoor("overworld", [[0, 70, 0]], true) && openBit([0, 70, 0]) === true);
    check("a gate opens", W.setDoor("overworld", [[2, 70, 0]], true) && openBit([2, 70, 0]) === true);
    check("stone cannot, and says so", W.setDoor("overworld", [[4, 70, 0]], true) === false);
    check("stone is still stone", W.typeAt("overworld", [4, 70, 0]) === "minecraft:stone");
    check("and reads as unknown", W.readDoor("overworld", [[4, 70, 0]]) === "unknown");
    done();
});

test("a door in an unloaded chunk is unknown, cannot be swung, and nothing is written", () => {
    fake.reset();
    const { check, done } = checks();
    ironDoor();

    fake.setUnloaded("overworld", [{ from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 100, z: 20 } }]);

    check("unknown", W.readDoor("overworld", [LOW, HIGH]) === "unknown");
    check("swinging answers false", W.setDoor("overworld", [LOW, HIGH], true) === false);
    check("not loaded", W.isLoaded("overworld", LOW) === false && W.blockAt("overworld", LOW) === undefined && W.typeAt("overworld", LOW) === undefined);

    fake.setUnloaded("overworld", []);
    check("and nothing was written meanwhile", openBit(LOW) === false && openBit(HIGH) === false);
    check("it works once loaded", W.setDoor("overworld", [LOW, HIGH], true) && openBit(HIGH) === true);
    done();
});

test("clicking a door binds both halves; clicking anything else binds the one block", () => {
    fake.reset();
    const { check, done } = checks();
    ironDoor();
    fake.placeBlock("overworld", { x: 20, y: 70, z: 20 }, "minecraft:iron_door", { upper_block_bit: false });   // a door with no upper half
    fake.placeBlock("overworld", { x: 30, y: 70, z: 30 }, "minecraft:stone");

    check("the lower half gives lower then upper", JSON.stringify(W.cellsToBind("overworld", LOW)) === JSON.stringify([LOW, HIGH]), JSON.stringify(W.cellsToBind("overworld", LOW)));
    check("the upper half gives the same list", JSON.stringify(W.cellsToBind("overworld", HIGH)) === JSON.stringify([LOW, HIGH]));
    check("a half with no partner is just itself", JSON.stringify(W.cellsToBind("overworld", [20, 70, 20])) === JSON.stringify([[20, 70, 20]]));
    check("stone is just itself", JSON.stringify(W.cellsToBind("overworld", [30, 70, 30])) === JSON.stringify([[30, 70, 30]]));
    check("air is just itself", JSON.stringify(W.cellsToBind("overworld", [99, 70, 99])) === JSON.stringify([[99, 70, 99]]));
    done();
});

// ---------------------------------------------------------------------------------------------------------

test("a chest is filled from its loot table and then its fixed items", () => {
    fake.reset();
    const { check, done } = checks();
    fake.lootTables.set("chests/gold_2", [["minecraft:gold_ingot", 12], ["minecraft:emerald", 3]]);
    chestAt([5, 70, 5]);

    const result = W.fillChest("overworld", [[5, 70, 5]], "chests/gold_2", [["minecraft:diamond", 2]]);

    check("it worked", result.ok === true && result.problem === undefined, JSON.stringify(result));
    check("three stacks went in", result.stacks === 3);
    check("the table's loot, then the fixed items", contents([5, 70, 5]).join() === "gold_ingotx12,emeraldx3,diamondx2", contents([5, 70, 5]).join());
    check("it is not empty any more", W.chestIsEmpty("overworld", [[5, 70, 5]]) === false);
    done();
});

test("a chest with only fixed items, or only a table, fills too; a missing table is reported but the items still go in", () => {
    fake.reset();
    const { check, done } = checks();
    chestAt([5, 70, 5]);
    chestAt([8, 70, 5]);

    const onlyItems = W.fillChest("overworld", [[5, 70, 5]], undefined, [["minecraft:diamond", 5]]);
    check("fixed items alone", onlyItems.ok && contents([5, 70, 5]).join() === "diamondx5", JSON.stringify(onlyItems));

    const missing = W.fillChest("overworld", [[8, 70, 5]], "chests/no_such_table", [["minecraft:diamond", 1]]);
    check("the problem names the table", missing.ok === true && /no loot table chests\/no_such_table/.test(missing.problem ?? ""), JSON.stringify(missing));
    check("the fixed item is there anyway", contents([8, 70, 5]).join() === "diamondx1");
    done();
});

test("a chest that is too full says what did not fit; a double chest takes it all", () => {
    fake.reset();
    const { check, done } = checks();
    fake.lootTables.set("big", Array.from({ length: 30 }, () => ["minecraft:gold_ingot", 64]));   // more than 27 slots
    chestAt([5, 70, 5]);

    const single = W.fillChest("overworld", [[5, 70, 5]], "big", []);
    check("a single chest fills up and reports the rest", single.ok === true && single.stacks === 27 && /192 items did not fit/.test(single.problem ?? ""), JSON.stringify(single));

    fake.lootTables.set("one_huge_stack", [["minecraft:gold_ingot", 64 * 30]]);
    chestAt([40, 70, 5]);
    const huge = W.fillChest("overworld", [[40, 70, 5]], "one_huge_stack", []);
    check("a stack that only partly fits still counts as placed", huge.ok === true && huge.stacks === 1 && /192 items did not fit/.test(huge.problem ?? ""), JSON.stringify(huge));

    chestAt([20, 70, 5]);
    chestAt([21, 70, 5]);
    fake.pairChests("overworld", { x: 20, y: 70, z: 5 }, { x: 21, y: 70, z: 5 });
    const double = W.fillChest("overworld", [[20, 70, 5], [21, 70, 5]], "big", []);
    check("a double chest holds it all", double.ok === true && double.problem === undefined, JSON.stringify(double));
    done();
});

test("when a double chest is two separate halves, what the first cannot hold goes in the second", () => {
    fake.reset();
    const { check, done } = checks();
    fake.lootTables.set("big", Array.from({ length: 30 }, () => ["minecraft:gold_ingot", 64]));
    chestAt([5, 70, 5]);
    chestAt([6, 70, 5]);

    const result = W.fillChest("overworld", [[5, 70, 5], [6, 70, 5]], "big", []);

    check("no problem: it fit across the two", result.ok && result.problem === undefined, JSON.stringify(result));
    check("the second half got the overflow", contents([6, 70, 5]).length > 0, contents([6, 70, 5]).join());
    done();
});

test("filling something that is not a container, or is not loaded, fails without changing anything", () => {
    fake.reset();
    const { check, done } = checks();
    fake.placeBlock("overworld", { x: 1, y: 70, z: 1 }, "minecraft:stone");
    chestAt([5, 70, 5]);

    const stone = W.fillChest("overworld", [[1, 70, 1]], undefined, [["minecraft:diamond", 1]]);
    check("stone is not a container", stone.ok === false && /no container/.test(stone.problem ?? ""), JSON.stringify(stone));

    fake.setUnloaded("overworld", [{ from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 100, z: 10 } }]);
    const away = W.fillChest("overworld", [[5, 70, 5]], undefined, [["minecraft:diamond", 1]]);
    check("an unloaded chest is reported as such", away.ok === false && /not loaded/.test(away.problem ?? ""), JSON.stringify(away));

    fake.setUnloaded("overworld", []);
    check("nothing went into it", W.chestIsEmpty("overworld", [[5, 70, 5]]));
    done();
});

test("emptying clears every block of the chest, tolerates a block that stopped being a container, and waits for an unloaded one", () => {
    fake.reset();
    const { check, done } = checks();
    chestAt([5, 70, 5]);
    chestAt([6, 70, 5]);
    W.fillChest("overworld", [[5, 70, 5]], undefined, [["minecraft:diamond", 3]]);
    W.fillChest("overworld", [[6, 70, 5]], undefined, [["minecraft:diamond", 3]]);

    check("emptying both succeeds", W.emptyChest("overworld", [[5, 70, 5], [6, 70, 5]]) === true);
    check("both are empty", W.chestIsEmpty("overworld", [[5, 70, 5], [6, 70, 5]]));

    fake.placeBlock("overworld", { x: 7, y: 70, z: 5 }, "minecraft:stone");
    check("a cell that is not a container any more counts as clean", W.emptyChest("overworld", [[7, 70, 5]]) === true);

    chestAt([9, 70, 5]);
    W.fillChest("overworld", [[9, 70, 5]], undefined, [["minecraft:diamond", 1]]);
    fake.setUnloaded("overworld", [{ from: { x: 9, y: 0, z: 0 }, to: { x: 9, y: 100, z: 10 } }]);
    check("an unloaded chest cannot be emptied yet", W.emptyChest("overworld", [[9, 70, 5]]) === false);
    check("and does not read as empty", W.chestIsEmpty("overworld", [[9, 70, 5]]) === false);

    fake.setUnloaded("overworld", []);
    check("once loaded it can", W.emptyChest("overworld", [[9, 70, 5]]) && W.chestIsEmpty("overworld", [[9, 70, 5]]));
    done();
});

test("nothing here throws when the engine does", () => {
    fake.reset();
    const { check, done } = checks();
    ironDoor();
    chestAt([5, 70, 5]);

    const original = overworld.getBlock;
    overworld.getBlock = () => { throw new Error("PositionInUnloadedChunkError"); };
    let threw = false;
    let results;
    try {
        results = [
            W.readDoor("overworld", [LOW, HIGH]), W.setDoor("overworld", [LOW, HIGH], true), W.fillChest("overworld", [[5, 70, 5]], undefined, []),
            W.emptyChest("overworld", [[5, 70, 5]]), W.chestIsEmpty("overworld", [[5, 70, 5]]), W.typeAt("overworld", LOW), W.cellsToBind("overworld", LOW)
        ];
    } catch { threw = true; } finally { overworld.getBlock = original; }

    check("no exception reached the caller", !threw);
    check("the answers are the safe ones", results?.[0] === "unknown" && results?.[1] === false && results?.[2].ok === false && results?.[3] === false && results?.[4] === false && results?.[5] === undefined, JSON.stringify(results));

    check("a dimension with no door in it is just unknown", W.readDoor("mars", [LOW]) === "unknown");
    done();
});
