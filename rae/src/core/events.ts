import { world, system, type Entity, type Player } from "@minecraft/server";

/**
 * Fixes the scattered-subscriber problem from V1.
 *
 * In V1, main.ts, train.ts, fort.ts and harming.ts each subscribed to
 * entityDie separately. Nothing knew what the others did, and the
 * ordering between them was accidental.
 *
 * Now there is one subscription. Handlers run in a defined order.
 */

export interface DeathContext {
    readonly dead: Entity;
    readonly killer: Player | undefined;
    /** True once a handler has fully resolved this death. */
    handled: boolean;
}

export type DeathHandler = (ctx: DeathContext) => void;

interface RegisteredHandler {
    readonly name: string;
    readonly order: number;
    readonly fn: DeathHandler;
}

const deathHandlers: RegisteredHandler[] = [];

/**
 * Lower order runs first. Use these bands:
 *   0-99    penalties that apply to any death (coins, inventory drop)
 *   100-199 role outcomes (bounty payout, jail, elimination)
 *   200+    mob kill rewards
 */
export function onDeath(name: string, order: number, fn: DeathHandler): void {
    deathHandlers.push({ name, order, fn });
    deathHandlers.sort((a, b) => a.order - b.order);
}

world.afterEvents.entityDie.subscribe((event) => {

    const rawKiller = event.damageSource.damagingEntity;

    const ctx: DeathContext = {
        dead: event.deadEntity,
        killer: rawKiller?.typeId === "minecraft:player"
            ? (rawKiller as Player)
            : undefined,
        handled: false
    };

    for (const handler of deathHandlers) {

        if (ctx.handled) break;

        try {
            handler.fn(ctx);
        } catch (error) {
            reportHandlerError("DEATH", handler.name, error);
        }
    }
});

/**
 * Spawns get the same treatment as deaths. Respawn used to be handled by two separate
 * subscribers (jail.ts and main.ts) whose only coordination was a tag the first one removed
 * before the second one looked for it, so a captured outlaw was sent to jail and then straight
 * on to an outlaw spawn. Now there is one subscription, an explicit order, and an explicit flag.
 */

export interface SpawnContext {
    readonly player: Player;
    /** Set by a handler that has decided where this player goes (jail, spectator) so the generic respawn skips them. */
    placed: boolean;
}

export type SpawnHandler = (ctx: SpawnContext) => void;

const spawnHandlers: { readonly name: string; readonly order: number; readonly fn: SpawnHandler }[] = [];

/**
 * Lower order runs first; every handler runs, and reads ctx.placed for itself. Use these bands:
 *   0-99    setup for everyone (effects)
 *   100-199 role outcomes that decide placement (jail, elimination), then round checks
 *   200+    generic respawn placement
 */
export function onSpawn(name: string, order: number, fn: SpawnHandler): void {
    spawnHandlers.push({ name, order, fn });
    spawnHandlers.sort((a, b) => a.order - b.order);
}

world.afterEvents.playerSpawn.subscribe((event) => {

    const ctx: SpawnContext = { player: event.player, placed: false };

    for (const handler of spawnHandlers) {
        try {
            handler.fn(ctx);
        } catch (error) {
            reportHandlerError("SPAWN", handler.name, error);
        }
    }
});

function reportHandlerError(kind: string, name: string, error: unknown): void {
    world.sendMessage(`§c[${kind} ERROR] ${name}: ${error}`);
}

/**
 * Script events, registered by id instead of one subscriber per file.
 */

/**
 * `message` is the text after the id (`/scriptevent rae:train_station Depot` passes "Depot"),
 * or "" when there is none. Handlers that do not need it can ignore the second argument.
 */
export type ScriptEventHandler = (player: Player | undefined, message: string) => void;

const scriptEvents = new Map<string, ScriptEventHandler>();

export function onScriptEvent(id: string, fn: ScriptEventHandler): void {
    scriptEvents.set(id, fn);
}

system.afterEvents.scriptEventReceive.subscribe((event) => {

    const handler = scriptEvents.get(event.id);

    if (!handler) return;

    const source = event.sourceEntity;

    const player = source?.typeId === "minecraft:player"
        ? (source as Player)
        : undefined;

    try {
        handler(player, event.message ?? "");
    } catch (error) {
        reportHandlerError("EVENT", event.id, error);
    }
});

export function listScriptEvents(): string[] {
    return [...scriptEvents.keys()].sort();
}
