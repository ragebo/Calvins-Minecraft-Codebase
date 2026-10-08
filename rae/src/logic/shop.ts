import { SHOP as S } from "../config/balance.js";
import { itemLabel } from "./robbery.js";

/**
 * An NPC shop, as data: what the NPC sells, buys, swaps and does, and what each deal costs. Pure rules, no game imports: nothing
 * here knows what an ItemStack or a Player is. core/shopstore.ts keeps shops in the world, core/shoptrade.ts carries a deal
 * out, and the builder edits them through the functions below.
 *
 * The one idea is a TRADE: a cost (coins, items, or both, or nothing) and one or more rewards. A reward is goods (items), coins,
 * or a SERVICE done to the customer (a potion effect, an enchantment on the item they hold, a tame mount, a teleport). So
 * everything an NPC shop does is that one shape:
 *   buy      coins for goods                   "Iron Sword for 60 coins"
 *   sell     items for coins                   "Sell Feather x3 for 8 coins"
 *   trade    items (and maybe coins) for goods "Diamond for Gold Ingot x3"
 *   gift     nothing for goods
 *   service  coins (or items) for a service    "Regeneration 3 (10s) for 20 coins"
 * so a deal is checked and carried out in one place, all or nothing, instead of a chain of separate commands that can each
 * fail on their own (a button that charges and then fails to give, or gives and forgets to charge). A deal may also require
 * the customer to be on a side (law or outlaw) or to carry a bounty.
 *
 * Every edit is immutable and answers `{ok, shop}` or `{ok: false, reason}`, the way logic/robbery.ts's edits do, and every
 * result is validated as a whole, so a shop that exists is always one that can be saved, loaded and used. `parse` never throws
 * and runs the same validation, so a damaged save is reported, never half-loaded.
 *
 * The saved form is JSON with short keys (a world property is small and every character counts); only this file knows them.
 */

export const SHOP_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

/** One kind of item and how many: what a deal asks for, or hands over. */
export interface ItemSpec {
    /** "minecraft:iron_sword". */
    readonly type: string;
    readonly amount: number;
    /** A custom name. When set, only an item with exactly this name counts as it (a cost), and the reward comes out with it. */
    readonly name?: string;
    readonly lore?: readonly string[];
    /** [enchantment id, level] pairs. A reward comes out enchanted; a cost never asks for enchantments (see `costSpec`). */
    readonly enchants?: readonly (readonly [string, number])[];
    /** A potion's [effect, delivery], which is what tells one potion from another. */
    readonly potion?: readonly [effect: string, delivery: string];
}

export interface Cost {
    readonly coins: number;
    readonly items: readonly ItemSpec[];
}

export interface ItemReward { readonly kind: "item"; readonly item: ItemSpec }
export interface CoinsReward { readonly kind: "coins"; readonly amount: number }

/** A potion effect on the customer. `amplifier` 0 is level 1. */
export interface EffectReward { readonly kind: "effect"; readonly effect: string; readonly seconds: number; readonly amplifier: number }

/** An enchantment added to the item the customer is holding. */
export interface EnchantReward { readonly kind: "enchant"; readonly enchantment: string; readonly level: number }

/** A tame animal (a horse, a mule) that appears beside the customer, theirs to ride. */
export interface MountReward { readonly kind: "mount"; readonly entity: string }

/** The customer is taken somewhere. */
export interface TeleportReward {
    readonly kind: "teleport";
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** "overworld", "nether" or "the_end". */
    readonly dimension: string;
    /** What the place is called, for the button. */
    readonly name?: string;
}

/** Something done to the customer rather than handed to them. */
export type ServiceReward = EffectReward | EnchantReward | MountReward | TeleportReward;
export type Reward = ItemReward | CoinsReward | ServiceReward;

export const isService = (reward: Reward): reward is ServiceReward => reward.kind !== "item" && reward.kind !== "coins";

export type Role = "law" | "outlaw";
export const ROLES: readonly Role[] = ["law", "outlaw"];
export const DIMENSIONS: readonly string[] = ["overworld", "nether", "the_end"];

/** Who may take a deal. Both given means both must hold. */
export interface Requirement {
    readonly role?: Role;
    /** The least bounty the customer must carry. */
    readonly bounty?: number;
}

export interface Trade {
    /** "t1", "t2"...: stable for the life of the shop and never reused, so an open screen can tell a deal changed under it. */
    readonly id: string;
    readonly cost: Cost;
    readonly rewards: readonly Reward[];
    /** Who may take it. Absent means anyone. */
    readonly requires?: Requirement;
}

export interface Shop {
    readonly version: number;
    /** A short lowercase slug, never changed: it names the world property and what the NPC carries. */
    readonly id: string;
    readonly name: string;
    /** What the NPC says above the list of deals. May be empty. */
    readonly greeting: string;
    /** The number the next trade id comes from. */
    readonly nextTrade: number;
    readonly trades: readonly Trade[];
}

/** A deal before it has an id. */
export interface NewTrade {
    readonly cost: Cost;
    readonly rewards: readonly Reward[];
    readonly requires?: Requirement;
}

