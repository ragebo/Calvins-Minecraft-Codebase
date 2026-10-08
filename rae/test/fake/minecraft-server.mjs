// Stand-in for @minecraft/server, used by `npm test`.
//
// scripts/test.mjs copies this file to .test-build/node_modules/@minecraft/server/index.js,
// so the compiled game code loads it exactly where it would load the real module.
// Tests drive time and events through the exported `fake` object. Nothing here talks to
// a real game: it records what the code does so tests can assert on it.
//
// Don't edit this file from a feature branch. Extend behaviour inside your own test file
// (e.g. `fake.itemTypes.add("bountysys:x")`, or replace `world.structureManager.get`).
// If a permanent addition is needed, tell the orchestrator.
//
// Additions made on the main line stay opt-in, so every older test reads the same fake it always did:
//   - a block store (`fake.placeBlock`, `dim.getBlock(...)` with real permutations and containers),
//   - `fake.strictBefore`: "before" event handlers and custom-command callbacks run in RESTRICTED EXECUTION, where
//     the engine refuses every call its typings tag `@privilege no-restricted-execution` (measured in the real game
//     on 2026-10-06: they throw "cannot be used in restricted execution"),
//   - `fake.startUp()`: a custom-command registry that enforces the rules the real one does (namespaced names,
//     enum registered before the command that uses it, startup-only, typed arguments, permission level),
//   - item frames: `fake.setFrameItem` / `fake.frameItemAt` (what a frame block shows), `fake.punchFrame` (an assumed punch, see its
//     comment), and structures that save the frames in their box with what each shows and bring them back on `place`,
//   - `fake.passableBlocks`: type ids the default ray (`getBlockFromViewDirection`) looks straight through, as the engine's does for
//     flowers and vines, unless it is asked with `includePassableBlocks: true`,
//   - `fake.strictFrameSync` and `fake.frameShown`: what a PLAYER sees in an item frame. Off, it is the same as `fake.frameItemAt`.
//     On, it models what the owner saw on 2026-10-08 (a frame put back by placing a structure over the frame standing there held
//     its item and showed nothing): the screen is told only about a frame that is a NEW block (set from air or from another block,
//     or placed by a structure over something that was not that same frame), about `fake.setFrameItem`, and about a punch's pop,
//     never about a structure loaded into an identical frame. This is a model of a suspicion, not a measurement of the engine,
//   - `fake.hideUnloadedEntities`: a query cannot see an entity standing in a stretch `fake.setUnloaded` marked, until a ticking
//     area that has finished loading covers it; with `fake.tickingAreaDelay` (ticks a new area takes to load),
//     `fake.tickingAreaFails` (a message every new area is refused with) and `fake.tickingAreaCapacity` (chunks that fit).

export const EquipmentSlot = { Mainhand: "Mainhand", Offhand: "Offhand", Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet" };
export const EntitySwingSource = { Attack: "Attack", Build: "Build", DropItem: "DropItem", Event: "Event", Interact: "Interact", Mine: "Mine", None: "None", Place: "Place", Throw: "Throw", Use: "Use" };
export const EntityDamageCause = { entityAttack: "entityAttack", projectile: "projectile", fall: "fall", override: "override" };
export const PlayerPermissionLevel = { Visitor: 0, Member: 1, Operator: 2, Custom: 3 };
export const StructureSaveMode = { Memory: "Memory", World: "World" };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 };
export const CustomCommandParamType = {
    BlockType: "BlockType", Boolean: "Boolean", EntitySelector: "EntitySelector", EntityType: "EntityType",
    Enum: "Enum", Float: "Float", Integer: "Integer", ItemType: "ItemType", Location: "Location",
    PlayerSelector: "PlayerSelector", String: "String"
};
export const CustomCommandStatus = { Success: 0, Failure: 1 };
// Where a /scriptevent came from (`sourceType` on the event; the fake's emit passes whatever a test gives it).
export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };

// How many of an item one slot holds. The engine knows every item's own limit; the fake knows the common ones (tools, weapons,
// armour and potions hold one, a few throwables sixteen) and everything else holds 64. `fake.maxStacks` overrides one by id.
const HOLDS_ONE = /(?:sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots|bow|crossbow|trident|shield|saddle|fishing_rod|shears|elytra|flint_and_steel|water_bucket|lava_bucket|milk_bucket|potion|boat|minecart|wand|revolver|pistol|shotgun|rifle)$/;
const HOLDS_SIXTEEN = /(?:ender_pearl|snowball|egg|sign|:bucket)$/;
function maxStackOf(typeId) {
    if (fake.maxStacks.has(typeId)) return fake.maxStacks.get(typeId);
    if (HOLDS_ONE.test(typeId)) return 1;
    if (HOLDS_SIXTEEN.test(typeId)) return 16;
    return 64;
}

// What the engine says about enchantments (bare id -> highest level) and which kinds of item take them.
const ENCHANTABLE = /(?:sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots|bow|crossbow|trident|shield|fishing_rod|shears|elytra|book)$/;
const ENCHANT_ONLY_FOR = {
    flame: /bow$/, power: /bow$/, punch: /bow$/, infinity: /bow$/,
    multishot: /crossbow$/, quick_charge: /crossbow$/, piercing: /crossbow$/,
    sharpness: /(?:sword|axe)$/, fire_aspect: /sword$/, lunge: /sword$/
};
const POTION_ITEMS = { Consume: "minecraft:potion", ThrowSplash: "minecraft:splash_potion", ThrowLingering: "minecraft:lingering_potion" };

const bareId = (id) => String(id).replace(/^minecraft:/, "");

// The engine's tick rate, which scripts convert seconds with.
export const TicksPerSecond = 20;

// Effect and entity types the engine knows, looked up by `EffectTypes.get(id)` / `EntityTypes.get(id)` with or without the
// namespace. Static tables (`fake.effects`, `fake.entityTypes`): `reset` leaves them alone.
export const EffectTypes = {
    get(id) { const bare = bareId(id); return fake.effects.has(bare) ? { id: bare, getName: () => bare } : undefined; }
};
export const EntityTypes = {
    get(id) { const bare = bareId(id); return fake.entityTypes.has(bare) ? { id: `minecraft:${bare}` } : undefined; }
};

/** The animals that carry a `minecraft:tamemount` component, as the real horse family does. */
const RIDEABLE = /(?:^|:)(?:horse|mule|donkey|skeleton_horse|zombie_horse|camel|llama)$/;

export class EnchantmentType {
    constructor(id) {
        const bare = bareId(id);
        if (!fake.enchantments.has(bare)) throw new Error(`EnchantmentTypeUnknownIdError: unknown enchantment ${id}`);
        this.id = `minecraft:${bare}`;
        this.maxLevel = fake.enchantments.get(bare);
    }
}
export const EnchantmentTypes = {
    get(id) { try { return new EnchantmentType(id); } catch { return undefined; } }
};

