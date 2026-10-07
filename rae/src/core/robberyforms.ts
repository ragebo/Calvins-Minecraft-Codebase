import type { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { ROBBERY as R } from "../config/balance.js";
import {
    ELEMENT_KINDS, HOOK_NAMES, clearArea, findElement, itemLabel, setArea, setHook, setSettings, updateElement, whyNotRunnable,
    type Effect, type Element, type ElementKind, type HookName, type Lock, type LockKind, type Pos, type Robbery
} from "../logic/robbery.js";
import {
    EFFECT_LABELS, LOCK_LABELS, describeEffect, describeElement, describeLock, describeRobbery, effectFields, effectFromAnswers,
    formatItemList, lockFields, lockFromAnswers, parseItemList, readAnswers, sentence, settingsFields, settingsFromAnswers,
    type Answers, type Field
} from "../logic/robberymeta.js";
import { confirmForm, showForm } from "./forms.js";
import { error } from "./log.js";
import {
    addElementAt, applyEdit, createRobbery, removeElementFrom, select, selectedRobbery, setPending, suggestedKind,
    type Pending
} from "./robberyedit.js";
import { clock, cooldownLeftSeconds, resetSiteNow, startRobbery, stopRobbery, viewOf } from "./robberyrun.js";
import { deleteRobbery, getRobbery, listStored, undoAvailable, undoLast } from "./robberystore.js";
import { lootTableExists, neighbourChest } from "./robberyworld.js";
import { format, tell } from "./ui.js";

/**
 * Every screen the builder sees. Presentation only: what is shown comes from logic/robberymeta.ts (fields and plain-language
 * summaries) and every change is made through core/robberyedit.ts's `applyEdit`, which validates it, so a screen here can
 * ask for something the rules refuse and the answer is a sentence in chat, never a half-made robbery.
 *
 * A screen is a title, some text and a list of buttons, and a button runs an action that may open another screen. A screen
 * builds itself again each time it is shown, from what is saved right now, so what it says is never stale and a robbery
 * deleted from under an open screen simply closes it. Closing a form walks back one screen; the actions that need a click in
 * the world (the corners of the area, the block to bind) close everything, so the builder can click.
 */

const SOURCE = "robbery";

const ok = (text: string): string => format("ok", text);

/** The title of a screen about one thing: "Bank: settings". */
const heading = (name: string, what: string): string => `${name}: ${what}`;
const warn = (text: string): string => format("warn", text);

// ---------------------------------------------------------------------------------------------------------
// Plumbing: screens, questions, and who has one open
// ---------------------------------------------------------------------------------------------------------

type Step = "back" | void;
interface Action { readonly label: string; readonly run: () => Promise<Step> | Step }
interface Screen { readonly title: string; readonly body: string; readonly actions: readonly Action[] }

const BACK: Action = { label: "Back", run: () => "back" };

/** Builders with a menu open right now: a second menu on top of the first would only fight it for the form. */
const open = new Set<string>();
/** Builders whose whole menu stack should close (an action that needs a click in the world sets this). */
const closing = new Set<string>();

function closeAllMenus(player: Player): void {
    closing.add(player.id);
}

/** Runs a menu for a player unless one is already open, and always leaves them with none open. */
async function menuFor(player: Player, body: () => Promise<void>): Promise<void> {

    if (open.has(player.id)) {
        tell(player, warn("Finish or close the menu you have open first."));
        return;
    }

    open.add(player.id);
    closing.delete(player.id);

    try {
        await body();
    } catch (err) {
        error(SOURCE, `a menu failed for ${player.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        open.delete(player.id);
        closing.delete(player.id);
    }
}

/** Shows a screen, runs what is pressed, and shows it again, until it is closed, goes "back", or has nothing left to show. */
async function runScreen(player: Player, build: () => Screen | undefined): Promise<void> {

    for (;;) {

        if (closing.has(player.id) || !player.isValid) return;

        const screen = build();
        if (!screen) return;

        const form = new ActionFormData().title(screen.title).body(screen.body);
        for (const action of screen.actions) form.button(action.label);

        const response = await showForm(player, form);

        if (!response || response.canceled || response.selection === undefined) return;

        const action = screen.actions[response.selection];
        if (!action) return;

        if ((await action.run()) === "back") return;
    }
}

function addField(form: ModalFormData, field: Field): void {

    if (field.kind === "text") form.textField(field.label, field.placeholder, { defaultValue: field.value });
    else if (field.kind === "number") form.textField(field.label, String(field.value), { defaultValue: String(field.value) });
    else if (field.kind === "toggle") form.toggle(field.label, { defaultValue: field.value });
    else if (field.kind === "slider") form.slider(field.label, field.min, field.max, { valueStep: field.step, defaultValue: field.value });
    else form.dropdown(field.label, field.options.map((option) => option.label), { defaultValueIndex: Math.max(0, field.options.findIndex((option) => option.value === field.value)) });
}

/** Asks a form's worth of questions. Undefined when it was closed, or when an answer was refused (and said why in chat). */
async function ask(player: Player, title: string, fields: readonly Field[]): Promise<Answers | undefined> {

    const form = new ModalFormData().title(title);
    for (const field of fields) addField(form, field);

    const response = await showForm(player, form);

    if (!response || response.canceled) return undefined;

    const read = readAnswers(fields, response.formValues);

    if (!read.ok) {
        tell(player, warn(sentence(read.reason)));
        return undefined;
    }

    return read.value;
}

/** Tells the builder how an edit went. True when it worked. */
function report(player: Player, outcome: { readonly ok: boolean; readonly reason?: string }, success: string): boolean {

    if (outcome.ok) {
        tell(player, ok(success));
        return true;
    }

    tell(player, warn(`Not changed: ${(outcome.reason ?? "it did not work").replace(/\.$/, "")}.`));

    return false;
}

const statusLine = (id: string): string => {

    const view = viewOf(id);

    if (view) {
        const waiting = view.resetInSeconds !== undefined ? `, put back in ${clock(view.resetInSeconds)}` : "";
        return `§7Right now: §f${view.phase === "running" ? "running" : `over (${view.result ?? "ended"})`}${view.test ? " (test)" : ""}${waiting}`;
    }

    const wait = cooldownLeftSeconds(id);

    return wait > 0 ? `§7Right now: §fclosed for another ${clock(wait)}` : "§7Right now: §fidle";
};

// ---------------------------------------------------------------------------------------------------------
// Robberies: the main menu, choosing one, making one
// ---------------------------------------------------------------------------------------------------------

/** The wand's menu. */
export function openMainMenu(player: Player): Promise<void> {

    return menuFor(player, async () => {

        for (;;) {

            const robbery = selectedRobbery(player);

            if (!robbery) {
                await (listStored().length === 0 ? newRobberyForm(player) : pickScreen(player));
                if (!selectedRobbery(player)) return;
                continue;
            }

            const id = robbery.id;
            let leave = false;

            await runScreen(player, () => {

                const current = getRobbery(id);
                if (!current) return undefined;

                const problems = whyNotRunnable(current);

                const actions: Action[] = [
                    { label: `Elements (${current.elements.length})`, run: () => elementsScreen(player, id) },
                    { label: "Settings", run: () => settingsForm(player, id) },
                    { label: "Area", run: () => areaScreen(player, id) },
                    { label: "Start, win and fail effects", run: () => hooksScreen(player, id) },
                    { label: "Run it: start, test, stop, reset", run: () => runControls(player, id) },
                    { label: "Rename", run: () => renameForm(player, id) },
                    { label: "Another robbery, or a new one", run: async () => { await pickScreen(player); leave = true; return "back"; } },
                    ...(undoAvailable(id) ? [{ label: "Undo the last change", run: () => undoChange(player, id) }] : []),
                    { label: "Delete this robbery", run: async () => { if (await deleteRobberyConfirmed(player, id)) { leave = true; return "back"; } } },
                    { label: "Close", run: () => { closeAllMenus(player); } }
                ];

                return { title: current.name, body: `${describeRobbery(current, problems).join("\n")}\n${statusLine(id)}`, actions };
            });

            if (!leave) return;
        }
    });
}

async function pickScreen(player: Player): Promise<Step> {

    await runScreen(player, () => {

        const stored = listStored();

        const actions: Action[] = stored.map((entry) => entry.ok
            ? { label: `${entry.robbery.name} (${entry.id}, ${entry.robbery.elements.length} elements)`, run: (): Step => { select(player, entry.id); return "back"; } }
            : { label: `§c${entry.id}: cannot be read`, run: (): void => { tell(player, warn(`${entry.id} cannot be read: ${entry.problem}. It is left exactly as it is.`)); } });

        actions.push({ label: "A new robbery", run: async () => { await newRobberyForm(player); return selectedRobbery(player) ? "back" : undefined; } });
        actions.push(BACK);

        return { title: "Robberies", body: stored.length === 0 ? "There are none yet." : "Which one are you working on?", actions };
    });

    return undefined;
}

async function newRobberyForm(player: Player): Promise<Step> {

    const answers = await ask(player, "A new robbery", [
        { kind: "text", key: "name", label: "What it is called", placeholder: "Saint Diego Bank", value: "" },
        { kind: "text", key: "id", label: `A short id, lowercase (blank: made from the name, up to ${R.maxIdLength} characters)`, placeholder: "saint_diego", value: "" }
    ]);

    if (!answers) return undefined;

    const made = createRobbery(player, String(answers["id"]), String(answers["name"]));

    report(player, made, made.ok ? `Made ${made.robbery.name} (${made.robbery.id}) and selected it. Point the wand at a door, chest or button and right-click to bind it.` : "");

    return undefined;
}

async function renameForm(player: Player, id: string): Promise<Step> {

    const robbery = getRobbery(id);
    if (!robbery) return;

    const answers = await ask(player, "Rename", [{ kind: "text", key: "name", label: "Its name", placeholder: robbery.name, value: robbery.name }]);
    if (!answers) return;

    report(player, applyEdit(id, (current) => ({ ok: true, robbery: { ...current, name: String(answers["name"]) } })), "Renamed.");
}

async function undoChange(player: Player, id: string): Promise<Step> {

    report(player, undoLast(id), "Undone. (Undo again to put it back.)");
}

async function deleteRobberyConfirmed(player: Player, id: string): Promise<boolean> {

    const robbery = getRobbery(id);
    if (!robbery) return true;

    const sure = await confirmForm(player, "Delete it?", `Delete ${robbery.name}, its ${robbery.elements.length} elements and everything set on them? Its doors are shut and its chests emptied first. "Undo" brings it back until the world is reloaded.`, "Delete it");
    if (!sure) return false;

    resetSiteNow(id);

    const gone = deleteRobbery(id);
    if (gone.ok) select(player, undefined);

    report(player, gone, `Deleted ${robbery.name}.`);

    return gone.ok;
}

// ---------------------------------------------------------------------------------------------------------
// Settings, area, hooks, running
// ---------------------------------------------------------------------------------------------------------

async function settingsForm(player: Player, id: string): Promise<Step> {

    const robbery = getRobbery(id);
    if (!robbery) return;

    const answers = await ask(player, heading(robbery.name, "settings"), settingsFields(robbery.settings));
    if (!answers) return;

    report(player, applyEdit(id, (current) => setSettings(current, settingsFromAnswers(answers))), "Settings saved.");
}

async function areaScreen(player: Player, id: string): Promise<Step> {

    await runScreen(player, () => {

        const robbery = getRobbery(id);
        if (!robbery) return undefined;

        const here = (): Pos => [Math.floor(player.location.x), Math.floor(player.location.y), Math.floor(player.location.z)];

        const actions: Action[] = [
            {
                label: "Set it by clicking two corners",
                run: () => {
                    setPending(player, { kind: "corner", robbery: id });
                    tell(player, ok("Click the first corner with the wand (the air counts as where you stand), then the opposite one."));
                    closeAllMenus(player);
                }
            },
            {
                label: "A box around where I stand",
                run: async () => {
                    const answers = await ask(player, "Area around you", [{ kind: "slider", key: "radius", label: "How far out (blocks)", min: 3, max: 60, step: 1, value: 20 }]);
                    if (!answers) return;
                    const radius = Number(answers["radius"]);
                    const [x, y, z] = here();
                    report(player, applyEdit(id, (current) => setArea(current, [x - radius, y - 5, z - radius], [x + radius, y + radius, z + radius])), "The area is set.");
                }
            },
            ...(robbery.area ? [{ label: "Clear it", run: (): void => { report(player, applyEdit(id, clearArea), "The area is cleared."); } }] : []),
            BACK
        ];

        const area = robbery.area ? `${robbery.area.min.join(", ")}  to  ${robbery.area.max.join(", ")}` : "not set";

        return { title: heading(robbery.name, "area"), body: `The area is where "everyone in the area" is counted, and what the empty-area fail watches.\n§7Now: §f${area}`, actions };
    });
}

async function hooksScreen(player: Player, id: string): Promise<Step> {

    await runScreen(player, () => {

        const robbery = getRobbery(id);
        if (!robbery) return undefined;

        const names: Record<HookName, string> = { start: "When it starts", win: "When it is won", fail: "When it fails" };

        return {
            title: heading(robbery.name, "effects"),
            body: "What happens at the start, and at the end, of the whole robbery.",
            actions: [...HOOK_NAMES.map((hook): Action => ({ label: `${names[hook]} (${robbery.hooks[hook].length})`, run: () => effectsScreen(player, id, { kind: "hook", hook }) })), BACK]
        };
    });
}

async function runControls(player: Player, id: string): Promise<Step> {

    await runScreen(player, () => {

        const robbery = getRobbery(id);
        if (!robbery) return undefined;

        const running = viewOf(id)?.phase === "running";

        const actions: Action[] = [
            { label: "Start it now", run: () => { report(player, startRobbery(id, { by: player }), "Started."); } },
            { label: "Start a test run (anyone can take part, no cooldown)", run: () => { report(player, startRobbery(id, { by: player, test: true }), "Test run started."); } },
            ...(running ? [{ label: "Stop it", run: (): void => { report(player, stopRobbery(id), "Stopped. The site is put back."); } }] : []),
            {
                label: "Put the site back now",
                run: () => {
                    const result = resetSiteNow(id);
                    tell(player, ok(`Put back ${result.cleaned} block${result.cleaned === 1 ? "" : "s"}${result.left > 0 ? `; ${result.left} more wait for their chunk to load` : ""}.`));
                }
            },
            BACK
        ];

        return { title: heading(robbery.name, "run it"), body: statusLine(id), actions };
    });
}

// ---------------------------------------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------------------------------------

async function elementsScreen(player: Player, id: string): Promise<Step> {

    await runScreen(player, () => {

        const robbery = getRobbery(id);
        if (!robbery) return undefined;

        const view = viewOf(id);
        const stateOf = (element: Element): string => view?.elements.find((e) => e.id === element.id)?.state ?? "idle";

        const actions: Action[] = [
            ...robbery.elements.map((element): Action => ({ label: `${element.name} (${element.kind}, ${stateOf(element)})`, run: () => elementScreen(player, id, element.id) })),
            BACK
        ];

        return {
            title: heading(robbery.name, "elements"),
            body: robbery.elements.length === 0
                ? "None yet. Close this and right-click a door, chest, button, lever or plate with the wand to bind it."
                : "Pick one to change it. To add another, right-click a block with the wand.",
            actions
        };
    });
}

/** Opens one element's screen. The wand does this when it is used on a bound block. */
export function openElementMenu(player: Player, robberyId: string, elementId: string): Promise<void> {
    return menuFor(player, async () => { await elementScreen(player, robberyId, elementId); });
}

async function elementScreen(player: Player, robberyId: string, elementId: string): Promise<Step> {

    await runScreen(player, () => {

        const robbery = getRobbery(robberyId);
        const element = robbery ? findElement(robbery, elementId) : undefined;

        if (!robbery || !element) return undefined;

        const view = viewOf(robberyId)?.elements.find((e) => e.id === elementId);
        const hasPick = element.locks.some((lock) => lock.kind === "pick");

        const actions: Action[] = [
            { label: "Rename", run: () => renameElementForm(player, robberyId, elementId) },
            { label: `Locks (${element.locks.length})`, run: () => locksScreen(player, robberyId, elementId) },
            { label: `Waits for (${element.req.length})`, run: () => requirementsForm(player, robberyId, elementId) },
            { label: `When it is done (${element.onDone.length})`, run: () => effectsScreen(player, robberyId, { kind: "done", element: elementId }) },
            ...(hasPick ? [{ label: `When its lock jams (${element.onFail.length})`, run: () => effectsScreen(player, robberyId, { kind: "fail", element: elementId }) }] : []),
            ...(element.kind === "chest" ? [{ label: "Loot", run: () => lootForm(player, robberyId, elementId) }] : []),
            { label: "Change its blocks", run: () => blocksScreen(player, robberyId, elementId) },
            { label: "Delete it", run: async () => { if (await deleteElementConfirmed(player, robberyId, elementId)) return "back"; } },
            BACK
        ];

        const state = view ? `\n§7Right now: §f${view.state}` : "";

        return { title: element.name, body: `${describeElement(robbery, element).join("\n")}${state}`, actions };
    });
}

async function renameElementForm(player: Player, robberyId: string, elementId: string): Promise<Step> {

    const element = findElementOf(robberyId, elementId);
    if (!element) return;

    const answers = await ask(player, "Rename", [{ kind: "text", key: "name", label: "Its name", placeholder: element.name, value: element.name }]);
    if (!answers) return;

    report(player, applyEdit(robberyId, (current) => updateElement(current, elementId, { name: String(answers["name"]) })), "Renamed.");
}

function findElementOf(robberyId: string, elementId: string): Element | undefined {
    const robbery = getRobbery(robberyId);
    return robbery ? findElement(robbery, elementId) : undefined;
}

async function deleteElementConfirmed(player: Player, robberyId: string, elementId: string): Promise<boolean> {

    const element = findElementOf(robberyId, elementId);
    if (!element) return true;

    const sure = await confirmForm(player, "Delete it?", `Delete ${element.name}? Anything that waited for it stops waiting.`, "Delete it");
    if (!sure) return false;

    const removed = removeElementFrom(robberyId, elementId);

    report(player, removed, removed.ok
        ? `Deleted ${element.name}${removed.removedReferences > 0 ? `; ${removed.removedReferences} thing${removed.removedReferences === 1 ? "" : "s"} no longer wait${removed.removedReferences === 1 ? "s" : ""} for it` : ""}.`
        : "");

    return removed.ok;
}

// ---------------------------------------------------------------------------------------------------------
// Locks and requirements
// ---------------------------------------------------------------------------------------------------------

async function locksScreen(player: Player, robberyId: string, elementId: string): Promise<Step> {

    await runScreen(player, () => {

        const element = findElementOf(robberyId, elementId);
        if (!element) return undefined;

        const actions: Action[] = [];

        for (const lock of element.locks) {
            actions.push({ label: `Change: ${describeLock(lock)}`, run: () => lockForm(player, robberyId, elementId, lock.kind) });
            actions.push({ label: `Remove: ${LOCK_LABELS[lock.kind]}`, run: () => { report(player, applyEdit(robberyId, (current) => updateElement(current, elementId, { locks: element.locks.filter((l) => l.kind !== lock.kind) })), `${LOCK_LABELS[lock.kind]} removed.`); } });
        }

        if (element.locks.length < R.maxLocks) {
            for (const kind of ["pick", "key", "pay"] as const) {
                if (!element.locks.some((lock) => lock.kind === kind)) actions.push({ label: `Add a ${LOCK_LABELS[kind].toLowerCase()}`, run: () => lockForm(player, robberyId, elementId, kind) });
            }
        }

        actions.push(BACK);

        return {
            title: heading(element.name, "locks"),
            body: element.locks.length === 0
                ? "No locks. Touched with nothing in the way, it opens at once (once what it waits for is done)."
                : `${element.locks.map(describeLock).join("\n")}\n§7All of them must be passed.`,
            actions
        };
    });
}

async function lockForm(player: Player, robberyId: string, elementId: string, kind: LockKind): Promise<Step> {

    const element = findElementOf(robberyId, elementId);
    if (!element) return;

    const current = element.locks.find((lock) => lock.kind === kind);
    const answers = await ask(player, heading(element.name, LOCK_LABELS[kind].toLowerCase()), lockFields(kind, current));
    if (!answers) return;

    const raw = lockFromAnswers(kind, answers);
    const others = element.locks.filter((lock) => lock.kind !== kind);

    // The raw answers are judged by the same validator as a saved lock (inside the edit); a wrong one comes back as a sentence.
    report(player, applyEdit(robberyId, (c) => updateElement(c, elementId, { locks: [...others, raw as Lock] })), `${LOCK_LABELS[kind]} saved.`);
}

async function requirementsForm(player: Player, robberyId: string, elementId: string): Promise<Step> {

    const robbery = getRobbery(robberyId);
    const element = robbery ? findElement(robbery, elementId) : undefined;
    if (!robbery || !element) return;

    const others = robbery.elements.filter((e) => e.id !== elementId);

    if (others.length === 0) {
        tell(player, warn("There is nothing else for it to wait for yet. Bind another element first."));
        return;
    }

    const answers = await ask(player, heading(element.name, "waits for"), others.map((other): Field => ({ kind: "toggle", key: other.id, label: `Waits for ${other.name}`, value: element.req.includes(other.id) })));
    if (!answers) return;

    const req = others.filter((other) => answers[other.id] === true).map((other) => other.id);

    report(player, applyEdit(robberyId, (current) => updateElement(current, elementId, { req })), req.length === 0 ? "It waits for nothing now: touching it can start the robbery." : "Saved.");
}

// ---------------------------------------------------------------------------------------------------------
// Effects: when an element is done or jams, and at the start and end of the robbery
// ---------------------------------------------------------------------------------------------------------

type Target = { readonly kind: "done" | "fail"; readonly element: string } | { readonly kind: "hook"; readonly hook: HookName };

function effectsOf(robbery: Robbery, target: Target): readonly Effect[] | undefined {

    if (target.kind === "hook") return robbery.hooks[target.hook];

    const element = findElement(robbery, target.element);

    return element ? (target.kind === "done" ? element.onDone : element.onFail) : undefined;
}

function titleOf(robbery: Robbery, target: Target): string {

    if (target.kind === "hook") return heading(robbery.name, target.hook === "start" ? "when it starts" : target.hook === "win" ? "when it is won" : "when it fails");

    return `${findElement(robbery, target.element)?.name ?? "Element"}: ${target.kind === "done" ? "when it is done" : "when its lock jams"}`;
}

/** Writes a whole effect list. The effects may be raw (an effect form's answers): the validators inside the edit judge them. */
function writeEffects(robberyId: string, target: Target, effects: readonly unknown[]): ReturnType<typeof applyEdit> {

    if (target.kind === "hook") return applyEdit(robberyId, (current) => setHook(current, target.hook, effects as readonly Effect[]));

    return applyEdit(robberyId, (current) => updateElement(current, target.element, target.kind === "done" ? { onDone: effects as readonly Effect[] } : { onFail: effects as readonly Effect[] }));
}

async function effectsScreen(player: Player, robberyId: string, target: Target): Promise<Step> {

    await runScreen(player, () => {

        const robbery = getRobbery(robberyId);
        const effects = robbery ? effectsOf(robbery, target) : undefined;

        if (!robbery || !effects) return undefined;

        const actions: Action[] = effects.map((effect, index): Action => ({ label: describeEffect(effect), run: () => effectForm(player, robberyId, target, index) }));

        if (effects.length < R.maxEffectsPerList) {
            for (const kind of ["say", "reward", "end"] as const) actions.push({ label: `Add: ${EFFECT_LABELS[kind].toLowerCase()}`, run: () => effectForm(player, robberyId, target, undefined, kind) });
        }

        actions.push(BACK);

        return {
            title: titleOf(robbery, target),
            body: effects.length === 0 ? "Nothing happens. Add something." : `${effects.length} thing${effects.length === 1 ? "" : "s"} happen, in this order. Pick one to change or delete it.`,
            actions
        };
    });
}

async function effectForm(player: Player, robberyId: string, target: Target, index: number | undefined, newKind?: Effect["kind"]): Promise<Step> {

    const robbery = getRobbery(robberyId);
    const effects = robbery ? effectsOf(robbery, target) : undefined;
    if (!robbery || !effects) return;

    const existing = index !== undefined ? effects[index] : undefined;
    const kind = existing?.kind ?? newKind;
    if (!kind) return;

    const fields: Field[] = [...effectFields(kind, existing), ...(existing ? [{ kind: "toggle", key: "remove", label: "Delete this effect", value: false } as const] : [])];
    const answers = await ask(player, `${EFFECT_LABELS[kind]}`, fields);
    if (!answers) return;

    if (existing && answers["remove"] === true) {
        report(player, writeEffects(robberyId, target, effects.filter((_, i) => i !== index)), "Deleted.");
        return;
    }

    const written = effectFromAnswers(kind, answers);
    const next = existing && index !== undefined ? effects.map((effect, i): unknown => (i === index ? written : effect)) : [...effects, written];

    report(player, writeEffects(robberyId, target, next), existing ? "Changed." : "Added.");
}

// ---------------------------------------------------------------------------------------------------------
// Loot and blocks
// ---------------------------------------------------------------------------------------------------------

async function lootForm(player: Player, robberyId: string, elementId: string): Promise<Step> {

    const element = findElementOf(robberyId, elementId);
    if (!element || element.kind !== "chest") return;

    const answers = await ask(player, heading(element.name, "loot"), [
        { kind: "text", key: "table", label: "A loot table to roll (blank: none)", placeholder: "chests/gold_2", value: element.table ?? "" },
        { kind: "text", key: "items", label: "Items to add on top: item amount, item amount", placeholder: "minecraft:diamond 2, minecraft:emerald 5", value: formatItemList(element.items) }
    ]);

    if (!answers) return;

    const items = parseItemList(String(answers["items"]));

    if (!items.ok) {
        tell(player, warn(sentence(items.reason)));
        return;
    }

    const table = String(answers["table"]);
    const saved = applyEdit(robberyId, (current) => updateElement(current, elementId, { table: table.length > 0 ? table : null, items: items.value }));

    if (!report(player, saved, "Loot saved. It goes in the chest when the chest is unlocked, and out again when the site is put back.")) return;

    if (table.length > 0 && lootTableExists(table) === false) {
        tell(player, warn(`The game has no loot table called ${table}, so only the items you listed will be in the chest.`));
    }
}

async function blocksScreen(player: Player, robberyId: string, elementId: string): Promise<Step> {

    await runScreen(player, () => {

        const element = findElementOf(robberyId, elementId);
        if (!element) return undefined;

        const ask = (mode: "replace" | "add"): Action["run"] => () => {
            const pending: Pending = { kind: "rebind", robbery: robberyId, element: elementId, mode };
            setPending(player, pending);
            tell(player, ok(mode === "replace" ? `Right-click the block ${element.name} should be bound to, with the wand.` : `Right-click the extra block ${element.name} should also use, with the wand.`));
            closeAllMenus(player);
        };

        const actions: Action[] = [{ label: "Move it: click the new block", run: ask("replace") }];

        const most = element.kind === "switch" ? R.maxCells : 2;
        if (element.cells.length < most && element.kind !== "door") actions.push({ label: "Add another block (click it)", run: ask("add") });

        actions.push(BACK);

        return { title: heading(element.name, "blocks"), body: `Now at: ${element.cells.map((c) => c.join(", ")).join("  |  ")}`, actions };
    });
}

// ---------------------------------------------------------------------------------------------------------
// Adding an element at a block
// ---------------------------------------------------------------------------------------------------------

/** The wand was used on a block that is not part of any robbery: ask what it should be. */
export function openAddElement(player: Player, robberyId: string, pos: Pos, blockType: string): Promise<void> {

    return menuFor(player, async () => {

        const robbery = getRobbery(robberyId);
        if (!robbery) return;

        const suggested = suggestedKind(blockType);
        const twin = suggested === "chest" ? neighbourChest(robbery.dimension, pos) : undefined;

        const kinds: readonly { readonly value: ElementKind; readonly label: string }[] = [
            { value: "door", label: "A door: it opens when it is done" },
            { value: "chest", label: "A chest: loot goes in when it is unlocked" },
            { value: "switch", label: "A switch or keypad: a button, lever or plate to work" }
        ];

        const answers = await ask(player, heading(robbery.name, "bind a block"), [
            { kind: "choice", key: "kind", label: `Bind ${itemLabel(blockType)} at ${pos.join(", ")} as...`, options: kinds, value: suggested },
            { kind: "text", key: "name", label: "Its name (blank: a default like Door 3)", placeholder: "Vault door", value: "" },
            ...(twin ? [{ kind: "toggle", key: "twin", label: "Also bind the chest beside it (a double chest)", value: true } as const] : [])
        ]);

        if (!answers) return;

        const kind = ELEMENT_KINDS.find((candidate) => candidate === answers["kind"]);
        if (!kind) return;

        const added = addElementAt(robberyId, { kind, name: String(answers["name"]), pos, withNeighbour: answers["twin"] === true });

        if (!report(player, added, added.ok ? `Bound ${added.element.name}. Set what it does:` : "") || !added.ok) return;

        await elementScreen(player, robberyId, added.element.id);
    });
}

/** The wand was used with no robbery yet: make the first one. */
export function openNewRobbery(player: Player): Promise<void> {
    return menuFor(player, async () => { await newRobberyForm(player); });
}

/** The wand was used with robberies saved but none chosen. */
export function openPickRobbery(player: Player): Promise<void> {
    return menuFor(player, async () => { await pickScreen(player); });
}