export interface Fail { readonly ok: false; readonly reason: string }
export type Result<T> = { readonly ok: true; readonly value: T } | Fail;
export type Edit = { readonly ok: true; readonly shop: Shop } | Fail;
export type AddResult = { readonly ok: true; readonly shop: Shop; readonly trade: Trade } | Fail;

const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (reason: string): Fail => ({ ok: false, reason });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// ---------------------------------------------------------------------------------------------------------
// Names and ids
// ---------------------------------------------------------------------------------------------------------

const SLUG = /^[a-z][a-z0-9_]*$/;
const TRADE_ID = /^t[1-9][0-9]*$/;
const ITEM_ID = /^[a-z0-9_]+:[a-z0-9_./]+$/;
/** An id with or without a namespace: "flame", "minecraft:flame", "regeneration". */
const GAME_ID = /^[a-z0-9_]+(?::[a-z0-9_]+)?$/;
const POTION_PART = /^[A-Za-z0-9_]{1,40}$/;
const FORMAT_CODE = /§./g;

/** A name as it is stored: no colour codes (they would make the lists unreadable), single spaces, trimmed. */
export function cleanName(raw: string): string {
    return raw.replace(FORMAT_CODE, "").replace(/\s+/g, " ").trim();
}

export function whyBadId(id: string): string | undefined {
    if (id.length < 2 || id.length > S.maxIdLength) return `an id is 2 to ${S.maxIdLength} characters`;
    if (!SLUG.test(id)) return "an id is lowercase letters, digits and underscores, starting with a letter";
    return undefined;
}

export function whyBadName(name: string): string | undefined {
    if (name.length === 0) return "a name cannot be empty";
    if (name.length > S.maxNameLength) return `a name is at most ${S.maxNameLength} characters`;
    return undefined;
}

/** "Habiti the Horseman" -> "habiti_the_horseman": a legal id made from a name, or "" when the name has nothing to make one from. */
export function slugify(text: string): string {
    return text.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^[0-9_]+/, "")
        .slice(0, S.maxIdLength)
        .replace(/_+$/, "");
}