function makeEnchantable(stack) {
    if (!ENCHANTABLE.test(stack.typeId)) return undefined;
    const add = (enchantment) => {
        restrictedCheck("ItemEnchantableComponent.addEnchantment");
        const type = enchantment.type;
        const bare = bareId(type.id);
        if (!fake.enchantments.has(bare)) throw new Error(`EnchantmentTypeUnknownIdError: ${type.id}`);
        if (!Number.isInteger(enchantment.level) || enchantment.level < 1 || enchantment.level > fake.enchantments.get(bare)) throw new Error(`EnchantmentLevelOutOfBoundsError: ${type.id} level ${enchantment.level}`);
        if (ENCHANT_ONLY_FOR[bare] && !ENCHANT_ONLY_FOR[bare].test(stack.typeId)) throw new Error(`EnchantmentTypeNotCompatibleError: ${type.id} on ${stack.typeId}`);
        stack.enchantments = [...stack.enchantments.filter((e) => e.type.id !== type.id), { type, level: enchantment.level }];
    };
    // The same checks `add` makes, answering false for an enchantment that does not fit and throwing for an unknown one or a bad level.
    const canAdd = (enchantment) => {
        const bare = bareId(enchantment.type.id);
        if (!fake.enchantments.has(bare)) throw new Error(`EnchantmentTypeUnknownIdError: ${enchantment.type.id}`);
        if (!Number.isInteger(enchantment.level) || enchantment.level < 1 || enchantment.level > fake.enchantments.get(bare)) throw new Error(`EnchantmentLevelOutOfBoundsError: ${enchantment.type.id} level ${enchantment.level}`);
        return !(ENCHANT_ONLY_FOR[bare] && !ENCHANT_ONLY_FOR[bare].test(stack.typeId));
    };
    return {
        getEnchantments() { return stack.enchantments.map((e) => ({ type: e.type, level: e.level })); },
        canAddEnchantment: canAdd,
        addEnchantment: add,
        addEnchantments(list) { for (const enchantment of list) add(enchantment); }
    };
}

// A real item stack: the type, a count, a name, a lore, enchantments, a potion, and (only for a non-stackable one) dynamic
// properties. `fake.makeItemStack` below is the lighter stand-in most tests already use.
export class ItemStack {
    constructor(typeId, amount = 1) {
        this.typeId = typeId; this.amount = amount; this.nameTag = undefined; this.lore = [];
        this.maxAmount = maxStackOf(typeId); this.properties = new Map();
        this.enchantments = [];        // [{ type: EnchantmentType, level }]
        this.potion = undefined;       // { effect, delivery }: set on a stack Potions.resolve made
    }
    clone() {
        const copy = new ItemStack(this.typeId, this.amount);
        copy.nameTag = this.nameTag; copy.lore = [...this.lore]; copy.maxAmount = this.maxAmount;
        copy.enchantments = this.enchantments.map((e) => ({ type: e.type, level: e.level }));
        copy.potion = this.potion ? { ...this.potion } : undefined;
        for (const [k, v] of this.properties) copy.properties.set(k, v);
        return copy;
    }
    isStackableWith(other) {
        const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
        const enchants = (stack) => stack.enchantments.map((e) => `${e.type.id}:${e.level}`).sort();
        return this.typeId === other.typeId && this.nameTag === other.nameTag && sameList(this.lore, other.lore)
            && sameList(enchants(this), enchants(other)) && JSON.stringify(this.potion) === JSON.stringify(other.potion)
            && this.properties.size === 0 && other.properties.size === 0;
    }
    setLore(lines = []) { this.lore = [...lines]; }
    getLore() { return [...this.lore]; }
    getComponent(id) {
        if (id === "minecraft:enchantable") return makeEnchantable(this);
        if (id === "minecraft:potion" && this.potion) return { potionEffectType: { id: this.potion.effect }, potionDeliveryType: { id: this.potion.delivery } };
        return undefined;
    }
    setDynamicProperty(k, v) {
        if (this.maxAmount > 1) throw new Error("ArgumentOutOfBoundsError: dynamic properties only work on non-stackable items");
        if (v === undefined || v === null) this.properties.delete(k); else this.properties.set(k, v);
    }
    getDynamicProperty(k) { return this.properties.get(k); }
}

// Potions.getEffectType / getDeliveryType turn an id into a handle (undefined for one the engine does not know), and
// Potions.resolve(effect, delivery) makes the potion item (the engine's own errors for an effect or delivery it does not know).
export const Potions = {
    getEffectType(id) { return fake.potionEffects.has(id) ? { id } : undefined; },
    getDeliveryType(id) { return POTION_ITEMS[id] ? { id } : undefined; },
    resolve(effect, delivery) {
        const e = typeof effect === "string" ? effect : effect?.id;
        const d = typeof delivery === "string" ? delivery : delivery?.id;
        if (!fake.potionEffects.has(e)) throw new Error(`InvalidPotionEffectTypeError: ${e}`);
        if (!POTION_ITEMS[d]) throw new Error(`InvalidPotionDeliveryTypeError: ${d}`);
        const stack = new ItemStack(POTION_ITEMS[d], 1);
        stack.potion = { effect: e, delivery: d };
        return stack;
    }
};

// Text floating in the world (world.primitiveShapesManager.addText). Only what a test reads back is kept.
export class TextPrimitive {
    constructor(location, text) {
        this.location = { ...location }; this.text = text; this.visibleTo = []; this.timeLeft = undefined;
        this.depthTest = true; this.color = undefined; this.scale = 1;
    }
    setText(text) { this.text = text; }
}
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }

// A block permutation: a type and its states. `withState` answers a NEW permutation, as the engine's does.
function makePermutation(id, states = {}) {
    const permutation = {
        type: { id },
        states: { ...states },
        getState(name) { return permutation.states[name]; },
        getAllStates() { return { ...permutation.states }; },
        withState(name, value) { return makePermutation(id, { ...permutation.states, [name]: value }); },
        matches(typeId, wanted) { return typeId === id && Object.entries(wanted ?? {}).every(([k, v]) => permutation.states[k] === v); },
        getTags() { return []; }
    };
    return permutation;
}
export const BlockPermutation = { resolve(id, states) { return makePermutation(id, states ?? {}); } };

// Restricted execution. While `fake.restricted` is above zero (a strict "before" event or a custom-command callback is
// running) every call the engine's typings tag `@privilege no-restricted-execution` throws the engine's own error.
function restrictedCheck(label) {
    if (fake.restricted > 0) throw new ReferenceError(`Native function [${label}] cannot be used in restricted execution`);
}

export const ItemTypes = {
    get(id) { return fake.itemTypes.has(id) ? { id } : undefined; },
    getAll() { return [...fake.itemTypes].map((id) => ({ id })); }
};

// ---------------------------------------------------------------------------
// Event signals. Any event name works: `world.afterEvents.whatever.subscribe(fn)`.
// Tests deliver events with `.emit(payload)`, which the real game would do itself.
// ---------------------------------------------------------------------------

