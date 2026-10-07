import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, checks } from "./helpers.mjs";

// The pieces of the test double the shop tests lean on (items with enchantments and potions, an inventory that answers copies,
// per-kind stack limits, dropped items). They are pinned here so that if someone "fixes" the fake, the tests that trust it do
// not pass for the wrong reason. All of it is opt-in: a player only has the real inventory with `{ inventory: true }`.

const { ItemStack, Potions, EnchantmentTypes, EnchantmentType } = fakeApi;

test("an item holds as many as its kind does, and a test can override one", () => {
    const { check, done } = checks();
    check("a sword holds one", new ItemStack("minecraft:iron_sword").maxAmount === 1);
    check("armour holds one", new ItemStack("minecraft:iron_chestplate").maxAmount === 1);
    check("a potion holds one", new ItemStack("minecraft:potion").maxAmount === 1 && new ItemStack("minecraft:splash_potion").maxAmount === 1);
    check("an ender pearl holds sixteen", new ItemStack("minecraft:ender_pearl").maxAmount === 16);
    check("an empty bucket holds sixteen, a full one holds one", new ItemStack("minecraft:bucket").maxAmount === 16 && new ItemStack("minecraft:water_bucket").maxAmount === 1);
    check("anything else holds sixty-four", new ItemStack("minecraft:arrow").maxAmount === 64 && new ItemStack("minecraft:gold_ingot").maxAmount === 64);

    fake.maxStacks.set("minecraft:arrow", 32);
    check("an override applies", new ItemStack("minecraft:arrow").maxAmount === 32);
    fake.maxStacks.clear();
    done();
});

test("enchantments: only enchantable items have the component, and the engine's own errors are thrown", () => {
    const { check, done } = checks();
    const bow = new ItemStack("minecraft:bow");
    const flame = EnchantmentTypes.get("minecraft:flame");

    check("a bow can be enchanted", bow.getComponent("minecraft:enchantable") !== undefined);
    check("an arrow cannot", new ItemStack("minecraft:arrow").getComponent("minecraft:enchantable") === undefined);
    check("an unknown enchantment is not found", EnchantmentTypes.get("minecraft:nonsense") === undefined);
    check("making an unknown type throws", (() => { try { new EnchantmentType("minecraft:nonsense"); return false; } catch (err) { return /Unknown/.test(err.message); } })());

    const component = bow.getComponent("minecraft:enchantable");
    component.addEnchantment({ type: flame, level: 1 });
    check("it reads back", component.getEnchantments().length === 1 && component.getEnchantments()[0].type.id === "minecraft:flame");

    check("a level too high throws", (() => { try { component.addEnchantment({ type: flame, level: 2 }); return false; } catch (err) { return /OutOfBounds/.test(err.message); } })());
    check("an enchantment that does not fit throws", (() => { try { new ItemStack("minecraft:iron_sword").getComponent("minecraft:enchantable").addEnchantment({ type: flame, level: 1 }); return false; } catch (err) { return /NotCompatible/.test(err.message); } })());

    const copy = bow.clone();
    check("a clone keeps its enchantments", copy.getComponent("minecraft:enchantable").getEnchantments().length === 1);
    done();
});

test("potions: Potions.resolve makes the item for an effect and a delivery, and refuses what the engine refuses", () => {
    const { check, done } = checks();
    const splash = Potions.resolve("Swiftness", "ThrowSplash");

    check("a splash potion is its own item", splash.typeId === "minecraft:splash_potion");
    check("it reports its effect and delivery", splash.getComponent("minecraft:potion").potionEffectType.id === "Swiftness" && splash.getComponent("minecraft:potion").potionDeliveryType.id === "ThrowSplash");
    check("a drinkable one is a potion", Potions.resolve("Healing", "Consume").typeId === "minecraft:potion");
    check("an item that is not a potion has no potion component", new ItemStack("minecraft:stick").getComponent("minecraft:potion") === undefined);
    check("an unknown effect throws", (() => { try { Potions.resolve("Nonsense", "Consume"); return false; } catch (err) { return /InvalidPotionEffectType/.test(err.message); } })());
    check("an unknown delivery throws", (() => { try { Potions.resolve("Healing", "Eat"); return false; } catch (err) { return /InvalidPotionDeliveryType/.test(err.message); } })());
    check("a clone keeps the potion", splash.clone().potion.effect === "Swiftness");
    done();
});

