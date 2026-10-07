import { ItemStack, system, type Player } from "@minecraft/server";
import { ROBBERY as R } from "../config/balance.js";
import { classOfBlockType } from "../logic/blockclass.js";
import {
    addElement, boxSize, cleanName, newRobbery, removeElement, sameDimension, setArea, updateElement,
    type Edit, type Element, type ElementKind, type Pos, type Robbery
} from "../logic/robbery.js";
import { slugify, suggestKind, whyBlockCannotBe } from "../logic/robberymeta.js";
import { warn } from "./log.js";
import { registerSystem } from "./registry.js";
import { allRobberies, boundAt, getRobbery, getStored, listStored, saveRobbery } from "./robberystore.js";
import { cellsToBind, neighbourChest, typeAt } from "./robberyworld.js";

/**
 * Editing a robbery, without any screen: which robbery a builder is working on, saving an edit, adding an element at a
 * block, and what a wand click means. The forms (core/robberyforms.ts) and the commands (systems/robberybuilder.ts) both
 * stand on this, so what they do is decided once and tested without a form in sight.
 *
 * Every change goes through `applyEdit`: the pure edit in logic/robbery.ts (which validates the whole result), then a check
 * that no block is claimed by two robberies (logic can only see one robbery at a time), then the store (which refuses what
 * does not fit and writes at once). A refusal is a sentence for the builder and changes nothing.
 */

export type EditOutcome = { readonly ok: true; readonly robbery: Robbery } | { readonly ok: false; readonly reason: string };

const fail = (reason: string): { readonly ok: false; readonly reason: string } => ({ ok: false, reason });

const label = (pos: Pos): string => `${pos[0]}, ${pos[1]}, ${pos[2]}`;

// ---------------------------------------------------------------------------------------------------------
// Which robbery a builder is working on
// ---------------------------------------------------------------------------------------------------------

/** On the player themself, so it survives a relog and a reload, and is each builder's own. */
const SELECTED_PROPERTY = "rae:robbery:selected";

