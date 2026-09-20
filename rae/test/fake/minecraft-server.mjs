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

export const EquipmentSlot = { Mainhand: "Mainhand", Offhand: "Offhand", Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet" };
export const EntityDamageCause = { entityAttack: "entityAttack", projectile: "projectile", fall: "fall", override: "override" };
export const PlayerPermissionLevel = { Visitor: 0, Member: 1, Operator: 2, Custom: 3 };
export const StructureSaveMode = { Memory: "Memory", World: "World" };
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
export const BlockPermutation = { resolve(id, states) { return { type: { id }, states }; } };

export const ItemTypes = {
    get(id) { return fake.itemTypes.has(id) ? { id } : undefined; },
    getAll() { return [...fake.itemTypes].map((id) => ({ id })); }
};

// ---------------------------------------------------------------------------
// Event signals. Any event name works: `world.afterEvents.whatever.subscribe(fn)`.
// Tests deliver events with `.emit(payload)`, which the real game would do itself.
// ---------------------------------------------------------------------------

function makeSignal() {
    const handlers = [];
    return {
        subscribe(fn) { handlers.push(fn); return fn; },
        unsubscribe(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
        emit(payload) { for (const fn of [...handlers]) fn(payload); },
        get count() { return handlers.length; }
    };
}

function signalBag() {
    const signals = new Map();
    return new Proxy({}, {
        get(_, name) {
            if (typeof name !== "string" || name === "then") return undefined;
            if (!signals.has(name)) signals.set(name, makeSignal());
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

function makeDimension(id) {
    const dim = {
        id,
        commands: [], played: [], spawned: [], explosions: [], filled: [],
        runCommand(command) { dim.commands.push(command); return { successCount: 1 }; },
        // Mirrors the engine's documented limits so a bad cue really throws.
        playSound(soundId, location, options = {}) {
            if (options.pitch !== undefined && options.pitch < 0.01) throw new Error("PropertyOutOfBoundsError: pitch");
            if (options.volume !== undefined && options.volume < 0) throw new Error("PropertyOutOfBoundsError: volume");
            dim.played.push({ tick: fake.tick, id: soundId, location: { ...location }, volume: options.volume, pitch: options.pitch });
        },
        getPlayers(options) { fake.calls.dimensionGetPlayers++; return queryPlayers(options).filter((p) => p._dimension === dim); },
        getEntities(options) { return fake.entities.filter((e) => e._dimension === dim && matchesQuery(e, options)); },
        spawnEntity(typeId, location) { const e = fake.makeEntity({ typeId, location, dimension: dim }); dim.spawned.push(e); return e; },
        spawnItem(stack, location) { return fake.makeEntity({ typeId: "minecraft:item", location, dimension: dim }); },
        createExplosion(location, radius, options) { dim.explosions.push({ location, radius, options }); return true; },
        fillBlocks(volume, permutation) { dim.filled.push({ volume, permutation }); },
        getBlock() { return undefined; },
        getBlockFromRay() { return undefined; },
        getEntitiesFromRay() { return []; }
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
        effects: [], damage: [], teleports: [], dynamic: new Map(),
        _location: { ...(options.location ?? { x: 0, y: 64, z: 0 }) },
        _dimension: options.dimension ?? fake.dimension("overworld"),
        hasTag(t) { guard(entity); return entity.tags.has(t); },
        addTag(t) { guard(entity); entity.tags.add(t); return true; },
        removeTag(t) { guard(entity); return entity.tags.delete(t); },
        getTags() { guard(entity); return [...entity.tags]; },
        getViewDirection() { guard(entity); return entity.facing; },
        getHeadLocation() { guard(entity); return { x: entity._location.x, y: entity._location.y + 1.6, z: entity._location.z }; },
        getRotation() { guard(entity); return { x: 0, y: 0 }; },
        addEffect(id, duration, opts) { guard(entity); entity.effects.push({ id, duration, ...opts }); },
        applyDamage(amount, opts) { guard(entity); entity.damage.push({ amount, ...opts }); return true; },
        teleport(location) { guard(entity); entity.teleports.push({ ...location }); entity._location = { ...location }; },
        runCommand(command) { guard(entity); return entity._dimension.runCommand(command); },
        getDynamicProperty(k) { guard(entity); return entity.dynamic.get(k); },
        setDynamicProperty(k, v) { guard(entity); if (v === undefined || v === null) entity.dynamic.delete(k); else entity.dynamic.set(k, v); },
        getComponent() { guard(entity); return undefined; },
        kill() { entity.remove(); return true; },
        remove() { entity.isValid = false; const i = fake.entities.indexOf(entity); if (i >= 0) fake.entities.splice(i, 1); const p = fake.players.indexOf(entity); if (p >= 0) fake.players.splice(p, 1); }
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
    const container = {
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
        container,
        permission: options.permission ?? PlayerPermissionLevel.Member,
        messages: [], actionBar: [], titles: [], privateSounds: [], commands: [],
        scoreboardIdentity: { displayName: name, id: name },
        onScreenDisplay: {
            setActionBar(text) { guard(player); player.actionBar.push(text); },
            setTitle(text) { guard(player); player.titles.push(text); }
        },
        sendMessage(text) { guard(player); player.messages.push(text); },
        playSound(id, opts) { guard(player); player.privateSounds.push({ id, ...opts }); },
        giveAmmo(itemId, amount = 64) { slots[0] = makeItemStack(itemId, amount); },
        getComponent(id) {
            guard(player);
            if (id === "minecraft:equippable") {
                return { getEquipmentSlot() { return { getItem() { return player.holding ? makeItemStack(player.holding) : undefined; } }; } };
            }
            if (id === "minecraft:inventory") return { container };
            if (id === "minecraft:health") return { currentValue: 20, effectiveMax: 20, resetToMaxValue() {} };
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
    structureManager: { get(id) { return fake.structures.has(id) ? { id } : undefined; } },
    scoreboard: {
        getObjective(id) { return objectives.get(id); },
        addObjective(id) { const o = makeObjective(id); objectives.set(id, o); return o; }
    },
    afterEvents: signalBag(),
    beforeEvents: signalBag(),
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
    itemTypes: new Set(["minecraft:stick", "minecraft:gold_ingot"]),
    calls: freshCalls(),
    makePlayer, makeEntity, makeItemStack,
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
        }
    },
    advanceTo(tick) { fake.advance(Math.max(0, tick - fake.tick)); },
    // Clears players, entities, chat, storage and records. Module-level registrations
    // (event subscribers, intervals) are kept, because the game code registers them once at import.
    reset() {
        fake.players.length = 0; fake.entities.length = 0; fake.chat.length = 0;
        fake.dynamic.clear(); fake.structures.clear(); fake.dynamicStringLimit = null;
        objectives.clear(); fake.calls = freshCalls();
        for (const d of Object.values(fake.dimensions)) { d.commands.length = 0; d.played.length = 0; d.spawned.length = 0; d.explosions.length = 0; d.filled.length = 0; }
    }
};
