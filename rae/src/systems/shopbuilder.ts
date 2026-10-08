import { CustomCommandParamType, system, type CustomCommandOrigin } from "@minecraft/server";
import { failure, later, ok, playerOf, registerOperatorCommands, type CommandSpec } from "../core/commands.js";
import { info } from "../core/log.js";
import { registerSystem } from "../core/registry.js";
import { addHeldDeal, copyShopAs, createShop, select, selectedId, selectedShop, type HeldKind } from "../core/shopedit.js";
import { moveNpcHere, openMovePicker, openServiceScreen, openShop, openShopEditor, openShopPicker, openSwapDeal } from "../core/shopforms.js";
import { aimedShopNpc, npcsByShop, rememberSpot, retireNpcs, spawnShopNpc, whereIsNpc } from "../core/shopnpc.js";
import { allShops, deleteShop, getShop, getStored, listStored, rawText, undoLast } from "../core/shopstore.js";
import { format, tell } from "../core/ui.js";
import { describeShop, describeTrade, findShop } from "../logic/shop.js";

/**
 * Building a shop in the game: the commands. Operators only, all of it. The screens are in core/shopforms.ts and the wand opens
 * them on a click (systems/shoptalk.ts); the commands are the guaranteed way to do the same, and the quick way to stock a
 * shop: hold an item and say what it costs.
 *
 *   /rae:shop_new Habiti          an NPC appears in front of you, named, with an empty shop
 *   hold a sword                  /rae:shop_sell 60       the NPC sells it for 60 coins
 *   hold 3 feathers               /rae:shop_buy 8         the NPC buys 3 feathers for 8 coins
 *   hold a diamond                /rae:shop_trade         players hand over an item (maybe coins too) for it
 *   stand where players should go /rae:shop_service       a small form: an effect, an enchantment, a tame animal or a teleport
 *
 * Which shop a command means: the one named (by its id or by the name you gave it, in any case: "Mule Dealer" and mule_dealer are
 * one shop), else the NPC you are looking at, else the one you last worked on.
 *
 *   stand where it should be      /rae:shop_move Habiti   its NPC comes to you from wherever it is, and no second one is made
 *
 * A command's callback is restricted (it may read, send chat and save a world property, but not spawn, move or remove anything),
 * so each command saves what it can at once, answers, and does the part that changes the world a tick later, telling the player
 * how it went.
 */

const SOURCE = "shop";

const STRING = CustomCommandParamType.String;
const BOOLEAN = CustomCommandParamType.Boolean;
const INTEGER = CustomCommandParamType.Integer;

/** The shop a command is about, or why there is none to say. */
function target(origin: CustomCommandOrigin, named?: string): { readonly id: string } | { readonly problem: string } {

    if (named !== undefined && named.length > 0) {
        const found = findShop(allShops(), named, true);
        return found.ok ? { id: found.value.id } : { problem: found.reason };
    }

    const player = playerOf(origin);

    if (player) {
        const aimed = aimedShopNpc(player);
        if (aimed && getShop(aimed.shop)) return { id: aimed.shop };

        const chosen = selectedShop(player);
        if (chosen) return { id: chosen.id };
    }

    return { problem: "name a shop, look at its NPC, or choose one with /rae:shop_select" };
}

function describeList(): string {

    const stored = listStored();

    if (stored.length === 0) return "There are no shops yet. /rae:shop_new <name> makes one.";

    const loaded = npcsByShop();

    return stored.map((entry) => {
        if (!entry.ok) return `${entry.id}: cannot be read (${entry.problem})`;

        const npcs = loaded.get(entry.id) ?? [];
        const [first] = npcs;

        // Looking at the list is a chance to learn where an NPC stands, so a later "bring it here" knows where to look.
        if (first) rememberSpot(entry.id, first);

        return `${entry.id}: ${entry.value.name}, ${entry.value.trades.length} deal${entry.value.trades.length === 1 ? "" : "s"}, NPC: ${whereIsNpc(entry.id, npcs)}`;
    }).join("\n");
}

