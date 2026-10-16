import type { Player } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { ENDINGS as E } from "../config/balance.js";
import { edit, newEnding, type Ending, type EndingPatch, type Place, type Result } from "../logic/endings.js";
import { getEnding, listEndings, newEndingId, removeEnding, saveEnding, undoAvailable, undoEnding } from "./endingstore.js";
import { confirmForm, showForm } from "./forms.js";
import { isOperator } from "./players.js";
import { BACK, createScreens, type Action, type Step } from "./screens.js";
import { heldStack } from "./shopitems.js";
import { format, tell } from "./ui.js";

/**
 * The operator's screens for the endings, opened from an "Endings" button in the RAE menu that only operators see. The list of endings, Add (a name and
 * a type), and a screen per ending to edit every field of it: on or off, the place and the win spot (taken where the operator STANDS, so no
 * coordinates are typed), the radius and the price, the item (taken from the operator's hand), whether it is consumed, the four messages, delete.
 *
 * The rules of an ending are logic/endings.ts's and where they are kept is core/endingstore.ts's; this is only the screens over them. A value that
 * cannot be saved brings the same box back with the reason in its title and what was typed kept (the way the start sequence's screens do it), and
 * nothing is saved until a box is submitted and accepted, so closing one half way changes nothing.
 */

const screens = createScreens("endings");

/** The ending an operator deleted last, so the list can offer to bring it back (the store keeps one undo per id until the scripts reload). */
let lastDeleted: string | undefined;

/** The editor for an operator. Anyone else is told, and no screen is shown: the menu does not offer the button, and this is the second lock. */
export function openEndingsEditor(player: Player): Promise<void> {

    if (!isOperator(player)) {
        tell(player, format("warn", "Only operators can change the endings."));
        return Promise.resolve();
    }

    return screens.menuFor(player, async () => { await mainScreen(player); });
}

/** Where the operator stands, as the middle of that block: whole numbers are all a person reading a screen needs, and the middle is where a player stands. */
function standingPlace(player: Player): Place {
    const at = player.location;
    return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 };
}

const where = (place: Place): string => `${Math.round(place.x)}, ${Math.round(place.y)}, ${Math.round(place.z)}`;

const kindName = (ending: Ending): string => (ending.kind === "group" ? "Group" : "Solo");

async function mainScreen(player: Player): Promise<void> {

    await screens.run(player, () => {

        const actions: Action[] = [];

        for (const stored of listEndings()) {
            actions.push(stored.ok
                ? { label: `${stored.value.name} (${kindName(stored.value).toLowerCase()}, ${stored.value.enabled ? "on" : "off"})`, run: () => oneEnding(player, stored.id) }
                : { label: `${stored.id} (cannot be read)`, run: () => brokenEnding(player, stored.id, stored.problem) });
        }

        actions.push({ label: "Add an ending", run: () => addOne(player) });

        const bringBack = lastDeleted !== undefined && getEnding(lastDeleted) === undefined && undoAvailable(lastDeleted) ? lastDeleted : undefined;
        if (bringBack !== undefined) actions.push({ label: `Bring back ${bringBack}`, run: () => undo(player, bringBack) });

        actions.push(BACK);

        const count = listEndings().length;

        return {
            title: "Endings",
            body: count === 0
                ? "There are no endings, so nobody can escape until you add one."
                : `${count} of ${E.maxEndings} endings. A group ending needs the whole gang at its place and ends the round; a solo one lets one outlaw leave alone.`,
            actions
        };
    });
}

/** A saved ending that cannot be read: all that can be done with it is to delete it, which frees its place (and undo brings it back). */
async function brokenEnding(player: Player, id: string, problem: string): Promise<void> {

    await screens.run(player, () => ({
        title: `Ending ${id}`,
        body: `§cThis ending cannot be read: ${problem}`,
        actions: [{ label: "Delete", run: () => deleteOne(player, id, id) }, BACK]
    }));
}

// ---------------------------------------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------------------------------------