/** `base`, or `base_2`, `base_3`... whichever is not taken yet (keeping the whole id inside the length limit). */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {

    const start = base.length >= 2 ? base : "shop";

    if (!taken.has(start)) return start;

    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = `${start.slice(0, S.maxIdLength - suffix.length).replace(/_+$/, "")}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** A name as it is compared: lowercase, and runs of spaces, underscores and hyphens read as one space, so "Mule_Dealer" is "mule dealer". */
export const nameKey = (text: string): string => text.trim().toLowerCase().replace(/[\s_-]+/g, " ");

const fits = (shops: readonly Shop[]): string => shops.map((shop) => `${shop.name} (${shop.id})`).join(", ");

/**
 * The shop a builder means by the text they typed: its id first, then its name, either one the way nameKey reads it. With
 * `loose`, when neither fits, the one shop whose name (or id) starts with the text. It never picks between two: text that fits
 * more than one shop is refused and names them, so a slip cannot move or delete the wrong shop.
 */
export function findShop(shops: readonly Shop[], text: string, loose: boolean): Result<Shop> {

    const key = nameKey(text);

    if (key.length === 0) return bad("name a shop");

    const asId = shops.find((shop) => shop.id === text.trim().toLowerCase());

    if (asId) return good(asId);

    const same = shops.filter((shop) => nameKey(shop.name) === key || nameKey(shop.id) === key);
    const [first] = same;

    if (first && same.length === 1) return good(first);
    if (same.length > 1) return bad(`"${text.trim()}" fits more than one shop: ${fits(same)}. Use the id.`);

    if (loose) {
        const starts = shops.filter((shop) => nameKey(shop.name).startsWith(key) || nameKey(shop.id).startsWith(key));
        const [only] = starts;

        if (only && starts.length === 1) return good(only);
        if (starts.length > 1) return bad(`"${text.trim()}" fits more than one shop: ${fits(starts)}. Type more of the name, or the id.`);
    }

    return bad(`there is no shop "${text.trim()}" (/rae:shop_list shows them)`);
}

// ---------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------

/** Two item specs that would ask for the same thing: the same kind, name and potion. */
export function specKey(spec: ItemSpec): string {
    return `${spec.type}|${spec.name ?? ""}|${spec.potion ? spec.potion.join("/") : ""}`;
}

function validateItem(raw: unknown, what: string): Result<ItemSpec> {

    if (!isRecord(raw)) return bad(`${what} is not an item`);

    const type = raw["type"];
    const amount = raw["amount"];

    if (typeof type !== "string" || !ITEM_ID.test(type)) return bad(`${what} needs an item id like minecraft:iron_sword`);
    if (!isWhole(amount, 1, S.maxAmount)) return bad(`${what}: the amount is a whole number from 1 to ${S.maxAmount}`);

    const name = raw["name"];
    const lore = raw["lore"];
    const enchants = raw["enchants"];
    const potion = raw["potion"];

    if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > S.maxItemNameLength)) {
        return bad(`${what}: an item name is 1 to ${S.maxItemNameLength} characters`);
    }

    let loreLines: string[] | undefined;

    if (lore !== undefined) {
        if (!Array.isArray(lore) || lore.length > S.maxLoreLines || !lore.every((line) => typeof line === "string" && line.length <= S.maxLoreLength)) {
            return bad(`${what}: lore is at most ${S.maxLoreLines} lines of ${S.maxLoreLength} characters`);
        }
        if (lore.length > 0) loreLines = lore as string[];
    }

    let pairs: (readonly [string, number])[] | undefined;

    if (enchants !== undefined) {
        if (!Array.isArray(enchants) || enchants.length > S.maxEnchants) return bad(`${what}: at most ${S.maxEnchants} enchantments`);
        const read: (readonly [string, number])[] = [];
        for (const pair of enchants) {
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !GAME_ID.test(pair[0]) || !isWhole(pair[1], 1, S.maxEnchantLevel)) {
                return bad(`${what}: an enchantment is an id and a level from 1 to ${S.maxEnchantLevel}`);
            }
            read.push([pair[0], pair[1]]);
        }
        if (read.length > 0) pairs = read;
    }

    let potionKind: readonly [string, string] | undefined;

    if (potion !== undefined) {
        if (!Array.isArray(potion) || potion.length !== 2 || typeof potion[0] !== "string" || typeof potion[1] !== "string"
            || !POTION_PART.test(potion[0]) || !POTION_PART.test(potion[1])) {
            return bad(`${what}: a potion is an effect and a delivery`);
        }
        potionKind = [potion[0], potion[1]];
    }

    return good({
        type, amount,
        ...(name !== undefined ? { name } : {}),
        ...(loreLines ? { lore: loreLines } : {}),
        ...(pairs ? { enchants: pairs } : {}),
        ...(potionKind ? { potion: potionKind } : {})
    });
}

function validateCost(raw: unknown): Result<Cost> {

    if (!isRecord(raw)) return bad("a deal has no cost");

    const coins = raw["coins"];
    const items = raw["items"];

    if (!isWhole(coins, 0, S.maxCoins)) return bad(`a price is a whole number of coins from 0 to ${S.maxCoins}`);
    if (!Array.isArray(items) || items.length > S.maxCostItems) return bad(`a deal asks for at most ${S.maxCostItems} kinds of item`);

    const read: ItemSpec[] = [];
    const seen = new Set<string>();

    for (const raw of items) {
        const item = validateItem(raw, "a cost");
        if (!item.ok) return item;
        const key = specKey(item.value);
        if (seen.has(key)) return bad(`a deal asks for ${itemName(item.value)} twice: make it one amount`);
        seen.add(key);
        read.push(item.value);
    }

    return good({ coins, items: read });
}

const isCoordinate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= S.maxCoordinate;

function validateReward(raw: unknown): Result<Reward> {

    if (!isRecord(raw)) return bad("a reward is missing");

    switch (raw["kind"]) {

        case "item": {
            const item = validateItem(raw["item"], "a reward");
            return item.ok ? good({ kind: "item", item: item.value }) : item;
        }

        case "coins": {
            const amount = raw["amount"];
            return isWhole(amount, 1, S.maxCoins) ? good({ kind: "coins", amount }) : bad(`a coin reward is a whole number from 1 to ${S.maxCoins}`);
        }

        case "effect": {
            const { effect, seconds, amplifier } = raw;
            if (typeof effect !== "string" || !GAME_ID.test(effect)) return bad("an effect needs an id like regeneration");
            if (!isWhole(seconds, 1, S.maxEffectSeconds)) return bad(`an effect lasts a whole number of seconds from 1 to ${S.maxEffectSeconds}`);
            if (!isWhole(amplifier, 0, S.maxAmplifier)) return bad(`an effect's strength is a whole number from 0 (level 1) to ${S.maxAmplifier}`);
            return good({ kind: "effect", effect, seconds, amplifier });
        }

        case "enchant": {
            const { enchantment, level } = raw;
            if (typeof enchantment !== "string" || !GAME_ID.test(enchantment)) return bad("an enchantment needs an id like flame");
            if (!isWhole(level, 1, S.maxEnchantLevel)) return bad(`an enchantment level is a whole number from 1 to ${S.maxEnchantLevel}`);
            return good({ kind: "enchant", enchantment, level });
        }

        case "mount": {
            const entity = raw["entity"];
            if (typeof entity !== "string" || !ITEM_ID.test(entity)) return bad("a mount needs an animal id like minecraft:horse");
            return good({ kind: "mount", entity });
        }

        case "teleport": {
            const { x, y, z, dimension, name } = raw;
            if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(z)) return bad(`a teleport needs x, y and z within ${S.maxCoordinate} of the origin`);
            if (y < S.minTeleportY || y > S.maxTeleportY) return bad(`a teleport's height is ${S.minTeleportY} to ${S.maxTeleportY}`);
            if (typeof dimension !== "string" || !DIMENSIONS.includes(dimension)) return bad("a teleport goes to the overworld, the nether or the end");
            if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > S.maxNameLength)) return bad(`a place name is 1 to ${S.maxNameLength} characters`);
            return good({ kind: "teleport", x, y, z, dimension, ...(name !== undefined ? { name } : {}) });
        }

        default:
            return bad("a reward is an item, coins, an effect, an enchantment, a mount or a teleport");
    }
}

