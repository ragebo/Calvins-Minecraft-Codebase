import { system, type Player } from "@minecraft/server";
import { JAILS as J } from "../config/balance.js";
import { addButton, edit, placeText } from "../logic/jails.js";
import { getJail, saveJail } from "./jailstore.js";
import { isOperator } from "./players.js";
import { boundAt } from "./robberystore.js";
import { format, tell } from "./ui.js";

/**
 * Binding a block to a jail by clicking it. An operator presses "bind a button" (or "set the door trigger") on a jail's screen, the screens close, and the next
 * block they right-click becomes it. A click is used instead of aiming because it needs no ray (how a ray behaves is unmeasured in the game here), takes the
 * block exactly where it is, and works on any block, however far it is from the operator's feet.
 *
 * The click is read by systems/jailbreak.ts's one handler on the block-interaction event (which cancels it and defers the work), and finished here.
 */

type Kind = "button" | "door";

interface Pending {
    readonly jail: string;
    readonly kind: Kind;
    readonly until: number;
}

/** By player id: a handle goes invalid when its player leaves, an id does not, and an unfinished bind simply expires. */
const waiting = new Map<string, Pending>();

/** When a player's bind click was last taken, so an item use the game reports for the same click (the menu item in their hand) can be told from a real one. */
const lastBound = new Map<string, number>();

/** How long after a bind click an item use is taken to be that click's. */
const SAME_CLICK_TICKS = 10;

export function startBind(player: Player, jail: string, kind: Kind): void {
    waiting.set(player.id, { jail, kind, until: system.currentTick + J.bindSeconds * 20 });
}

export function cancelBind(player: Player): void {
    waiting.delete(player.id);
}

/** Whether this player's next click is a bind (and has not expired). Read in the before-event, so it only reads. */
export function hasPendingBind(player: Player): boolean {

    const pending = waiting.get(player.id);

    if (!pending) return false;
    if (system.currentTick <= pending.until) return true;

    waiting.delete(player.id);
    return false;
}

/** Whether this player's bind click was taken a moment ago. The game can report an item use for the same click, and it must not open the menu over the answer. */
export function boundJustNow(player: Player): boolean {

    const at = lastBound.get(player.id);

    return at !== undefined && system.currentTick - at <= SAME_CLICK_TICKS;
}

/** The block a player clicked, as the click handler saw it. */
export interface Clicked {
    readonly dimensionId: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly typeId: string;
}

/** Finishes a bind with the block that was clicked, and tells the operator how it went. Runs outside the before-event (it writes). */
export function completeBind(player: Player, clicked: Clicked): void {

    const pending = waiting.get(player.id);
    waiting.delete(player.id);
    lastBound.set(player.id, system.currentTick);

    // A bind is only ever started for an operator; checked again here, because they may have stopped being one since.
    if (!player.isValid || !isOperator(player)) return;

    if (!pending || system.currentTick > pending.until) {
        tell(player, format("warn", "That took too long: open the Jails screen and press the button again."));
        return;
    }

    const jail = getJail(pending.jail);

    if (!jail) {
        tell(player, format("warn", "That jail is gone."));
        return;
    }

    const block = { x: clicked.x, y: clicked.y, z: clicked.z };
    const where = placeText(block);

    if (clicked.dimensionId !== "overworld" && clicked.dimensionId !== "minecraft:overworld") {
        tell(player, format("warn", "Not bound: jails are in the overworld."));
        return;
    }

    // A block that is already a robbery's element would have both play it at once: a robbery element and a jail block are kept apart.
    if (boundAt(clicked.dimensionId, block.x, block.y, block.z)) {
        tell(player, format("warn", `Not bound: the block at ${where} is part of a robbery.`));
        return;
    }

    if (pending.kind === "button" && jail.buttons.some((button) => button.x === block.x && button.y === block.y && button.z === block.z)) {
        tell(player, format("warn", `That block is already a button of ${jail.name}.`));
        return;
    }

    const made = pending.kind === "button" ? addButton(jail, block) : edit(jail, { doorTrigger: block });
    const saved = made.ok ? saveJail(made.value) : made;

    if (!saved.ok) {
        tell(player, format("warn", `Not bound: ${saved.reason}.`));
        return;
    }

    tell(player, format("ok", pending.kind === "button"
        ? `Bound: ${clicked.typeId.replace(/^minecraft:/, "")} at ${where} now starts the lockpick for ${jail.name}. It no longer does its usual job (a door will not open, a chest will not open). Press it with an outlaw to try it.`
        : `The door trigger of ${jail.name} is now the block at ${where}: a redstone block REPLACES it when the jailbreak succeeds.`));
}

/** Forgets every unfinished bind. For tests. */
export function forgetBinds(): void {
    waiting.clear();
    lastBound.clear();
}
