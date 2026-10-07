import type { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { showForm } from "./forms.js";
import { error } from "./log.js";
import { format, tell } from "./ui.js";

/**
 * Screens for a builder's menus: a title, some text and a list of buttons, where a button runs an action that may open another
 * screen. A screen builds itself again each time it is shown, from what is saved right now, so what it says is never stale and
 * a thing deleted from under an open screen simply closes it. Closing a form walks back one screen; an action that needs a click
 * in the world closes the whole stack.
 *
 * Each caller makes its own set (`createScreens("shop")`), so the shop's menus and the robbery builder's never share state, and
 * a player can only have one menu of a kind open at a time: a second menu on top of the first would only fight it for the form.
 * (core/robberyforms.ts has these same few lines of its own, written before there were two users.)
 */

export type Step = "back" | void;

export interface Action {
    readonly label: string;
    readonly run: () => Promise<Step> | Step;
}

export interface Screen {
    readonly title: string;
    readonly body: string;
    readonly actions: readonly Action[];
}

/** A button that goes back one screen. */
export const BACK: Action = { label: "Back", run: () => "back" };

export interface Screens {
    /** Whether this player has a menu of this kind open right now. */
    hasMenuOpen(player: Player): boolean;
    /** Closes the player's whole stack of menus (an action that needs a click in the world calls this). */
    closeAll(player: Player): void;
    /** Runs a menu for a player unless one is already open, and always leaves them with none open. */
    menuFor(player: Player, body: () => Promise<void>): Promise<void>;
    /** Shows a screen, runs what is pressed, and shows it again, until it is closed, goes "back", or has nothing left to show. */
    run(player: Player, build: () => Screen | undefined): Promise<void>;
}

export function createScreens(source: string): Screens {

    const open = new Set<string>();
    const closing = new Set<string>();

    return {

        hasMenuOpen: (player) => open.has(player.id),

        closeAll(player) {
            closing.add(player.id);
        },

        async menuFor(player, body) {

            if (open.has(player.id)) {
                tell(player, format("warn", "Finish or close the menu you have open first."));
                return;
            }

            open.add(player.id);
            closing.delete(player.id);

            try {
                await body();
            } catch (err) {
                // The player may be the very thing that failed (they left), so their name is not read here.
                error(source, `a menu failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                open.delete(player.id);
                closing.delete(player.id);
            }
        },

        async run(player, build) {

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
    };
}
