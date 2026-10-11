import type { Player } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import {
    changedFields, defaultText, getField, hasOverride, listCategories, listFields, parseFieldValue, rangeText, resetOverride, setOverride,
    standingPoint, valueText, type EditableField
} from "./configoverrides.js";
import { showForm } from "./forms.js";
import { BACK, createScreens, type Action } from "./screens.js";
import { format } from "./ui.js";

/**
 * The live config editor as screens: pick a group, pick a setting, change it with the right control for what it is (a box for a
 * number, a switch for an on/off, three boxes for a position), and the result shows at the top of the next screen. Everything it
 * offers comes from core/configoverrides.ts's registry, which is also what `/rae:config` types into, so the two cannot disagree
 * about what exists, what is allowed, or what a setting goes back to.
 *
 * A refused answer (a number out of range, a position outside the world) shows the same form again with what was typed still
 * in it and the reason in the title, because losing a typed value to a refusal is the one thing a form must not do.
 */

const screens = createScreens("config");

/** More buttons than this is a wall to scroll through: a group this large is split by what its labels start with ("Revolver: ..."). */
const SPLIT_ABOVE = 24;
/** The most results a search shows at once. */
const MAX_MATCHES = 40;

/** What a label says before its first colon ("Revolver" in "Revolver: fire rate"), when it says one. */
const prefixOf = (field: EditableField): string | undefined => {
    const colon = field.label.indexOf(": ");
    return colon > 0 ? field.label.slice(0, colon) : undefined;
};

const shortLabel = (field: EditableField): string => {
    const prefix = prefixOf(field);
    return prefix !== undefined ? field.label.slice(prefix.length + 2) : field.label;
};

const fieldButton = (field: EditableField, trim: boolean): string =>
    `${trim ? shortLabel(field) : field.label}  =  ${valueText(field)}${hasOverride(field.id) ? "  (changed)" : ""}`;

export const hasConfigMenuOpen = (player: Player): boolean => screens.hasMenuOpen(player);

/** Opens the editor for an operator. */
export function openConfigEditor(player: Player): Promise<void> {
    return screens.menuFor(player, async () => { await mainScreen(player); });
}

async function mainScreen(player: Player): Promise<void> {

    await screens.run(player, () => {

        const total = listFields().length;
        const groups = listCategories();
        const changed = changedFields();

        const actions: Action[] = [
            { label: "Find a setting by name...", run: () => findForm(player) },
            ...(changed.length > 0
                ? [{ label: `Changed from the default (${changed.length})`, run: () => listScreen(player, "Changed from the default", () => changedFields(), false) }]
                : []),
            ...groups.map((group): Action => ({ label: `${group} (${listFields(group).length})`, run: () => groupScreen(player, group) })),
            { label: "Close", run: () => { screens.closeAll(player); } }
        ];

        return {
            title: "Live config",
            body: `${total} settings in ${groups.length} groups, ${changed.length === 0 ? "none changed from the default" : `${changed.length} changed from the default`}. A change takes effect at once and is kept across restarts.`,
            actions
        };
    });
}

/** One group: its settings, or, when it is long and its labels have a shared start, the sub-groups to pick from. */
async function groupScreen(player: Player, group: string): Promise<void> {

    const fields = listFields(group);
    const prefixes = [...new Set(fields.map(prefixOf).filter((prefix): prefix is string => prefix !== undefined))];

    if (fields.length <= SPLIT_ABOVE || prefixes.length < 2) {
        await listScreen(player, group, () => listFields(group), false);
        return;
    }

    const loose = fields.filter((field) => prefixOf(field) === undefined);

    await screens.run(player, () => ({
        title: group,
        body: `${fields.length} settings. Pick one part.`,
        actions: [
            ...prefixes.map((prefix): Action => ({
                label: `${prefix} (${fields.filter((field) => prefixOf(field) === prefix).length})`,
                run: () => listScreen(player, `${group}: ${prefix}`, () => listFields(group).filter((field) => prefixOf(field) === prefix), true)
            })),
            ...(loose.length > 0 ? [{ label: `Other (${loose.length})`, run: () => listScreen(player, `${group}: other`, () => listFields(group).filter((field) => prefixOf(field) === undefined), false) }] : []),
            BACK
        ]
    }));
}

