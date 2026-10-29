import { world, type Player } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { JAILS as J } from "../config/balance.js";
import { edit, newJail, placeText, removeButton, samePlace, type Jail, type JailPatch, type Place } from "../logic/jails.js";
import { confirmForm, showForm } from "./forms.js";
import { startBind } from "./jailbind.js";
import { getJail, holdsPrisoners, listJails, newJailId, removeJail, saveJail, undoAvailable, undoJail } from "./jailstore.js";
import { isOperator } from "./players.js";
import { BACK, createScreens, type Action, type Step } from "./screens.js";
import { format, tell } from "./ui.js";

/**
 * The operator's screens for the jails, opened from a "Jails" button in the RAE menu that only operators see: the list of jails, Add (a name), and a screen
 * per jail to turn it on or off, rename it, move its spot to where the operator stands, bind blocks to it as BUTTONS (right-click a button, a lever, anything,
 * to start the lockpick for this jail), set or clear its door trigger (the block where a redstone block is placed when the jailbreak succeeds), send the
 * operator to it, undo and delete.
 *
 * A block is bound by CLICKING it (core/jailbind.ts): the screens close, the operator right-clicks the block, and the next screen says how it went. A ray
 * is not used, because how one behaves in the game is unmeasured here and a click takes the block exactly.
 *
 * The rules of a jail are logic/jails.ts's and where they are kept is core/jailstore.ts's; this is only the screens over them. A value that cannot be saved
 * comes back with the reason (a refused name keeps what was typed), and nothing is saved until a box is submitted and accepted.
 */

const screens = createScreens("jails");

/** The jail an operator deleted last, so the list can offer to bring it back (the store keeps one undo per id until the scripts reload). */
let lastDeleted: string | undefined;

/** The editor for an operator. Anyone else is told, and no screen is shown: the menu does not offer the button, and this is the second lock. */
export function openJailsEditor(player: Player): Promise<void> {

    if (!isOperator(player)) {
        tell(player, format("warn", "Only operators can change the jails."));
        return Promise.resolve();
    }

    return screens.menuFor(player, async () => { await mainScreen(player); });
}

/** Where the operator stands, as the middle of that block: where a player stands. */
function standingPlace(player: Player): Place {
    const at = player.location;
    return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 };
}

const buttonCount = (jail: Jail): string => `${jail.buttons.length} button${jail.buttons.length === 1 ? "" : "s"}`;

/** Jails are in the overworld (the lockpick, the door and the teleport all assume it), so a spot is only taken there. */
const inOverworld = (player: Player): boolean => player.dimension.id === "minecraft:overworld" || player.dimension.id === "overworld";

const NOT_OVERWORLD = "jails are in the overworld: go there first";

async function mainScreen(player: Player): Promise<void> {

    await screens.run(player, () => {

        const actions: Action[] = [];

        for (const stored of listJails()) {
            actions.push(stored.ok
                ? { label: `${stored.value.name} (${stored.value.enabled ? "on" : "off"}, ${buttonCount(stored.value)}${holdsPrisoners(stored.id) ? ", holds prisoners" : ""})`, run: () => oneJail(player, stored.id) }
                : { label: `${stored.id} (cannot be read)`, run: () => brokenJail(player, stored.id, stored.problem) });
        }

        actions.push({ label: "Add a jail", run: () => addOne(player) });

        const bringBack = lastDeleted !== undefined && getJail(lastDeleted) === undefined && undoAvailable(lastDeleted) ? lastDeleted : undefined;
        if (bringBack !== undefined) actions.push({ label: `Bring back ${bringBack}`, run: () => undo(player, bringBack) });

        actions.push(BACK);

        return {
            title: "Jails",
            body: `${listJails().length} of ${J.maxJails} jails. A captured outlaw is sent to one of the jails that are on, at random, and prisoners share it until it is empty. `
                + "Bind a button to a jail and a right-click on it starts the lockpick for that jail.",
            actions
        };
    });
}

/** A saved jail that cannot be read: all that can be done with it is to delete it, which frees its place (and undo brings it back). */
async function brokenJail(player: Player, id: string, problem: string): Promise<void> {

    await screens.run(player, () => ({
        title: `Jail ${id}`,
        body: `§cThis jail cannot be read: ${problem}`,
        actions: [{ label: "Delete", run: () => deleteOne(player, id, id) }, BACK]
    }));
}

