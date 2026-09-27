import { world, system, PlayerPermissionLevel, type Player } from "@minecraft/server";

/**
 * The one place a failure or a diagnostic goes, replacing two idioms V1 left scattered everywhere:
 * `world.sendMessage` of a red, bracket-tagged line (e.g. "§c" + "[TAG ERROR] ..."), which put
 * every failure in every player's chat whether they could do anything about it or not, and ad hoc
 * `console.warn`/`console.error` calls with a hand-rolled `[tag]` prefix that nobody but someone
 * watching the content log ever saw.
 *
 * Deliberately standalone: this file imports NOTHING from `core/` — only `@minecraft/server`.
 * registry.ts, economy.ts, tick.ts, events.ts, game.ts, round.ts and director.ts all need to call
 * into this, and several of those are themselves depended on by nearly everything else in `core/`;
 * importing any of them back from here would create a real import cycle. The one price of standing
 * alone is `error()` below reaching `world.getAllPlayers()` directly instead of through
 * `core/players.ts` (see its own comment).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Off by default. A dev/ops toggle, not round state, so this is not a registerSystem reset — see
 * the rae:log_debug script event below, which is the only way it changes. */
let debugLogging = false;

export function setDebugLogging(on: boolean): void {
    debugLogging = on;
}

function line(source: string, message: string): string {
    return `[${source}] ${message}`;
}

/** Routine tracing: silent unless `setDebugLogging(true)` (or `/scriptevent rae:log_debug on`) has run. */
export function debug(source: string, message: string): void {
    if (!debugLogging) return;
    console.warn(line(source, message));
}

/** Always-on console output for something worth knowing that is not a failure. */
export function info(source: string, message: string): void {
    console.warn(line(source, message));
}

/** Always-on console output for a real problem that does not need a player told. */
export function warn(source: string, message: string): void {
    console.warn(line(source, message));
}

/**
 * A real failure: always to the console (`console.error`, so it stands out from the `warn`/`info`/
 * `debug` noise above, which all use `console.warn`), and always to a player too — every online
 * operator by default, so a failure reaches someone who can act on it without V1's habit of
 * shouting "§c[TAG ERROR]" at every player in the game. Pass `options.to` for a specific recipient
 * instead of chat-to-every-operator; then only that player is messaged.
 *
 * "Every online operator" means asking the engine for the whole player list and checking each
 * one's permission level directly — normally core/players.ts's job, but this file cannot import it
 * (see the file-level note above), so this is the one raw `world.getAllPlayers()` call in
 * core/log.ts. Zero operators online (and no `options.to`) is not a failure of error() itself: the
 * console.error already happened, which is enough.
 */
export function error(source: string, message: string, options?: { readonly to?: Player }): void {

    const text = line(source, message);
    console.error(text);

    const chatLine = `§c${text}`;

    if (options?.to) {
        // A stale handle (the caller's player disconnected) must not turn error() itself into a
        // new, uncaught failure — the console.error above already happened either way.
        if (options.to.isValid) options.to.sendMessage(chatLine);
        return;
    }

    for (const player of world.getAllPlayers()) {
        if (player.playerPermissionLevel === PlayerPermissionLevel.Operator) {
            player.sendMessage(chatLine);
        }
    }
}

/**
 * `/scriptevent rae:log_debug on|off` — toggles the gate `debug()` checks. Not registered through
 * core/events.ts's onScriptEvent (this file cannot import core/events.ts either), so this
 * subscribes to the raw engine signal itself, copying that module's own idiom for pulling a player
 * and a message out of the event: see its dispatcher and systems/tumbleweed.ts's rae:tumbleweed
 * for the shape this follows. A command block (no player) still toggles the flag; only the chat
 * reply needs someone to send it to, the same trade-off rae:adopt makes.
 */
system.afterEvents.scriptEventReceive.subscribe((event) => {

    if (event.id !== "rae:log_debug") return;

    const source = event.sourceEntity;
    const player = source?.typeId === "minecraft:player" ? (source as Player) : undefined;

    const argument = (event.message ?? "").trim().toLowerCase();

    if (argument !== "on" && argument !== "off") {
        player?.sendMessage("§eUsage: /scriptevent rae:log_debug on|off");
        return;
    }

    setDebugLogging(argument === "on");
    player?.sendMessage(`§7Debug logging is now ${argument}.`);
});