export function selectedId(player: Player): string | undefined {

    try {
        const value = player.getDynamicProperty(SELECTED_PROPERTY);
        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
}

export function select(player: Player, id: string | undefined): void {

    try {
        player.setDynamicProperty(SELECTED_PROPERTY, id);
    } catch (err) {
        warn("robbery", `could not remember ${player.name}'s selection: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** The robbery this builder is working on: the one they chose, or, if they chose none, the only one there is. */
export function selectedRobbery(player: Player): Robbery | undefined {

    const chosen = selectedId(player);
    const robbery = chosen !== undefined ? getRobbery(chosen) : undefined;

    if (robbery) return robbery;

    const all = allRobberies();

    return all.length === 1 ? all[0] : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Making an edit
// ---------------------------------------------------------------------------------------------------------

/** The first block of this robbery that another robbery already uses, as a sentence, or undefined. */
function conflictWithOthers(robbery: Robbery): string | undefined {

    for (const element of robbery.elements) {
        for (const cell of element.cells) {
            const other = boundAt(robbery.dimension, cell[0], cell[1], cell[2]);
            if (other && other.robbery !== robbery.id) return `the block at ${label(cell)} already belongs to the robbery ${other.robbery}`;
        }
    }

    return undefined;
}

/** Applies an edit to a saved robbery and saves the result. Nothing changes unless all of it works. */
export function applyEdit(robberyId: string, edit: (robbery: Robbery) => Edit): EditOutcome {

    const current = getRobbery(robberyId);
    if (!current) return fail(`there is no robbery ${robberyId}`);

    const edited = edit(current);
    if (!edited.ok) return fail(edited.reason);

    const conflict = conflictWithOthers(edited.robbery);
    if (conflict) return fail(conflict);

    const saved = saveRobbery(edited.robbery);

    return saved.ok ? { ok: true, robbery: saved.robbery } : fail(saved.reason);
}

/** Makes a new robbery in the dimension the builder is standing in, and selects it. An empty id is made from the name. */
export function createRobbery(player: Player, idText: string, nameText: string): EditOutcome {

    const name = cleanName(nameText);
    const id = idText.trim().length > 0 ? idText.trim().toLowerCase() : slugify(name);

    if (id.length === 0) return fail("give it an id, or a name with some letters in it");
    if (getStored(id)) return fail(`there is already a robbery called ${id}`);

    const made = newRobbery(id, name, sameDimension(player.dimension.id));
    if (!made.ok) return fail(made.reason);

    const saved = saveRobbery(made.robbery);
    if (!saved.ok) return fail(saved.reason);

    select(player, id);

    return { ok: true, robbery: saved.robbery };
}

// ---------------------------------------------------------------------------------------------------------
// Binding blocks
// ---------------------------------------------------------------------------------------------------------

/** The blocks an element of this kind takes when `pos` is clicked: a door both halves, a chest maybe its twin, a switch just the one. */
function cellsFor(kind: ElementKind, dimension: string, pos: Pos, withNeighbour: boolean): Pos[] {

    if (kind === "door") return cellsToBind(dimension, pos);

    if (kind === "chest" && withNeighbour) {
        const twin = neighbourChest(dimension, pos);
        if (twin) return [pos, twin];
    }

    return [pos];
}

export interface AddSpec {
    readonly kind: ElementKind;
    /** Empty means a default name ("Door 3"). */
    readonly name: string;
    readonly pos: Pos;
    /** Bind the chest beside it too (a double chest). */
    readonly withNeighbour: boolean;
}

export type AddOutcome = { readonly ok: true; readonly robbery: Robbery; readonly element: Element } | { readonly ok: false; readonly reason: string };

/** Binds the block at `pos` as a new element of the robbery. */
export function addElementAt(robberyId: string, spec: AddSpec): AddOutcome {

    const robbery = getRobbery(robberyId);
    if (!robbery) return fail(`there is no robbery ${robberyId}`);

    const typeId = typeAt(robbery.dimension, spec.pos);
    if (typeId === undefined) return fail("that block is not loaded right now");

    const problem = whyBlockCannotBe(spec.kind, typeId);
    if (problem) return fail(problem);

    let added: Element | undefined;

    const outcome = applyEdit(robberyId, (current) => {
        const result = addElement(current, { kind: spec.kind, name: spec.name, cells: cellsFor(spec.kind, robbery.dimension, spec.pos, spec.withNeighbour) });
        if (result.ok) added = result.element;
        return result.ok ? { ok: true, robbery: result.robbery } : result;
    });

    if (!outcome.ok || !added) return outcome.ok ? fail("it could not be added") : outcome;

    return { ok: true, robbery: outcome.robbery, element: added };
}

export type RemoveOutcome = { readonly ok: true; readonly robbery: Robbery; readonly removedReferences: number } | { readonly ok: false; readonly reason: string };

/** Removes an element; says how many requirements that took with it. */
export function removeElementFrom(robberyId: string, elementId: string): RemoveOutcome {

    let removed = 0;

    const outcome = applyEdit(robberyId, (current) => {
        const result = removeElement(current, elementId);
        if (result.ok) removed = result.removedReferences;
        return result.ok ? { ok: true, robbery: result.robbery } : result;
    });

    return outcome.ok ? { ok: true, robbery: outcome.robbery, removedReferences: removed } : outcome;
}

// ---------------------------------------------------------------------------------------------------------
// What the wand's next click is waiting for
// ---------------------------------------------------------------------------------------------------------

/** A menu can ask for a click: the corners of the area, or the block to bind an element to. */
export type Pending =
    | { readonly kind: "corner"; readonly robbery: string; readonly first?: Pos }
    | { readonly kind: "rebind"; readonly robbery: string; readonly element: string; readonly mode: "replace" | "add" };

const pending = new Map<string, { readonly action: Pending; readonly until: number }>();

export function setPending(player: Player, action: Pending): void {
    pending.set(player.id, { action, until: system.currentTick + R.pendingSeconds * 20 });
}

export function clearPending(player: Player): void {
    pending.delete(player.id);
}

export function pendingFor(player: Player): Pending | undefined {

    const entry = pending.get(player.id);
    if (!entry) return undefined;

    if (system.currentTick > entry.until) {
        pending.delete(player.id);
        return undefined;
    }

    return entry.action;
}

/** What the wand did, for the caller to show: a line of text, or a screen to open. */
export type WandAction =
    | { readonly kind: "say"; readonly text: string }
    | { readonly kind: "element"; readonly robbery: string; readonly element: string }
    | { readonly kind: "add"; readonly robbery: string; readonly pos: Pos; readonly blockType: string }
    | { readonly kind: "new" }
    | { readonly kind: "pick" }
    | { readonly kind: "menu" };

const say = (text: string): WandAction => ({ kind: "say", text });

function sizeText(a: Pos, b: Pos): string {
    const size = boxSize({ min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] });
    return `${size.x} x ${size.y} x ${size.z}`;
}

function finishPending(player: Player, action: Pending, dimension: string, pos: Pos, blockType: string): WandAction {

    const robbery = getRobbery(action.robbery);

    if (!robbery) {
        clearPending(player);
        return say(`The robbery ${action.robbery} is gone.`);
    }

    if (robbery.dimension !== dimension) {
        return say(`That is in the ${dimension}, and ${robbery.name} is in the ${robbery.dimension}.`);
    }

    if (action.kind === "corner") {

        if (!action.first) {
            setPending(player, { kind: "corner", robbery: robbery.id, first: pos });
            return say(`Corner 1 is ${label(pos)}. Now click the opposite corner (or left-click the air to use where you stand).`);
        }

        const first = action.first;
        const outcome = applyEdit(robbery.id, (current) => setArea(current, first, pos));
        clearPending(player);

        return outcome.ok ? say(`The area of ${robbery.name} is now ${sizeText(first, pos)} blocks, from ${label(first)} to ${label(pos)}.`) : say(`The area was not set: ${outcome.reason}.`);
    }

    // rebind: the block clicked becomes (or is added to) the element's blocks.
    const element = robbery.elements.find((e) => e.id === action.element);

    if (!element) {
        clearPending(player);
        return say("That element is gone.");
    }

    const problem = whyBlockCannotBe(element.kind, blockType);
    if (problem) return say(`Not that block: ${problem}. Click another.`);

    const added = cellsFor(element.kind, dimension, pos, false);
    const cells = action.mode === "add"
        ? [...element.cells, ...added.filter((cell) => !element.cells.some((c) => c[0] === cell[0] && c[1] === cell[1] && c[2] === cell[2]))]
        : added;

    const outcome = applyEdit(robbery.id, (current) => updateElement(current, element.id, { cells }));

    if (!outcome.ok) return say(`Not changed: ${outcome.reason}.`);

    clearPending(player);

    return say(action.mode === "add"
        ? `${element.name} now also uses ${label(pos)}.`
        : `${element.name} is now bound to ${cells.map(label).join(" and ")}.`);
}

/**
 * The wand was used on a block. What that means depends on what is waiting for a click, on whether the builder is sneaking
 * (sneak and right-click anywhere is the main menu: the one gesture that needs nothing but a block to point at, so it is
 * the way to the menu that cannot fail to be heard), and on whether the block is bound.
 */
export function wandOnBlock(player: Player, dimensionId: string, pos: Pos, blockType: string): WandAction {

    const dimension = sameDimension(dimensionId);
    const waiting = pendingFor(player);

    if (waiting) return finishPending(player, waiting, dimension, pos, blockType);

    if (player.isSneaking) return { kind: "menu" };

    const bound = boundAt(dimension, pos[0], pos[1], pos[2]);

    if (bound) {
        select(player, bound.robbery);
        return { kind: "element", robbery: bound.robbery, element: bound.element };
    }

    const robbery = selectedRobbery(player);

    if (!robbery) return { kind: listStored().length === 0 ? "new" : "pick" };

    if (robbery.dimension !== dimension) return say(`${robbery.name} is in the ${robbery.dimension}. Go there, or select another robbery.`);

    return { kind: "add", robbery: robbery.id, pos, blockType };
}

/**
 * The wand was used on nothing: a left-click in the air (which the game reports reliably), or a right-click in the air where
 * it reports one. If a corner is wanted, where the builder stands is the corner; otherwise it is the menu.
 */
export function wandOnAir(player: Player): WandAction {

    const waiting = pendingFor(player);

    if (!waiting) return { kind: "menu" };

    if (waiting.kind !== "corner") return say("Click the block you mean; the air will not do.");

    const feet: Pos = [Math.floor(player.location.x), Math.floor(player.location.y), Math.floor(player.location.z)];

    return finishPending(player, waiting, sameDimension(player.dimension.id), feet, "minecraft:air");
}

/** What a block would be suggested to be, for the first choice in the add form. */
export function suggestedKind(blockType: string): ElementKind {
    return suggestKind(classOfBlockType(blockType));
}

// ---------------------------------------------------------------------------------------------------------
// The wand itself
// ---------------------------------------------------------------------------------------------------------

/** Puts a wand in the builder's inventory unless they have one. True if one was given. */
export function giveWand(player: Player): boolean {

    try {
        const container = player.getComponent("minecraft:inventory")?.container;
        if (!container) return false;

        for (let slot = 0; slot < container.size; slot++) {
            if (container.getItem(slot)?.typeId === R.wandItemId) return false;
        }

        container.addItem(new ItemStack(R.wandItemId, 1));

        return true;
    } catch (err) {
        warn("robbery", `could not give the wand: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

registerSystem({
    name: "robberyedit",
    reset() {
        // A round reset forgets which click anyone was waiting to make. What they had selected is theirs, and stays.
        pending.clear();
    }
});