test("stacking: only the same kind, name, lore, enchantments and potion stack", () => {
    const { check, done } = checks();
    const a = new ItemStack("minecraft:gold_ingot", 1);
    const b = new ItemStack("minecraft:gold_ingot", 1);
    check("the same kind stacks", a.isStackableWith(b));
    b.nameTag = "Shiny";
    check("a name stops it", !a.isStackableWith(b));
    const c = new ItemStack("minecraft:gold_ingot", 1);
    c.setLore(["x"]);
    check("lore stops it", !a.isStackableWith(c));
    check("another kind does not", !a.isStackableWith(new ItemStack("minecraft:iron_ingot")));
    check("two potions of different effects do not", !Potions.resolve("Healing", "Consume").isStackableWith(Potions.resolve("Swiftness", "Consume")));
    done();
});

test("a player with { inventory: true } has a real bag that answers copies, as the engine does", () => {
    fake.reset();
    const { check, done } = checks();
    const p = fake.makePlayer("Ada", { inventory: true });
    const bag = p.getComponent("minecraft:inventory").container;

    check("thirty-six slots", bag.size === 36 && bag.emptySlotsCount === 36);

    const stack = new ItemStack("minecraft:gold_ingot", 10);
    bag.setItem(0, stack);
    stack.amount = 99;
    check("setItem keeps a copy: changing the original afterwards changes nothing", bag.getItem(0).amount === 10);

    const read = bag.getItem(0);
    read.amount = 3;
    check("getItem answers a copy: changing it changes nothing until it is put back", bag.getItem(0).amount === 10);
    bag.setItem(0, read);
    check("put back, it changes", bag.getItem(0).amount === 3);

    check("addItem stacks into what is there", bag.addItem(new ItemStack("minecraft:gold_ingot", 5)) === undefined && bag.getItem(0).amount === 8);
    check("a named stack does not merge into a plain one", bag.addItem((() => { const s = new ItemStack("minecraft:gold_ingot", 1); s.nameTag = "Shiny"; return s; })()) === undefined && bag.getItem(1)?.nameTag === "Shiny");

    for (let i = 0; i < 36; i++) bag.setItem(i, new ItemStack("minecraft:stone", 64));
    const leftover = bag.addItem(new ItemStack("minecraft:iron_sword", 1));
    check("a full bag hands back what did not fit", leftover?.amount === 1 && leftover.typeId === "minecraft:iron_sword");

    fake.restricted = 1;
    try {
        check("changing a bag is refused in restricted execution", (() => { try { bag.setItem(0, undefined); return false; } catch (err) { return /restricted execution/.test(err.message); } })());
        check("reading one is not", bag.getItem(0)?.typeId === "minecraft:stone");
    } finally {
        fake.restricted = 0;
    }
    done();
});

test("an ordinary fake player keeps the minimal bag every older test uses", () => {
    fake.reset();
    const p = fake.makePlayer("Ada");
    const bag = p.getComponent("minecraft:inventory").container;
    const stack = { typeId: "minecraft:stick", amount: 1 };
    bag.setItem(2, stack);
    assert.equal(bag.getItem(2), stack, "the very same object comes back");
});

test("spawnItem is recorded with the stack and where it landed, and cleared by reset", () => {
    fake.reset();
    const dim = fake.dimension("overworld");
    const stack = new ItemStack("minecraft:bread", 2);
    const entity = dim.spawnItem(stack, { x: 1, y: 2, z: 3 });
    assert.equal(dim.spawnedItems.length, 1);
    assert.equal(dim.spawnedItems[0].stack, stack);
    assert.deepEqual(dim.spawnedItems[0].location, { x: 1, y: 2, z: 3 });
    assert.equal(entity.getComponent("minecraft:item").itemStack, stack);
    fake.reset();
    assert.equal(dim.spawnedItems.length, 0);
});

test("a player looks at the entities a test puts in front of them", () => {
    fake.reset();
    const p = fake.makePlayer("Ada");
    const npc = fake.makeEntity({ typeId: "minecraft:npc" });
    assert.deepEqual(p.getEntitiesFromViewDirection(), [], "nothing by default");
    p.aimEntities = [npc];
    assert.equal(p.getEntitiesFromViewDirection()[0].entity, npc);
    npc.remove();
    assert.deepEqual(p.getEntitiesFromViewDirection(), [], "a removed entity is not seen");
});
