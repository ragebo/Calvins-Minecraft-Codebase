import { ROBBERY as R } from "../config/balance.js";
import { bareId, classOfBlockType, swingsOpen, type BlockClass } from "./blockclass.js";
import {
    AUDIENCES, CHANNELS, SETTING_KEYS, isFlagSetting, itemLabel, kindLabel,
    type Audience, type Channel, type Effect, type EffectKind, type Element, type ElementKind, type Lock, type LockKind, type Result,
    type Robbery, type SettingKey, type Settings
} from "./robbery.js";

/**
 * What the builder's forms are made of, as data. A form is a list of fields, each with a key, a label and its current
 * value; the same list builds the form and reads its answers back, and the answers go straight into the validators in
 * logic/robbery.ts (validateLock, validateEffect, setSettings), which are the only judges of what is allowed. So this file
 * knows how to ask and how to read, never what is valid, and none of it touches the game: core/robberyforms.ts turns a field
 * list into a ModalFormData and hands back the values.
 *
 * Forms here use only text boxes, toggles, drop-downs and sliders, never a label or divider control, so the answers line up
 * with the fields one for one: a label control takes a slot in the answers too, and which slot is the sort of thing that is
 * only learned in the real game.
 *
 * Also here: the plain-language summaries the builder reads (a lock, an effect, an element, a robbery), because a builder
 * who cannot read what they built cannot trust it.
 */

// ---------------------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------------------

export interface Choice {
    readonly value: string;
    readonly label: string;
}

export type Field =
    | { readonly kind: "text"; readonly key: string; readonly label: string; readonly placeholder: string; readonly value: string }
    /** A whole number typed into a text box; the answer is checked against min and max. `what` names it in an error. */
    | { readonly kind: "number"; readonly key: string; readonly label: string; readonly what: string; readonly min: number; readonly max: number; readonly value: number }
    | { readonly kind: "toggle"; readonly key: string; readonly label: string; readonly value: boolean }
    | { readonly kind: "choice"; readonly key: string; readonly label: string; readonly options: readonly Choice[]; readonly value: string }
    | { readonly kind: "slider"; readonly key: string; readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly value: number };

export type Answers = Readonly<Record<string, string | number | boolean>>;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (reason: string): Result<never> => ({ ok: false, reason });

/** "12" -> 12. Nothing else: no decimals, no signs, no trailing words. */
export function wholeNumber(text: string, what: string, min: number, max: number): Result<number> {

    const trimmed = text.trim();

    if (!/^\d+$/.test(trimmed)) return bad(`${what} must be a whole number from ${min} to ${max}`);

    const value = Number(trimmed);

    if (value < min || value > max) return bad(`${what} must be a whole number from ${min} to ${max}`);

    return ok(value);
}

/**
 * Reads a submitted form back into answers by key. Anything missing or of the wrong sort is refused with a sentence the
 * builder can act on, never silently turned into a default.
 */
export function readAnswers(fields: readonly Field[], values: readonly unknown[] | undefined): Result<Answers> {

    if (!values || values.length < fields.length) return bad("the form came back incomplete");

    const answers: Record<string, string | number | boolean> = {};

    for (let i = 0; i < fields.length; i++) {

        const field = fields[i]!;
        const raw = values[i];

        if (field.kind === "text") {
            answers[field.key] = typeof raw === "string" ? raw.trim() : "";
            continue;
        }

        if (field.kind === "number") {
            const number = wholeNumber(typeof raw === "string" ? raw : String(raw ?? ""), field.what, field.min, field.max);
            if (!number.ok) return number;
            answers[field.key] = number.value;
            continue;
        }

        if (field.kind === "toggle") {
            answers[field.key] = raw === true;
            continue;
        }

        if (field.kind === "slider") {
            if (typeof raw !== "number" || !Number.isFinite(raw)) return bad(`${field.label} came back as something that is not a number`);
            answers[field.key] = Math.round(raw);
            continue;
        }

        // A choice arrives as the index of the option picked.
        const option = typeof raw === "number" ? field.options[raw] : undefined;
        if (!option) return bad(`${field.label} came back with nothing picked`);
        answers[field.key] = option.value;
    }

    return ok(answers);
}