/** A requirement with nothing in it is no requirement: the answer is `undefined`. */
function validateRequirement(raw: unknown): Result<Requirement | undefined> {

    if (raw === undefined) return good(undefined);
    if (!isRecord(raw)) return bad("a requirement is a side and/or a bounty");

    const role = raw["role"];
    const bounty = raw["bounty"];

    if (role !== undefined && (typeof role !== "string" || !ROLES.includes(role as Role))) return bad("a deal can be for law or for outlaws");
    if (bounty !== undefined && !isWhole(bounty, 1, S.maxBounty)) return bad(`a bounty requirement is a whole number from 1 to ${S.maxBounty}`);

    if (role === undefined && bounty === undefined) return good(undefined);

    return good({ ...(role !== undefined ? { role: role as Role } : {}), ...(bounty !== undefined ? { bounty } : {}) });
}

function validateTrade(raw: unknown): Result<Trade> {

    if (!isRecord(raw)) return bad("a deal is not a deal");

    const id = raw["id"];

    if (typeof id !== "string" || !TRADE_ID.test(id)) return bad("a deal id looks like t1");

    const cost = validateCost(raw["cost"]);
    if (!cost.ok) return cost;

    const requires = validateRequirement(raw["requires"]);
    if (!requires.ok) return requires;

    const rawRewards = raw["rewards"];

    if (!Array.isArray(rawRewards) || rawRewards.length < 1 || rawRewards.length > S.maxRewards) return bad(`a deal gives 1 to ${S.maxRewards} things`);

    const rewards: Reward[] = [];

    for (const entry of rawRewards) {
        const reward = validateReward(entry);
        if (!reward.ok) return reward;
        rewards.push(reward.value);
    }

    const paysCoins = rewards.filter((r) => r.kind === "coins").length;

    if (paysCoins > 1) return bad("a deal pays coins once");
    if (paysCoins === 1 && cost.value.items.length === 0) return bad("coins are paid for items handed over: a deal cannot pay coins for nothing");
    if (paysCoins === 1 && cost.value.coins > 0) return bad("a deal does not take coins and pay coins");

    if (rewards.filter((r) => r.kind === "teleport").length > 1) return bad("a deal can teleport the customer once");
    if (rewards.filter((r) => r.kind === "mount").length > 1) return bad("a deal gives one mount");

    const effects = rewards.flatMap((r) => (r.kind === "effect" ? [r.effect] : []));
    if (new Set(effects).size !== effects.length) return bad("a deal gives each effect once");

    const enchants = rewards.flatMap((r) => (r.kind === "enchant" ? [r.enchantment] : []));
    if (new Set(enchants).size !== enchants.length) return bad("a deal gives each enchantment once");

    return good({ id, cost: cost.value, rewards, ...(requires.value ? { requires: requires.value } : {}) });
}

export function validateShop(raw: unknown): Result<Shop> {

    if (!isRecord(raw)) return bad("the saved data is not a shop");

    const { version, id, name, greeting, nextTrade } = raw;

    if (version !== SHOP_VERSION) return bad(`it was saved by a different version (${String(version)}), and this one reads ${SHOP_VERSION}`);

    if (typeof id !== "string") return bad("a shop has no id");
    const badId = whyBadId(id);
    if (badId) return bad(badId);

    if (typeof name !== "string") return bad("a shop has no name");
    const badName = whyBadName(name);
    if (badName) return bad(badName);

    if (typeof greeting !== "string" || greeting.length > S.maxGreetingLength) return bad(`a greeting is at most ${S.maxGreetingLength} characters`);

    const rawTrades = raw["trades"];

    if (!Array.isArray(rawTrades)) return bad("a shop has no list of deals");
    if (rawTrades.length > S.maxTrades) return bad(`a shop holds at most ${S.maxTrades} deals`);

    const trades: Trade[] = [];
    const seen = new Set<string>();

    for (const entry of rawTrades) {
        const trade = validateTrade(entry);
        if (!trade.ok) return trade;
        if (seen.has(trade.value.id)) return bad(`the deal id ${trade.value.id} is used twice`);
        seen.add(trade.value.id);
        trades.push(trade.value);
    }

    if (!isWhole(nextTrade, 1, 1_000_000)) return bad("the deal counter is damaged");
    if (trades.some((t) => Number(t.id.slice(1)) >= nextTrade)) return bad("the deal counter is behind a deal it has already used");

    return good({ version: SHOP_VERSION, id, name, greeting, nextTrade, trades });
}

// ---------------------------------------------------------------------------------------------------------
// The saved form (short keys). Only this section knows them.
// ---------------------------------------------------------------------------------------------------------