async function addOne(player: Player): Promise<void> {

    let name = "";
    let type = 0;
    let refusal: string | undefined;

    for (;;) {

        const form = new ModalFormData()
            .title(refusal !== undefined ? `Not saved: ${refusal}` : "Add an ending (placed where you stand)")
            .textField("Name", "Escape boat", { defaultValue: name })
            .dropdown("Type", ["Group: the whole gang, ends the round", "Solo: one outlaw leaves alone"], { defaultValueIndex: type });

        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) return;

        name = String(response.formValues[0] ?? "");
        type = Number(response.formValues[1] ?? 0);

        const made = newEnding(type === 1 ? "solo" : "group", newEndingId(name), name, standingPlace(player));
        const saved = made.ok ? saveEnding(made.value) : made;

        if (!saved.ok) {
            refusal = saved.reason;
            continue;
        }

        screens.notify(player, format("ok", `Added ${made.ok ? made.value.name : ""}. Its place is where you stood: move it from its own screen if that was wrong.`));
        return;
    }
}

// ---------------------------------------------------------------------------------------------------------
// One ending
// ---------------------------------------------------------------------------------------------------------

function summary(ending: Ending): string {

    const lines = [
        `${kindName(ending)} ending, ${ending.enabled ? "§aon" : "§coff"}§r.`,
        `Place: ${where(ending.place)}, within ${ending.radius} blocks.`,
        ending.kind === "group" ? `Price: ${ending.price} coins from each outlaw in the gang.` : `Price: ${ending.price} coins.`
    ];

    if (ending.kind === "solo") {
        lines.push(ending.item
            ? `Item: ${ending.item.count} x ${ending.item.id}, ${ending.consumeItem ? "taken" : "only has to be held"}.`
            : "Item: none.");
    }

    lines.push(ending.winSpot ? `Winners are taken to ${where(ending.winSpot)}.` : "Nobody is moved when it succeeds.");

    return lines.join("\n");
}

async function oneEnding(player: Player, id: string): Promise<void> {

    await screens.run(player, () => {

        const ending = getEnding(id);

        // Deleted from under the screen: there is nothing left to show.
        if (!ending) return undefined;

        const actions: Action[] = [
            { label: ending.enabled ? "Turn it off" : "Turn it on", run: () => apply(player, ending, { enabled: !ending.enabled }, ending.enabled ? "It is off." : "It is on.") },
            { label: "Name, radius and price", run: () => details(player, id) },
            { label: "Messages", run: () => messages(player, id) },
            { label: "Move the place to where I stand", run: () => apply(player, ending, { place: standingPlace(player) }, "The place is where you stand.") },
            { label: "Set the win spot to where I stand", run: () => apply(player, ending, { winSpot: standingPlace(player) }, "Winners will be taken to where you stand.") }
        ];

        if (ending.winSpot) actions.push({ label: "Clear the win spot", run: () => apply(player, ending, { winSpot: null }, "Nobody will be moved.") });

        if (ending.kind === "solo") {
            actions.push({ label: "Take the item from my hand", run: () => takeItem(player, ending) });
            if (ending.item) actions.push({ label: "Ask for no item", run: () => apply(player, ending, { item: null }, "It asks for no item.") });
        }

        if (undoAvailable(id)) actions.push({ label: "Undo my last change", run: () => undo(player, id) });

        actions.push({ label: "Delete", run: () => deleteOne(player, id, ending.name) });
        actions.push(BACK);

        return { title: ending.name, body: summary(ending), actions };
    });
}

/** Makes one change and saves it, saying how it went at the top of the next screen. */
function apply(player: Player, ending: Ending, patch: EndingPatch, said: string): void {

    const made = edit(ending, patch);
    const saved = made.ok ? saveEnding(made.value) : made;

    screens.notify(player, saved.ok ? format("ok", said) : format("warn", `Not changed: ${saved.reason}.`));
}

function takeItem(player: Player, ending: Ending): void {

    const stack = heldStack(player);

    if (!stack) {
        screens.notify(player, format("warn", "Your hand is empty: hold the item the ending should ask for, then press this again."));
        return;
    }

    // A stack is never above 64, the most an ending may ask for, so there is no count to clamp.
    apply(player, ending, { item: { id: stack.typeId, count: stack.amount } }, `It asks for ${stack.amount} x ${stack.typeId}.`);
}

function undo(player: Player, id: string): void {

    const result = undoEnding(id);

    screens.notify(player, result.ok ? format("ok", "Undone.") : format("warn", `Not undone: ${result.reason}.`));
}

async function deleteOne(player: Player, id: string, called: string): Promise<Step> {

    if (!await confirmForm(player, `Delete ${called}?`, "Players can no longer escape that way. You can bring it back from the list until the scripts reload.", "Delete it")) return;

    const result = removeEnding(id);

    if (result.ok) lastDeleted = id;

    screens.notify(player, result.ok ? format("ok", `Deleted ${called}.`) : format("warn", `Not deleted: ${result.reason}.`));

    return "back";
}