// ---------------------------------------------------------------------------------------------------------
// The choices
// ---------------------------------------------------------------------------------------------------------

const AUDIENCE_LABELS: Record<Audience, string> = {
    actor: "The player who did it",
    area: "Everyone in the area",
    outlaws: "All outlaws",
    law: "All law",
    all: "Everyone"
};

const CHANNEL_LABELS: Record<Channel, string> = { chat: "Chat", bar: "Action bar", title: "Big title" };

export const AUDIENCE_CHOICES: readonly Choice[] = AUDIENCES.map((value) => ({ value, label: AUDIENCE_LABELS[value] }));
export const CHANNEL_CHOICES: readonly Choice[] = CHANNELS.map((value) => ({ value, label: CHANNEL_LABELS[value] }));
export const RESULT_CHOICES: readonly Choice[] = [{ value: "win", label: "The robbery is won" }, { value: "fail", label: "The robbery fails" }];

export const LOCK_LABELS: Record<LockKind, string> = { pick: "Pick lock", key: "Key", pay: "Price" };
export const EFFECT_LABELS: Record<EffectKind, string> = { say: "Say something", reward: "Pay out", end: "End the robbery" };

// ---------------------------------------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------------------------------------

/** What a lock of this kind starts as when the builder adds one. */
export function defaultLock(kind: LockKind): Lock {

    if (kind === "pick") return { kind: "pick", hits: R.pickHits, tolerance: R.pickTolerance, strikes: R.pickStrikes, jamSeconds: R.pickJamSeconds };
    if (kind === "key") return { kind: "key", item: "", consume: true };

    return { kind: "pay", coins: 25 };
}

export function lockFields(kind: LockKind, current?: Lock): Field[] {

    const lock = current?.kind === kind ? current : defaultLock(kind);

    if (lock.kind === "pick") {
        return [
            { kind: "slider", key: "hits", label: "Correct picks needed", min: 1, max: R.maxPickHits, step: 1, value: lock.hits },
            { kind: "slider", key: "tolerance", label: "How close a guess must be (+/-)", min: 1, max: Math.floor(R.pickSliderMax / 2), step: 1, value: lock.tolerance },
            { kind: "slider", key: "strikes", label: "Misses in a row that jam it (0 = never)", min: 0, max: R.maxPickStrikes, step: 1, value: lock.strikes },
            { kind: "number", key: "jamSeconds", label: "Seconds a jam lasts", what: "the jam time", min: 0, max: R.maxPickJamSeconds, value: lock.jamSeconds }
        ];
    }

    if (lock.kind === "key") {
        return [
            { kind: "text", key: "item", label: "The item that opens it", placeholder: "minecraft:iron_pickaxe", value: lock.item },
            { kind: "toggle", key: "consume", label: "Used up when it opens", value: lock.consume }
        ];
    }

    return [{ kind: "number", key: "coins", label: "Price in coins", what: "the price", min: 1, max: R.maxPayCoins, value: lock.coins }];
}

/** The answers of a lock form as the untyped shape validateLock takes. */
export function lockFromAnswers(kind: LockKind, answers: Answers): unknown {

    if (kind === "pick") return { kind, hits: answers["hits"], tolerance: answers["tolerance"], strikes: answers["strikes"], jamSeconds: answers["jamSeconds"] };
    if (kind === "key") return { kind, item: answers["item"], consume: answers["consume"] };

    return { kind, coins: answers["coins"] };
}

