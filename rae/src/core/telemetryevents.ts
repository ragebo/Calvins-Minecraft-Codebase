import { system, world } from "@minecraft/server";
import { TELEMETRY } from "../config/balance.js";
import { BUILD_VERSION } from "../config/build.js";
import {
    FRESH_LIMITER, TELEMETRY_SOURCE, TELEMETRY_VERSION, limitStep, toLine,
    type EventFields, type EventKind, type LimiterState, type TelemetryEvent
} from "../logic/telemetry.js";
import { info, warn } from "./log.js";
import { onTick } from "./tick.js";

/**
 * Writing telemetry: every event the game wants counted goes through `emit`, which stamps it, holds it to the rate limit and writes it as
 * one line to the console, where the content log keeps it (logic/telemetry.ts is the format, tasks/plan.md the reasoning). This file
 * decides nothing about what is worth counting, and it must never cost the game anything: `emit` does not throw, and a failure to write
 * a line is reported once and then kept quiet, because a line about every failure is the flood this exists to avoid.
 *
 * Deliberately no registerSystem/reset(), like core/telemetry.ts: a round reset must not restart the numbering of the lines, change the
 * boot id or forget how many lines the rate limit has let through, because the reader tells one boot's lines from another's by them.
 */

/**
 * Where the world's id is kept. Not under core/persist.ts's "rae:persist:" prefix, so `rae:persist_reset` (which clears everything under
 * it) leaves it alone: a reset world would otherwise turn up in the reports as a second world.
 */
const WORLD_PROPERTY = "rae:telemetry:world";

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const WORLD_ID_LENGTH = 6;
const BOOT_ID_LENGTH = 4;

function randomId(length: number): string {

    let id = "";

    for (let i = 0; i < length; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];

    return id;
}

/** One load of the scripts. A reload makes a new one, which is how the reader tells the boots of a world apart. */
const bootId = randomId(BOOT_ID_LENGTH);

let lineNumber = 0;
let limiter: LimiterState = FRESH_LIMITER;
let worldId: string | undefined;
let complained = false;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/**
 * Says the first thing that goes wrong, once per boot, under a source of its own: the readers look for `[telemetry]` and expect JSON after
 * it, and a sentence there would be counted as a damaged line.
 */
function complain(message: string): void {

    if (complained) return;
    complained = true;

    try {
        warn("telemetry-problem", message);
    } catch {
        // The console itself is what failed: there is nowhere left to say so.
    }
}

/** The world's id: read once, and made (and saved) the first time there is none. */
function worldIdNow(): string {

    if (worldId !== undefined) return worldId;

    const saved = world.getDynamicProperty(WORLD_PROPERTY);

    if (typeof saved === "string" && saved.length > 0) {
        worldId = saved;
        return saved;
    }

    const made = randomId(WORLD_ID_LENGTH);

    // Kept in memory first: if the save below fails, this boot still has one id (a reload would make another).
    worldId = made;

    try {
        world.setDynamicProperty(WORLD_PROPERTY, made);
    } catch (err) {
        complain(`the world's id could not be saved, so a reload will make a new one: ${reasonOf(err)}`);
    }

    return made;
}

function write<K extends EventKind>(kind: K, fields: EventFields[K]): void {

    // The spread of a generic cannot be shown to be one member of the union, so the compiler is told.
    const event = {
        v: TELEMETRY_VERSION, k: kind, w: worldIdNow(), b: bootId, n: ++lineNumber, t: system.currentTick, bv: BUILD_VERSION, ...fields
    } as unknown as TelemetryEvent;

    info(TELEMETRY_SOURCE, toLine(event, TELEMETRY.events));
}

/**
 * Writes one event as a line in the content log, unless telemetry is off or the rate limit has used up its window. Safe to call from
 * anywhere in the game: it never throws and never touches the world beyond the id it keeps.
 */
export function emit<K extends EventKind>(kind: K, fields: EventFields[K]): void {

    if (!TELEMETRY.events.enabled) return;

    try {
        const step = limitStep(limiter, system.currentTick, TELEMETRY.events.maxLinesPerWindow, TELEMETRY.events.windowTicks);
        limiter = step.state;

        // The lines the last window refused are told once, before the first line of this one, and do not count against it.
        if (step.dropped > 0) write("telemetry.dropped", { lines: step.dropped });

        if (step.allowed) write(kind, fields);
    } catch (err) {
        complain(`a line could not be written: ${reasonOf(err)}`);
    }
}

// The first tick after the scripts load: one line saying which world and which build just started, which is also the first proof, in any
// log, that the way out works. Not at import: a world property cannot be read while the scripts are still starting.
const stopBoot = onTick("telemetry:boot", () => {
    stopBoot();
    emit("boot", {});
}, { everyTicks: 1 });
