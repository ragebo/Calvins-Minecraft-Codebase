import { system, type CustomCommandOrigin, type Player } from "@minecraft/server";
import { failure, later, ok, playerOf, registerFamily, type Family } from "../core/commands.js";
import { info } from "../core/log.js";
import { registerSystem } from "../core/registry.js";
import { addHeldDeal, copyShopAs, createShop, select, selectedId, selectedShop, type HeldKind } from "../core/shopedit.js";
import { moveNpcHere, openMovePicker, openServiceScreen, openShop, openShopEditor, openShopPicker, openSwapDeal } from "../core/shopforms.js";
import { aimedShopNpc, npcsByShop, rememberSpot, retireNpcs, spawnShopNpc, whereIsNpc } from "../core/shopnpc.js";
import { allShops, deleteShop, getShop, getStored, listStored, rawText, undoLast } from "../core/shopstore.js";
import { format, tell } from "../core/ui.js";
import { describeShop, describeTrade, findShop, type Shop } from "../logic/shop.js";

/**
 * Building a shop in the game: the command. Operators only, all of it. The screens are in core/shopforms.ts and the wand opens
 * them on a click (systems/shoptalk.ts); the command is the guaranteed way to do the same, and the quick way to stock a
 * shop: hold an item and say what it costs. It is ONE command, `/rae:shop` (it was fifteen), whose first word picks the action
 * (core/commands.ts has the family); with nothing after it, it opens the list of shops.
 *
 *   /rae:shop new Habiti          an NPC appears in front of you, named, with an empty shop
 *   hold a sword                  /rae:shop sell 60       the NPC sells it for 60 coins
 *   hold 3 feathers               /rae:shop buy 8         the NPC buys 3 feathers for 8 coins
 *   hold a diamond                /rae:shop trade         players hand over an item (maybe coins too) for it
 *   stand where players should go /rae:shop service       a small form: an effect, an enchantment, a tame animal or a teleport
 *
 * Which shop a command means: the one named (by its id or by the name you gave it, in any case: "Mule Dealer" and mule_dealer are
 * one shop), else the NPC you are looking at, else the one you last worked on.
 *
 *   stand where it should be      /rae:shop move Habiti   its NPC comes to you from wherever it is, and no second one is made
 *
 * A command's callback is restricted (it may read, send chat and save a world property, but not spawn, move or remove anything),
 * so each command saves what it can at once, answers, and does the part that changes the world a tick later, telling the player
 * how it went.
 */

const SOURCE = "shop";

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

    return { problem: "name a shop, look at its NPC, or choose one with /rae:shop select" };
}

