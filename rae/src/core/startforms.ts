import type { Player } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { START as S } from "../config/balance.js";
import { addCommand, editCommand, removeCommand, type Result } from "../logic/start.js";
import { confirmForm, showForm } from "./forms.js";
import { isOperator } from "./players.js";
import { BACK, createScreens, type Action } from "./screens.js";
import { commandsAreDefault, commandsProblem, resetStartCommands, saveStartCommands, startCommands } from "./startstore.js";
import { format, tell } from "./ui.js";

/**
 * The operator's screens for the start sequence, opened from a "Start sequence" button in the RAE menu that only operators see. This is
 * the start commands half: the numbered list of what runs first at every Start, Add (a text box), Edit one (the box filled in; an empty
 * box deletes it), Put the defaults back, Back. The rules of a command and of the list are logic/start.ts's, and where it is saved is
 * core/startstore.ts's; this is only the screens over them.
 *
 * A line that cannot be saved comes straight back in the same box, with the reason in its title and what was typed kept (the way the live
 * config editor does it), and a success shows at the top of the next screen.
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
        body: `What happens when a game starts, before anything else.\n§7Start commands: ${commandsSummary()}`,
        actions: [
            { label: `Start commands (${startCommands().length})`, run: () => commandsScreen(player) },
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
