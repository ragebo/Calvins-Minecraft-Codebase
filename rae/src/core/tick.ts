import { world, system, type Player } from "@minecraft/server";

/**
 * Fixes the polling problem your profiler found.
 *
 * In V1 five files each ran their own runInterval and each one called
 * world.getAllPlayers(). That call showed up as 94% of script time.
 *
 * Now the whole game has ONE system.runInterval, ticking every tick,
 * and every repeating job is a handler with its own cadence. The loop
 * only looks at when each handler is next due, so a tick where nothing
 * is due costs a pass over a handful of numbers. The player list is
 * fetched lazily: once per tick at most, and only if a handler that is
 * due actually reads it.
 *
 * Add a repeating job with onTick, never with a raw runInterval.
 */

export interface TickContext {
    /**
     * Every player in the world. Fetched the first time a handler reads
     * it on a tick and shared by every handler after that, so a tick
     * where nobody reads it never makes the (costly) query.
     */
    readonly players: readonly Player[];
    /** system.currentTick, the same for every handler on this tick. */
    readonly tick: number;
}

export type TickHandler = (ctx: TickContext) => void;

export interface TickOptions {
    /**
     * Run every N ticks. The first run is N ticks after registration and
     * then every N ticks, exactly like system.runInterval(fn, N).
     * Whole ticks, at least 1. Default 20, which is once a second.
     */
    readonly everyTicks?: number;
}

/** The cadence of a handler that doesn't ask for one. */
const DEFAULT_EVERY_TICKS = 20;

interface Registration {
    readonly name: string;
    readonly fn: TickHandler;
    readonly everyTicks: number;
    /** The first tick this handler is due again. */
    dueTick: number;
    /** Set once stopped, so a handler already queued for this tick is skipped. */
    removed: boolean;
}

/** Live registrations, in the order they were made. */
const registrations: Registration[] = [];

/** Whole ticks, at least 1. Anything that isn't a number falls back to the default. */
function cadence(everyTicks: number | undefined): number {
    if (everyTicks === undefined || !Number.isFinite(everyTicks)) return DEFAULT_EVERY_TICKS;
    return Math.max(1, Math.floor(everyTicks));
}

/**
 * Every removal goes through here. A registration that isn't marked
 * removed is always in the list, and its stopper only ever touches its
 * own registration, so a stale stopper can't stop a replacement.
 */
function remove(registration: Registration): void {
    if (registration.removed) return;
    registration.removed = true;
    registrations.splice(registrations.indexOf(registration), 1);
}

/**
 * Runs `fn` every `options.everyTicks` ticks (default 20) and returns a
 * function that stops it. The stopper can be called any number of times,
 * including from inside `fn` itself.
 *
 * If a handler with this name is already active, it is stopped and this
 * one takes its place, counting from now.
 *
 * Handlers due on the same tick run in the order they were registered.
 * One that throws is reported to chat and doesn't stop the others.
 */
export function onTick(name: string, fn: TickHandler, options: TickOptions = {}): () => void {

    const previous = registrations.find((registration) => registration.name === name);

    if (previous) remove(previous);

    const everyTicks = cadence(options.everyTicks);

    const registration: Registration = {
        name,
        fn,
        everyTicks,
        dueTick: system.currentTick + everyTicks,
        removed: false
    };

    registrations.push(registration);

    return () => remove(registration);
}

/** One context per tick that has something due. The player query is deferred until asked for. */
function contextFor(tick: number): TickContext {

    let players: readonly Player[] | undefined;

    return {
        tick,
        get players() {
            if (!players) players = world.getAllPlayers();
            return players;
        }
    };
}

function dispatch(): void {

    const now = system.currentTick;

    // Collect what is due before running anything, so handlers may add and
    // stop handlers freely while this tick is dispatched. Most ticks have
    // nothing due, and then nothing is allocated.
    let due: Registration[] | undefined;

    for (let i = 0; i < registrations.length; i++) {

        if (registrations[i].dueTick > now) continue;

        if (!due) due = [];
        due.push(registrations[i]);
    }

    if (!due) return;

    const ctx = contextFor(now);

    for (const registration of due) {

        // An earlier handler on this tick may have stopped this one.
        if (registration.removed) continue;

        // Schedule the next run before running this one, so a throw or a
        // self-stop can't disturb the cadence. Steps in whole periods to
        // keep the handler's own phase, and lands after `now` even when
        // the loop was late: a stall costs skipped runs, never a burst.
        do {
            registration.dueTick += registration.everyTicks;
        } while (registration.dueTick <= now);

        try {
            registration.fn(ctx);
        } catch (error) {
            world.sendMessage(`§c[TICK ERROR] ${registration.name}: ${error}`);
        }
    }
}

system.runInterval(dispatch, 1);
