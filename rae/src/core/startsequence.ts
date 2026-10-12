import { world, type Player } from "@minecraft/server";
import { error } from "./log.js";
import { startCommands } from "./startstore.js";

/**
 * The start of a game, as a sequence (core/game.ts's begin() starts it): the operator's start commands, then a camera intro, then the
 * roles are revealed, law choose a spawn and play begins. This file holds the whole sequence; it must not import core/game.ts, which
 * calls it.
 *
 * Nothing in a sequence may hang a game: every step that waits has its own way to finish, and a step that fails says so and lets the
 * rest go on.
 */

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

export interface CommandFailure {
    /** Its place in the list, from 1: the number an operator sees on the screen. */
    readonly number: number;
    readonly command: string;
    readonly reason: string;
}

export interface CommandReport {
    /** How many ran without the game refusing them. A command that ran but matched no one counts as run. */
    readonly ran: number;
    readonly failed: readonly CommandFailure[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/**
 * Runs the operator's start commands in order, as the server, in the overworld. Selectors like `@a[tag=law]` work (the roles are already
 * assigned when this runs); `@s` does not, because there is no one it could mean. A command the game refuses is reported to `by` (whoever
 * pressed Start; every operator online when it is not known) and the rest still run: one bad line must not leave a game half set up.
 */
export function runStartCommands(by?: Player): CommandReport {

    const list = startCommands();
    const failed: CommandFailure[] = [];

    list.forEach((command, index) => {
        try {
            world.getDimension("overworld").runCommand(command);
        } catch (err) {
            failed.push({ number: index + 1, command, reason: errorText(err) });
        }
    });

    for (const failure of failed) {
        error("start", `Start command ${failure.number} (${failure.command}) did not run: ${failure.reason}`, by ? { to: by } : undefined);
    }

    return { ran: list.length - failed.length, failed };
}
