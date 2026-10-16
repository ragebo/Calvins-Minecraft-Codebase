import type { Player } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { START as S } from "../config/balance.js";
import { addCommand, editCommand, makeShot, nextShotId, removeCommand, type Mark, type Result, type Shot } from "../logic/start.js";
import { confirmForm, showForm } from "./forms.js";
import { eyeMark, pendingMark as readPending, setPendingMark as writePending, where } from "./marks.js";
import { isOperator } from "./players.js";
import { BACK, createScreens, type Action, type Step } from "./screens.js";
import { previewShot } from "./startsequence.js";
import { commandsAreDefault, commandsProblem, deleteShot, getShot, listStoredShots, resetStartCommands, saveShot, saveStartCommands, startCommands } from "./startstore.js";
import { format, tell } from "./ui.js";

/**
 * The operator's screens for the start sequence, opened from a "Start sequence" button in the RAE menu that only operators see. Two halves:
 *
 *   - the START COMMANDS: the numbered list of what runs first at every Start, Add (a text box), Edit one (the box filled in; an empty
 *     box deletes it), Put the defaults back, Back;
 *   - the CAMERA SHOTS: the operator stands where a shot should start and presses "Mark the start of a new shot here", goes where it ends and
 *     presses "Mark the end here" (and names it, if they like). A mark is where the CAMERA is, so the operator's eyes and the way they face,
 *     not their feet. A shot's own screen has Preview (plays it for the operator alone) and Delete.
 *
 * The rules of a command, a shot and the list are logic/start.ts's, and where they are saved is core/startstore.ts's; this is only the
 * screens over them. A line that cannot be saved comes straight back in the same box, with the reason in its title and what was typed kept
 * (the way the live config editor does it), and a success shows at the top of the next screen.
 */

const screens = createScreens("start");

/** The editor for an operator. Anyone else is told, and no screen is shown: the menu does not offer the button, and this is the second lock. */
export function openStartEditor(player: Player): Promise<void> {

    if (!isOperator(player)) {
        tell(player, format("warn", "Only operators can change the start sequence."));
        return Promise.resolve();
    }

    return screens.menuFor(player, async () => { await mainScreen(player); });
}

/** A command short enough for a button. */
const short = (command: string): string => (command.length > 38 ? `${command.slice(0, 37)}...` : command);

function commandsSummary(): string {

    if (commandsProblem() !== undefined) return "§ccannot be read";
    if (commandsAreDefault()) return "the defaults";

    const count = startCommands().length;

    return count === 0 ? "none (nothing runs)" : `${count} of your own`;
}

async function mainScreen(player: Player): Promise<void> {

    await screens.run(player, () => ({
        title: "Start sequence",
        body: `What happens when a game starts, before anything else.\n§7Start commands: ${commandsSummary()}\n§7Camera shots: ${listStoredShots().length}`,
        actions: [
            { label: `Start commands (${startCommands().length})`, run: () => commandsScreen(player) },
            { label: `Camera shots (${listStoredShots().length})`, run: () => shotsScreen(player) },
            BACK
        ]
    }));
}

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

function commandsBody(): string {

    const problem = commandsProblem();

    if (problem !== undefined) return `§cThe saved list cannot be read (${problem}). Nothing runs at the start until you put the defaults back.`;

    const head = "Run first when a game starts, in this order, as the server. Use @a or @a[tag=law] to pick players; @s does not work here.";
    const list = startCommands();

    if (list.length === 0) return `${head}\n§7No commands: nothing runs at the start.`;

    return `${head}\n§7${commandsAreDefault() ? "These are the defaults: you have not changed them." : `${list.length} of ${S.maxCommands} commands.`}`;
}