// ---------------------------------------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------------------------------------

async function addOne(player: Player): Promise<void> {

    let name = "";
    let refusal: string | undefined;

    for (;;) {

        const form = new ModalFormData()
            .title(refusal !== undefined ? `Not saved: ${refusal}` : "Add a jail (its spot is where you stand)")
            .textField("Name", "Town jail", { defaultValue: name });

        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) return;

        name = String(response.formValues[0] ?? "");

        const made = inOverworld(player) ? newJail(newJailId(name), name, standingPlace(player)) : { ok: false as const, reason: NOT_OVERWORLD };
        const saved = made.ok ? saveJail(made.value) : made;

        if (!saved.ok) {
            refusal = saved.reason;
            continue;
        }

        screens.notify(player, format("ok", `Added ${made.ok ? made.value.name : ""}. It is on, so prisoners can be sent there already; its spot is where you stood. Set its door trigger and bind its buttons from its own screen (turn it off while you build if you like).`));
        return;
    }
}

// ---------------------------------------------------------------------------------------------------------
// One jail
// ---------------------------------------------------------------------------------------------------------

function summary(jail: Jail): string {

    const lines = [
        `${jail.enabled ? "§aOn" : "§cOff"}§r. Prisoners are put at ${placeText(jail.jail)}.${holdsPrisoners(jail.id) ? " §ePrisoners are held here now.§r" : ""}`,
        jail.doorTrigger
            ? `Door trigger: ${placeText(jail.doorTrigger)} (a redstone block is placed there when the jailbreak succeeds).`
            : "Door trigger: none, so nothing is placed when the jailbreak succeeds (the prisoners are still freed)."
    ];

    if (jail.buttons.length === 0) lines.push("Buttons: none. Bind a block and a right-click on it starts the lockpick.");
    else lines.push(`Buttons: ${jail.buttons.map((button) => placeText(button)).join("; ")}.`);

    return lines.join("\n");
}

async function oneJail(player: Player, id: string): Promise<void> {

    await screens.run(player, () => {

        const jail = getJail(id);

        // Deleted from under the screen: there is nothing left to show.
        if (!jail) return undefined;

        const actions: Action[] = [
            { label: jail.enabled ? "Turn it off" : "Turn it on", run: () => apply(player, jail, { enabled: !jail.enabled }, jail.enabled ? "It is off." : "It is on.") },
            { label: "Name", run: () => rename(player, id) },
            { label: "Move the jail spot to where I stand", run: () => (inOverworld(player) ? apply(player, jail, { jail: standingPlace(player) }, "Prisoners are put where you stand.") : screens.notify(player, format("warn", `Not changed: ${NOT_OVERWORLD}.`))) },
            { label: "Bind a button: click the block", run: () => bind(player, jail, "button") },
            { label: "Set the door trigger: click the block", run: () => bind(player, jail, "door") }
        ];

        if (jail.doorTrigger) actions.push({ label: "Clear the door trigger", run: () => apply(player, jail, { doorTrigger: null }, "Nothing is placed when the jailbreak succeeds.") });

        jail.buttons.forEach((button, index) => actions.push({ label: `Remove button ${index + 1} (${placeText(button)})`, run: () => unbindButton(player, jail.id, button) }));

        actions.push({ label: "Send me to the jail spot", run: () => goThere(player, jail) });

        if (undoAvailable(id)) actions.push({ label: "Undo my last change", run: () => undo(player, id) });

        actions.push({ label: "Delete", run: () => deleteOne(player, id, jail.name) });
        actions.push(BACK);

        return { title: jail.name, body: summary(jail), actions };
    });
}

/**
 * Makes one change and saves it, saying how it went at the top of the next screen. The jail is read again now, not taken from the screen: another operator may have
 * changed or deleted it since the screen was drawn, and saving the screen's copy would undo their change or bring it back.
 */
function apply(player: Player, drawn: Jail, patch: JailPatch, said: string): void {

    const jail = getJail(drawn.id);

    if (!jail) {
        screens.notify(player, format("warn", `Not changed: ${drawn.name} was deleted.`));
        return;
    }

    const made = edit(jail, patch);
    const saved = made.ok ? saveJail(made.value) : made;

    screens.notify(player, saved.ok ? format("ok", said) : format("warn", `Not changed: ${saved.reason}.`));
}