function storeItem(item: ItemSpec): Record<string, unknown> {
    return {
        t: item.type, a: item.amount,
        ...(item.name !== undefined ? { n: item.name } : {}),
        ...(item.lore && item.lore.length > 0 ? { l: [...item.lore] } : {}),
        ...(item.enchants && item.enchants.length > 0 ? { e: item.enchants.map((pair) => [pair[0], pair[1]]) } : {}),
        ...(item.potion ? { p: [item.potion[0], item.potion[1]] } : {})
    };
}

function readItem(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    return { type: raw["t"], amount: raw["a"], name: raw["n"], lore: raw["l"], enchants: raw["e"], potion: raw["p"] };
}

function storeReward(reward: Reward): Record<string, unknown> {

    switch (reward.kind) {
        case "item": return { i: storeItem(reward.item) };
        case "coins": return { c: reward.amount };
        case "effect": return { ef: [reward.effect, reward.seconds, reward.amplifier] };
        case "enchant": return { en: [reward.enchantment, reward.level] };
        case "mount": return { mo: reward.entity };
        case "teleport": return { tp: [reward.x, reward.y, reward.z, reward.dimension, ...(reward.name !== undefined ? [reward.name] : [])] };
    }
}

function readReward(raw: unknown): unknown {

    if (!isRecord(raw)) return raw;

    if (raw["i"] !== undefined) return { kind: "item", item: readItem(raw["i"]) };
    if (raw["c"] !== undefined) return { kind: "coins", amount: raw["c"] };

    const effect = raw["ef"];
    if (Array.isArray(effect)) return { kind: "effect", effect: effect[0], seconds: effect[1], amplifier: effect[2] };

    const enchant = raw["en"];
    if (Array.isArray(enchant)) return { kind: "enchant", enchantment: enchant[0], level: enchant[1] };

    if (raw["mo"] !== undefined) return { kind: "mount", entity: raw["mo"] };

    const teleport = raw["tp"];
    if (Array.isArray(teleport)) return { kind: "teleport", x: teleport[0], y: teleport[1], z: teleport[2], dimension: teleport[3], name: teleport[4] };

    return raw;
}

const ROLE_CODES: Record<Role, string> = { law: "l", outlaw: "o" };
const ROLE_FROM_CODE: Record<string, Role> = { l: "law", o: "outlaw" };

function storeRequirement(requires: Requirement): Record<string, unknown> {
    return { ...(requires.role !== undefined ? { r: ROLE_CODES[requires.role] } : {}), ...(requires.bounty !== undefined ? { b: requires.bounty } : {}) };
}

function readRequirement(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    const code = raw["r"];
    return { role: typeof code === "string" ? (ROLE_FROM_CODE[code] ?? code) : code, bounty: raw["b"] };
}

function storeTrade(trade: Trade): Record<string, unknown> {
    return {
        i: trade.id,
        ...(trade.cost.coins > 0 ? { c: trade.cost.coins } : {}),
        ...(trade.cost.items.length > 0 ? { ci: trade.cost.items.map(storeItem) } : {}),
        r: trade.rewards.map(storeReward),
        ...(trade.requires ? { q: storeRequirement(trade.requires) } : {})
    };
}

function readTrade(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    return {
        id: raw["i"],
        cost: { coins: raw["c"] ?? 0, items: Array.isArray(raw["ci"]) ? raw["ci"].map(readItem) : raw["ci"] ?? [] },
        rewards: Array.isArray(raw["r"]) ? raw["r"].map(readReward) : raw["r"],
        requires: raw["q"] === undefined ? undefined : readRequirement(raw["q"])
    };
}

/** The text a shop is saved as. */
export function serialize(shop: Shop): string {
    return JSON.stringify({ v: shop.version, id: shop.id, nm: shop.name, g: shop.greeting, n: shop.nextTrade, t: shop.trades.map(storeTrade) });
}

/** A saved shop, or the reason it cannot be one. Never throws. */
export function parse(text: string | undefined): Result<Shop> {

    if (text === undefined || text.length === 0) return bad("nothing is saved");

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return bad("the saved data is not valid JSON");
    }

    if (!isRecord(raw)) return bad("the saved data is not a shop");

    return validateShop({
        version: raw["v"], id: raw["id"], name: raw["nm"], greeting: raw["g"] ?? "", nextTrade: raw["n"],
        trades: Array.isArray(raw["t"]) ? raw["t"].map(readTrade) : raw["t"]
    });
}

/** A deal as one string: two deals with the same signature are the same deal, so a screen can tell one changed under it. */
export const signature = (trade: Trade): string => JSON.stringify(storeTrade(trade));

// ---------------------------------------------------------------------------------------------------------
// Matching items
// ---------------------------------------------------------------------------------------------------------

/** What an item in a bag looks like to a deal: its kind, its custom name and, for a potion, which one. */
export interface StackInfo {
    readonly type: string;
    readonly name?: string | undefined;
    readonly potion?: readonly [string, string] | undefined;
}

/** Whether this stack is what the spec asks for. Only what the spec names has to match: "3 Gold Ingot" takes any gold ingot. */
export function specMatches(spec: ItemSpec, stack: StackInfo): boolean {

    if (stack.type !== spec.type) return false;
    if (spec.name !== undefined && stack.name !== spec.name) return false;
    if (spec.potion !== undefined && (stack.potion?.[0] !== spec.potion[0] || stack.potion?.[1] !== spec.potion[1])) return false;

    return true;
}

