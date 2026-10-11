import { system, type CustomCommandResult } from "@minecraft/server";
import { failure, ok, playerOf, registerFamily, type Family } from "../core/commands.js";
import { openConfigEditor } from "../core/configforms.js";
import {
    changedFields, defaultText, getField, listCategories, listFields, parseFieldValue, rangeText, resetOverride, setOverride, standingPoint, valueText
} from "../core/configoverrides.js";
import { registerSystem } from "../core/registry.js";

/**
 * The live-config command: ONE operator-only `/rae:config` (it was six, `config_list`, `_get`, `_set_number`, `_set_bool`,
 * `_set_coordinate` and `_reset`, plus five enums of field ids). With nothing after it, it opens the editor (core/configforms.ts):
 * groups, a search box, and the right control for each kind of setting. Typed, it is `/rae:config set <field> <value>`, and the
 * game's own command bar completes the field from the list of every setting's id. No knowledge of GUNS/BALANCE/WORLD lives here:
 * only core/configoverrides.ts's public functions.
 *
 * Custom commands (system.beforeEvents.startup's customCommandRegistry) give two things a scriptevent cannot: client-side
 * autocomplete for a field id, and an engine-enforced permission level on the command itself instead of a hand-rolled check.
 * Registration only works once, in the early startup window, which is why the enums and the command are built inside that one
 * subscription (core/commands.ts's registerFamily) rather than at module top level.
 *
 * CONFIRMED by real-game testing (content log, 2026-10-01): an Enum-kind parameter's `name` doubles as the registered enum's name,
 * and `registerEnum`'s own `name` ALSO requires a namespace, exactly like `CustomCommand.name` does, even though its doc comment
 * does not say so: a bare name throws `NamespaceNameError` from inside the startup callback. Every enum name here is namespaced
 * for that reason, and a registration mistake is reported to the log by registerFamily instead of taking the command down silently.
 */

const FIELD_ENUM = "rae:config_field";

const describe = (id: string): string => {
    const field = getField(id);
    return field ? `${field.id} = ${valueText(field)}  (${field.label}; default ${defaultText(field.id)}; ${rangeText(field)})` : `${id}: unknown`;
};

const FAMILY: Family = {
    name: "rae:config",
    description: "Live-edit the game's numbers and positions. With nothing after it, opens the editor. set / get / reset take a setting's id.",
    actionEnum: "rae:config_action",
    first: { name: "field", choices: { enumId: FIELD_ENUM, values: listFields().map((field) => field.id) } },
    second: { name: "value" },
    bareHelp: "opens the editor (groups, a search box, a control for each kind of setting)",
    bare: (origin): CustomCommandResult => {
        const player = playerOf(origin);
        if (!player) return failure("The editor opens for a player. From a command block use set, get, reset or list.");

        system.run(() => { void openConfigEditor(player); });

        return ok("Opening the editor. Close the chat to see it.");
    },
    actions: [
        {
            name: "list",
            usage: "",
            description: "Shows what is changed from the default, and the groups of settings.",
            run: () => {
                const changed = changedFields();

                const lines = [changed.length === 0 ? "Nothing is changed from the default." : `Changed from the default (${changed.length}):`];
                for (const field of changed) lines.push(`  ${field.id} = ${valueText(field)}  (default ${defaultText(field.id)})`);

                lines.push("Groups: " + listCategories().map((group) => `${group} (${listFields(group).length})`).join(", ") + ". /rae:config opens them.");

                return ok(lines.join("\n"));
            }
        },
        {
            name: "get",
            usage: "<field>",
            description: "Shows one setting: its value, its default and what it accepts.",
            run: (_origin, id) => {
                if (id === undefined) return failure("Which setting? /rae:config get <field>: the command bar completes it.");
                return getField(id) ? ok(describe(id)) : failure(`Unknown setting "${id}".`);
            }
        },
        {
            name: "set",
            usage: "<field> <value>",
            description: "Sets a setting: a number, on or off, or a position (here, or \"x y z\" in quotes; ~ means where you stand).",
            run: (origin, id, value) => {
                const player = playerOf(origin);
                if (!player) return failure("Run this as a player.");
                if (id === undefined) return failure("Which setting? /rae:config set <field> <value>.");

                const field = getField(id);
                if (!field) return failure(`Unknown setting "${id}".`);
                if (value === undefined) return failure(`${id} takes ${rangeText(field)}. /rae:config set ${id} <value>.`);

                const parsed = parseFieldValue(field, value, standingPoint(player.location));
                if (!parsed.ok) return failure(`${id}: ${parsed.reason}.`);

                const before = valueText(field);
                const result = setOverride(player, id, parsed.value);

                return result.ok ? ok(`${id}: ${before} -> ${valueText(field)}.`) : failure(`${id}: ${result.reason} (it takes ${rangeText(field)}).`);
            }
        },
        {
            name: "reset",
            usage: "<field>",
            description: "Puts a setting back to the default it was built with.",
            run: (origin, id) => {
                const player = playerOf(origin);
                if (!player) return failure("Run this as a player.");
                if (id === undefined) return failure("Which setting? /rae:config reset <field>.");

                const field = getField(id);
                if (!field) return failure(`Unknown setting "${id}".`);

                const before = valueText(field);
                const result = resetOverride(player, id);

                return result.ok ? ok(`${id}: ${before} -> ${valueText(field)} (the default).`) : failure(`${id}: ${result.reason}.`);
            }
        }
    ]
};

system.beforeEvents.startup.subscribe((event) => {
    registerFamily(event.customCommandRegistry, "liveconfig", FAMILY);
});

registerSystem({
    name: "liveconfig",
    reset() {
        // Nothing round-scoped to clear: this file only dispatches commands into
        // core/configoverrides.ts, which deliberately survives a round reset (see its own header comment).
    }
});