function describeList(): string {

    const stored = listStored();

    if (stored.length === 0) return "There are no shops yet. /rae:shop new <name> makes one.";

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

/** "yes", "true" or "confirm" typed after a destructive action: anything else is not a yes. */
const isYes = (text: string | undefined): boolean => text !== undefined && ["yes", "true", "confirm", "y"].includes(text.toLowerCase());

/** Stocking a shop from the hand: the same for `sell` and `buy`. */
function stock(origin: CustomCommandOrigin, kind: HeldKind, typed: string | undefined) {

    const player = playerOf(origin);
    if (!player) return failure("hold an item and run this as a player");

    const coins = typed === undefined ? Number.NaN : Number(typed);
    if (!Number.isInteger(coins)) return failure(`how many coins? Hold the item and type /rae:shop ${kind === "sells" ? "sell" : "buy"} <coins>`);

    const wanted = target(origin);
    if ("problem" in wanted) return failure(wanted.problem);

    const outcome = addHeldDeal(player, wanted.id, kind, coins);

    if (!outcome.ok) return failure(outcome.reason);

    return ok(`Added to ${outcome.shop.name}: ${outcome.trade ? describeTrade(outcome.trade) : "a deal"}.`);
}

/** Makes a shop's NPC appear in front of a player after the shop was made (a command's callback may not spawn anything itself). */
function placeNewNpc(origin: CustomCommandOrigin, player: Player, shop: Shop, aftermath: string): void {

    system.run(() => {
        if (!player.isValid) return;
        try {
            spawnShopNpc(player, shop);
            later(origin, SOURCE, format("ok", `${shop.name} (${shop.id}) is in front of you${aftermath}`));
        } catch (err) {
            later(origin, SOURCE, format("warn", `The shop ${shop.id} is saved but its NPC could not be placed (${err instanceof Error ? err.message : String(err)}). /rae:shop place tries again.`));
        }
    });
}

const FAMILY: Family = {
    name: "rae:shop",
    description: "Build NPC shops. With nothing after it, opens the list of shops and the builder. help lists the rest.",
    actionEnum: "rae:shop_action",
    first: { name: "shop" },
    second: { name: "value" },
    bareHelp: "opens the shops: pick one to edit, or make a new one",
    bare: (origin) => {
        const player = playerOf(origin);
        if (!player) return failure("the screen opens for a player: run this as a player");

        system.run(() => { void openShopPicker(player); });

        return ok("Opening the shops. Close the chat to see them.");
    },
    actions: [
        {
            name: "list",
            usage: "",
            description: "Lists every shop, how many deals it has and where its NPC is (or was last seen).",
            run: () => ok(describeList())
        },
        {
            name: "info",
            usage: "[shop] [raw]",
            description: "Shows a shop's deals. Add raw to write its saved text to the content log as a backup.",
            run: (origin, named, raw) => {
                const wanted = target(origin, named);
                if ("problem" in wanted) return failure(wanted.problem);

                if (raw?.toLowerCase() === "raw") {
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
            name: "new",
            usage: "<name>",
            description: "Makes a new shop and puts its NPC in front of you. Then hold an item and use /rae:shop sell <coins> or /rae:shop buy <coins>.",
            run: (origin, name) => {
                const player = playerOf(origin);
                if (!player) return failure("a shop's NPC appears in front of a player: run this as a player");
                if (name === undefined) return failure("name it: /rae:shop new Habiti");

                const made = createShop(player, name);
                if (!made.ok) return failure(made.reason);

                placeNewNpc(origin, player, made.shop, ". Hold an item and run /rae:shop sell <coins> to stock it.");

                return ok(`Made ${made.shop.name} (${made.shop.id}) and selected it. Placing its NPC.`);
            }
        },
        {
            name: "sell",
            usage: "<coins>",
            description: "The NPC SELLS the item you hold (all of the stack) for this many coins.",
            run: (origin, coins) => stock(origin, "sells", coins)
        },
        {
            name: "buy",
            usage: "<coins>",
            description: "The NPC BUYS the item you hold (all of the stack) from players for this many coins.",
            run: (origin, coins) => stock(origin, "buys", coins)
        },
        {
            name: "trade",
            usage: "",
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
            name: "service",
            usage: "",
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
            name: "edit",
            usage: "[shop]",
            description: "Opens a shop's builder screen (the same as clicking its NPC with the wand). With no shop, lists them.",
            run: (origin, named) => {
                const player = playerOf(origin);
                if (!player) return failure("the screen opens for a player: run this as a player");

                const wanted = target(origin, named);

                if (named !== undefined && named.length > 0 && "problem" in wanted) return failure(wanted.problem);

                system.run(() => { void ("id" in wanted ? openShopEditor(player, wanted.id) : openShopPicker(player)); });

                return ok("Opening the screen. Close the chat to see it.");
            }
        },
        {
            name: "open",
            usage: "<shop>",
            description: "Opens a shop for yourself, as a customer sees it (to try it).",
            run: (origin, named) => {
                const player = playerOf(origin);
                if (!player) return failure("the shop opens for a player: run this as a player");
                if (named === undefined) return failure("which shop? /rae:shop open <shop>");

                const wanted = target(origin, named);
                if ("problem" in wanted) return failure(wanted.problem);

                system.run(() => { void openShop(player, wanted.id); });

                return ok(`Opening ${wanted.id}. Close the chat to see it.`);
            }
        },
        {
            name: "select",
            usage: "<shop>",
            description: "Chooses the shop you are building.",
            run: (origin, named) => {
                const player = playerOf(origin);
                if (!player) return failure("this is for a player building a shop");
                if (named === undefined) return failure("which shop? /rae:shop select <shop>. /rae:shop list shows them.");

                const found = findShop(allShops(), named, true);
                if (!found.ok) return failure(found.reason);

                select(player, found.value.id);

                return ok(`Now building ${found.value.name}.`);
            }
        },
        {
            name: "copy",
            usage: "<from> <name>",
            description: "Makes a new shop with the same deals as another, with its own NPC in front of you.",
            run: (origin, from, name) => {
                const player = playerOf(origin);
                if (!player) return failure("the copy's NPC appears in front of a player: run this as a player");
                if (from === undefined || name === undefined) return failure("which shop, and what is the copy called? /rae:shop copy <from> <name>");

                const source = findShop(allShops(), from, true);
                if (!source.ok) return failure(source.reason);

                const copy = copyShopAs(player, source.value.id, name);
                if (!copy.ok) return failure(copy.reason);

                placeNewNpc(origin, player, copy.shop, ` with the same deals. To stand it somewhere else, go there and run /rae:shop move ${copy.shop.id}.`);

                return ok(`Copied ${from} as ${copy.shop.name} (${copy.shop.id}). Placing its NPC.`);
            }
        },
        {
            name: "place",
            usage: "[shop] [new]",
            description: "Puts a shop's NPC in front of you: brings it from wherever it is, or makes a new one when it is gone. Add new to make a new one regardless.",
            run: (origin, named, makeNew) => {
                const player = playerOf(origin);
                if (!player) return failure("the NPC comes to a player: run this as a player");

                const wanted = target(origin, named);
                if ("problem" in wanted) return failure(wanted.problem);

                const shop = getShop(wanted.id);
                if (!shop) return failure(`there is no shop ${wanted.id}`);

                const fresh = makeNew?.toLowerCase() === "new";

                system.run(() => {
                    if (!player.isValid) return;

                    if (!fresh) {
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
            name: "move",
            usage: "[shop]",
            description: "Moves a shop's NPC to stand in front of you, from wherever it is, even far away. Never makes a second one. With no shop, lists them to pick from.",
            run: (origin, named) => {
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
            name: "delete",
            usage: "<shop> yes",
            description: "Deletes a shop and its NPC (until the world is reloaded, undo brings the shop back). Needs yes to be sure.",
            run: (origin, named, confirm) => {
                if (named === undefined) return failure("which shop? /rae:shop delete <shop> yes");
                if (!isYes(confirm)) return failure("add yes at the end to really delete it");

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

                return ok(`Deleted ${id}. /rae:shop undo ${id} brings it back (and /rae:shop place puts its NPC out again).`);
            }
        },
        {
            name: "undo",
            usage: "[shop]",
            description: "Undoes the last change to a shop (or the deletion of one). Doing it again redoes.",
            run: (origin, named) => {
                // A deleted shop is not there to be found by name, aim or selection, so what is not a shop is taken as an id as typed.
                const typed = named !== undefined && named.length > 0 ? named.trim().toLowerCase() : undefined;
                const known = typed !== undefined ? strictTarget(typed) : undefined;
                const wanted = typed === undefined ? target(origin) : known && "id" in known ? known : { id: typed };
                if ("problem" in wanted) return failure(wanted.problem);

                const result = undoLast(wanted.id);

                return result.ok ? ok(`Undone for ${wanted.id}. Run it again to put it back.`) : failure(result.reason);
            }
        }
    ]
};

system.beforeEvents.startup.subscribe((event) => {
    registerFamily(event.customCommandRegistry, SOURCE, FAMILY);
});

registerSystem({
    name: "shopbuilder",
    reset() {
        // Nothing is kept between rounds: a shop is world data.
    }
});