// ---------------------------------------------------------------------------------------------------------
// The boxes
// ---------------------------------------------------------------------------------------------------------

/** One control of a box: what it is called, what it starts as, and whether it is text or a switch. */
type Field = { readonly label: string; readonly start: string } | { readonly label: string; readonly toggle: boolean };

/**
 * A box of fields over one ending. It is shown again, with the reason in its title and what was typed kept, until the answers make a change the store
 * accepts or the operator closes it (which saves nothing). `read` turns the answers into a change, or says why it cannot.
 */
async function box(player: Player, id: string, title: string, fields: readonly Field[], read: (answers: readonly (string | boolean)[], ending: Ending) => Result<EndingPatch>): Promise<void> {

    let typed: (string | boolean)[] | undefined;
    let refusal: string | undefined;

    for (;;) {

        const shown = getEnding(id);
        if (!shown) return;

        const form = new ModalFormData().title(refusal !== undefined ? `Not saved: ${refusal}` : title);

        fields.forEach((field, index) => {
            const kept = typed?.[index];

            if ("toggle" in field) form.toggle(field.label, { defaultValue: typeof kept === "boolean" ? kept : field.toggle });
            else form.textField(field.label, "", { defaultValue: typeof kept === "string" ? kept : field.start });
        });

        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) return;

        typed = fields.map((field, index) => {
            const value = response.formValues?.[index];
            return "toggle" in field ? value === true : String(value ?? "");
        });

        // Read again: another operator may have deleted it while the box was up, and saving would bring it back.
        const ending = getEnding(id);

        if (!ending) {
            screens.notify(player, format("warn", "Not saved: that ending was deleted while the box was open."));
            return;
        }

        const patch = read(typed, ending);
        const made = patch.ok ? edit(ending, patch.value) : patch;
        const saved = made.ok ? saveEnding(made.value) : made;

        if (!saved.ok) {
            refusal = saved.reason;
            continue;
        }

        screens.notify(player, format("ok", "Saved."));
        return;
    }
}

/** A number typed into a box, or why it is not one. */
function numberFrom(label: string, text: string): Result<number> {

    const value = text.trim() === "" ? Number.NaN : Number(text);

    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: `the ${label} must be a number` };
}

function details(player: Player, id: string): Promise<void> {

    const ending = getEnding(id);

    if (!ending) return Promise.resolve();

    const fields: Field[] = [
        { label: "Name", start: ending.name },
        { label: "Radius (blocks)", start: String(ending.radius) },
        { label: ending.kind === "group" ? "Price per gang member (coins)" : "Price (coins)", start: String(ending.price) }
    ];

    if (ending.item) {
        fields.push({ label: "Item count", start: String(ending.item.count) });
        fields.push({ label: "The item is taken (off: it only has to be held)", toggle: ending.consumeItem });
    }

    return box(player, id, `Settings for ${ending.name}`, fields, (answers, current) => {

        const radius = numberFrom("radius", String(answers[1]));
        if (!radius.ok) return radius;

        const price = numberFrom("price", String(answers[2]));
        if (!price.ok) return price;

        const patch: { -readonly [K in keyof EndingPatch]: EndingPatch[K] } = { name: String(answers[0]), radius: radius.value, price: price.value };

        if (current.item) {
            const count = numberFrom("item count", String(answers[3]));
            if (!count.ok) return count;

            patch.item = { id: current.item.id, count: count.value };
            patch.consumeItem = answers[4] === true;
        }

        return { ok: true, value: patch };
    });
}

function messages(player: Player, id: string): Promise<void> {

    const ending = getEnding(id);

    if (!ending) return Promise.resolve();

    const fields: Field[] = [
        { label: "Announced when it succeeds", start: ending.texts.headline },
        { label: "The line under it", start: ending.texts.detail },
        { label: ending.kind === "group" ? "Said when the gang is not all there" : "Said when they are not at the place", start: ending.texts.gather },
        { label: "Said to anyone who is not an outlaw", start: ending.texts.outlawsOnly }
    ];

    return box(player, id, `Messages for ${ending.name} ({coins} {player} {count} are filled in)`, fields, (answers) => ({
        ok: true,
        value: { texts: { headline: String(answers[0]), detail: String(answers[1]), gather: String(answers[2]), outlawsOnly: String(answers[3]) } }
    }));
}