/** A list of settings, each a button showing its value. It is built again each time, so a change shows at once. */
async function listScreen(player: Player, title: string, pick: () => readonly EditableField[], trim: boolean, note?: string): Promise<void> {

    await screens.run(player, () => {

        const fields = pick();

        // Nothing left to list (the last changed setting was put back): the screen goes away instead of showing an empty one.
        if (fields.length === 0) return undefined;

        return {
            title,
            body: `Press one to change it.${note !== undefined ? `\n${note}` : ""}`,
            actions: [...fields.map((field): Action => ({ label: fieldButton(field, trim), run: () => editField(player, field.id) })), BACK]
        };
    });
}

async function findForm(player: Player): Promise<void> {

    const response = await showForm(player, new ModalFormData().title("Find a setting").textField("Part of its name (for example: fire rate, reload, spawn)", "fire rate"));

    if (!response || response.canceled) return;

    const typed = String(response.formValues?.[0] ?? "").trim().toLowerCase();

    if (typed.length === 0) return;

    const words = typed.split(/\s+/);
    const matches = listFields().filter((field) => {
        const haystack = `${field.label} ${field.id}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
    });

    if (matches.length === 0) {
        screens.notify(player, format("warn", `Nothing is called "${typed}". Try one word, such as reload or spawn.`));
        return;
    }

    const shown = matches.slice(0, MAX_MATCHES);
    const note = matches.length > shown.length ? `Showing ${shown.length} of ${matches.length}: type more of the name to narrow it.` : undefined;

    await listScreen(player, `Settings matching "${typed}"`, () => shown, false, note);
}

/**
 * Changes one setting. The form has the control its kind needs, and, for a setting that has been changed, a switch that puts it
 * back to its default. A refusal shows the form again with what was typed and says why.
 */
async function editField(player: Player, id: string): Promise<void> {

    let typed: string[] | undefined;
    let refusal: string | undefined;

    for (;;) {

        const field = getField(id);
        if (!field || !player.isValid) return;

        const changed = hasOverride(id);
        const title = refusal !== undefined ? `Not saved: ${refusal}` : field.label;

        const form = new ModalFormData().title(title);

        if (field.kind === "boolean") {
            form.toggle(`${field.label}`, { defaultValue: typed ? typed[0] === "true" : field.get() });
        } else if (field.kind === "vector3") {
            const now = field.get();
            const start = typed ?? [String(now.x), String(now.y), String(now.z)];
            form.textField("X", String(now.x), { defaultValue: start[0] ?? "" });
            form.textField("Y", String(now.y), { defaultValue: start[1] ?? "" });
            form.textField("Z", String(now.z), { defaultValue: start[2] ?? "" });
            form.toggle("Use the block I am standing on instead", { defaultValue: false });
        } else {
            form.textField(`${field.label} (${rangeText(field)})`, valueText(field), { defaultValue: typed ? (typed[0] ?? "") : valueText(field) });
        }

        if (changed) form.toggle(`Put it back to the default (${defaultText(id)})`, { defaultValue: false });

        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) return;

        const values = response.formValues;

        // The last control is the "put it back" switch when there is one.
        if (changed && values[values.length - 1] === true) {
            const reset = resetOverride(player, id);

            screens.notify(player, reset.ok
                ? format("ok", `${field.label} is back to its default, ${valueText(field)}.`)
                : format("warn", `Not changed: ${reset.reason}.`));
            return;
        }

        const before = valueText(field);
        const here = standingPoint(player.location);
        let value: number | boolean | { x: number; y: number; z: number };

        if (field.kind === "boolean") {
            value = values[0] === true;
        } else {
            const text = field.kind === "vector3"
                ? (values[3] === true ? "here" : `${String(values[0] ?? "")} ${String(values[1] ?? "")} ${String(values[2] ?? "")}`)
                : String(values[0] ?? "");

            const parsed = parseFieldValue(field, text, here);

            if (!parsed.ok) {
                typed = field.kind === "vector3" ? [String(values[0] ?? ""), String(values[1] ?? ""), String(values[2] ?? "")] : [String(values[0] ?? "")];
                refusal = parsed.reason;
                continue;
            }

            value = parsed.value as number | { x: number; y: number; z: number };
        }

        const result = setOverride(player, id, value);

        if (!result.ok) {
            typed = field.kind === "vector3"
                ? [String(values[0] ?? ""), String(values[1] ?? ""), String(values[2] ?? "")]
                : field.kind === "boolean" ? [String(value)] : [String(values[0] ?? "")];
            refusal = result.reason;
            continue;
        }

        screens.notify(player, format("ok", `${field.label}: ${before} -> ${valueText(field)}.`));
        return;
    }
}
