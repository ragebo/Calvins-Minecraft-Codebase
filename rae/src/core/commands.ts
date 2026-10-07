import {
    CommandPermissionLevel, CustomCommandStatus,
    type CustomCommandOrigin, type CustomCommandParamType, type CustomCommandRegistry, type CustomCommandResult, type Player
} from "@minecraft/server";
import { info, warn } from "./log.js";
import { tell } from "./ui.js";

/**
 * What every system that registers custom commands (`/rae:...`) needs: answering a command, finding the player behind it, and
 * registering a list of them safely. A registration mistake (a bare name, an enum used before it exists) throws, and an uncaught
 * throw inside the startup callback would take every command after it down too (the rae:config_* commands once all failed at
 * once that way), so each command is tried on its own and only the log hears of a failure.
 *
 * Both a before-event and a custom command's callback run in RESTRICTED execution (measured 2026-10-06): they may read, send a
 * chat line and write a dynamic property, and nothing that changes the world, so a command checks everything it can at once,
 * answers honestly, and defers the rest with `system.run`.
 */

export const ok = (message: string): CustomCommandResult => ({ status: CustomCommandStatus.Success, message });
export const failure = (message: string): CustomCommandResult => ({ status: CustomCommandStatus.Failure, message });

/** The player behind a command: whoever typed it, or, from an NPC's button, the player who pressed it. */
export function playerOf(origin: CustomCommandOrigin): Player | undefined {

    const source = origin.sourceEntity;
    if (source?.typeId === "minecraft:player") return source as Player;

    const initiator = origin.initiator;

    return initiator?.typeId === "minecraft:player" ? (initiator as Player) : undefined;
}

/** How a deferred command reports back: to the player who ran it, or to the log when there is none (a command block). */
export function later(origin: CustomCommandOrigin, source: string, text: string): void {

    const player = playerOf(origin);

    if (player?.isValid) tell(player, text);
    else info(source, text.replace(/§./g, ""));
}

export interface Parameter {
    readonly name: string;
    readonly type: CustomCommandParamType;
}

export interface CommandSpec {
    readonly name: string;
    readonly description: string;
    readonly mandatory?: readonly Parameter[];
    readonly optional?: readonly Parameter[];
    readonly run: (origin: CustomCommandOrigin, ...args: any[]) => CustomCommandResult;
}

/** Registers every command in the list as operator-only, each on its own so one mistake cannot take the rest down. */
export function registerOperatorCommands(registry: CustomCommandRegistry, source: string, specs: readonly CommandSpec[]): void {

    for (const spec of specs) {
        try {
            registry.registerCommand(
                {
                    name: spec.name,
                    description: spec.description,
                    permissionLevel: CommandPermissionLevel.GameDirectors,
                    ...(spec.mandatory ? { mandatoryParameters: spec.mandatory.map((p) => ({ name: p.name, type: p.type })) } : {}),
                    ...(spec.optional ? { optionalParameters: spec.optional.map((p) => ({ name: p.name, type: p.type })) } : {})
                },
                spec.run
            );
        } catch (err) {
            warn(source, `registering ${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
