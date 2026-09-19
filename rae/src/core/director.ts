import { world, system } from "@minecraft/server";
import { registerSystem } from "./registry.js";
import { onScriptEvent } from "./events.js";
import { onTick } from "./tick.js";

/**
 * Fixes the hand-wired lock problem from V1.
 *
 * Fort raid, ranch raid and train robbery took turns through a one-flag lock (eventLock.ts).
 * Each one's script-event handler claimed it, printed the "already in progress" line when it was
 * taken, started the event, and every way the event could end had to remember to let go. A start
 * that never really began (a ranch raid with nobody inside) forgot, and the lock stayed taken
 * until the next round reset.
 *
 * Now an event is a definition and this module owns the one slot they share. It claims the slot,
 * asks the event to start, and frees the slot at once if the event says it could not. The event
 * only has to call finishEvent() when it ends. Beyond that the director can queue a request until
 * the slot frees, keep an event on cooldown after it finishes, announce its start and end, and
 * pick an event by weight (requestRandomEvent: nothing calls it yet).
 *
 * Jailbreak deliberately does NOT go through here: it's a continuous system (anyone can attempt a
 * lockpick anytime the jail is occupied), not a scripted set-piece like these.
 */

export interface EventDefinition {
    /** "fort", "ranch", "train". What activeEvent() reports and what finishEvent() takes. */
    readonly id: string;
    /** Used in the busy line: "Can't start a <label> ...". */
    readonly label: string;
    /** The script event that requests this event, e.g. "bounty:fort". The director registers it. */
    readonly trigger?: string;
    /**
     * Begins the event. Return false when it could not actually start (nobody in the area, ...):
     * the director then frees the slot at once. The event calls finishEvent(id) when it ends.
     */
    start(): boolean;
    /**
     * What to say when this event is requested while the slot is taken. Return undefined to fall
     * back to the director's line. For an event that knows better than the director why it can't
     * start (the train has its own line for "I am still moving"). `active` is what holds the slot.
     */
    readonly busyMessage?: (active: string) => string | undefined;
    /** Ticks it is blocked for after it finishes. Default 0: it can start again at once. */
    readonly cooldownTicks?: number;
    /** Relative chance when the director picks an event itself. Default 1; 0 means never. */
    readonly weight?: number;
    /** Chat lines the director sends. Default none: the events announce themselves. */
    readonly announce?: {
        /** Sent once the event has started, so after whatever the event said while starting. */
        readonly start?: string;
        /** Sent when the event finishes. Not sent when a round reset cuts it short. */
        readonly end?: string;
    };
}

/**
 * Why a request did not start:
 *   busy      another event holds the slot
 *   cooldown  it finished too recently (or, for a random pick, everything did)
 *   unknown   no event is registered under that id (or none can be picked)
 *   failed    it was asked to start and could not
 */
export type RejectReason = "busy" | "cooldown" | "unknown" | "failed";

export type RequestResult =
    | { readonly status: "started" }
    /** Waiting for the slot. `position` counts from 1: the next one to start. */
    | { readonly status: "queued"; readonly position: number }
    /** `active` is the event holding the slot, when the reason is "busy". */
    | { readonly status: "rejected"; readonly reason: RejectReason; readonly active?: string };

export interface RequestOptions {
    /** When the request can't start now (the slot is taken, or it is cooling down), wait in line instead of being rejected. */
    readonly queue?: boolean;
}

const TICKS_PER_SECOND = 20;
/** How often queued events are looked at. They also start the moment the slot frees. */
const SWEEP_TICKS = 20;

const definitions = new Map<string, EventDefinition>();

/** The event holding the slot, or null. */
let active: string | null = null;
/** Ids waiting to start, first come first served. */
const queue: string[] = [];
/** The tick each event may start again, for events that finished with a cooldown. */
const readyAt = new Map<string, number>();

function cooldownLeft(id: string): number {
    return Math.max(0, (readyAt.get(id) ?? 0) - system.currentTick);
}

function weightOf(id: string): number {
    return definitions.get(id)?.weight ?? 1;
}

/**
 * Makes an event known to the director. Registering an id again replaces the earlier
 * definition. When it has a trigger, that script event now requests the event.
 */
export function registerEvent(definition: EventDefinition): void {

    definitions.set(definition.id, definition);

    if (definition.trigger !== undefined) {
        onScriptEvent(definition.trigger, () => {
            requestEvent(definition.id);
        });
    }
}

/**
 * Claims the slot for an event that is free to start, and starts it. Callers make sure the
 * slot is free. An event that says it could not start, or throws, gives the slot back at once,
 * because nothing will ever call finishEvent for it.
 */
function begin(definition: EventDefinition): RequestResult {

    // However it got here, it is not waiting any more.
    const waiting = queue.indexOf(definition.id);
    if (waiting !== -1) queue.splice(waiting, 1);

    active = definition.id;

    let started = false;

    try {
        started = definition.start();
    } catch (error) {
        console.error(`[director] ${definition.id} threw while starting: ${error}`);
    }

    if (!started) {
        if (active === definition.id) active = null;
        return { status: "rejected", reason: "failed" };
    }

    if (definition.announce?.start) world.sendMessage(definition.announce.start);

    return { status: "started" };
}