function makeSignal(isBefore = false) {
    const handlers = [];
    return {
        subscribe(fn) { handlers.push(fn); return fn; },
        unsubscribe(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
        emit(payload) {
            // A "before" event runs its handlers in restricted execution when a test asks for it (fake.strictBefore).
            const strict = isBefore && fake.strictBefore;
            if (strict) fake.restricted++;
            try {
                for (const fn of [...handlers]) fn(payload);
            } finally {
                if (strict) fake.restricted--;
            }
        },
        get count() { return handlers.length; }
    };
}

function signalBag(isBefore = false) {
    const signals = new Map();
    return new Proxy({}, {
        get(_, name) {
            if (typeof name !== "string" || name === "then") return undefined;
            if (!signals.has(name)) signals.set(name, makeSignal(isBefore));
            return signals.get(name);
        }
    });
}

// ---------------------------------------------------------------------------
// Scheduler. Time only moves when a test calls fake.advance()/advanceTo().
// ---------------------------------------------------------------------------

const jobs = [];
let nextJobId = 1;
let jobOrder = 0;

function schedule(fn, ticks, repeat) {
    const job = { id: nextJobId++, due: fake.tick + ticks, every: repeat ? ticks : 0, fn, order: jobOrder++ };
    jobs.push(job);
    return job.id;
}

export const system = {
    get currentTick() { return fake.tick; },
    run(fn) { return schedule(fn, 1, false); },
    runTimeout(fn, ticks = 1) { return schedule(fn, Math.max(1, ticks), false); },
    runInterval(fn, ticks = 1) { return schedule(fn, Math.max(1, ticks), true); },
    clearRun(id) { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    afterEvents: signalBag(),
    beforeEvents: signalBag()
};

// ---------------------------------------------------------------------------
// Entities, players, dimensions
// ---------------------------------------------------------------------------

let nextEntityId = 1;

function matchesQuery(entity, options = {}) {
    const tags = options.tags ?? [];
    const exclude = options.excludeTags ?? [];
    if (!tags.every((t) => entity.tags.has(t))) return false;
    if (exclude.some((t) => entity.tags.has(t))) return false;
    if (options.type && entity.typeId !== options.type) return false;
    return true;
}

function queryPlayers(options) { return fake.players.filter((p) => matchesQuery(p, options)); }

/** The item frames in a box of a dimension, with what each shows, as offsets from the box's lowest corner (what a saved structure keeps of them). */
/** A block's states as a list sorted by name, so two blocks can be compared whatever order their states were written in. */
const sortedStates = (states) => Object.entries(states ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function framesIn(dim, from, to) {
    const min = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) };
    const max = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) };
    const found = [];

    // The block store is sparse, so look through what is there, not through every position of a box that may be 100 blocks a side.
    for (const [key, typeId] of dim.blocks) {
        if (!/(?:^|:)(?:glow_)?frame$/.test(typeId)) continue;
        const [x, y, z] = key.split(",").map(Number);
        if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) continue;
        const states = dim.blockStates.get(key);
        const item = dim.frameItems.get(key);
        found.push({ dx: x - min.x, dy: y - min.y, dz: z - min.z, typeId, states: states ? { ...states } : undefined, item: item ? { ...item } : undefined });
    }

    return found;
}

// An entity in a stretch the world has not loaded cannot be found by a query. Opt-in (`fake.hideUnloadedEntities`): the stretches
// are the ones `fake.setUnloaded` marks, and a ticking area that has FINISHED loading brings the chunks it covers back.
const chunkOf = (n) => Math.floor(n / 16);
const chunkSpan = (a, b) => chunkOf(Math.max(a, b)) - chunkOf(Math.min(a, b)) + 1;
const chunksIn = (area) => chunkSpan(area.from.x, area.to.x) * chunkSpan(area.from.z, area.to.z);
function areaCovers(area, p) {
    const within = (v, a, b) => chunkOf(v) >= chunkOf(Math.min(a, b)) && chunkOf(v) <= chunkOf(Math.max(a, b));
    return within(p.x, area.from.x, area.to.x) && within(p.z, area.from.z, area.to.z);
}
function entityReachable(dim, entity) {
    if (!fake.hideUnloadedEntities) return true;
    if (dim.isChunkLoaded(entity._location)) return true;
    return [...fake.tickingAreas].some(([id, area]) => fake.tickingAreaReady.has(id) && area.dimension === dim && areaCovers(area, entity._location));
}

// ---------------------------------------------------------------------------
// Blocks: a type per position (dim.blocks, which predates this), its states, and a container for the types that have one.
// ---------------------------------------------------------------------------

const blockKey = (location) => `${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}`;

/** The block types that carry an inventory (the ones the robbery framework binds a chest element to). */
const CONTAINER_TYPES = new Set(["minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel"]);

/** Added to a placed door/trapdoor/gate when the test names no state, because the real block always has one. */
const DEFAULT_STATES = { open_bit: false };
const hasOpenBit = (typeId) => /[:_](?:door|trapdoor|fence_gate)$/.test(typeId);

/**
 * A real container: slots, stacking addItem (answers the part that did not fit), clearAll. With `copies` it behaves as the
 * engine's does about ownership: `getItem` answers a COPY of the stack in the slot (changing it changes nothing until it is
 * put back with `setItem`) and `setItem` keeps a copy of what it is given. A player's inventory is made this way; a chest is not,
 * so older tests that read a chest's stacks in place see what they always did.
 */
function makeContainer(size, { copies = false } = {}) {
    const slots = new Array(size).fill(undefined);
    const copy = (stack) => (copies && stack?.clone ? stack.clone() : stack);
    const stacks = (a, b) => (a.isStackableWith ? a.isStackableWith(b) : a.typeId === b.typeId);
    const container = {
        isValid: true,
        size,
        get emptySlotsCount() { return slots.filter((s) => s === undefined).length; },
        getItem(i) { return copy(slots[i]); },
        setItem(i, stack) { restrictedCheck("Container.setItem"); slots[i] = copy(stack); },
        addItem(stack) {
            restrictedCheck("Container.addItem");
            let left = stack.amount;
            const max = stack.maxAmount ?? 64;
            for (let i = 0; i < slots.length && left > 0; i++) {
                const here = slots[i];
                if (here && stacks(here, stack) && here.amount < (here.maxAmount ?? 64)) {
                    const moved = Math.min(left, (here.maxAmount ?? 64) - here.amount);
                    here.amount += moved; left -= moved;
                }
            }
            for (let i = 0; i < slots.length && left > 0; i++) {
                if (slots[i] !== undefined) continue;
                const moved = Math.min(left, max);
                const placed = stack.clone ? stack.clone() : { ...stack };
                placed.amount = moved;
                slots[i] = placed; left -= moved;
            }
            if (left === 0) return undefined;
            const rest = stack.clone ? stack.clone() : { ...stack };
            rest.amount = left;
            return rest;
        },
        clearAll() { restrictedCheck("Container.clearAll"); slots.fill(undefined); }
    };
    return container;
}

function makeBlock(dim, location) {
    const x = Math.floor(location.x), y = Math.floor(location.y), z = Math.floor(location.z);
    const key = blockKey(location);
    const block = {
        dimension: dim,
        location: { x, y, z }, x, y, z,
        // A block handle is only good while its chunk is loaded.
        get isValid() { return dim.isChunkLoaded({ x, y, z }); },
        get typeId() { return dim.blocks.get(key) ?? "minecraft:air"; },
        get type() { return { id: block.typeId }; },
        get permutation() { return makePermutation(block.typeId, dim.blockStates.get(key) ?? {}); },
        setType(type) {
            restrictedCheck("Block.setType");
            dim.blocks.set(key, typeof type === "string" ? type : type.id);
            dim.blockStates.delete(key); dim.containers.delete(key); dim.frameItems.delete(key); dim.frameSeen.delete(key);
        },
        setPermutation(permutation) {
            restrictedCheck("Block.setPermutation");
            // A different block is a different block entity: what a frame showed goes with it.
            if (dim.blocks.get(key) !== permutation.type.id) { dim.containers.delete(key); dim.frameItems.delete(key); dim.frameSeen.delete(key); }
            dim.blocks.set(key, permutation.type.id);
            dim.blockStates.set(key, permutation.getAllStates());
        },
        getComponent(id) {
            if (id !== "minecraft:inventory" || !CONTAINER_TYPES.has(block.typeId)) return undefined;
            if (!dim.containers.has(key)) dim.containers.set(key, makeContainer(27));
            return { container: dim.containers.get(key) };
        }
    };
    return block;
}

