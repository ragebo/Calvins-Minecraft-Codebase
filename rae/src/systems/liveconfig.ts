import {
    CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, system,
    type CustomCommandOrigin, type CustomCommandResult, type DimensionLocation, type Player
} from "@minecraft/server";
import { getField, listCategories, listFields, resetOverride, setOverride, type EditableField } from "../core/configoverrides.js";
import { error } from "../core/log.js";
import { registerSystem } from "../core/registry.js";

/**
 * The live-config command surface: six `/rae:config_*` custom commands, each operator-gated at the engine
 * level (CommandPermissionLevel.GameDirectors) and each with a `field` parameter the game's own command bar
 * tab-completes (an Enum-kind parameter backed by an enum built from core/configoverrides.ts's registry). No
 * knowledge of GUNS/BALANCE/WORLD lives here — only core/configoverrides.ts's public functions.
 *
 * Custom commands (system.beforeEvents.startup's customCommandRegistry) are unprecedented elsewhere in this
 * codebase — every other command here is a plain /scriptevent (core/events.ts's onScriptEvent). They were
 * chosen deliberately for this feature because they give two things a scriptevent cannot: real client-side
 * autocomplete for a field id, and an engine-enforced permission level on the command itself instead of a
 * hand-rolled check. Registration only works once, in the early startup window — this is why the enums and
 * commands are built inside that one subscription rather than at module top level the way every
 * onScriptEvent call elsewhere in this codebase runs immediately at import.
 *
 * CONFIRMED by real-game testing (content log, 2026-10-01): CustomCommandParameter has only {name, type},
 * no separate "which enum" field, and an Enum-kind parameter's `name` really does double as the registered
 * enum's name — but `registerEnum`'s own `name` argument ALSO requires a namespace, exactly like
 * `CustomCommand.name` does, even though its own doc comment doesn't say so: a bare name like "numberField"
 * throws `NamespaceNameError: ... string must be prefixed with a namespace` from inside the
 * system.beforeEvents.startup callback, which had no try/catch, so the throw aborted every registerCommand
 * call after it too — all six commands silently failed to register, not just autocomplete. Every enum name
 * below is namespaced for exactly this reason, and the callback is now wrapped so a future registration
 * mistake is reported instead of silently killing the whole feature again.
 */

const NUMERIC_FIELD_ENUM = "rae:number_field";
const VECTOR3_FIELD_ENUM = "rae:vector_field";
const BOOLEAN_FIELD_ENUM = "rae:bool_field";
const ANY_FIELD_ENUM = "rae:any_field";
const CATEGORY_ENUM = "rae:category";

function playerFrom(origin: CustomCommandOrigin): Player | undefined {
    return origin.sourceEntity?.typeId === "minecraft:player" ? (origin.sourceEntity as Player) : undefined;
}

function ok(message: string): CustomCommandResult {
    return { status: CustomCommandStatus.Success, message };
}

function fail(message: string): CustomCommandResult {
    return { status: CustomCommandStatus.Failure, message };
}

function describe(field: EditableField): string {
    if (field.kind === "vector3") {
        const { x, y, z } = field.get();
        return `${field.id} = ${x}, ${y}, ${z}  (${field.label})`;
    }
    return `${field.id} = ${field.get()}  (${field.label})`;
}

function vectorOf(location: DimensionLocation): { x: number; y: number; z: number } {
    return { x: location.x, y: location.y, z: location.z };
}

