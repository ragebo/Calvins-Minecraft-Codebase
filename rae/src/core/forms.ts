import { system, type Player } from "@minecraft/server";
import { FormCancelationReason, MessageFormData } from "@minecraft/server-ui";
import { MENU } from "../config/balance.js";
import { warn } from "./log.js";

/**
 * Showing a form to a player, the way every system should.
 *
 * A form is refused with `FormCancelationReason.UserBusy` while the player is still doing something else in
 * the game's own UI. Opening one straight from an item (right-click) hits this: the player is still "using"
 * the item for a moment. So a busy answer is retried, a little later, a limited number of times, and any other
 * answer (submitted, or closed by the player) is handed back as it is.
 */

/** Anything with a `show(player)` that answers with a response: an ActionFormData, a ModalFormData, a MessageFormData. */
interface Showable<R> {
    show(player: Player): Promise<R>;
}

interface Response {
    readonly canceled: boolean;
    readonly cancelationReason?: FormCancelationReason;
}

const reported = new Set<string>();

function report(error: unknown): void {
    const text = String(error);
    if (reported.has(text)) return;
    reported.add(text);
    warn("forms", `showing a form failed: ${text}`);
}

const wait = (ticks: number): Promise<void> => new Promise((resolve) => { system.runTimeout(resolve, ticks); });

/**
 * Shows `form` to `player` and answers with the response, or `undefined` when the player left, the form could
 * not be shown, or the player stayed busy for the whole retry window. Never throws.
 */
export async function showForm<R extends Response>(player: Player, form: Showable<R>): Promise<R | undefined> {

    for (let attempt = 0; attempt <= MENU.busyRetries; attempt++) {

        if (!player.isValid) return undefined;

        let response: R;

        try {
            response = await form.show(player);
        } catch (error) {
            report(error);
            return undefined;
        }

        if (!(response.canceled && response.cancelationReason === FormCancelationReason.UserBusy)) return response;

        await wait(MENU.busyRetryTicks);
    }

    return undefined;
}

/**
 * A yes-or-no question. True only when the player picked the yes button: closing the form, a busy player and a form that
 * could not be shown all count as no, so a careless dismissal can never confirm something destructive.
 */
export async function confirmForm(player: Player, title: string, body: string, yes: string, no = "Cancel"): Promise<boolean> {

    const response = await showForm(player, new MessageFormData().title(title).body(body).button1(no).button2(yes));

    return response !== undefined && !response.canceled && response.selection === 1;
}
