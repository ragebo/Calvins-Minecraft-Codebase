import { world, type Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { TELEPORT_TARGETS } from "../config/world.js";
import { onScriptEvent } from "../core/events.js";
import { showForm } from "../core/forms.js";
import { resetGame, sendEveryoneToSpawns, startChosenRound, startRandomRound, type Choice } from "../core/game.js";
import { players } from "../core/players.js";
import { getRecord } from "../core/state.js";
import { format, tell } from "../core/ui.js";
import { registerSystem } from "../core/registry.js";

/**
 * The in-game menu: start a game (random roles, or roles you pick), reset it, and teleport to the key places.
 *
 * It replaces the physical button. It opens when a player uses the `bountysys:game_menu` item (right-click), or
 * from `/scriptevent rae:menu`, which needs a player and so cannot be run from a command block on its own.
 * Anyone holding the item can use every control (the owner's choice); the item is only obtainable with /give.
 *
 * The game's own rules for starting and resetting live in core/game.ts, shared with the old script events
 * (`bounty:start_round`, `rae:reset`, `bounty:teleport`), which keep working unchanged.
 */

const MENU_ITEM_ID = "bountysys:game_menu";

const TITLE = "§6RAE Game Menu";

/** The roles a player can be given when roles are chosen, in the order the dropdown lists them. */
const CHOICES: readonly { readonly label: string; readonly choice: Choice }[] = [
    { label: "Law", choice: "law" },
    { label: "Outlaw", choice: "outlaw" },
    { label: "Sit out", choice: "sit_out" }
];

/** Players who have a menu open. A second right-click while one is up must not stack another on top. */
const open = new Set<string>();

// ---------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------

/**
 * A yes/no built from a plain action form: its buttons are numbered from 0 in the order added, which is not
 * true of every form type. The dangerous choice is second, so a stray tap on the first button cancels.
 */
async function confirm(player: Player, question: string, yes: string): Promise<boolean> {

    const form = new ActionFormData()
        .title(TITLE)
        .body(question)
        .button("Cancel")
        .button(yes);

    const response = await showForm(player, form);

    return response !== undefined && !response.canceled && response.selection === 1;
}

async function startMenu(player: Player): Promise<void> {

    const form = new ActionFormData()
        .title(TITLE)
        .body("How should the roles be given out?")
        .button("Random roles")
        .button("Choose roles");

    const response = await showForm(player, form);
    if (!response || response.canceled) return;

    if (response.selection === 0) await startRandom(player);
    else if (response.selection === 1) await startChosen(player);
}

async function startRandom(player: Player): Promise<void> {

    if (!await confirm(player, "Start a new game with random roles?\n§7This resets the current game.", "Start the game")) return;

    // Says why itself when there are too few players.
    if (startRandomRound()) tell(player, format("ok", "Game started with random roles."));
}

async function startChosen(player: Player): Promise<void> {

    // The list is taken now and used when the form comes back: whoever joins in between is left out, and startChosenRound skips whoever left.
    const listed = [...players()];

    if (listed.length === 0) return;

    const form = new ModalFormData()
        .title(TITLE)
        .label("§7Pick a role for each player. Starting resets the current game.");

    for (const listedPlayer of listed) {
        const current = getRecord(listedPlayer).role;
        const defaultValueIndex = Math.max(0, CHOICES.findIndex((option) => option.choice === (current ?? "outlaw")));
        form.dropdown(listedPlayer.name, CHOICES.map((option) => option.label), { defaultValueIndex });
    }

    form.submitButton("Start the game");

    const response = await showForm(player, form);
    if (!response || response.canceled || !response.formValues) return;

    const picks = new Map<Player, Choice>();

    // formValues has one entry per control, in the order added: the label counts as one, and is a null.
    const values = response.formValues.filter((value) => typeof value === "number") as number[];

    listed.forEach((listedPlayer, index) => {
        const option = CHOICES[values[index] ?? 1];
        picks.set(listedPlayer, option ? option.choice : "outlaw");
    });

    const result = startChosenRound(picks);

    if (!result.ok) {
        tell(player, format("warn", result.refusal ?? "The game could not start."));
        return;
    }

    tell(player, format("ok", "Game started with the roles you chose."));
    for (const warning of result.warnings) tell(player, format("warn", warning));
}

async function resetMenu(player: Player): Promise<void> {

    if (!await confirm(player, "Reset the game?\n§7Every system goes back to its starting state.", "Reset the game")) return;

    resetGame();
}

async function teleportMenu(player: Player): Promise<void> {

    const form = new ActionFormData()
        .title(TITLE)
        .body("Where to?");

    for (const target of TELEPORT_TARGETS) form.button(target.name);

    const response = await showForm(player, form);
    if (!response || response.canceled || response.selection === undefined) return;

    const target = TELEPORT_TARGETS[response.selection];
    if (!target) return;

    try {
        player.teleport(target.at, { dimension: world.getDimension("overworld") });
        tell(player, format("ok", `Teleported to ${target.name}.`));
    } catch (error) {
        tell(player, format("warn", `Could not teleport to ${target.name}: ${error}`));
    }
}

async function mainMenu(player: Player): Promise<void> {

    const form = new ActionFormData()
        .title(TITLE)
        .body("What would you like to do?")
        .button("Start game")
        .button("Reset game")
        .button("Teleport")
        .button("Send everyone to their spawns");

    const response = await showForm(player, form);
    if (!response || response.canceled) return;

    switch (response.selection) {
        case 0: await startMenu(player); break;
        case 1: await resetMenu(player); break;
        case 2: await teleportMenu(player); break;
        case 3:
            sendEveryoneToSpawns();
            tell(player, format("ok", "Everyone with a role was sent to their spawns."));
            break;
        default: break;
    }
}

async function openMenu(player: Player): Promise<void> {

    if (open.has(player.id)) return;
    open.add(player.id);

    try {
        await mainMenu(player);
    } catch (error) {
        console.warn(`[menu] the menu failed for a player: ${error}`);
    } finally {
        open.delete(player.id);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------------------------

world.afterEvents.itemUse.subscribe((event) => {
    if (event.itemStack.typeId === MENU_ITEM_ID) void openMenu(event.source);
});

onScriptEvent("rae:menu", (player) => {

    if (!player) {
        console.warn("[menu] rae:menu has to be run by a player: a form needs someone to show it to.");
        return;
    }

    void openMenu(player);
});

registerSystem({
    name: "menu",
    reset() {
        // Nothing to clear: a menu that is open belongs to the player looking at it, and resetting from it is a normal use.
    }
});