system.beforeEvents.startup.subscribe((event) => {

    try {
        const registry = event.customCommandRegistry;

        registry.registerEnum(NUMERIC_FIELD_ENUM, listFields().filter((f) => f.kind === "integer" || f.kind === "float").map((f) => f.id));
        registry.registerEnum(VECTOR3_FIELD_ENUM, listFields().filter((f) => f.kind === "vector3").map((f) => f.id));
        registry.registerEnum(BOOLEAN_FIELD_ENUM, listFields().filter((f) => f.kind === "boolean").map((f) => f.id));
        registry.registerEnum(ANY_FIELD_ENUM, listFields().map((f) => f.id));
        registry.registerEnum(CATEGORY_ENUM, listCategories());

        registry.registerCommand(
            {
                name: "rae:config_list",
                description: "Lists live-editable config fields and their current values.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                optionalParameters: [{ name: CATEGORY_ENUM, type: CustomCommandParamType.Enum }]
            },
            (_origin: CustomCommandOrigin, category?: string) => {
                const matches = listFields(category);
                if (matches.length === 0) return fail(category ? `No fields in category "${category}".` : "No fields registered.");
                return ok(matches.map(describe).join("\n"));
            }
        );

        registry.registerCommand(
            {
                name: "rae:config_get",
                description: "Reports a live-editable config field's current value.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                mandatoryParameters: [{ name: ANY_FIELD_ENUM, type: CustomCommandParamType.Enum }]
            },
            (_origin: CustomCommandOrigin, id: string) => {
                const field = getField(id);
                return field ? ok(describe(field)) : fail(`Unknown field "${id}".`);
            }
        );

        registry.registerCommand(
            {
                name: "rae:config_set_number",
                description: "Sets a numeric live-editable config field.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                mandatoryParameters: [
                    { name: NUMERIC_FIELD_ENUM, type: CustomCommandParamType.Enum },
                    { name: "value", type: CustomCommandParamType.Float }
                ]
            },
            (origin: CustomCommandOrigin, id: string, value: number) => {
                const player = playerFrom(origin);
                if (!player) return fail("Run this as a player.");
                const result = setOverride(player, id, value);
                return result.ok ? ok(`${id} set to ${value}.`) : fail(result.reason);
            }
        );

        registry.registerCommand(
            {
                name: "rae:config_set_bool",
                description: "Sets a true/false live-editable config field.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                mandatoryParameters: [
                    { name: BOOLEAN_FIELD_ENUM, type: CustomCommandParamType.Enum },
                    { name: "value", type: CustomCommandParamType.Boolean }
                ]
            },
            (origin: CustomCommandOrigin, id: string, value: boolean) => {
                const player = playerFrom(origin);
                if (!player) return fail("Run this as a player.");
                const result = setOverride(player, id, value);
                return result.ok ? ok(`${id} set to ${value}.`) : fail(result.reason);
            }
        );

        registry.registerCommand(
            {
                name: "rae:config_set_coordinate",
                description: "Sets a coordinate live-editable config field. ~ ~ ~ works for your current position.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                mandatoryParameters: [
                    { name: VECTOR3_FIELD_ENUM, type: CustomCommandParamType.Enum },
                    { name: "value", type: CustomCommandParamType.Location }
                ]
            },
            (origin: CustomCommandOrigin, id: string, value: DimensionLocation) => {
                const player = playerFrom(origin);
                if (!player) return fail("Run this as a player.");
                const result = setOverride(player, id, vectorOf(value));
                return result.ok ? ok(`${id} set to ${value.x}, ${value.y}, ${value.z}.`) : fail(result.reason);
            }
        );

        registry.registerCommand(
            {
                name: "rae:config_reset",
                description: "Reverts a live-editable config field to its compiled-in default.",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                mandatoryParameters: [{ name: ANY_FIELD_ENUM, type: CustomCommandParamType.Enum }]
            },
            (origin: CustomCommandOrigin, id: string) => {
                const player = playerFrom(origin);
                if (!player) return fail("Run this as a player.");
                const result = resetOverride(player, id);
                return result.ok ? ok(`${id} reset to its default.`) : fail(result.reason);
            }
        );
    } catch (err) {
        error("liveconfig", `registering the rae:config_* commands failed, none of them will work this session: ${err}`);
    }
});

registerSystem({
    name: "liveconfig",
    reset() {
        // Nothing round-scoped to clear: this file only dispatches commands into
        // core/configoverrides.ts, which deliberately survives a round reset (see its own header comment).
    }
});