async function commandsScreen(player: Player): Promise<void> {

    await screens.run(player, () => {

        const readable = commandsProblem() === undefined;
        const actions: Action[] = [];

        if (readable) {
            startCommands().forEach((command, index) => actions.push({ label: `${index + 1}. ${short(command)}`, run: () => editOne(player, index) }));
            actions.push({ label: "Add a command", run: () => addOne(player) });
        }

        if (!readable || !commandsAreDefault()) actions.push({ label: "Put the defaults back", run: () => putDefaultsBack(player) });

        actions.push(BACK);

        return { title: "Start commands", body: commandsBody(), actions };
    });
}

/** Saves a list an edit made, or says why it cannot be: the reason, or undefined when it is saved. */
function commit(next: Result<readonly string[]>): string | undefined {

    if (!next.ok) return next.reason;

    const saved = saveStartCommands(next.value);

    return saved.ok ? undefined : saved.reason;
}

/** The text box for a command, shown again with the reason in its title and what was typed kept until it saves or is closed. */
async function askCommand(player: Player, title: string, label: string, start: string, make: (list: readonly string[], text: string) => Result<readonly string[]>, said: (text: string, list: readonly string[]) => string): Promise<void> {

    let typed = start;
    let refusal: string | undefined;

    for (;;) {

        if (!player.isValid) return;

        const form = new ModalFormData().title(refusal !== undefined ? `Not saved: ${refusal}` : title).textField(label, "effect @a clear", { defaultValue: typed });
        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) return;

        const text = String(response.formValues[0] ?? "");
        const made = make(startCommands(), text);
        const problem = commit(made);

        if (problem !== undefined) {
            typed = text;
            refusal = problem;
            continue;
        }

        screens.notify(player, format("ok", said(text, made.ok ? made.value : [])));
        return;
    }
}

function addOne(player: Player): Promise<void> {
    return askCommand(
        player, "Add a command", "Command (without the slash)", "",
        (list, text) => addCommand(list, text),
        (_text, list) => `Added: ${list[list.length - 1] ?? ""}`
    );
}

function editOne(player: Player, index: number): Promise<void> {

    const current = startCommands()[index];

    if (current === undefined) return Promise.resolve();

    return askCommand(
        player, `Command ${index + 1}`, `Command ${index + 1} (leave it empty to delete it)`, current,
        // An empty box deletes it; anything else replaces it.
        (list, text) => (text.trim() === "" ? removeCommand(list, index) : editCommand(list, index, text)),
        (text, list) => (text.trim() === "" ? `Command ${index + 1} was deleted.` : `Command ${index + 1} is now: ${list[index] ?? ""}`)
    );
}

async function putDefaultsBack(player: Player): Promise<void> {

    if (!await confirmForm(player, "Put the defaults back?", "Your own list of start commands is replaced by the defaults.", "Put them back")) return;

    const result = resetStartCommands();

    screens.notify(player, result.ok ? format("ok", "The default start commands are back.") : format("warn", `Not changed: ${result.reason}.`));
}

// ---------------------------------------------------------------------------------------------------------
// The camera shots
// ---------------------------------------------------------------------------------------------------------

/** Where an operator's pending start is kept: on the operator, so it survives a screen closing and does not belong to a game. */
const PENDING_MARK = "rae:start:mark";

const pendingMark = (player: Player): Mark | undefined => readPending(player, PENDING_MARK);
const setPendingMark = (player: Player, mark: Mark | undefined): void => writePending(player, PENDING_MARK, mark, "start");

function shotsBody(count: number, pending: Mark | undefined): string {

    const lines = [count === 0
        ? "No shots yet, so a start has no intro until you make one."
        : `${count} of ${S.maxShots} shots. A start plays ${S.shotsPerStart} of them at random, ${S.introSeconds} seconds in all.`];

    if (pending !== undefined) lines.push(`§eStart marked at ${where(pending)}. Go where the shot should end, and press "Mark the end here".`);

    return lines.join("\n");
}