/** What a deal asks for when it takes this item: the kind and the amount (and name and potion), never enchantments or lore. */
export function costSpec(item: ItemSpec): ItemSpec {
    return {
        type: item.type, amount: item.amount,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.potion ? { potion: item.potion } : {})
    };
}

// ---------------------------------------------------------------------------------------------------------
// Describing
// ---------------------------------------------------------------------------------------------------------

const titled = (text: string): string => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const words = (camel: string): string => camel.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

/** "minecraft:jump_boost" -> "Jump Boost": a game id as a name, for a button or a message. */
export const gameName = (id: string): string => titled(id.replace(/^[a-z0-9_]+:/, "").replace(/_/g, " "));

/** "Iron Sword", "Splash Potion of Swiftness", or the custom name an item was given. */
export function itemName(spec: ItemSpec): string {

    if (spec.name !== undefined) return spec.name.replace(FORMAT_CODE, "");

    const base = titled(itemLabel(spec.type));

    return spec.potion ? `${base} of ${words(spec.potion[0])}` : base;
}

/** "Iron Sword", or "Arrow x6". */
export const describeItem = (spec: ItemSpec): string => (spec.amount > 1 ? `${itemName(spec)} x${spec.amount}` : itemName(spec));

export const coinsText = (n: number): string => `${n} coin${n === 1 ? "" : "s"}`;

/** "60 coins", "Gold Ingot x3", "Gold Ingot x3 + 10 coins", or "nothing". */
export function describeCost(cost: Cost): string {

    const parts = [...cost.items.map(describeItem), ...(cost.coins > 0 ? [coinsText(cost.coins)] : [])];

    return parts.length === 0 ? "nothing" : parts.join(" + ");
}

/** "Iron Sword", "8 coins", "Regeneration 3 (10s)", "Flame 1 on the item you hold", "Tame Horse", "Teleport to Saint Diego". */
export function describeReward(reward: Reward): string {

    switch (reward.kind) {
        case "item": return describeItem(reward.item);
        case "coins": return coinsText(reward.amount);
        case "effect": return `${gameName(reward.effect)} ${reward.amplifier + 1} (${reward.seconds}s)`;
        case "enchant": return `${gameName(reward.enchantment)} ${reward.level} on the item you hold`;
        case "mount": return `Tame ${gameName(reward.entity)}`;
        case "teleport": return `Teleport to ${reward.name ?? `${Math.round(reward.x)}, ${Math.round(reward.y)}, ${Math.round(reward.z)}`}`;
    }
}

export const describeRewards = (rewards: readonly Reward[]): string => rewards.map(describeReward).join(" + ");

/** "law only", "outlaw only, bounty 100+", "bounty 50+". */
export function describeRequirement(requires: Requirement): string {

    const parts = [
        ...(requires.role !== undefined ? [`${requires.role} only`] : []),
        ...(requires.bounty !== undefined ? [`bounty ${requires.bounty}+`] : [])
    ];

    return parts.join(", ");
}

export type Face = "buy" | "sell" | "trade" | "gift" | "service";

/** Which of the familiar shapes a deal has. */
export function faceOf(trade: Trade): Face {

    if (trade.rewards.some(isService)) return "service";

    const itemsIn = trade.cost.items.length > 0;
    const paysCoins = trade.rewards.some((r) => r.kind === "coins");

    if (!itemsIn && trade.cost.coins === 0) return "gift";
    if (itemsIn && paysCoins) return "sell";
    if (!itemsIn) return "buy";

    return "trade";
}

const isFree = (trade: Trade): boolean => trade.cost.items.length === 0 && trade.cost.coins === 0;

/**
 * A deal in one plain line: "Iron Sword for 60 coins", "Sell Feather x3 for 8 coins", "Diamond for Gold Ingot x3",
 * "Regeneration 3 (10s) for 20 coins (law only)".
 */
export function describeTrade(trade: Trade): string {

    let text: string;

    if (isFree(trade)) text = `Free: ${describeRewards(trade.rewards)}`;
    else if (faceOf(trade) === "sell") text = `Sell ${describeCost(trade.cost)} for ${describeRewards(trade.rewards)}`;
    else text = `${describeRewards(trade.rewards)} for ${describeCost(trade.cost)}`;

    return trade.requires ? `${text} (${describeRequirement(trade.requires)})` : text;
}

/** What to tell a player after a deal went through: "Bought Iron Sword for 60 coins.", "Sold Feather x3 for 8 coins.". */
export function describeDone(trade: Trade): string {

    const face = faceOf(trade);

    if (isFree(trade)) return `Took ${describeRewards(trade.rewards)}.`;
    if (face === "sell") return `Sold ${describeCost(trade.cost)} for ${describeRewards(trade.rewards)}.`;
    if (face === "trade") return `Traded ${describeCost(trade.cost)} for ${describeRewards(trade.rewards)}.`;

    return `Bought ${describeRewards(trade.rewards)} for ${describeCost(trade.cost)}.`;
}