function enqueue(id: string): RequestResult {

    let index = queue.indexOf(id);

    // Asking twice keeps the first place in line rather than adding a second one.
    if (index === -1) index = queue.push(id) - 1;

    return { status: "queued", position: index + 1 };
}

/**
 * Asks for an event. Starts it when the slot is free and it is not cooling down. Otherwise it
 * is queued (when options.queue is set) or refused with a line in chat.
 */
export function requestEvent(id: string, options: RequestOptions = {}): RequestResult {

    const definition = definitions.get(id);

    if (!definition) return { status: "rejected", reason: "unknown" };

    if (active === null && cooldownLeft(id) === 0) return begin(definition);

    if (options.queue) return enqueue(id);

    if (active !== null) {
        world.sendMessage(definition.busyMessage?.(active) ?? `§cCan't start a ${definition.label} — ${active} is already in progress.`);
        return { status: "rejected", reason: "busy", active };
    }

    const seconds = Math.ceil(cooldownLeft(id) / TICKS_PER_SECOND);
    world.sendMessage(`§cCan't start a ${definition.label} yet — ${seconds}s of cooldown left.`);
    return { status: "rejected", reason: "cooldown" };
}

/**
 * Called by an event when it ends, however it ends. Frees the slot, starts its cooldown and
 * announces the end, then starts the next queued event. Harmless to call twice, or for an event
 * that is not the one holding the slot: only the active event can be finished.
 */
export function finishEvent(id: string): void {

    if (active !== id) return;

    active = null;

    const definition = definitions.get(id);
    const cooldown = definition?.cooldownTicks ?? 0;

    if (cooldown > 0) readyAt.set(id, system.currentTick + cooldown);

    if (definition?.announce?.end) world.sendMessage(definition.announce.end);

    startQueued();
}

/** Starts queued events while the slot is free, first come first served. One still cooling down is passed over. */
function startQueued(): void {

    while (active === null) {

        const next = queue.findIndex((id) => cooldownLeft(id) === 0);

        if (next === -1) return;

        const [id] = queue.splice(next, 1);
        const definition = definitions.get(id);

        // A start that fails frees the slot again, so this goes on to the next in line.
        if (definition) begin(definition);
    }
}

/** The id of the event holding the slot, or null when none is running. */
export function activeEvent(): string | null {
    return active;
}

/** Ids waiting for the slot, next to start first. */
export function queuedEvents(): readonly string[] {
    return [...queue];
}

/**
 * Picks one of `ids` with chance proportional to its weight. A weight that is not a positive
 * number never wins. Undefined when nothing can. `random` returns a number in [0, 1) and is a
 * parameter so a test can steer the choice.
 */
export function pickWeighted(
    ids: readonly string[],
    weight: (id: string) => number,
    random: () => number = Math.random
): string | undefined {

    const weights = ids.map((id) => {
        const w = weight(id);
        return Number.isFinite(w) && w > 0 ? w : 0;
    });

    const total = weights.reduce((sum, w) => sum + w, 0);

    if (total <= 0) return undefined;

    let roll = random() * total;
    let last: string | undefined;

    for (let i = 0; i < ids.length; i++) {

        if (weights[i] === 0) continue;

        last = ids[i];
        roll -= weights[i];

        if (roll < 0) return ids[i];
    }

    // Rounding can leave a sliver at the very top of the range: it belongs to the last one.
    return last;
}

/**
 * The director picking for itself: one of the registered events that is not cooling down, by
 * weight, started if the slot is free. Nothing calls this yet. Nobody asked for a particular
 * event, so a rejection is silent: the result says why.
 */
export function requestRandomEvent(random: () => number = Math.random): RequestResult {

    if (active !== null) return { status: "rejected", reason: "busy", active };

    const ready = [...definitions.keys()].filter((id) => cooldownLeft(id) === 0);
    const id = pickWeighted(ready, weightOf, random);
    const definition = id === undefined ? undefined : definitions.get(id);

    if (!definition) {
        // Either everything is cooling down, or there is nothing (with any weight) to pick.
        return { status: "rejected", reason: ready.length === 0 && definitions.size > 0 ? "cooldown" : "unknown" };
    }

    return begin(definition);
}

// Queued events start the moment the slot frees (finishEvent); this sweep covers the ones that
// were waiting out a cooldown. It rides the shared tick loop, it does not start a loop of its own.
onTick("director", startQueued, { everyTicks: SWEEP_TICKS });

registerSystem({
    name: "director",
    reset() {
        // A round reset drops whatever is running or waiting, and forgets every cooldown. The
        // registered events stay: they are code, not state.
        active = null;
        queue.length = 0;
        readyAt.clear();
    }
});