function makeDimension(id) {
    const dim = {
        id,
        commands: [], played: [], spawned: [], explosions: [], filled: [],
        runCommand(command) { restrictedCheck("Dimension.runCommand"); dim.commands.push(command); return { successCount: 1 }; },
        // Mirrors the engine's documented limits so a bad cue really throws.
        playSound(soundId, location, options = {}) {
            restrictedCheck("Dimension.playSound");
            if (options.pitch !== undefined && options.pitch < 0.01) throw new Error("PropertyOutOfBoundsError: pitch");
            if (options.volume !== undefined && options.volume < 0) throw new Error("PropertyOutOfBoundsError: volume");
            dim.played.push({ tick: fake.tick, id: soundId, location: { ...location }, volume: options.volume, pitch: options.pitch });
        },
        getPlayers(options) { fake.calls.dimensionGetPlayers++; return queryPlayers(options).filter((p) => p._dimension === dim); },
        getEntities(options) { return fake.entities.filter((e) => e._dimension === dim && matchesQuery(e, options) && entityReachable(dim, e)); },
        spawnEntity(typeId, location) { restrictedCheck("Dimension.spawnEntity"); const e = fake.makeEntity({ typeId, location, dimension: dim }); dim.spawned.push(e); return e; },
        // Every item dropped into the world is kept in `spawnedItems` (the stack and where it landed).
        spawnedItems: [],
        spawnItem(stack, location) { restrictedCheck("Dimension.spawnItem"); dim.spawnedItems.push({ stack, location: { ...location } }); return fake.makeEntity({ typeId: "minecraft:item", itemStack: stack, location, dimension: dim }); },
        createExplosion(location, radius, options) { restrictedCheck("Dimension.createExplosion"); dim.explosions.push({ location, radius, options }); return true; },
        // Recorded as it always was; a BlockVolume (from/to) is also written into the block store, with the block's states.
        fillBlocks(volume, block) {
            restrictedCheck("Dimension.fillBlocks");
            dim.filled.push({ volume, permutation: block });
            const from = volume?.from, to = volume?.to;
            if (!from || !to) return;
            const typeId = typeof block === "string" ? block : block?.type?.id ?? block?.id;
            if (typeof typeId !== "string") return;
            const states = typeof block === "object" && block?.getAllStates ? block.getAllStates() : undefined;
            for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) {
                for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) {
                    for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) {
                        const key = blockKey({ x, y, z });
                        dim.blocks.set(key, typeId);
                        if (states) dim.blockStates.set(key, { ...states }); else dim.blockStates.delete(key);
                        dim.containers.delete(key); dim.frameItems.delete(key); dim.frameSeen.delete(key);
                    }
                }
            }
        },
        // Sparse: an untouched location reads as air, like a real world. Keyed by whole-number
        // coordinates only (callers that care about sub-block position round first, same as the game).
        blocks: new Map(),
        blockStates: new Map(),
        containers: new Map(),
        // The item an item frame shows. In the game a frame is a BLOCK whose block entity holds it, and the scripting API cannot read
        // or set it: a test sets it with fake.setFrameItem and reads it with fake.frameItemAt, and only a structure restores it.
        frameItems: new Map(),
        // What a player standing there SEES in the frame (see fake.strictFrameSync): updated only by changes the screen is told about.
        frameSeen: new Map(),
        // A location in an unloaded chunk has no block (the engine answers undefined).
        getBlock(location) { return dim.isChunkLoaded(location) ? makeBlock(dim, location) : undefined; },
        getBlockFromRay() { return undefined; },
        getEntitiesFromRay() { return []; },
        // An ordinary, non-desert biome by default; a test that needs a specific one replaces this.
        getBiome() { return { id: "minecraft:plains" }; },
        particles: [],
        spawnParticle(effectName, location) { restrictedCheck("Dimension.spawnParticle"); dim.particles.push({ tick: fake.tick, id: effectName, location: { ...location } }); },
        // The whole fake world counts as loaded; a test that wants an unloaded stretch replaces this.
        isChunkLoaded() { return true; }
    };
    return dim;
}

function guard(entity) { if (!entity.isValid) throw new Error("InvalidEntityError: Failed to call function due to Entity being invalid (has the Entity been removed?)."); }

function makeItemStack(typeId, amount = 1) {
    return { typeId, amount, clone() { return makeItemStack(this.typeId, this.amount); } };
}

function makeEntity(options = {}) {
    const entity = {
        id: options.id ?? `fake-entity-${nextEntityId++}`,
        typeId: options.typeId ?? "minecraft:pillager",
        tags: new Set(options.tags ?? []),
        isValid: true,
        facing: options.facing ?? { x: 0, y: 0, z: 1 },
        effects: [], damage: [], teleports: [], teleportLog: [], dynamic: new Map(),
        _location: { ...(options.location ?? { x: 0, y: 64, z: 0 }) },
        _dimension: options.dimension ?? fake.dimension("overworld"),
        hasTag(t) { guard(entity); return entity.tags.has(t); },
        addTag(t) { guard(entity); restrictedCheck("Entity.addTag"); entity.tags.add(t); return true; },
        removeTag(t) { guard(entity); restrictedCheck("Entity.removeTag"); return entity.tags.delete(t); },
        getTags() { guard(entity); return [...entity.tags]; },
        getViewDirection() { guard(entity); return entity.facing; },
        getHeadLocation() { guard(entity); return { x: entity._location.x, y: entity._location.y + 1.6, z: entity._location.z }; },
        // Momentum. `velocity` moves the entity once per tick after the scripts have run (see fake.advance),
        // scaled by fake.physics.drag afterwards. applyImpulse adds to it, as the real one does.
        velocity: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0 },
        applyImpulse(v) {
            guard(entity); restrictedCheck("Entity.applyImpulse");
            if (Math.hypot(v.x, v.y, v.z) > fake.maxImpulse) throw new Error("ArgumentOutOfBoundsError: impulse too large");
            entity.velocity = { x: entity.velocity.x + v.x, y: entity.velocity.y + v.y, z: entity.velocity.z + v.z };
        },
        clearVelocity() { guard(entity); restrictedCheck("Entity.clearVelocity"); entity.velocity = { x: 0, y: 0, z: 0 }; },
        getVelocity() { guard(entity); return { ...entity.velocity }; },
        setRotation(r) { guard(entity); restrictedCheck("Entity.setRotation"); entity.rotation = { ...r }; },
        getRotation() { guard(entity); return { ...entity.rotation }; },
        // `id` may be an effect type handle (EffectTypes.get) as well as a string: it is recorded by its id either way.
        addEffect(id, duration, opts) { guard(entity); restrictedCheck("Entity.addEffect"); entity.effects.push({ id: typeof id === "string" ? id : id?.id, duration, ...opts }); },
        removeEffect(id) {
            guard(entity); restrictedCheck("Entity.removeEffect");
            const wanted = typeof id === "string" ? id : id?.id;
            const before = entity.effects.length;
            entity.effects = entity.effects.filter((e) => e.id !== wanted);
            return entity.effects.length !== before;
        },
        applyDamage(amount, opts) { guard(entity); restrictedCheck("Entity.applyDamage"); entity.damage.push({ amount, ...opts }); return true; },
        teleport(location, options = {}) {
            guard(entity); restrictedCheck("Entity.teleport");
            entity.teleports.push({ ...location });
            entity.teleportLog.push({ location: { ...location }, dimension: options.dimension, ...(options.facingLocation ? { facing: { ...options.facingLocation } } : {}) });
            entity._location = { ...location };
            if (options.dimension) entity._dimension = options.dimension;
            if (options.rotation) entity.rotation = { ...options.rotation };
            if (!options.keepVelocity) entity.velocity = { x: 0, y: 0, z: 0 };
        },
        runCommand(command) { guard(entity); restrictedCheck("Entity.runCommand"); return entity._dimension.runCommand(command); },
        getDynamicProperty(k) { guard(entity); return entity.dynamic.get(k); },
        setDynamicProperty(k, v) { guard(entity); if (v === undefined || v === null) entity.dynamic.delete(k); else entity.dynamic.set(k, v); },
        // Entity properties (declared per entity type in the real game, with a range/default/client_sync):
        // the fake just stores whatever is set, with no range enforcement — that's real-engine behavior a
        // test of this file's own logic doesn't need modeled.
        properties: new Map(),
        getProperty(id) { guard(entity); return entity.properties.get(id); },
        setProperty(id, v) { guard(entity); restrictedCheck("Entity.setProperty"); entity.properties.set(id, v); },
        // A vehicle: entities made with `seats` (and the train car, always) accept riders. A rider is moved along
        // with the vehicle by fake.advance and reads its mount back through minecraft:riding.
        seats: options.seats ?? (options.typeId === "bountysys:train_car" ? 4 : 0),
        riders: [],
        ridingOn: undefined,
        getComponent(id) {
            guard(entity);
            if (id === "minecraft:rideable" && entity.seats > 0) {
                const live = () => entity.riders.filter((r) => r.isValid);
                return {
                    seatCount: entity.seats,
                    getRiders: () => live(),
                    addRider(rider) {
                        if (live().length >= entity.seats || rider.ridingOn) return false;
                        entity.riders.push(rider); rider.ridingOn = entity;
                        return true;
                    },
                    ejectRider(rider) { entity.riders = entity.riders.filter((r) => r !== rider); if (rider.ridingOn === entity) rider.ridingOn = undefined; },
                    ejectRiders() { for (const r of entity.riders) if (r.ridingOn === entity) r.ridingOn = undefined; entity.riders = []; }
                };
            }
            if (id === "minecraft:riding" && entity.ridingOn?.isValid) return { entityRidingOn: entity.ridingOn };
            if (id === "minecraft:item" && options.itemStack) return { itemStack: options.itemStack };
            // The horse family can be tamed: tame / tameToPlayer set `tamed` (and who by), as the real component does.
            if (id === "minecraft:tamemount" && RIDEABLE.test(entity.typeId)) {
                return {
                    get isTamed() { return entity.tamed === true; },
                    get tamedToPlayer() { return entity.tamedBy; },
                    tame(showParticles) { restrictedCheck("EntityTameMountComponent.tame"); entity.tamed = true; entity.tamedParticles = showParticles; },
                    tameToPlayer(showParticles, player) { restrictedCheck("EntityTameMountComponent.tameToPlayer"); entity.tamed = true; entity.tamedBy = player; entity.tamedParticles = showParticles; return true; }
                };
            }
            return undefined;
        },
        kill() { entity.remove(); return true; },
        remove() { restrictedCheck("Entity.remove"); entity.isValid = false; const i = fake.entities.indexOf(entity); if (i >= 0) fake.entities.splice(i, 1); const p = fake.players.indexOf(entity); if (p >= 0) fake.players.splice(p, 1); }
    };
    Object.defineProperty(entity, "location", { get() { guard(entity); return entity._location; }, set(v) { entity._location = { ...v }; } });
    Object.defineProperty(entity, "dimension", { get() { guard(entity); return entity._dimension; } });
    fake.entities.push(entity);
    return entity;
}

