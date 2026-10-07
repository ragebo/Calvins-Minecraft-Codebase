import type { Entity, Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { SHOP as S } from "../config/balance.js";
import {
    describeItem, describeShop, describeTrade, faceOf, findTrade, moveTrade, priceOf, removeTrade, renameShop, setGreeting,
    signature, updateTrade, whyNotOpen, withPrice, type Shop, type Trade
} from "../logic/shop.js";
import { getCoins } from "./economy.js";
import { confirmForm, showForm } from "./forms.js";
import { error } from "./log.js";
import { BACK, createScreens, type Action, type Screen } from "./screens.js";
import {
    addHeldDeal, addSwapDeal, applyEdit, bagChoices, copyShopAs, createShop, select, selectedId, type HeldKind, type Outcome
} from "./shopedit.js";
import { bindNpc, npcsOf, placeNpcFor, retireNpcs, spawnShopNpc } from "./shopnpc.js";
import { deleteShop, getShop, listStored, undoAvailable, undoLast } from "./shopstore.js";
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

    const count = npcsOf(shopId).length;

    return `§7NPC: §f${count === 0 ? "none found loaded (place one)" : count === 1 ? "placed" : `${count} placed`}`;
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
        { label: npcsOf(shopId).length > 0 ? "Bring its NPC here" : "Place its NPC here", run: () => placeHere(player, shopId) },
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

        const actions: Action[] = [
            { label: "Change the price", run: () => priceForm(player, shopId, tradeId) },
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

        return { title: heading(shop.name, trade.id), body: describeTrade(trade), actions };
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
            BACK
        ];

        const body = "Hold the item in your hand first.\n§7SELLS: players pay coins and get what you hold (all of the stack).\nBUYS: players hand over what you hold and get coins.\nTRADE: players hand over another item from your bag, maybe with coins, for what you hold.";

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
    tell(player, ok(`Made ${copy.shop.name} (${copy.shop.id}) with the same deals, and put its NPC in front of you. /rae:shop_edit opens it.`));
}

function placeHere(player: Player, shopId: string): void {

    const shop = getShop(shopId);
    if (!shop) return;

    tell(player, ok(placeNpcFor(player, shop) === "moved" ? "The NPC is here." : `Made a new NPC for ${shop.name} in front of you.`));
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