export function describeLock(lock: Lock): string {

    if (lock.kind === "pick") {
        const jam = lock.strikes > 0 ? `jams after ${lock.strikes} misses for ${lock.jamSeconds}s` : "never jams";
        return `Pick lock: ${lock.hits} correct pick${lock.hits === 1 ? "" : "s"} (+/-${lock.tolerance}), ${jam}`;
    }

    if (lock.kind === "key") return `Key: ${itemLabel(lock.item)}${lock.consume ? " (used up)" : ""}`;

    return `Price: ${lock.coins} coins`;
}

// ---------------------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------------------

export function defaultEffect(kind: EffectKind): Effect {

    if (kind === "say") return { kind: "say", text: "", channel: "chat", to: "area" };
    if (kind === "reward") return { kind: "reward", coins: 100, bounty: 0, to: "area" };

    return { kind: "end", result: "win" };
}

export function effectFields(kind: EffectKind, current?: Effect): Field[] {

    const effect = current?.kind === kind ? current : defaultEffect(kind);
    const delay: Field = { kind: "number", key: "delaySeconds", label: "Seconds to wait first (0 = at once)", what: "the delay", min: 0, max: R.maxDelaySeconds, value: effect.delaySeconds ?? 0 };

    if (effect.kind === "say") {
        return [
            { kind: "text", key: "text", label: "What it says", placeholder: "Alarm! The vault is being robbed!", value: effect.text },
            { kind: "choice", key: "channel", label: "Where it shows", options: CHANNEL_CHOICES, value: effect.channel },
            { kind: "choice", key: "to", label: "Who sees it", options: AUDIENCE_CHOICES, value: effect.to },
            { kind: "text", key: "sound", label: "A sound with it (optional)", placeholder: "random.levelup", value: effect.sound ?? "" },
            delay
        ];
    }

    if (effect.kind === "reward") {
        return [
            { kind: "number", key: "coins", label: "Coins", what: "the coins", min: 0, max: R.maxRewardAmount, value: effect.coins },
            { kind: "number", key: "bounty", label: "Bounty added to them", what: "the bounty", min: 0, max: R.maxRewardAmount, value: effect.bounty },
            { kind: "choice", key: "to", label: "Who gets it", options: AUDIENCE_CHOICES, value: effect.to },
            delay
        ];
    }

    return [{ kind: "choice", key: "result", label: "How it ends", options: RESULT_CHOICES, value: effect.result }, delay];
}

/** The answers of an effect form as the untyped shape validateEffect takes. */
export function effectFromAnswers(kind: EffectKind, answers: Answers): unknown {

    const delay = { delaySeconds: answers["delaySeconds"] };

    if (kind === "say") {
        const sound = answers["sound"];
        return { kind, text: answers["text"], channel: answers["channel"], to: answers["to"], ...(typeof sound === "string" && sound.length > 0 ? { sound } : {}), ...delay };
    }

    if (kind === "reward") return { kind, coins: answers["coins"], bounty: answers["bounty"], to: answers["to"], ...delay };

    return { kind, result: answers["result"], ...delay };
}

export function describeEffect(effect: Effect): string {

    const wait = effect.delaySeconds !== undefined && effect.delaySeconds > 0 ? ` after ${effect.delaySeconds}s` : "";

    if (effect.kind === "say") {
        const clipped = effect.text.length > 40 ? `${effect.text.slice(0, 37)}...` : effect.text;
        return `Say "${clipped}" to ${AUDIENCE_LABELS[effect.to].toLowerCase()} (${CHANNEL_LABELS[effect.channel].toLowerCase()})${wait}`;
    }

    if (effect.kind === "reward") {
        const parts = [effect.coins > 0 ? `${effect.coins} coins` : "", effect.bounty > 0 ? `${effect.bounty} bounty` : ""].filter((p) => p.length > 0);
        return `Pay ${parts.join(" and ")} to ${AUDIENCE_LABELS[effect.to].toLowerCase()}${wait}`;
    }

    return `End: ${effect.result === "win" ? "won" : "failed"}${wait}`;
}

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