function makePlayer(name, options = {}) {
    const player = makeEntity({ ...options, typeId: "minecraft:player", id: options.id ?? `fake-player-${name}` });
    // A player is an entity, but lives in fake.players rather than fake.entities.
    fake.entities.splice(fake.entities.indexOf(player), 1);
    fake.players.push(player);

    const slots = [];
    // `inventory: true` gives the player a real 36-slot inventory (stacking addItem that answers what did not fit, copies in and
    // out as the engine does, restricted-execution checks). Without it the player has the minimal one every older test uses.
    const container = options.inventory ? makeContainer(36, { copies: true }) : {
        size: 36,
        getItem(i) { return slots[i]; },
        setItem(i, stack) { slots[i] = stack; },
        addItem(stack) { const i = slots.findIndex((s) => s === undefined); slots[i === -1 ? slots.length : i] = stack; }
    };

    Object.assign(player, {
        name,
        isSneaking: options.isSneaking ?? false,
        isInWater: false,
        holding: options.holding ?? null,
        // The hotbar slot the player has selected.
        selectedSlotIndex: options.selectedSlotIndex ?? 0,
        // What is in the off-hand slot (a type id) or null. Tests set it to act out an off-hand swap.
        offhand: options.offhand ?? null,
        // player.camera: setFov records what it was given, or throws fake.cameraError.
        camera: {
            fovCalls: [],
            setFov(o) { guard(player); if (fake.cameraError) throw new Error(fake.cameraError); player.camera.fovCalls.push(o); }
        },
        container,
        permission: options.permission ?? PlayerPermissionLevel.Member,
        messages: [], actionBar: [], titles: [], titleOptions: [], privateSounds: [], commands: [],
        // Player.spawnParticle: visible only to this player, so it is kept on the player, not on the dimension.
        privateParticles: [],
        spawnParticle(id, location) { guard(player); restrictedCheck("Player.spawnParticle"); player.privateParticles.push({ tick: fake.tick, id, location: { ...location } }); },
        // What the player is looking at: a test sets `aimAt` to a block position (or leaves it undefined for open air),
        // and getBlockFromViewDirection answers that block, as the engine's raycast would.
        aimAt: undefined,
        getBlockFromViewDirection(options) {
            guard(player);
            if (!player.aimAt) return undefined;
            const block = player._dimension.getBlock(player.aimAt);
            if (!block) return undefined;
            // Opt-in: a type listed in `fake.passableBlocks` is looked through unless the ray is asked to stop at passable blocks.
            if (fake.passableBlocks.has(block.typeId) && !options?.includePassableBlocks) return undefined;
            return { block, face: "Up", faceLocation: { x: 0.5, y: 1, z: 0.5 } };
        },
        // The entities the player looks at, nearest first: a test sets `aimEntities`, and the raycast answers them.
        aimEntities: [],
        getEntitiesFromViewDirection() {
            guard(player);
            return player.aimEntities.filter((e) => e.isValid).map((entity, i) => ({ entity, distance: 2 + i }));
        },
        scoreboardIdentity: { displayName: name, id: name },
        onScreenDisplay: {
            setActionBar(text) { guard(player); restrictedCheck("ScreenDisplay.setActionBar"); player.actionBar.push(text); },
            setTitle(text, options) { guard(player); restrictedCheck("ScreenDisplay.setTitle"); player.titles.push(text); player.titleOptions.push(options); }
        },
        sendMessage(text) { guard(player); player.messages.push(text); },
        playSound(id, opts) { guard(player); restrictedCheck("Player.playSound"); player.privateSounds.push({ id, ...opts }); },
        giveAmmo(itemId, amount = 64) { slots[0] = makeItemStack(itemId, amount); },
        getComponent(id) {
            guard(player);
            if (id === "minecraft:equippable") {
                return {
                    getEquipmentSlot(slot) {
                        const type = slot === "Offhand" ? player.offhand : player.holding;
                        return { getItem() { return type ? makeItemStack(type) : undefined; } };
                    }
                };
            }
            if (id === "minecraft:inventory") return { container };
            if (id === "minecraft:health") return { currentValue: 20, effectiveMax: 20, resetToMaxValue() {} };
            if (id === "minecraft:riding" && player.ridingOn?.isValid) return { entityRidingOn: player.ridingOn };
            return undefined;
        }
    });
    Object.defineProperty(player, "playerPermissionLevel", { get() { guard(player); return player.permission; } });
    return player;
}

// ---------------------------------------------------------------------------
// Scoreboard, world, dynamic properties
// ---------------------------------------------------------------------------

const objectives = new Map();

function scoreKey(target) {
    if (typeof target === "string") return target;
    return target?.scoreboardIdentity?.displayName ?? target?.displayName ?? target?.name ?? String(target);
}

function makeObjective(id) {
    const scores = new Map();
    return {
        id, scores,
        getScore(target) { return scores.get(scoreKey(target)); },
        setScore(target, value) { scores.set(scoreKey(target), value); },
        addScore(target, value) { const k = scoreKey(target); scores.set(k, (scores.get(k) ?? 0) + value); }
    };
}