/** A shop, for a list or an info screen. */
export function describeShop(shop: Shop): string[] {

    const lines = [`${shop.name} (${shop.id}): ${shop.trades.length === 0 ? "no deals yet" : `${shop.trades.length} deal${shop.trades.length === 1 ? "" : "s"}`}`];

    if (shop.greeting.length > 0) lines.push(`Greeting: ${shop.greeting}`);

    for (const trade of shop.trades) lines.push(`  ${trade.id}  ${describeTrade(trade)}`);

    return lines;
}

// ---------------------------------------------------------------------------------------------------------
// Looking things up
// ---------------------------------------------------------------------------------------------------------

export const findTrade = (shop: Shop, id: string): Trade | undefined => shop.trades.find((t) => t.id === id);

// ---------------------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------------------

function checked(candidate: Shop): Edit {
    const result = validateShop(candidate);
    return result.ok ? { ok: true, shop: result.value } : result;
}

export function newShop(id: string, name: string): Edit {

    const badId = whyBadId(id);
    if (badId) return bad(badId);

    const clean = cleanName(name);
    const badName = whyBadName(clean);
    if (badName) return bad(badName);

    return checked({ version: SHOP_VERSION, id, name: clean, greeting: "", nextTrade: 1, trades: [] });
}

export function renameShop(shop: Shop, name: string): Edit {

    const clean = cleanName(name);
    const badName = whyBadName(clean);

    return badName ? bad(badName) : checked({ ...shop, name: clean });
}

/** The greeting is kept as typed (colour codes allowed, it is the NPC's own voice) apart from the ends being trimmed. */
export function setGreeting(shop: Shop, text: string): Edit {
    return checked({ ...shop, greeting: text.trim() });
}

export function addTrade(shop: Shop, deal: NewTrade): AddResult {

    const trade: Trade = { id: `t${shop.nextTrade}`, cost: deal.cost, rewards: deal.rewards, ...(deal.requires ? { requires: deal.requires } : {}) };
    const result = checked({ ...shop, nextTrade: shop.nextTrade + 1, trades: [...shop.trades, trade] });

    if (!result.ok) return result;

    return { ok: true, shop: result.shop, trade: findTrade(result.shop, trade.id) ?? trade };
}

/**
 * Changes a deal's cost, its rewards or who may take it. A patch that names `requires` sets it, and one that names it as
 * `undefined` clears it; a patch that leaves it out keeps what was there.
 */
export function updateTrade(shop: Shop, id: string, patch: Partial<NewTrade>): Edit {

    const old = findTrade(shop, id);
    if (!old) return bad(`there is no deal ${id}`);

    const requires = "requires" in patch ? patch.requires : old.requires;
    const next: Trade = { id, cost: patch.cost ?? old.cost, rewards: patch.rewards ?? old.rewards, ...(requires ? { requires } : {}) };

    return checked({ ...shop, trades: shop.trades.map((t) => (t.id === id ? next : t)) });
}

export function removeTrade(shop: Shop, id: string): Edit {

    if (!findTrade(shop, id)) return bad(`there is no deal ${id}`);

    return checked({ ...shop, trades: shop.trades.filter((t) => t.id !== id) });
}

/** Moves a deal up (-1) or down (+1) the list. At the end of the list it stays where it is. */
export function moveTrade(shop: Shop, id: string, by: -1 | 1): Edit {

    const from = shop.trades.findIndex((t) => t.id === id);
    if (from === -1) return bad(`there is no deal ${id}`);

    const to = from + by;
    if (to < 0 || to >= shop.trades.length) return { ok: true, shop };

    const trades = [...shop.trades];
    const [moved] = trades.splice(from, 1);
    trades.splice(to, 0, moved!);

    return checked({ ...shop, trades });
}

/** The same deals under a new identity: a second NPC that sells the same things. */
export function copyShop(source: Shop, id: string, name: string): Edit {

    const made = newShop(id, name);
    if (!made.ok) return made;

    return checked({ ...made.shop, greeting: source.greeting, nextTrade: source.nextTrade, trades: source.trades });
}

// ---------------------------------------------------------------------------------------------------------
// Making a deal from what a builder holds, or from what they ask for
// ---------------------------------------------------------------------------------------------------------

/** The coins in a deal: what a player pays (buy, trade, gift, service) or gets (sell). */
export function priceOf(trade: Trade): number {
    const payout = trade.rewards.find((r) => r.kind === "coins");
    return payout && payout.kind === "coins" ? payout.amount : trade.cost.coins;
}

/** The change that gives a deal a new price, to hand to `updateTrade`. */
export function withPrice(trade: Trade, coins: number): Partial<NewTrade> {

    if (trade.rewards.some((r) => r.kind === "coins")) {
        return { rewards: trade.rewards.map((r): Reward => (r.kind === "coins" ? { kind: "coins", amount: coins } : r)) };
    }

    return { cost: { ...trade.cost, coins } };
}

