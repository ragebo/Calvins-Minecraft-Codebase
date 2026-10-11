import {
    CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus,
    type CustomCommandOrigin, type CustomCommandRegistry, type CustomCommandResult, type Player
} from "@minecraft/server";
import { info, warn } from "./log.js";
import { tell } from "./ui.js";

/**
 * What every system that registers custom commands (`/rae:...`) needs: answering a command, finding the player behind it, and
 * registering one safely. A registration mistake (a bare name, an enum used before it exists) throws, and an uncaught
 * throw inside the startup callback would take every command after it down too (the rae:config commands once all failed at
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

// ---------------------------------------------------------------------------------------------------------
// A family: one command that does a whole area's work
// ---------------------------------------------------------------------------------------------------------

/*
 * Typing `/rae:` once listed 38 separate commands. A FAMILY is one command (`/rae:robbery`) whose first word picks an action
 * (`/rae:robbery start bank test`): the game's command bar completes the action word from a list, so every action stays one
 * keystroke away and only ONE entry is left in the list of commands. Typed with nothing after it, a family does the thing a
 * person most often wants (open its menu), and `help` after it lists the actions.
 *
 * The cost is that two text slots follow the action, whatever the action is, so what an action reads from them is its own affair
 * (a robbery id and "test"; a shop and a price). A slot can still be a list the command bar completes (the config editor's
 * field ids), which is why a slot may name its choices.
 */

/** One of the two words after the action: a text box, or a list the game's command bar completes. */
export interface Slot {
    readonly name: string;
    readonly choices?: { readonly enumId: string; readonly values: readonly string[] };
}

export interface FamilyAction {
    /** The word that picks it, lowercase. */
    readonly name: string;
    /** What may follow it, for `help`: "[robbery] [test]". */
    readonly usage: string;
    readonly description: string;
    readonly run: (origin: CustomCommandOrigin, first: string | undefined, second: string | undefined) => CustomCommandResult;
}

export interface Family {
    /** The command, namespaced: "rae:robbery". */
    readonly name: string;
    readonly description: string;
    /** The name the game's command bar knows the list of actions by: namespaced as well ("rae:robbery_action"). */
    readonly actionEnum: string;
    readonly first: Slot;
    readonly second: Slot;
    /** What the command does with no action, and how `help` words it. */
    readonly bare: (origin: CustomCommandOrigin) => CustomCommandResult;
    readonly bareHelp: string;
    readonly actions: readonly FamilyAction[];
}

/** Text typed after an action, trimmed; nothing at all when it is only spaces. */
const word = (text: string | undefined): string | undefined => {
    const trimmed = text?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

export function familyHelp(family: Family): string {

    const lines = [`/${family.name}  ${family.bareHelp}`];

    for (const action of family.actions) lines.push(`/${family.name} ${action.name}${action.usage.length > 0 ? ` ${action.usage}` : ""}  ${action.description}`);

    return lines.join("\n");
}

/** Does what typing the family's command with these words means. Exported so a test can type it without a game. */
export function runFamily(family: Family, origin: CustomCommandOrigin, action?: string, first?: string, second?: string): CustomCommandResult {

    const wanted = word(action)?.toLowerCase();

    if (wanted === undefined) return family.bare(origin);
    if (wanted === "help") return ok(familyHelp(family));

    const found = family.actions.find((candidate) => candidate.name === wanted);

    if (!found) return failure(`/${family.name} has no action "${wanted}". Its actions are: ${family.actions.map((a) => a.name).join(", ")}, help.`);

    return found.run(origin, word(first), word(second));
}

/** Registers one family as a single operator-only command. A mistake is reported to the log and takes nothing else down. */
export function registerFamily(registry: CustomCommandRegistry, source: string, family: Family): void {

    try {
        registry.registerEnum(family.actionEnum, [...family.actions.map((action) => action.name), "help"]);

        const parameter = (slot: Slot): { name: string; type: CustomCommandParamType } => {
            if (!slot.choices) return { name: slot.name, type: CustomCommandParamType.String };
            registry.registerEnum(slot.choices.enumId, [...slot.choices.values]);
            return { name: slot.choices.enumId, type: CustomCommandParamType.Enum };
        };

        registry.registerCommand(
            {
                name: family.name,
                description: family.description,
                permissionLevel: CommandPermissionLevel.GameDirectors,
                optionalParameters: [
                    { name: family.actionEnum, type: CustomCommandParamType.Enum },
                    parameter(family.first),
                    parameter(family.second)
                ]
            },
            (origin: CustomCommandOrigin, action?: string, first?: string, second?: string) => runFamily(family, origin, action, first, second)
        );
    } catch (err) {
        warn(source, `registering ${family.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