export function settingsFields(settings: Settings): Field[] {

    const seconds = (key: SettingKey, label: string, what: string): Field => ({ kind: "number", key, label, what, min: 0, max: R.maxSettingSeconds, value: settings[key] as number });

    return [
        { kind: "toggle", key: "autoStart", label: "Starts when a player touches the first element", value: settings.autoStart },
        { kind: "toggle", key: "exclusive", label: "Only one event at a time (fort, ranch, train)", value: settings.exclusive },
        { kind: "toggle", key: "roundOnly", label: "Only during a round", value: settings.roundOnly },
        { kind: "toggle", key: "protect", label: "Its blocks cannot be broken or blown up", value: settings.protect },
        { kind: "toggle", key: "outlawsOnly", label: "Only outlaws can take part", value: settings.outlawsOnly },
        seconds("cooldownSeconds", "Seconds before it can be robbed again", "the cooldown"),
        seconds("timeLimitSeconds", "Time limit in seconds (0 = none)", "the time limit"),
        seconds("resetAfterSeconds", "Seconds after it ends until the site is put back", "the reset time"),
        seconds("failWhenEmptySeconds", "Fails if nobody is in the area this long (0 = never)", "the empty-area time")
    ];
}

/** The answers of the settings form as a patch for setSettings. */
export function settingsFromAnswers(answers: Answers): Partial<Settings> {

    const patch: Record<string, string | number | boolean> = {};

    for (const key of SETTING_KEYS) {
        const value = answers[key];
        if (value !== undefined) patch[key] = value;
    }

    return patch as Partial<Settings>;
}

const FLAG_WORDS = new Map<string, boolean>([["on", true], ["off", false], ["true", true], ["false", false], ["yes", true], ["no", false], ["1", true], ["0", false]]);

/** What a /rae:robbery_set value means for a setting: on or off for a flag, a whole number of seconds for the rest. */
export function parseSettingValue(key: SettingKey, text: string): Result<boolean | number> {

    const word = text.trim().toLowerCase();

    if (isFlagSetting(key)) {
        const flag = FLAG_WORDS.get(word);
        return flag === undefined ? bad(`${key} is on or off`) : ok(flag);
    }

    return wholeNumber(word, key, 0, R.maxSettingSeconds);
}

// ---------------------------------------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------------------------------------

/** "minecraft:diamond 2, minecraft:emerald" -> [["minecraft:diamond", 2], ["minecraft:emerald", 1]]. */
export function parseItemList(text: string): Result<(readonly [string, number])[]> {

    const items: (readonly [string, number])[] = [];

    for (const part of text.split(/[,\n]/).map((p) => p.trim()).filter((p) => p.length > 0)) {

        const [id, amount, ...rest] = part.split(/\s+/);

        if (rest.length > 0) return bad(`"${part}": write an item and an amount, like minecraft:diamond 2`);

        const count = amount === undefined ? ok(1) : wholeNumber(amount, `the amount for ${id}`, 1, 64);
        if (!count.ok) return count;

        items.push([id!, count.value]);
    }

    return ok(items);
}

export function formatItemList(items: readonly (readonly [string, number])[]): string {
    return items.map(([id, amount]) => (amount === 1 ? id : `${id} ${amount}`)).join(", ");
}

// ---------------------------------------------------------------------------------------------------------
// Which blocks can be what
// ---------------------------------------------------------------------------------------------------------

/** What a block most likely is meant to be, for the first choice in the add form. */
export function suggestKind(blockClass: BlockClass): ElementKind {

    if (swingsOpen(blockClass)) return "door";
    if (blockClass === "container") return "chest";

    return "switch";
}

/** Chests whose contents a script can fill (an ender chest, a hopper or a furnace are not loot boxes). */
function isLootContainer(typeId: string): boolean {
    const id = bareId(typeId);
    return id === "chest" || id === "trapped_chest" || id === "barrel" || id === "shulker_box" || id.endsWith("_shulker_box");
}

