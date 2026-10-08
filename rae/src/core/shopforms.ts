import type { Entity, Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { SHOP as S } from "../config/balance.js";
import {
    DIMENSIONS, describeDestination, describeItem, describeRequirement, describeShop, describeTrade, faceOf, findTrade, moveTrade, priceOf,
    readDestination, removeTrade, renameShop, setGreeting, signature, teleportOf, updateTrade, whyNotOpen, withPrice,
    type Destination, type Requirement, type Shop, type Trade
} from "../logic/shop.js";
import { getCoins } from "./economy.js";
import { confirmForm, showForm } from "./forms.js";
import { error } from "./log.js";
import { BACK, createScreens, type Action, type Screen } from "./screens.js";
import {
    addHeldDeal, addServiceDeal, addSwapDeal, applyEdit, bagChoices, copyShopAs, createShop, select, selectedId, setRequirement, setTeleport,
    whereIStand,
    type HeldKind, type Outcome, type ServiceKind
} from "./shopedit.js";
import { bindNpc, bringShopNpc, broughtText, needsFetch, npcsByShop, npcsOf, recallSpot, retireNpcs, spawnShopNpc, whereIsNpc } from "./shopnpc.js";
import { allShops, deleteShop, getShop, listStored, undoAvailable, undoLast } from "./shopstore.js";
import { carryOutTrade, whyCannotTrade } from "./shoptrade.js";
import { playFor } from "./sound.js";
import { format, tell } from "./ui.js";

/**
 * Every screen of a shop: the one a customer sees, and the builder's. Presentation only: what is shown comes from
 * logic/shop.ts (plain-language lines for a deal), a purchase is core/shoptrade.ts's all-or-nothing `carryOutTrade`, and every
 * change a builder makes goes through core/shopedit.ts, which validates it, so a screen can ask for something the rules refuse
 * and the answer is a sentence in chat, never a half-made shop.
 *
 * A screen builds itself again each time it is shown, from what is saved right now, so what it says is never stale and a shop
 * deleted from under an open screen simply closes it.
 */

const SOURCE = "shop";

const ok = (text: string): string => format("ok", text);
const warn = (text: string): string => format("warn", text);

/** The title of a screen about one thing: "Habiti: deals". (Built here so no template literal opens with a player-style name key, which the legacy ratchet counts.) */
const heading = (name: string, what: string): string => `${name}: ${what}`;

// ---------------------------------------------------------------------------------------------------------
// The customer's screen
// ---------------------------------------------------------------------------------------------------------

/** Customers with a shop open right now: a click on an NPC can be reported twice, and one shop on top of another helps no one. */
const shopping = new Set<string>();

export const hasShopOpen = (player: Player): boolean => shopping.has(player.id);

/** A deal's button: plain when the player can take it, greyed when they cannot (yet). */
function buttonLabel(player: Player, trade: Trade): string {
    const text = describeTrade(trade);
    return whyCannotTrade(player, trade) === undefined ? text : `§7${text}`;
}

function shopBody(shop: Shop, player: Player, notice: string): string {

    const greeting = shop.greeting.length > 0 ? `${shop.greeting}\n\n` : "";
    const purse = `§7You have §f${getCoins(player)} coins§7.`;

    return `${greeting}${purse}${notice.length > 0 ? `\n\n${notice}` : ""}`;
}

/**
 * Opens a shop for a customer and keeps it open, so buying several things is several clicks: each deal is carried out whole or
 * not at all, the answer is written at the top of the next screen, and the screen is shown again until the player closes it.
 */
export async function openShop(player: Player, shopId: string): Promise<void> {

    if (shopping.has(player.id)) return;

    shopping.add(player.id);

    try {

        let notice = "";

        for (;;) {

            if (!player.isValid) return;

            const shop = getShop(shopId);

            if (!shop) {
                tell(player, warn("That shop has closed."));
                return;
            }

            const closed = whyNotOpen(shop);

            if (closed) {
                tell(player, warn(heading(shop.name, `${closed}.`)));
                return;
            }

            // What the player is shown, deal by deal. A deal is bought only if it is still exactly this.
            const shown = shop.trades.map(signature);

            const form = new ActionFormData().title(shop.name).body(shopBody(shop, player, notice));
            for (const trade of shop.trades) form.button(buttonLabel(player, trade));
            form.button("Close");

            const response = await showForm(player, form);

            // A player who left while the form was open has no bag or purse to settle a deal against.
            if (!response || response.canceled || response.selection === undefined || !player.isValid) return;

            const chosen = shop.trades[response.selection];

            if (!chosen) return;                                     // the Close button

            const now = getShop(shopId)?.trades.find((trade) => trade.id === chosen.id);

            if (!now || signature(now) !== shown[response.selection]) {
                notice = warn("That deal has just changed. Have another look.");
                continue;
            }

            const outcome = carryOutTrade(player, now);

            if (outcome.ok) {
                playFor(player, faceOf(now) === "sell" ? S.cues.sold : S.cues.bought);
                notice = ok(`${outcome.summary}${outcome.dropped > 0 ? " Your bag was full, so some of it is on the ground." : ""}`);
            } else {
                playFor(player, S.cues.denied);
                notice = warn(outcome.reason);
            }
        }

    } catch (err) {
        error(SOURCE, `a shop screen failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        shopping.delete(player.id);
    }
}

// ---------------------------------------------------------------------------------------------------------
// The builder's screens
// ---------------------------------------------------------------------------------------------------------

const screens = createScreens(SOURCE);

/** Whether this builder has a shop menu open. */
export const hasBuilderMenuOpen = screens.hasMenuOpen;

/** Tells the builder how an edit went. True when it worked. */
function report(player: Player, outcome: Outcome, success: string): boolean {

    if (outcome.ok) {
        tell(player, ok(success));
        return true;
    }

    tell(player, warn(`Not changed: ${outcome.reason.replace(/\.$/, "")}.`));

    return false;
}

/** Asks one line of text. Undefined when the form was closed. */
async function askText(player: Player, title: string, label: string, placeholder: string, value: string): Promise<string | undefined> {

    const response = await showForm(player, new ModalFormData().title(title).textField(label, placeholder, { defaultValue: value }));

    if (!response || response.canceled) return undefined;

    return String(response.formValues?.[0] ?? "").trim();
}

/** Asks for a whole number of coins. Undefined when the form was closed or the answer was not a number (and says so). */
async function askCoins(player: Player, title: string, label: string, value: number): Promise<number | undefined> {

    const text = await askText(player, title, label, String(value), String(value));

    if (text === undefined) return undefined;

    const coins = Number(text);

    if (text.length === 0 || !Number.isInteger(coins)) {
        tell(player, warn("A price is a whole number of coins."));
        return undefined;
    }

    return coins;
}

function npcLine(shopId: string): string {
    return `§7NPC: §f${whereIsNpc(shopId, npcsOf(shopId))}`;
}

/** The screen for one shop. `last` is its final button: Close at the top of a stack, Back inside the picker. */
function editorScreen(player: Player, shopId: string, last: Action): Screen | undefined {

    const shop = getShop(shopId);
    if (!shop) return undefined;

    const actions: Action[] = [
        { label: `Deals (${shop.trades.length})`, run: () => dealsScreen(player, shopId) },
        { label: "Add a deal", run: () => addDealScreen(player, shopId) },
        { label: "Greeting", run: () => greetingForm(player, shopId) },
        { label: "Rename", run: () => renameForm(player, shopId) },
        { label: "Copy this shop to a new NPC here", run: () => copyForm(player, shopId) },
        { label: npcsOf(shopId).length > 0 || recallSpot(shopId) !== undefined ? "Bring its NPC here" : "Place its NPC here", run: () => placeHere(player, shopId) },
        ...(undoAvailable(shopId) ? [{ label: "Undo the last change", run: () => undoChange(player, shopId) }] : []),
        { label: "Delete this shop", run: async () => ((await deleteConfirmed(player, shopId)) ? "back" as const : undefined) },
        last
    ];

    return { title: shop.name, body: `${describeShop(shop).join("\n")}\n${npcLine(shopId)}`, actions };
}

/** The builder's screen for one shop. Also the wand's click on the shop's NPC. */
export function openShopEditor(player: Player, shopId: string): Promise<void> {

    return screens.menuFor(player, async () => {

        select(player, shopId);

        const close: Action = { label: "Close", run: () => { screens.closeAll(player); } };

        await screens.run(player, () => editorScreen(player, shopId, close));
    });
}

async function dealsScreen(player: Player, shopId: string): Promise<void> {

    await screens.run(player, () => {

        const shop = getShop(shopId);
        if (!shop) return undefined;

        const actions: Action[] = [
            ...shop.trades.map((trade): Action => ({ label: `${trade.id}  ${describeTrade(trade)}`, run: () => dealScreen(player, shopId, trade.id) })),
            BACK
        ];

        return { title: heading(shop.name, "deals"), body: shop.trades.length === 0 ? "No deals yet. Add one from the shop's menu." : "Pick a deal to change its price, move it or remove it.", actions };
    });
}

async function dealScreen(player: Player, shopId: string, tradeId: string): Promise<void> {

    await screens.run(player, () => {

        const shop = getShop(shopId);
        const trade = shop ? findTrade(shop, tradeId) : undefined;

        if (!shop || !trade) return undefined;

        const teleport = teleportOf(trade);

        const actions: Action[] = [
            { label: "Change the price", run: () => priceForm(player, shopId, tradeId) },
            ...(teleport ? [{ label: "Change where it goes", run: () => teleportForm(player, shopId, tradeId) }] : []),
            { label: "Who can take it", run: () => requirementForm(player, shopId, tradeId) },
            { label: "Move up", run: () => { report(player, applyEdit(shopId, (s) => moveTrade(s, tradeId, -1)), "Moved up."); } },
            { label: "Move down", run: () => { report(player, applyEdit(shopId, (s) => moveTrade(s, tradeId, 1)), "Moved down."); } },
            {
                label: "Remove this deal",
                run: async () => {
                    if (!(await confirmForm(player, shop.name, `Remove "${describeTrade(trade)}"?`, "Remove"))) return undefined;
                    return report(player, applyEdit(shopId, (s) => removeTrade(s, tradeId)), "Removed.") ? "back" as const : undefined;
                }
            },
            BACK
        ];

        return { title: heading(shop.name, trade.id), body: teleport ? `${describeTrade(trade)}\n§7Goes to §f${describeDestination(teleport)}` : describeTrade(trade), actions };
    });
}

async function priceForm(player: Player, shopId: string, tradeId: string): Promise<void> {

    const trade = getShop(shopId) ? findTrade(getShop(shopId)!, tradeId) : undefined;
    if (!trade) return;

    const coins = await askCoins(player, "Price", faceOf(trade) === "sell" ? "Coins players are paid" : "Coins players pay", priceOf(trade));

    if (coins === undefined) return;

    report(player, applyEdit(shopId, (shop) => updateTrade(shop, tradeId, withPrice(trade, coins))), "The price is changed.");
}

async function addDealScreen(player: Player, shopId: string): Promise<void> {

    await screens.run(player, () => {

        const shop = getShop(shopId);
        if (!shop) return undefined;

        const actions: Action[] = [
            { label: "The NPC SELLS what I am holding", run: () => heldDealForm(player, shopId, "sells") },
            { label: "The NPC BUYS what I am holding", run: () => heldDealForm(player, shopId, "buys") },
            { label: "TRADE: players hand over an item for what I hold", run: () => swapForm(player, shopId) },
            { label: "A SERVICE: effect, enchantment, tame animal, teleport", run: () => serviceScreen(player, shopId) },
            BACK
        ];

        const body = "Hold the item in your hand first.\n§7SELLS: players pay coins and get what you hold (all of the stack).\nBUYS: players hand over what you hold and get coins.\nTRADE: players hand over another item from your bag, maybe with coins, for what you hold.\nSERVICE: players pay coins for something done to them, no item needed.";

        return { title: heading(shop.name, "add a deal"), body, actions };
    });
}

async function heldDealForm(player: Player, shopId: string, kind: HeldKind): Promise<void> {

    const coins = await askCoins(player, kind === "sells" ? "The NPC sells" : "The NPC buys", kind === "sells" ? "Coins players pay" : "Coins players are paid", 10);

    if (coins === undefined) return;

    const outcome = addHeldDeal(player, shopId, kind, coins);

    report(player, outcome, outcome.ok && outcome.trade ? `Added: ${describeTrade(outcome.trade)}.` : "Added.");
}

async function swapForm(player: Player, shopId: string): Promise<void> {

    const choices = bagChoices(player);

    if (choices.length === 0) {
        tell(player, warn("Put the item players should hand over in your bag first (not in the hand you are holding)."));
        return;
    }

    const form = new ModalFormData()
        .title("Trade")
        .dropdown("Players hand over", choices.map((choice) => `${describeItem(choice.spec)} (slot ${choice.slot + 1})`), { defaultValueIndex: 0 })
        .textField("How many", "1", { defaultValue: "1" })
        .textField("Extra coins they also pay (0 for none)", "0", { defaultValue: "0" });

    const response = await showForm(player, form);

    if (!response || response.canceled) return;

    const [picked, amountText, coinsText] = response.formValues ?? [];
    const choice = choices[typeof picked === "number" ? picked : 0];
    const amount = Number(String(amountText ?? "").trim());
    const coins = Number(String(coinsText ?? "").trim());

    if (!choice) return;

    if (!Number.isInteger(amount) || !Number.isInteger(coins)) {
        tell(player, warn("How many, and the extra coins, are whole numbers."));
        return;
    }

    const outcome = addSwapDeal(player, shopId, choice.slot, amount, coins);

    report(player, outcome, outcome.ok && outcome.trade ? `Added: ${describeTrade(outcome.trade)}.` : "Added.");
}

/** The trade form on its own (the /rae:shop_trade command). */
export const openSwapDeal = (player: Player, shopId: string): Promise<void> => screens.menuFor(player, () => swapForm(player, shopId));

/** The service screen on its own (the /rae:shop_service command). */
export const openServiceScreen = (player: Player, shopId: string): Promise<void> => screens.menuFor(player, () => serviceScreen(player, shopId));

async function serviceScreen(player: Player, shopId: string): Promise<void> {

    await screens.run(player, () => {

        const shop = getShop(shopId);
        if (!shop) return undefined;

        const actions: Action[] = [
            { label: "A potion EFFECT", run: () => serviceForm(player, shopId, "effect") },
            { label: "An ENCHANTMENT on the item they hold", run: () => serviceForm(player, shopId, "enchant") },
            { label: "A tame ANIMAL (horse, mule, donkey)", run: () => serviceForm(player, shopId, "mount") },
            { label: "A TELEPORT (to where I stand, or typed coordinates)", run: () => teleportForm(player, shopId) },
            BACK
        ];

        const body = "What the customer pays coins for. The game is asked whether it knows what you type, so a typo is caught here.\n§7A teleport's boxes start as the spot you are standing on: leave them, or type any coordinates to send customers anywhere.";

        return { title: heading(shop.name, "add a service"), body, actions };
    });
}

/** A whole number from a form's text, or undefined when it is not one. */
const wholeNumber = (value: unknown): number | undefined => {
    const text = String(value ?? "").trim();
    return /^-?\d+$/.test(text) ? Number(text) : undefined;
};

async function serviceForm(player: Player, shopId: string, kind: Exclude<ServiceKind, "teleport">): Promise<void> {

    const form = new ModalFormData();

    if (kind === "effect") {
        form.title("A potion effect")
            .textField("Effect", "regeneration", { defaultValue: "" })
            .textField("Level (1 is normal)", "1", { defaultValue: "1" })
            .textField("Seconds it lasts", "10", { defaultValue: "10" })
            .textField("Coins players pay", "20", { defaultValue: "20" });
    } else if (kind === "enchant") {
        form.title("An enchantment")
            .textField("Enchantment", "flame", { defaultValue: "" })
            .textField("Level", "1", { defaultValue: "1" })
            .textField("Coins players pay", "100", { defaultValue: "100" });
    } else {
        form.title("A tame animal")
            .textField("Animal", "horse", { defaultValue: "horse" })
            .textField("Coins players pay", "35", { defaultValue: "35" });
    }

    const response = await showForm(player, form);

    if (!response || response.canceled) return;

    const values = response.formValues ?? [];
    const text = (index: number): string => String(values[index] ?? "").trim();

    // The fields line up with the form above: effect (what, level, seconds, coins), enchant (what, level, coins), mount (what, coins).
    const coinsAt = kind === "effect" ? 3 : kind === "enchant" ? 2 : 1;
    const coins = wholeNumber(values[coinsAt]);
    const level = kind === "effect" || kind === "enchant" ? wholeNumber(values[1]) : 1;
    const seconds = kind === "effect" ? wholeNumber(values[2]) : 0;

    if (coins === undefined || level === undefined || seconds === undefined) {
        tell(player, warn("The level, the seconds and the coins are whole numbers."));
        return;
    }

    const outcome = addServiceDeal(player, shopId, kind, { what: text(0), level, seconds, coins, name: "" });

    report(player, outcome, outcome.ok && outcome.trade ? `Added: ${describeTrade(outcome.trade)}.` : "Added.");
}

/**
 * Where a teleport goes, as boxes to type in. A new teleport's boxes start as the spot the builder stands on (leave them and
 * that is where it goes; type others to send customers anywhere, however far from the NPC). An existing deal's start as its
 * destination, and a switch sends it to where the builder stands instead, for when they have walked there.
 */
async function teleportForm(player: Player, shopId: string, tradeId?: string): Promise<void> {

    const shop = getShop(shopId);
    if (!shop) return;

    const trade = tradeId !== undefined ? findTrade(shop, tradeId) : undefined;
    const old = trade ? teleportOf(trade) : undefined;

    if (tradeId !== undefined && !old) return;          // the deal changed under the screen

    const start: Destination = old ?? whereIStand(player);

    const form = new ModalFormData().title(old ? "Where it goes" : "A teleport");

    if (old) form.toggle("Use where I am standing now instead (the boxes below are ignored)", { defaultValue: false });

    form.textField("X (east-west)", "0", { defaultValue: String(start.x) })
        .textField("Y (height)", "64", { defaultValue: String(start.y) })
        .textField("Z (north-south)", "0", { defaultValue: String(start.z) })
        .dropdown("Dimension", ["The overworld", "The nether", "The end"], { defaultValueIndex: Math.max(0, DIMENSIONS.indexOf(start.dimension)) })
        .textField("Name of this place (optional)", "Saint Diego", { defaultValue: old?.name ?? "" });

    if (!old) form.textField("Coins players pay", "25", { defaultValue: "25" });

    const response = await showForm(player, form);

    if (!response || response.canceled) return;

    const values = response.formValues ?? [];
    const first = old ? 1 : 0;                           // the form for an existing deal starts with the switch

    const where = old && values[0] === true
        ? { ok: true as const, value: whereIStand(player) }
        : readDestination(
            { x: String(values[first] ?? ""), y: String(values[first + 1] ?? ""), z: String(values[first + 2] ?? "") },
            DIMENSIONS[Number(values[first + 3])] ?? start.dimension
        );

    if (!where.ok) {
        tell(player, warn(`Not changed: ${where.reason}.`));
        return;
    }

    const name = String(values[first + 4] ?? "");

    if (old && tradeId !== undefined) {
        report(player, setTeleport(shopId, tradeId, where.value, name), `It now goes to ${describeDestination(where.value)}.`);
        return;
    }

    const coins = wholeNumber(values[first + 5]);

    if (coins === undefined) {
        tell(player, warn("Not changed: the coins are a whole number."));
        return;
    }

    const outcome = addServiceDeal(player, shopId, "teleport", { what: "", level: 1, seconds: 0, coins, name, where: where.value });

    report(player, outcome, outcome.ok && outcome.trade ? `Added: ${describeTrade(outcome.trade)}.` : "Added.");
}

async function requirementForm(player: Player, shopId: string, tradeId: string): Promise<void> {

    const shop = getShop(shopId);
    const trade = shop ? findTrade(shop, tradeId) : undefined;

    if (!trade) return;

    const current = trade.requires;
    const sides = ["Anyone", "Law only", "Outlaws only"];

    const form = new ModalFormData()
        .title("Who can take it")
        .dropdown("Side", sides, { defaultValueIndex: current?.role === "law" ? 1 : current?.role === "outlaw" ? 2 : 0 })
        .textField("Least bounty (0 for none)", "0", { defaultValue: String(current?.bounty ?? 0) });

    const response = await showForm(player, form);

    if (!response || response.canceled) return;

    const [side, bountyText] = response.formValues ?? [];
    const bounty = wholeNumber(bountyText);

    if (bounty === undefined || bounty < 0) {
        tell(player, warn("The least bounty is a whole number, 0 for none."));
        return;
    }

    const role = side === 1 ? "law" : side === 2 ? "outlaw" : undefined;
    const requires: Requirement | undefined = role === undefined && bounty === 0 ? undefined : { ...(role !== undefined ? { role } : {}), ...(bounty > 0 ? { bounty } : {}) };

    report(player, setRequirement(shopId, tradeId, requires), requires ? `Now only for: ${describeRequirement(requires)}.` : "Anyone can take it now.");
}

async function greetingForm(player: Player, shopId: string): Promise<void> {

    const shop = getShop(shopId);
    if (!shop) return;

    const text = await askText(player, "Greeting", "What the NPC says above the deals", "Howdy, stranger.", shop.greeting);

    if (text === undefined) return;

    report(player, applyEdit(shopId, (s) => setGreeting(s, text)), text.length > 0 ? "The greeting is set." : "The greeting is cleared.");
}

async function renameForm(player: Player, shopId: string): Promise<void> {

    const shop = getShop(shopId);
    if (!shop) return;

    const text = await askText(player, "Rename", "The shop's name", shop.name, shop.name);

    if (text === undefined) return;

    if (report(player, applyEdit(shopId, (s) => renameShop(s, text)), "Renamed.")) {
        const renamed = getShop(shopId);
        if (renamed) for (const npc of npcsOf(shopId)) npc.nameTag = renamed.name;
    }
}

async function copyForm(player: Player, shopId: string): Promise<void> {

    const shop = getShop(shopId);
    if (!shop) return;

    const text = await askText(player, "Copy this shop", "A name for the new shop", shop.name, `${shop.name} 2`);

    if (text === undefined) return;

    const copy = copyShopAs(player, shopId, text);

    if (!copy.ok) {
        report(player, copy, "");
        return;
    }

    spawnShopNpc(player, copy.shop);
    tell(player, ok(`Made ${copy.shop.name} (${copy.shop.id}) with the same deals, and put its NPC in front of you. To stand it somewhere else, go there and run /rae:shop_move ${copy.shop.id}. /rae:shop_edit opens it.`));
}

/**
 * Brings a shop's NPC to stand in front of the builder and says how it went. From wherever it is: an NPC whose area is not
 * loaded is fetched by loading the area for a moment. `mayMake`: when it is truly gone, make a new one (else say so, and make none).
 */
export async function moveNpcHere(player: Player, shop: Shop, mayMake: boolean): Promise<void> {

    if (needsFetch(shop.id)) tell(player, format("info", `Loading the area where ${shop.name}'s NPC was last seen...`));

    try {
        const brought = await bringShopNpc(player, shop, mayMake);
        const text = broughtText(shop, brought);

        tell(player, brought.how === "none" || brought.how === "stuck" ? warn(text) : ok(text));
    } catch (err) {
        tell(player, warn(`${shop.name}'s NPC could not be placed: ${err instanceof Error ? err.message : String(err)}`));
    }
}

async function placeHere(player: Player, shopId: string): Promise<void> {

    const shop = getShop(shopId);
    if (!shop) return;

    await moveNpcHere(player, shop, true);
}

/** "Whose NPC should come here?": every shop by name, with where its NPC is. Pressing one brings it, and never makes a second. */
export function openMovePicker(player: Player): Promise<void> {

    return screens.menuFor(player, async () => {

        await screens.run(player, () => {

            const shops = allShops();
            const loaded = npcsByShop();

            const actions: Action[] = [
                ...shops.map((shop): Action => ({
                    label: `${shop.name} (${whereIsNpc(shop.id, loaded.get(shop.id) ?? [])})`,
                    run: async () => {
                        await moveNpcHere(player, shop, false);
                        screens.closeAll(player);
                    }
                })),
                { label: "Close", run: () => { screens.closeAll(player); } }
            ];

            return { title: "Bring an NPC here", body: shops.length === 0 ? "No shops yet." : "Whose NPC should come and stand in front of you? It is brought from wherever it is; none is made.", actions };
        });
    });
}

function undoChange(player: Player, shopId: string): void {

    const result = undoLast(shopId);

    tell(player, result.ok ? ok("Undone. Do it again to put it back.") : warn(result.reason));
}

async function deleteConfirmed(player: Player, shopId: string): Promise<boolean> {

    const shop = getShop(shopId);
    if (!shop) return false;

    if (!(await confirmForm(player, shop.name, `Delete ${shop.name} and ${shop.trades.length} deal${shop.trades.length === 1 ? "" : "s"}? Its NPC goes too. /rae:shop_undo brings the shop back.`, "Delete"))) return false;

    const gone = deleteShop(shopId);

    if (!gone.ok) {
        tell(player, warn(`Not deleted: ${gone.reason}.`));
        return false;
    }

    const [removed] = retireNpcs(shopId);

    if (selectedId(player) === shopId) select(player, undefined);

    tell(player, ok(`Deleted ${shop.name}${removed > 0 ? " and its NPC" : ""}. /rae:shop_undo ${shopId} brings the shop back (/rae:shop_place puts its NPC out again).`));

    return true;
}

/** The picker: every shop to edit, and a new one. */
export function openShopPicker(player: Player): Promise<void> {

    return screens.menuFor(player, async () => {

        await screens.run(player, () => {

            const stored = listStored();

            const actions: Action[] = [
                ...stored.map((entry): Action => ({
                    label: entry.ok ? `${entry.value.name} (${entry.id})` : `${entry.id} (cannot be read)`,
                    run: async () => {
                        if (!entry.ok) { tell(player, warn(`${entry.id} cannot be read: ${entry.problem}. /rae:shop_delete ${entry.id} true clears it, and /rae:shop_undo brings it back.`)); return undefined; }
                        select(player, entry.id);
                        await screens.run(player, () => editorScreen(player, entry.id, BACK));
                        return undefined;
                    }
                })),
                { label: "A new shop, with an NPC here", run: () => newShopForm(player) },
                { label: "Close", run: () => { screens.closeAll(player); } }
            ];

            return { title: "Shops", body: stored.length === 0 ? "No shops yet." : "Pick a shop to edit, or make a new one.", actions };
        });
    });
}

async function newShopForm(player: Player): Promise<void> {

    const name = await askText(player, "A new shop", "The shop's name", "Habiti", "");

    if (name === undefined) return;

    const made = createShop(player, name);

    if (!made.ok) {
        report(player, made, "");
        return;
    }

    spawnShopNpc(player, made.shop);
    tell(player, ok(`Made ${made.shop.name} (${made.shop.id}) and put its NPC in front of you. Hold an item and use /rae:shop_sell <coins> to stock it.`));
}

/** The wand clicked on an NPC that is not a shop yet: offers to make it one. */
export async function openAdoptNpc(player: Player, npc: Entity): Promise<void> {

    if (screens.hasMenuOpen(player)) return;

    if (!(await confirmForm(player, "Make this NPC a shop?", "This NPC is not a shop. Turn it into one? Its own dialogue stays under the game's NPC screen (sneak and click it).", "Make it a shop"))) return;

    const name = await askText(player, "A new shop", "The shop's name", "Habiti", "");

    if (name === undefined || !npc.isValid) return;

    const made = createShop(player, name);

    if (!made.ok) {
        report(player, made, "");
        return;
    }

    bindNpc(npc, made.shop);
    tell(player, ok(`${made.shop.name} (${made.shop.id}) is a shop now.`));

    await openShopEditor(player, made.shop.id);
}