/** The NPC sells `goods` for `coins`. */
export const buyDeal = (goods: ItemSpec, coins: number): NewTrade => ({ cost: { coins, items: [] }, rewards: [{ kind: "item", item: goods }] });

/** The NPC buys `items` for `coins`. */
export const sellDeal = (items: ItemSpec, coins: number): NewTrade => ({ cost: { coins: 0, items: [costSpec(items)] }, rewards: [{ kind: "coins", amount: coins }] });

/** The NPC hands over `goods` for `give` (and `coins` besides, if any). */
export const swapDeal = (goods: ItemSpec, give: readonly ItemSpec[], coins = 0): NewTrade => ({ cost: { coins, items: give.map(costSpec) }, rewards: [{ kind: "item", item: goods }] });

/** A potion effect on the customer for `coins`. */
export const effectDeal = (effect: string, seconds: number, amplifier: number, coins: number): NewTrade =>
    ({ cost: { coins, items: [] }, rewards: [{ kind: "effect", effect, seconds, amplifier }] });

/** An enchantment on the item the customer holds, for `coins`. */
export const enchantDeal = (enchantment: string, level: number, coins: number): NewTrade =>
    ({ cost: { coins, items: [] }, rewards: [{ kind: "enchant", enchantment, level }] });

/** A tame mount for `coins`. */
export const mountDeal = (entity: string, coins: number): NewTrade =>
    ({ cost: { coins, items: [] }, rewards: [{ kind: "mount", entity }] });

/** A trip to `to` for `coins`. */
export const teleportDeal = (to: Omit<TeleportReward, "kind">, coins: number): NewTrade =>
    ({ cost: { coins, items: [] }, rewards: [{ kind: "teleport", ...to }] });

// ---------------------------------------------------------------------------------------------------------
// Where a teleport goes
// ---------------------------------------------------------------------------------------------------------

/** A place in the world: where a teleport sends a customer, and where a shop's NPC was last seen. */
export interface Destination {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** "overworld", "nether" or "the_end". */
    readonly dimension: string;
}

/** A coordinate as it is kept: to a hundredth of a block, which is finer than anyone can stand. */
export const toHundredth = (n: number): number => Math.round(n * 100) / 100;

const DIMENSION_WORDS: Readonly<Record<string, string>> = { overworld: "the overworld", nether: "the nether", the_end: "the end" };

/** "-251.5, 63, 186.5 in the overworld". */
export const describeDestination = (to: Destination): string => `${to.x}, ${to.y}, ${to.z} in ${DIMENSION_WORDS[to.dimension] ?? to.dimension}`;

/** What one of a form's number boxes may hold: a plain number, with a minus sign and decimals when it needs them. */
const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

/**
 * A destination from what a builder typed into a form's three boxes. Decimals are fine (kept to a hundredth of a block). A blank,
 * a word, a height the world does not have, or a place beyond the world border is refused with a sentence that says which box
 * and what it may hold.
 */
export function readDestination(typed: { readonly x: string; readonly y: string; readonly z: string }, dimension: string): Result<Destination> {

    const numbers: number[] = [];

    for (const [axis, raw] of [["X", typed.x], ["Y", typed.y], ["Z", typed.z]] as const) {
        const text = raw.trim();
        if (!PLAIN_NUMBER.test(text)) return bad(`${axis} is a number like -251.5 (${text.length > 0 ? `you typed "${text}"` : "it is blank"})`);
        numbers.push(toHundredth(Number(text)));
    }

    const [x, y, z] = numbers as [number, number, number];

    if (Math.abs(x) > S.maxCoordinate || Math.abs(z) > S.maxCoordinate) return bad(`X and Z stay within ${S.maxCoordinate} blocks of the origin`);
    if (y < S.minTeleportY || y > S.maxTeleportY) return bad(`Y is a height from ${S.minTeleportY} to ${S.maxTeleportY} (you typed ${y})`);
    if (!DIMENSIONS.includes(dimension)) return bad("a teleport goes to the overworld, the nether or the end");

    return good({ x, y, z, dimension });
}

/** The teleport a deal carries, if it carries one. */
export const teleportOf = (trade: Trade): TeleportReward | undefined =>
    trade.rewards.find((reward): reward is TeleportReward => reward.kind === "teleport");

/**
 * A deal's rewards with its teleport sent to `to` instead. `name` is what the place is called from now on; an empty one takes
 * the name off, so the button reads the coordinates.
 */
export function retarget(trade: Trade, to: Destination, name: string): Result<readonly Reward[]> {

    if (!teleportOf(trade)) return bad("that deal does not teleport anyone");

    const place = cleanName(name);

    return good(trade.rewards.map((reward): Reward =>
        reward.kind === "teleport"
            ? { kind: "teleport", x: to.x, y: to.y, z: to.z, dimension: to.dimension, ...(place.length > 0 ? { name: place } : {}) }
            : reward));
}

/** Why a shop is not worth showing yet, or undefined when it is. */
export const whyNotOpen = (shop: Shop): string | undefined => (shop.trades.length === 0 ? "it has nothing to sell, buy or trade yet" : undefined);