function dynamicBytes() {
    let total = 0;
    for (const [k, v] of fake.dynamic) total += k.length + (typeof v === "string" ? v.length : 8);
    return total;
}

export const world = {
    getAllPlayers() { fake.calls.getAllPlayers++; return [...fake.players]; },
    getPlayers(options) { fake.calls.getPlayers++; return queryPlayers(options); },
    getDimension(id) { return fake.dimension(id); },
    sendMessage(text) { fake.chat.push(text); },
    structureManager: {
        get(id) { return fake.structures.has(id) ? { id } : undefined; },
        // Enough of the real manager to act out saving, restoring and deleting a region: it keeps ids and a log of
        // calls, not the blocks. `fake.structureMax` makes a too-large box throw, as the engine does.
        createFromWorld(id, dimension, from, to, options = {}) {
            const size = { x: Math.abs(to.x - from.x) + 1, y: Math.abs(to.y - from.y) + 1, z: Math.abs(to.z - from.z) + 1 };
            if (Math.max(size.x, size.y, size.z) > fake.structureMax) throw new Error("ArgumentOutOfBoundsError: structure bounds exceed the maximum size");
            if (fake.structures.has(id)) throw new Error(`structure ${id} already exists`);
            fake.structures.add(id);
            // The item frames in the box are saved with what they show: the one thing a structure can put back that a script cannot set.
            fake.structureFrames.set(id, framesIn(dimension, from, to));
            fake.structureLog.push({ op: "create", id, from: { ...from }, to: { ...to }, options });
            return { id, size, isValid: true };
        },
        place(id, dimension, location, options) {
            const name = typeof id === "string" ? id : id.id;
            if (!fake.structures.has(name)) throw new Error(`structure ${name} does not exist`);
            for (const frame of fake.structureFrames.get(name) ?? []) {
                const at = { x: Math.floor(location.x) + frame.dx, y: Math.floor(location.y) + frame.dy, z: Math.floor(location.z) + frame.dz };
                const key = blockKey(at);
                // A structure loaded into a block identical to the one it replaces is the suspected case the screen is not told about.
                const identical = dimension.blocks.get(key) === frame.typeId && JSON.stringify(sortedStates(dimension.blockStates.get(key))) === JSON.stringify(sortedStates(frame.states));
                dimension.blocks.set(key, frame.typeId);
                if (frame.states) dimension.blockStates.set(key, { ...frame.states }); else dimension.blockStates.delete(key);
                if (frame.item) dimension.frameItems.set(key, { ...frame.item }); else dimension.frameItems.delete(key);
                if (!identical) { if (frame.item) dimension.frameSeen.set(key, { ...frame.item }); else dimension.frameSeen.delete(key); }
            }
            fake.structureLog.push({ op: "place", id: name, location: { ...location }, options });
        },
        delete(id) {
            const name = typeof id === "string" ? id : id.id;
            fake.structureFrames.delete(name);
            return fake.structures.delete(name);
        },
        getWorldStructureIds() { return [...fake.structures]; }
    },
    // fake.lootTables maps a table path to [[itemId, amount], ...]; an unknown path answers undefined, as the engine does.
    getLootTableManager() {
        return {
            getLootTable(path) { return fake.lootTables.has(path) ? { path } : undefined; },
            generateLootFromTable(table) { return (fake.lootTables.get(table.path) ?? []).map(([id, amount]) => new ItemStack(id, amount)); }
        };
    },
    tickingAreaManager: {
        get chunkCount() { return [...fake.tickingAreas.values()].reduce((sum, area) => sum + chunksIn(area), 0); },
        maxChunkCount: 255,
        // Room for the chunks an area covers (Infinity unless a test sets fake.tickingAreaCapacity).
        hasCapacity(options) { return fake.tickingAreaCapacity - this.chunkCount >= chunksIn(options); },
        hasTickingArea(id) { return fake.tickingAreas.has(typeof id === "string" ? id : id.identifier); },
        // The promise settles when the area is loaded and ticking (after fake.tickingAreaDelay ticks), or is refused.
        createTickingArea(id, options) {
            if (fake.tickingAreas.has(id)) return Promise.reject(new Error(`TickingAreaError: ${id} already exists`));
            if (fake.tickingAreaFails) return Promise.reject(new Error(fake.tickingAreaFails));
            fake.tickingAreas.set(id, options);
            if (fake.tickingAreaDelay <= 0) { fake.tickingAreaReady.add(id); return Promise.resolve(); }
            return new Promise((resolve) => {
                system.runTimeout(() => { if (fake.tickingAreas.has(id)) fake.tickingAreaReady.add(id); resolve(); }, fake.tickingAreaDelay);
            });
        },
        getAllTickingAreas() { return [...fake.tickingAreas.keys()].map((identifier) => ({ identifier })); },
        removeTickingArea(id) {
            const key = typeof id === "string" ? id : id.identifier;
            fake.tickingAreas.delete(key);
            fake.tickingAreaReady.delete(key);
        }
    },
    primitiveShapesManager: {
        maxShapes: 500,
        addText(text, dimension) { fake.shapes.push({ text, dimension }); },
        getShapes() { return fake.shapes.map((entry) => entry.text); },
        removeText(text) { const i = fake.shapes.findIndex((entry) => entry.text === text); if (i >= 0) fake.shapes.splice(i, 1); },
        removeAll() { fake.shapes.length = 0; }
    },
    scoreboard: {
        getObjective(id) { return objectives.get(id); },
        addObjective(id) { const o = makeObjective(id); objectives.set(id, o); return o; }
    },
    afterEvents: signalBag(),
    beforeEvents: signalBag(true),
    getDynamicProperty(k) { return fake.dynamic.get(k); },
    setDynamicProperty(k, v) {
        if (v === undefined || v === null) { fake.dynamic.delete(k); return; }
        if (fake.dynamicStringLimit !== null && typeof v === "string" && v.length > fake.dynamicStringLimit) {
            throw new Error("ArgumentOutOfBoundsError: dynamic property string too long");
        }
        fake.dynamic.set(k, v);
    },
    getDynamicPropertyIds() { return [...fake.dynamic.keys()]; },
    getDynamicPropertyTotalByteCount() { return dynamicBytes(); }
};

// ---------------------------------------------------------------------------
// Custom commands: a CustomCommandRegistry that enforces what the real one does, so a registration mistake fails a
// test instead of silently killing every command in the real game (the rae:config_* commands did exactly that
// once: a bare enum name threw NamespaceNameError inside an unguarded startup callback).
// ---------------------------------------------------------------------------

const NAMESPACED = /^[a-z0-9_.-]+:[a-z0-9_.-]+$/i;

/** Whether `value` is something a command parameter of `type` can arrive as. Enum values are checked by the caller. */
function acceptsArgument(type, value) {
    switch (type) {
        case CustomCommandParamType.Integer: return Number.isInteger(value);
        case CustomCommandParamType.Float: return typeof value === "number" && Number.isFinite(value);
        case CustomCommandParamType.Boolean: return typeof value === "boolean";
        case CustomCommandParamType.PlayerSelector: return Array.isArray(value);
        case CustomCommandParamType.EntitySelector: return Array.isArray(value);
        case CustomCommandParamType.Location: return typeof value === "object" && value !== null && ["x", "y", "z"].every((k) => typeof value[k] === "number");
        default: return typeof value === "string"; // String, Enum, BlockType, ItemType, EntityType
    }
}

