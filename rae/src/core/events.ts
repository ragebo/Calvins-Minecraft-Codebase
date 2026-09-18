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
            world.sendMessage(`§c[DEATH ERROR] ${handler.name}: ${error}`);
        }
    }
});

/**
 * Script events, registered by id instead of one subscriber per file.
 */

export type ScriptEventHandler = (player: Player | undefined) => void;

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
        handler(player);
    } catch (error) {
        world.sendMessage(`§c[EVENT ERROR] ${event.id}: ${error}`);
    }
});

export function listScriptEvents(): string[] {
    return [...scriptEvents.keys()].sort();
}