/** A shop by its id (even one too damaged to read) or by its exact name; never a guess between two. For commands that delete. */
function strictTarget(named: string): { readonly id: string } | { readonly problem: string } {

    const asId = named.trim().toLowerCase();

    if (getStored(asId)) return { id: asId };

    const found = findShop(allShops(), named, false);

    return found.ok ? { id: found.value.id } : { problem: found.reason };
}

/** Stocking a shop from the hand: the same for `sell` and `buy`. */
function stock(origin: CustomCommandOrigin, kind: HeldKind, coins: number) {

    const player = playerOf(origin);
    if (!player) return failure("hold an item and run this as a player");

    const wanted = target(origin);
    if ("problem" in wanted) return failure(wanted.problem);

    const outcome = addHeldDeal(player, wanted.id, kind, coins);

    if (!outcome.ok) return failure(outcome.reason);

    return ok(`Added to ${outcome.shop.name}: ${outcome.trade ? describeTrade(outcome.trade) : "a deal"}.`);
}

const COMMANDS: readonly CommandSpec[] = [
    {
        name: "rae:shop_list",
        description: "Lists every shop, how many deals it has and where its NPC is (or was last seen).",
        run: () => ok(describeList())
    },
    {
        name: "rae:shop_info",
        description: "Shows a shop's deals. Add true to write its saved text to the content log as a backup.",
        optional: [{ name: "shop", type: STRING }, { name: "raw", type: BOOLEAN }],
        run: (origin, named?: string, raw?: boolean) => {
            const wanted = target(origin, named);
            if ("problem" in wanted) return failure(wanted.problem);

            if (raw === true) {
                const text = rawText(wanted.id);
                if (text === undefined) return failure(`there is no shop ${wanted.id}`);
                info(SOURCE, `${wanted.id} saved as: ${text}`);
                return ok(`Written to the content log (${text.length} characters).`);
            }

            const shop = getShop(wanted.id);

            return shop ? ok(describeShop(shop).join("\n")) : failure(`there is no shop ${wanted.id}`);
        }
    },
    {
        name: "rae:shop_new",
        description: "Makes a new shop and puts its NPC in front of you. Then hold an item and use /rae:shop_sell or /rae:shop_buy.",
        mandatory: [{ name: "name", type: STRING }],
        run: (origin, name: string) => {
            const player = playerOf(origin);
            if (!player) return failure("a shop's NPC appears in front of a player: run this as a player");

            const made = createShop(player, name);
            if (!made.ok) return failure(made.reason);

            system.run(() => {
                if (!player.isValid) return;
                try {
                    spawnShopNpc(player, made.shop);
                    later(origin, SOURCE, format("ok", `${made.shop.name} (${made.shop.id}) is in front of you. Hold an item and run /rae:shop_sell <coins> to stock it.`));
                } catch (err) {
                    later(origin, SOURCE, format("warn", `The shop ${made.shop.id} is saved but its NPC could not be placed (${err instanceof Error ? err.message : String(err)}). /rae:shop_place tries again.`));
                }
            });

            return ok(`Made ${made.shop.name} (${made.shop.id}) and selected it. Placing its NPC.`);
        }
    },
    {
        name: "rae:shop_sell",
        description: "The NPC SELLS the item you hold (all of the stack) for this many coins.",
        mandatory: [{ name: "coins", type: INTEGER }],
        run: (origin, coins: number) => stock(origin, "sells", coins)
    },
    {
        name: "rae:shop_buy",
        description: "The NPC BUYS the item you hold (all of the stack) from players for this many coins.",
        mandatory: [{ name: "coins", type: INTEGER }],
        run: (origin, coins: number) => stock(origin, "buys", coins)
    },
    {
        name: "rae:shop_trade",
        description: "Players hand over an item from your bag (and maybe coins) for the item you hold. Opens a small form.",
        run: (origin) => {
            const player = playerOf(origin);
            if (!player) return failure("the form opens for a player: run this as a player");

            const wanted = target(origin);
            if ("problem" in wanted) return failure(wanted.problem);

            system.run(() => { void openSwapDeal(player, wanted.id); });

            return ok("Opening the trade form. Close the chat to see it.");
        }
    },
    {
        name: "rae:shop_service",
        description: "Opens the form to add a service to a shop: a potion effect, an enchantment on the held item, a tame animal, or a teleport to where you stand.",
        run: (origin) => {
            const player = playerOf(origin);
            if (!player) return failure("the form opens for a player: run this as a player");

            const wanted = target(origin);
            if ("problem" in wanted) return failure(wanted.problem);

            system.run(() => { void openServiceScreen(player, wanted.id); });

            return ok("Opening the service form. Close the chat to see it.");
        }
    },
    {
        name: "rae:shop_edit",
        description: "Opens a shop's builder screen (the same as clicking its NPC with the wand). With no shop, lists them.",
        optional: [{ name: "shop", type: STRING }],
        run: (origin, named?: string) => {
            const player = playerOf(origin);
            if (!player) return failure("the screen opens for a player: run this as a player");

            const wanted = target(origin, named);

            if (named !== undefined && named.length > 0 && "problem" in wanted) return failure(wanted.problem);

            system.run(() => { void ("id" in wanted ? openShopEditor(player, wanted.id) : openShopPicker(player)); });

            return ok("Opening the screen. Close the chat to see it.");
        }
    },
    {
        name: "rae:shop_open",
        description: "Opens a shop for yourself, as a customer sees it (to try it).",
        mandatory: [{ name: "shop", type: STRING }],
        run: (origin, named: string) => {
            const player = playerOf(origin);
            if (!player) return failure("the shop opens for a player: run this as a player");

            const wanted = target(origin, named);
            if ("problem" in wanted) return failure(wanted.problem);

            system.run(() => { void openShop(player, wanted.id); });

            return ok(`Opening ${wanted.id}. Close the chat to see it.`);
        }
    },
    {
        name: "rae:shop_select",
        description: "Chooses the shop you are building.",
        mandatory: [{ name: "shop", type: STRING }],
        run: (origin, named: string) => {
            const player = playerOf(origin);
            if (!player) return failure("this is for a player building a shop");

            const found = findShop(allShops(), named, true);
            if (!found.ok) return failure(found.reason);

            select(player, found.value.id);

            return ok(`Now building ${found.value.name}.`);
        }
    },
    {
        name: "rae:shop_copy",
        description: "Makes a new shop with the same deals as another, with its own NPC in front of you.",
        mandatory: [{ name: "from", type: STRING }, { name: "name", type: STRING }],
        run: (origin, from: string, name: string) => {
            const player = playerOf(origin);
            if (!player) return failure("the copy's NPC appears in front of a player: run this as a player");

            const source = findShop(allShops(), from, true);
            if (!source.ok) return failure(source.reason);

            const copy = copyShopAs(player, source.value.id, name);
            if (!copy.ok) return failure(copy.reason);

            system.run(() => {
                if (!player.isValid) return;
                try {
                    spawnShopNpc(player, copy.shop);
                    later(origin, SOURCE, format("ok", `${copy.shop.name} (${copy.shop.id}) is in front of you with the same deals. To stand it somewhere else, go there and run /rae:shop_move ${copy.shop.id}.`));
                } catch (err) {
                    later(origin, SOURCE, format("warn", `The copy ${copy.shop.id} is saved but its NPC could not be placed (${err instanceof Error ? err.message : String(err)}). /rae:shop_place tries again.`));
                }
            });

            return ok(`Copied ${from} as ${copy.shop.name} (${copy.shop.id}). Placing its NPC.`);
        }
    },
    {
        name: "rae:shop_place",
        description: "Puts a shop's NPC in front of you: brings it from wherever it is, or makes a new one when it is gone. Add true to make a new one regardless.",
        optional: [{ name: "shop", type: STRING }, { name: "makeNew", type: BOOLEAN }],
        run: (origin, named?: string, makeNew?: boolean) => {
            const player = playerOf(origin);
            if (!player) return failure("the NPC comes to a player: run this as a player");

            const wanted = target(origin, named);
            if ("problem" in wanted) return failure(wanted.problem);

            const shop = getShop(wanted.id);
            if (!shop) return failure(`there is no shop ${wanted.id}`);

            system.run(() => {
                if (!player.isValid) return;

                if (makeNew !== true) {
                    void moveNpcHere(player, shop, true);
                    return;
                }

                try {
                    spawnShopNpc(player, shop);
                    tell(player, format("ok", `Made a new NPC for ${shop.name} in front of you.`));
                } catch (err) {
                    tell(player, format("warn", `${shop.name}'s NPC could not be placed: ${err instanceof Error ? err.message : String(err)}`));
                }
            });

            return ok(`Placing ${shop.name}'s NPC.`);
        }
    },
    {
        name: "rae:shop_move",
        description: "Moves a shop's NPC to stand in front of you, from wherever it is, even far away. Never makes a second one. With no shop, lists them to pick from.",
        optional: [{ name: "shop", type: STRING }],
        run: (origin, named?: string) => {
            const player = playerOf(origin);
            if (!player) return failure("the NPC comes to a player: run this as a player");

            if (named === undefined || named.length === 0) {
                system.run(() => { void openMovePicker(player); });
                return ok("Opening the list. Close the chat to see it.");
            }

            const wanted = target(origin, named);
            if ("problem" in wanted) return failure(wanted.problem);

            const shop = getShop(wanted.id);
            if (!shop) return failure(`there is no shop ${wanted.id}`);

            system.run(() => {
                if (player.isValid) void moveNpcHere(player, shop, false);
            });

            return ok(`Bringing ${shop.name}'s NPC.`);
        }
    },
    {
        name: "rae:shop_delete",
        description: "Deletes a shop and its NPC (until the world is reloaded, undo brings the shop back). Needs true to be sure.",
        mandatory: [{ name: "shop", type: STRING }, { name: "confirm", type: BOOLEAN }],
        run: (origin, named: string, confirm: boolean) => {
            if (confirm !== true) return failure("add true at the end to really delete it");

            const doomed = strictTarget(named);
            if ("problem" in doomed) return failure(doomed.problem);

            const id = doomed.id;

            const gone = deleteShop(id);
            if (!gone.ok) return failure(gone.reason);

            // The shop is already gone, so ask what was chosen (the saved id), not which shop that is.
            const player = playerOf(origin);
            if (player && selectedId(player) === id) select(player, undefined);

            system.run(() => {
                const [removed, released] = retireNpcs(id);
                later(origin, SOURCE, format("ok", `${id}: ${removed} NPC${removed === 1 ? "" : "s"} removed${released > 0 ? `, ${released} left standing` : ""}.`));
            });

            return ok(`Deleted ${id}. /rae:shop_undo ${id} brings it back (and /rae:shop_place puts its NPC out again).`);
        }
    },
    {
        name: "rae:shop_undo",
        description: "Undoes the last change to a shop (or the deletion of one). Doing it again redoes.",
        optional: [{ name: "shop", type: STRING }],
        run: (origin, named?: string) => {
            // A deleted shop is not there to be found by name, aim or selection, so what is not a shop is taken as an id as typed.
            const typed = named !== undefined && named.length > 0 ? named.trim().toLowerCase() : undefined;
            const known = typed !== undefined ? strictTarget(typed) : undefined;
            const wanted = typed === undefined ? target(origin) : known && "id" in known ? known : { id: typed };
            if ("problem" in wanted) return failure(wanted.problem);

            const result = undoLast(wanted.id);

            return result.ok ? ok(`Undone for ${wanted.id}. Run it again to put it back.`) : failure(result.reason);
        }
    }
];

system.beforeEvents.startup.subscribe((event) => {
    registerOperatorCommands(event.customCommandRegistry, SOURCE, COMMANDS);
});

registerSystem({
    name: "shopbuilder",
    reset() {
        // Nothing is kept between rounds: a shop is world data.
    }
});