function makeCommandRegistry() {
    const enums = new Map();
    const commands = new Map();
    const state = { open: true };

    const registry = {
        registerEnum(name, values) {
            if (!state.open) throw new Error("registerEnum can only be called during startup");
            if (typeof name !== "string" || !NAMESPACED.test(name)) throw new Error(`NamespaceNameError: '${name}': string must be prefixed with a namespace`);
            if (enums.has(name)) throw new Error(`the enum ${name} is already registered`);
            if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string" || v.length === 0)) throw new Error(`the enum ${name} needs a non-empty list of text values`);
            enums.set(name, [...values]);
        },
        registerCommand(def, callback) {
            if (!state.open) throw new Error("registerCommand can only be called during startup");
            if (typeof def?.name !== "string" || !NAMESPACED.test(def.name)) throw new Error(`NamespaceNameError: '${def?.name}': string must be prefixed with a namespace`);
            if (commands.has(def.name)) throw new Error(`the command ${def.name} is already registered`);
            if (typeof callback !== "function") throw new Error(`the command ${def.name} has no callback`);
            if (!Object.values(CommandPermissionLevel).includes(def.permissionLevel)) throw new Error(`the command ${def.name} has no valid permissionLevel`);
            for (const param of [...(def.mandatoryParameters ?? []), ...(def.optionalParameters ?? [])]) {
                if (typeof param?.name !== "string" || param.name.length === 0) throw new Error(`the command ${def.name} has a parameter with no name`);
                if (!Object.values(CustomCommandParamType).includes(param.type)) throw new Error(`the command ${def.name} parameter ${param.name} has no valid type`);
                // An Enum parameter's name doubles as the name of the enum it takes, which must exist by now.
                if (param.type === CustomCommandParamType.Enum && !enums.has(param.name)) throw new Error(`the command ${def.name} parameter ${param.name} names an enum that is not registered (register the enum first)`);
            }
            commands.set(def.name, { def, callback });
        }
    };

    /**
     * Acts out a player typing the command: permission first, then the arguments (count and type), then the callback,
     * in restricted execution as the real engine runs it. Answers the callback's result, or `{ refused, reason }` when
     * the engine would have turned the command away before running it.
     */
    function run(name, origin, ...args) {
        const entry = commands.get(name);
        if (!entry) throw new Error(`no command ${name} is registered`);

        const source = origin?.sourceEntity;
        const operator = source?.typeId !== "minecraft:player" || source.playerPermissionLevel === PlayerPermissionLevel.Operator;
        if (entry.def.permissionLevel !== CommandPermissionLevel.Any && !operator) return { refused: "permission", reason: `${name} needs operator permission` };

        const mandatory = entry.def.mandatoryParameters ?? [];
        const optional = entry.def.optionalParameters ?? [];
        if (args.length < mandatory.length) return { refused: "syntax", reason: `${name} is missing ${mandatory[args.length].name}` };
        if (args.length > mandatory.length + optional.length) return { refused: "syntax", reason: `${name} takes at most ${mandatory.length + optional.length} arguments` };

        for (let i = 0; i < args.length; i++) {
            const param = [...mandatory, ...optional][i];
            if (args[i] === undefined && i >= mandatory.length) continue;
            if (param.type === CustomCommandParamType.Enum) {
                if (!enums.get(param.name)?.includes(args[i])) return { refused: "syntax", reason: `${args[i]} is not one of ${param.name}` };
            } else if (!acceptsArgument(param.type, args[i])) {
                return { refused: "syntax", reason: `${param.name} cannot be ${JSON.stringify(args[i])}` };
            }
        }

        fake.restricted++;
        try {
            return entry.callback(origin, ...args);
        } finally {
            fake.restricted--;
        }
    }

    return { registry, state, enums, commands, run };
}

// ---------------------------------------------------------------------------
// Test controls
// ---------------------------------------------------------------------------

function freshCalls() { return { getAllPlayers: 0, getPlayers: 0, dimensionGetPlayers: 0 }; }