/** Why a block cannot be an element of this kind, or undefined when it can. */
export function whyBlockCannotBe(kind: ElementKind, typeId: string): string | undefined {

    const name = itemLabel(typeId);

    if (typeId === "minecraft:air" || bareId(typeId) === "air") return "there is no block there";

    if (kind === "door" && !swingsOpen(classOfBlockType(typeId))) {
        return `${name} does not open and close: a ${kindLabel("door")} element needs a door, trapdoor or fence gate`;
    }

    if (kind === "chest" && !isLootContainer(typeId)) {
        return `${name} cannot hold loot: a ${kindLabel("chest")} element needs a chest, trapped chest, barrel or shulker box`;
    }

    return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Reading a robbery
// ---------------------------------------------------------------------------------------------------------

const KIND_NOUNS: Record<ElementKind, string> = { door: "door", chest: "chest", switch: "switch" };

export const nounOf = (kind: ElementKind): string => KIND_NOUNS[kind];

const place = (cell: readonly number[]): string => `${cell[0]}, ${cell[1]}, ${cell[2]}`;

/** The lines the element screen shows. `needs` are the names of what it waits on. */
export function describeElement(robbery: Robbery, element: Element): string[] {

    const needs = element.req.map((id) => robbery.elements.find((e) => e.id === id)?.name ?? id);
    const lines = [
        `§l${element.name}§r §7(${nounOf(element.kind)}, ${element.id})`,
        `§7At: §f${element.cells.map(place).join("  |  ")}`,
        `§7Locked by: §f${element.locks.length > 0 ? element.locks.map(describeLock).join("; ") : "nothing"}`,
        `§7Waits for: §f${needs.length > 0 ? needs.join(", ") : "nothing (it can start the robbery)"}`
    ];

    if (element.kind === "chest") {
        const loot = [element.table !== undefined ? `table ${element.table}` : "", element.items.length > 0 ? formatItemList(element.items) : ""].filter((p) => p.length > 0);
        lines.push(`§7Loot: §f${loot.length > 0 ? loot.join(" + ") : "none"}`);
    }

    lines.push(`§7When done: §f${element.onDone.length} effect${element.onDone.length === 1 ? "" : "s"}`);

    if (element.locks.some((lock) => lock.kind === "pick")) lines.push(`§7When jammed: §f${element.onFail.length} effect${element.onFail.length === 1 ? "" : "s"}`);

    return lines;
}

const YES_NO = (on: boolean): string => (on ? "on" : "off");

export function describeSettings(settings: Settings): string[] {
    return [
        `Starts by touch: ${YES_NO(settings.autoStart)}   One event at a time: ${YES_NO(settings.exclusive)}   Round only: ${YES_NO(settings.roundOnly)}`,
        `Blocks protected: ${YES_NO(settings.protect)}   Outlaws only: ${YES_NO(settings.outlawsOnly)}`,
        `Cooldown ${settings.cooldownSeconds}s   Time limit ${settings.timeLimitSeconds}s   Reset after ${settings.resetAfterSeconds}s   Empty-area fail ${settings.failWhenEmptySeconds}s`
    ];
}

/** The lines the main menu shows about a robbery. `problems` is what logic/robbery.ts's whyNotRunnable said. */
export function describeRobbery(robbery: Robbery, problems: readonly string[]): string[] {

    const area = robbery.area ? `${place(robbery.area.min)} to ${place(robbery.area.max)}` : "not set";

    return [
        `§l${robbery.name}§r §7(${robbery.id}, ${robbery.dimension})`,
        `§7Elements: §f${robbery.elements.length}   §7Area: §f${area}`,
        ...describeSettings(robbery.settings).map((line) => `§7${line}`),
        problems.length === 0 ? "§aReady to run." : `§eNot ready: §f${problems.join("; ")}`
    ];
}