async function shotsScreen(player: Player): Promise<void> {

    await screens.run(player, () => {

        const stored = listStoredShots();
        const pending = pendingMark(player);
        const actions: Action[] = [];

        stored.forEach((entry, index) => {
            const number = index + 1;

            actions.push(entry.ok
                ? { label: `${number}. ${entry.value.name || entry.id}`, run: () => oneShot(player, entry.id) }
                : { label: `${number}. ${entry.id} (cannot be read)`, run: () => brokenShot(player, entry.id, entry.problem) });
        });

        if (pending === undefined) {
            actions.push({ label: "Mark the start of a new shot here", run: () => markStart(player) });
        } else {
            actions.push({ label: "Mark the end here", run: () => markEnd(player) });
            actions.push({ label: "Cancel marking", run: () => { setPendingMark(player, undefined); screens.notify(player, format("ok", "Marking cancelled.")); } });
        }

        actions.push(BACK);

        return { title: "Camera shots", body: shotsBody(stored.length, pending), actions };
    });
}

function markStart(player: Player): void {

    if (listStoredShots().length >= S.maxShots) {
        screens.notify(player, format("warn", `There is room for ${S.maxShots} shots and they are all in use: delete one first.`));
        return;
    }

    // The next screen says where it was marked (shotsBody), so there is no notice to say it twice.
    setPendingMark(player, eyeMark(player));
}

/** The end is taken the moment the button is pressed, before the name box, so what the operator then types cannot move the camera. */
async function markEnd(player: Player): Promise<void> {

    const start = pendingMark(player);

    if (start === undefined) {
        screens.notify(player, format("warn", "There is no start marked."));
        return;
    }

    const end = eyeMark(player);

    let typed = "";
    let refusal: string | undefined;

    for (;;) {

        if (!player.isValid) return;

        const form = new ModalFormData()
            .title(refusal !== undefined ? `Not saved: ${refusal}` : "Name this shot")
            .textField("Name (optional)", "Bridge flyover", { defaultValue: typed });

        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) {
            screens.notify(player, format("warn", "Not saved: the box was closed. Your start mark is kept."));
            return;
        }

        const name = String(response.formValues[0] ?? "");
        const made = makeShot(nextShotId(listStoredShots().map((entry) => entry.id)), name, start, end);
        const saved = made.ok ? saveShot(made.value) : made;

        if (!saved.ok) {
            typed = name;
            refusal = saved.reason;
            continue;
        }

        setPendingMark(player, undefined);
        screens.notify(player, format("ok", `Saved ${made.ok ? made.value.id : ""}${made.ok && made.value.name ? ` (${made.value.name})` : ""}.`));
        return;
    }
}

async function oneShot(player: Player, id: string): Promise<void> {

    await screens.run(player, () => {

        const shot = getShot(id);

        // Deleted from under the screen: there is nothing left to show.
        if (!shot) return undefined;

        return {
            title: `Shot: ${shot.name || shot.id}`,
            body: `From ${where(shot.start)} to ${where(shot.end)}.`,
            actions: [
                { label: "Preview", run: () => preview(player, shot) },
                { label: "Delete", run: () => removeShot(player, shot) },
                BACK
            ]
        };
    });
}

/** A shot that is saved but cannot be read: all that can be done with it is to delete it, which frees its place. */
async function brokenShot(player: Player, id: string, problem: string): Promise<void> {

    await screens.run(player, () => ({
        title: `Shot ${id}`,
        body: `§cThis shot cannot be read: ${problem}`,
        actions: [{ label: "Delete", run: () => removeById(player, id, id) }, BACK]
    }));
}

/** Plays it for the operator alone and closes the menus, so the screen does not come back over the camera. */
function preview(player: Player, shot: Shot): void {

    const refusal = previewShot(player, shot);

    if (refusal !== undefined) {
        screens.notify(player, format("warn", refusal));
        return;
    }

    screens.closeAll(player);
}

function removeById(player: Player, id: string, called: string): Step {

    const result = deleteShot(id);

    screens.notify(player, result.ok ? format("ok", `Deleted ${called}.`) : format("warn", `Not deleted: ${result.reason}.`));

    return "back";
}

const removeShot = (player: Player, shot: Shot): Step => removeById(player, shot.id, shot.name || shot.id);