export const fake = {
    tick: 0,
    players: [], entities: [], chat: [],
    dimensions: {},
    dynamic: new Map(),
    dynamicStringLimit: null,           // set to a number to make oversized string properties throw
    structures: new Set(),
    structureFrames: new Map(),         // structure id -> the item frames it saved, with what each showed
    structureMax: Infinity,             // the largest side (blocks) createFromWorld accepts
    structureLog: [],                   // every createFromWorld/place the code made
    lootTables: new Map(),              // path -> [[itemId, amount], ...]
    tickingAreas: new Map(),
    tickingAreaReady: new Set(),        // the ids of areas that have finished loading
    tickingAreaDelay: 0,                // ticks a new area takes to load
    tickingAreaFails: null,             // a message: every new area is refused with it
    tickingAreaCapacity: Infinity,      // chunks that fit in all areas together
    hideUnloadedEntities: false,        // queries cannot see entities in a stretch fake.setUnloaded marked, unless a loaded ticking area covers them
    passableBlocks: new Set(),          // block type ids the default ray looks through (see getBlockFromViewDirection)
    strictFrameSync: false,             // frameShown follows only the changes a player's screen is told about (see the header)
    shapes: [],                       // world.primitiveShapesManager.addText calls
    itemTypes: new Set(["minecraft:stick", "minecraft:gold_ingot"]),
    // What the engine knows about items: a per-id override of how many one slot holds, the enchantments (bare id -> highest
    // level) and the potion effects that exist. Static tables: `reset` leaves them alone.
    maxStacks: new Map(),
    enchantments: new Map([
        ["flame", 1], ["power", 5], ["punch", 2], ["infinity", 1], ["multishot", 1], ["quick_charge", 3], ["piercing", 4],
        ["sharpness", 5], ["fire_aspect", 2], ["lunge", 3], ["unbreaking", 3], ["efficiency", 5], ["mending", 1], ["protection", 4]
    ]),
    effects: new Set([
        "regeneration", "speed", "strength", "resistance", "invisibility", "jump_boost", "fire_resistance", "instant_health", "poison",
        "slowness", "weakness", "night_vision", "water_breathing", "saturation", "absorption", "health_boost", "levitation", "nausea"
    ]),
    entityTypes: new Set(["horse", "mule", "donkey", "skeleton_horse", "pig", "cow", "sheep", "npc", "villager_v2"]),
    potionEffects: new Set([
        "Swiftness", "LongSwiftness", "StrongSwiftness", "Healing", "StrongHealing", "Regeneration", "Strength", "Poison",
        "TurtleMaster", "Leaping", "FireResistance", "WaterBreathing", "NightVision", "Invisibility", "SlowFalling", "Weakness"
    ]),
    calls: freshCalls(),
    // How bodies move (below), and the largest impulse applyImpulse accepts.
    // drag: what is left of a velocity after each tick. delivered: the share of a velocity that becomes movement (1 = all).
    physics: { drag: 1, delivered: 1 },
    maxImpulse: Infinity,
    // When set, player.camera.setFov throws this message.
    cameraError: null,
    // Restricted execution: above zero while a strict "before" event or a custom-command callback is running.
    restricted: 0,
    // Set true to run every "before" event handler in restricted execution, as the real engine does.
    strictBefore: false,
    makePlayer, makeEntity, makeItemStack,
    // Fires the one-shot startup event with a registry that enforces the real one's rules. Answers
    // { commands, enums, run(name, origin, ...args) }: `run` acts out typing the command (permission, argument types,
    // then the callback in restricted execution) and answers its result, or { refused, reason }.
    startUp() {
        const built = makeCommandRegistry();
        try {
            system.beforeEvents.startup.emit({ customCommandRegistry: built.registry });
        } finally {
            built.state.open = false;
        }
        return { commands: built.commands, enums: built.enums, run: built.run };
    },
    // Puts a block in the world: its type, its states (a door gets open_bit false unless told otherwise).
    placeBlock(dimension, pos, typeId, states) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        const key = blockKey(pos);
        dim.blocks.set(key, typeId);
        const merged = { ...(hasOpenBit(typeId) ? DEFAULT_STATES : {}), ...(states ?? {}) };
        if (Object.keys(merged).length > 0) dim.blockStates.set(key, merged); else dim.blockStates.delete(key);
        dim.containers.delete(key); dim.frameItems.delete(key); dim.frameSeen.delete(key);
        return makeBlock(dim, pos);
    },
    // Item frames. The item a frame shows is kept per frame block; a frame holds one item or none.
    setFrameItem(dimension, pos, typeId, amount = 1) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        dim.frameItems.set(blockKey(pos), { typeId, amount });
        dim.frameSeen.set(blockKey(pos), { typeId, amount });          // putting an item in a frame is announced
    },
    frameItemAt(dimension, pos) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        const item = dim.frameItems.get(blockKey(pos));
        return item ? { ...item } : undefined;
    },
    /** What a player sees in the frame at `pos`: what it holds, unless `fake.strictFrameSync` is on and the screen was never told. */
    frameShown(dimension, pos) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        const item = fake.strictFrameSync ? dim.frameSeen.get(blockKey(pos)) : dim.frameItems.get(blockKey(pos));
        return item ? { ...item } : undefined;
    },
    /**
     * A player punches the frame at `pos`. What the game does is ASSUMED here (docs/test-cards/ROBBERY-FRAME.md measures it): a frame
     * that shows an item pops it out as a dropped item and keeps standing; the game tells scripts that a player started breaking the
     * block (and/or that an entity hit it). `options.signals` picks which of those are sent, `options.order` is "pop-first" (default) or
     * "signal-first", `options.pop: false` is a game that pops nothing and `options.announce: false` one that pops the item without
     * telling scripts a dropped item appeared. Answers whether there was a frame to punch.
     */
    punchFrame(player, dimension, pos, options = {}) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        const key = blockKey(pos);
        if (!/(?:^|:)(?:glow_)?frame$/.test(dim.blocks.get(key) ?? "")) return false;

        const block = makeBlock(dim, pos);
        const signals = options.signals ?? ["start"];

        const pop = () => {
            const item = dim.frameItems.get(key);
            if (!item || options.pop === false) return;
            dim.frameItems.delete(key);
            dim.frameSeen.delete(key);                                  // the game's own pop is announced
            const entity = dim.spawnItem(new ItemStack(item.typeId, item.amount), { x: Math.floor(pos.x) + 0.5, y: Math.floor(pos.y) + 0.5, z: Math.floor(pos.z) + 0.5 });
            if (options.announce !== false) world.afterEvents.entitySpawn.emit({ entity, cause: "Spawned" });
        };

        const signal = () => {
            if (signals.includes("start")) world.afterEvents.playerStartBreakingBlock.emit({ player, block, dimension: dim, face: "North", blockPermutation: block.permutation });
            if (signals.includes("hit")) world.afterEvents.entityHitBlock.emit({ damagingEntity: player, hitBlock: block, blockFace: "North", hitBlockPermutation: block.permutation });
        };

        if (options.order === "signal-first") { signal(); pop(); } else { pop(); signal(); }

        return true;
    },
    // The block at a position, even in an unloaded chunk (a test reading the world back, not the game asking).
    blockAt(dimension, pos) {
        return makeBlock(typeof dimension === "string" ? fake.dimension(dimension) : dimension, pos);
    },
    // Makes two chest blocks one double chest: they share a single 54-slot container.
    pairChests(dimension, a, b) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        const shared = makeContainer(54);
        dim.containers.set(blockKey(a), shared);
        dim.containers.set(blockKey(b), shared);
    },
    // Marks boxes ({ from, to }, whole blocks) of a dimension as unloaded; an empty list loads everything again.
    setUnloaded(dimension, boxes) {
        const dim = typeof dimension === "string" ? fake.dimension(dimension) : dimension;
        const loader = (p) => !boxes.some((b) => {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            return x >= Math.min(b.from.x, b.to.x) && x <= Math.max(b.from.x, b.to.x)
                && y >= Math.min(b.from.y, b.to.y) && y <= Math.max(b.from.y, b.to.y)
                && z >= Math.min(b.from.z, b.to.z) && z <= Math.max(b.from.z, b.to.z);
        });
        dim.isChunkLoaded = loader;
        dim.fakeLoader = loader;
    },
    dimension(id) { const key = id.replace(/^minecraft:/, ""); return (fake.dimensions[key] ??= makeDimension(`minecraft:${key}`)); },
    addObjective(id) { return world.scoreboard.addObjective(id); },
    setScore(objectiveId, target, value) { (objectives.get(objectiveId) ?? world.scoreboard.addObjective(objectiveId)).setScore(target, value); },
    advance(ticks = 1) {
        for (let i = 0; i < ticks; i++) {
            fake.tick++;
            const due = jobs.filter((j) => j.due <= fake.tick).sort((a, b) => a.due - b.due || a.order - b.order);
            for (const job of due) {
                if (!jobs.includes(job)) continue;
                if (job.every) job.due += job.every; else jobs.splice(jobs.indexOf(job), 1);
                job.fn();
            }
            // Bodies move by their velocity once a tick, after the scripts have run; drag scales what is left.
            for (const body of [...fake.entities, ...fake.players]) {
                const v = body.velocity;
                if (!body.isValid || !v || (v.x === 0 && v.y === 0 && v.z === 0)) continue;
                const d = fake.physics.delivered;
                body._location = { x: body._location.x + v.x * d, y: body._location.y + v.y * d, z: body._location.z + v.z * d };
                body.velocity = { x: v.x * fake.physics.drag, y: v.y * fake.physics.drag, z: v.z * fake.physics.drag };
            }
            // Riders sit on their vehicle (a little above its origin), wherever it went this tick.
            for (const vehicle of fake.entities) {
                for (const rider of vehicle.riders ?? []) {
                    if (rider.isValid) rider._location = { x: vehicle._location.x, y: vehicle._location.y + 0.4, z: vehicle._location.z };
                }
            }
        }
    },
    advanceTo(tick) { fake.advance(Math.max(0, tick - fake.tick)); },
    // Clears players, entities, chat, storage and records. Module-level registrations
    // (event subscribers, intervals) are kept, because the game code registers them once at import.
    reset() {
        fake.players.length = 0; fake.entities.length = 0; fake.chat.length = 0;
        fake.dynamic.clear(); fake.structures.clear(); fake.structureFrames.clear(); fake.dynamicStringLimit = null;
        fake.structureMax = Infinity; fake.structureLog.length = 0; fake.lootTables.clear(); fake.tickingAreas.clear(); fake.shapes.length = 0;
        fake.tickingAreaReady.clear(); fake.tickingAreaDelay = 0; fake.tickingAreaFails = null; fake.tickingAreaCapacity = Infinity; fake.hideUnloadedEntities = false; fake.passableBlocks.clear(); fake.strictFrameSync = false;
        objectives.clear(); fake.calls = freshCalls();
        fake.physics.drag = 1; fake.physics.delivered = 1; fake.maxImpulse = Infinity; fake.cameraError = null;
        fake.restricted = 0; fake.strictBefore = false;
        // A loader a test installed by hand (the train tests do) is its own business; only setUnloaded's is undone here.
        for (const d of Object.values(fake.dimensions)) {
            d.blocks.clear(); d.blockStates.clear(); d.containers.clear(); d.frameItems.clear(); d.frameSeen.clear();
            if (d.fakeLoader && d.isChunkLoaded === d.fakeLoader) { d.isChunkLoaded = () => true; d.fakeLoader = undefined; }
        }
        for (const d of Object.values(fake.dimensions)) { d.commands.length = 0; d.played.length = 0; d.spawned.length = 0; d.explosions.length = 0; d.filled.length = 0; d.particles.length = 0; d.spawnedItems.length = 0; }
    }
};
