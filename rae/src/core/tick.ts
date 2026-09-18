import { world, system, type Player } from "@minecraft/server";

/**
 * Fixes the polling problem your profiler found.
 *
 * In V1 five files each ran their own runInterval and each one called
 * world.getAllPlayers(). That call showed up as 94% of script time.
 *
 * Now one loop scans once per second and hands the result to every
 * subscriber. Adding a system costs no extra scan.
 */

export interface TickContext {
    readonly players: readonly Player[];
    readonly tick: number;
}

type TickHandler = (ctx: TickContext) => void;

interface RegisteredTick {
    readonly name: string;
    /** Run every N loop passes. 1 means every pass. */
    readonly every: number;
    readonly fn: TickHandler;
}

const handlers: RegisteredTick[] = [];

/** Loop period. One second is enough for every V1 system. */
const LOOP_INTERVAL_TICKS = 20;

export function onTick(name: string, fn: TickHandler, every = 1): void {
    handlers.push({ name, every, fn });
}

let pass = 0;

system.runInterval(() => {

    if (handlers.length === 0) return;

    pass++;

    const ctx: TickContext = {
        players: world.getAllPlayers(),
        tick: system.currentTick
    };

    for (const handler of handlers) {

        if (pass % handler.every !== 0) continue;

        try {
            handler.fn(ctx);
        } catch (error) {
            world.sendMessage(`§c[TICK ERROR] ${handler.name}: ${error}`);
        }
    }

}, LOOP_INTERVAL_TICKS);