/** Takes away the button the screen showed, found by where it is now (its number may have changed since the screen was drawn). */
function unbindButton(player: Player, id: string, button: Place): void {

    const jail = getJail(id);
    const index = jail ? jail.buttons.findIndex((there) => samePlace(there, button)) : -1;

    if (!jail || index < 0) {
        screens.notify(player, format("warn", "Not changed: that button is already gone."));
        return;
    }

    const made = removeButton(jail, index);
    const saved = made.ok ? saveJail(made.value) : made;

    screens.notify(player, saved.ok ? format("ok", `Button ${index + 1} is no longer a button.`) : format("warn", `Not changed: ${saved.reason}.`));
}

/** Closes the screens so the operator can click, and says what to click. The click itself is read by systems/jailbreak.ts and finished in core/jailbind.ts. */
function bind(player: Player, drawn: Jail, kind: "button" | "door"): void {

    const jail = getJail(drawn.id);

    if (!jail) {
        screens.notify(player, format("warn", `Not bound: ${drawn.name} was deleted.`));
        return;
    }

    if (kind === "button" && jail.buttons.length >= J.maxButtons) {
        screens.notify(player, format("warn", `A jail has at most ${J.maxButtons} buttons: remove one first.`));
        return;
    }

    startBind(player, jail.id, kind);

    screens.notify(player, format("ok", kind === "button"
        ? `Right-click the block that should start the lockpick for ${jail.name} within ${J.bindSeconds} seconds. A button or a lever is best: a door or a chest bound this way stops doing its usual job. If nothing seems to happen the time ran out: open the Jails screen and press the button again.`
        : `Right-click the block where the redstone block should go for ${jail.name} within ${J.bindSeconds} seconds (the redstone block replaces whatever is there). If nothing seems to happen the time ran out: open the Jails screen and press the button again.`));

    screens.closeAll(player);
}

function goThere(player: Player, drawn: Jail): void {

    const jail = getJail(drawn.id) ?? drawn;

    try {
        player.teleport(jail.jail, { dimension: world.getDimension("overworld") });
        screens.notify(player, format("ok", `Sent to ${jail.name}.`));
    } catch (err) {
        screens.notify(player, format("warn", `Could not go there: ${err instanceof Error ? err.message : String(err)}`));
    }
}

function undo(player: Player, id: string): void {

    const result = undoJail(id);

    screens.notify(player, result.ok ? format("ok", "Undone.") : format("warn", `Not undone: ${result.reason}.`));
}

async function deleteOne(player: Player, id: string, called: string): Promise<Step> {

    if (!await confirmForm(player, `Delete ${called}?`, `Prisoners are no longer sent there and its buttons stop working. You can bring it back from the list until the scripts reload (it is listed there by its id, ${id}).`, "Delete it")) return;

    const result = removeJail(id);

    if (result.ok) lastDeleted = id;

    screens.notify(player, result.ok ? format("ok", `Deleted ${called}.`) : format("warn", `Not deleted: ${result.reason}.`));

    return "back";
}

async function rename(player: Player, id: string): Promise<void> {

    let name = getJail(id)?.name ?? "";
    let refusal: string | undefined;

    for (;;) {

        const jail = getJail(id);
        if (!jail) return;

        const form = new ModalFormData()
            .title(refusal !== undefined ? `Not saved: ${refusal}` : `Name of ${jail.name}`)
            .textField("Name", "", { defaultValue: name });

        const response = await showForm(player, form);

        if (!response || response.canceled || !response.formValues) return;

        name = String(response.formValues[0] ?? "");

        // Read again: another operator may have deleted it while the box was up, and saving would bring it back.
        const current = getJail(id);

        if (!current) {
            screens.notify(player, format("warn", "Not saved: that jail was deleted while the box was open."));
            return;
        }

        const made = edit(current, { name });
        const saved = made.ok ? saveJail(made.value) : made;

        if (!saved.ok) {
            refusal = saved.reason;
            continue;
        }

        screens.notify(player, format("ok", "Saved."));
        return;
    }
}

