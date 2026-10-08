import { system, type Container, type ItemStack, type Player, type Vector3 } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { ROBBERY as R } from "../config/balance.js";
import { FRESH_PICK, pickStep, type PickCurve, type PickParams, type PickState } from "../logic/lockpick.js";
import { briefly, sentence } from "../logic/robberymeta.js";
import {
    boxContains, findElement, itemLabel, sameDimension, whyNotRunnable,
    type Audience, type Effect, type Element, type Lock, type LootElement, type PickLock, type Pos, type RewardEffect, type Robbery, type SayEffect
} from "../logic/robbery.js";
import { activeEvent, finishEvent, registerEvent, requestEvent } from "./director.js";
import { addBounty, addCoins, getCoins, takeCoins } from "./economy.js";
import { showForm } from "./forms.js";
import { debug, error, warn } from "./log.js";
import { aliveOutlaws, alivePlayers, isOperator, lawPlayers, players } from "./players.js";
import { registerSystem } from "./registry.js";
import { clearDirty, dirtyCount, dirtyEntries, getRobbery, markDirty, robberyIsDirty, type Bound, type Dirty } from "./robberystore.js";
import { dimensionOf, dropItems, emptyChest, emptyFrame, fillChest, isLoaded, lootStacks, removeItemsNear, restoreFrame, setDoor } from "./robberyworld.js";
import { isPhase } from "./round.js";
import { playAtPoint, playFor } from "./sound.js";
import { recordOf } from "./state.js";
import { onTick, type TickContext } from "./tick.js";
import { ACTION_BAR_PRIORITY, format, setActionBar, showTitle, tell } from "./ui.js";

/**
 * Playing a robbery. Authored data is logic/robbery.ts; where it is kept is core/robberystore.ts; what it does to blocks
 * is core/robberyworld.ts; this is the run itself: starting one, who may touch what, the locks, what happens when an
 * element is done, how it ends and how the site is put back. systems/robberyrun.ts only turns game events into calls here.
 *
 * ONE shared loop (core/tick.ts) watches every run's time limit, area and delayed effects, and the site janitor. Nothing
 * here registers anything per robbery, because the game's death, spawn and tick hooks cannot be taken back.
 *
 * Putting the site back is one idempotent path. Before a door is opened or a chest filled, the block is noted in the
 * saved cleanup list (core/robberystore.ts), by position. A normal ending, a manual reset, a round reset, a crash and a
 * reload all end the same way: the janitor reads that list and puts each block back once its chunk is loaded. So a
 * robbery that was running when the world closed cannot leave a vault open for good, and a robbery that was deleted or
 * edited while its site was dirty is still cleaned.
 *
 * What is NOT kept across a reload: the run itself (which elements were done, a lock's progress). A reload ends a robbery
 * in progress; the site is put back and the next touch starts it afresh.
 */

const SOURCE = "robbery";
const TICKS_PER_SECOND = 20;

const eventId = (id: string): string => `robbery:${id}`;
const ticks = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);
const center = (pos: Pos): Vector3 => ({ x: pos[0] + 0.5, y: pos[1] + 0.5, z: pos[2] + 0.5 });

/** 125 seconds as "2:05". */
export function clock(totalSeconds: number): string {
    const whole = Math.max(0, Math.ceil(totalSeconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------
// The state of a run
// ---------------------------------------------------------------------------------------------------------

/**
 * What an element is right now.
 *   sealed  something it requires is not done yet
 *   armed   it can be tried
 *   jammed  its pick lock jammed and has not recovered
 *   done    it has been completed this run
 */
export type ElementState = "sealed" | "armed" | "jammed" | "done";

/** How a run ended: won, failed, stopped by hand, or cut short by a round reset. */
export type RunResult = "win" | "fail" | "stopped" | "round";

interface Pending {
    readonly at: number;
    readonly effect: Effect;
    readonly actorId: string | undefined;
}

interface Run {
    readonly id: string;
    readonly startedTick: number;
    /** A test run: anyone may take part, and there is no cooldown. */
    readonly test: boolean;
    /** Took the director's one slot, so it must give it back. */
    readonly holdsSlot: boolean;
    readonly done: Set<string>;
    readonly picks: Map<string, PickState>;
    readonly pending: Pending[];
    ended: boolean;
    result: RunResult | undefined;
    /** The tick the site is put back. Infinite while it is running. */
    resetAt: number;
    lastAreaCheck: number;
    /** The last tick anybody was inside the area. */
    lastInside: number;
    /** Who last completed something: the actor of the end-of-run effects. */
    lastActorId: string | undefined;
}

const runs = new Map<string, Run>();
/** The tick each robbery may be started again, after it ended. */
const cooldownUntil = new Map<string, number>();
/** Each player's last scored pick guess, for the mash-protection. */
const lastGuessTick = new Map<string, number>();
/** Who is in a pick form right now, so a double click does not open two. */
const picking = new Set<string>();
/** The last whole reason each builder was given in chat, so a click held on an unfinished robbery does not repeat it. */
const lastDetail = new Map<string, { readonly text: string; readonly tick: number }>();

type StartRequest = { readonly id: string; readonly by: Player | undefined; readonly test: boolean };
let launching: StartRequest | undefined;
const registeredEvents = new Set<string>();

export type RunOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };
const fail = (reason: string): RunOutcome => ({ ok: false, reason });
const ok: RunOutcome = { ok: true };

function stateOf(run: Run, element: Element, now: number): ElementState {

    if (run.done.has(element.id)) return "done";
    if (!element.req.every((id) => run.done.has(id))) return "sealed";

    const pick = run.picks.get(element.id);

    return pick !== undefined && now < pick.jammedUntil ? "jammed" : "armed";
}

// ---------------------------------------------------------------------------------------------------------
// Who is who
// ---------------------------------------------------------------------------------------------------------

function playerById(id: string | undefined): Player | undefined {
    return id === undefined ? undefined : players().find((player) => player.id === id && player.isValid);
}

/** Players inside the robbery's area: outlaws only when the robbery says so, and anyone at all in a test run. */
function insideArea(robbery: Robbery, run: Run | undefined): Player[] {

    const area = robbery.area;
    if (!area) return [];

    const pool = run?.test ? players() : robbery.settings.outlawsOnly ? aliveOutlaws() : alivePlayers();

    return pool.filter((player) => player.isValid
        && sameDimension(player.dimension.id) === robbery.dimension
        && boxContains(area, player.location.x, player.location.y, player.location.z));
}

function recipientsFor(audience: Audience, robbery: Robbery, run: Run | undefined, actorId: string | undefined): Player[] {

    switch (audience) {
        case "actor": {
            const actor = playerById(actorId);
            return actor ? [actor] : [];
        }
        case "area": return insideArea(robbery, run);
        case "outlaws": return [...aliveOutlaws()];
        case "law": return [...lawPlayers()];
        case "all": return [...players()];
    }
}

/** The reason this player may not work the robbery's elements, or undefined when they may. */
function whyNotAllowed(player: Player, robbery: Robbery, test: boolean): string | undefined {

    if (test) return undefined;

    const record = recordOf(player);

    if (record?.eliminated) return "you are out of the round";
    if (record?.inJail) return "you cannot do that from jail";
    if (robbery.settings.outlawsOnly && record?.role !== "outlaw") return "only outlaws can do this";

    return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Telling the player
// ---------------------------------------------------------------------------------------------------------

/**
 * A short refusal: one line on the action bar (it cannot be spammed into chat by clicking) and a dull thud. The bar is a
 * single centred line that cuts off whatever does not fit, so a long reason (an unfinished robbery lists everything it
 * lacks) is shortened there, and a builder, who can do something about it, is given the whole of it in chat, once.
 */
function deny(player: Player, reason: string): void {

    const full = sentence(reason);
    const line = briefly(full, R.noticeChars);

    setActionBar(player, SOURCE, format("warn", line), { priority: ACTION_BAR_PRIORITY.alert, ttlTicks: R.noticeTicks });
    playFor(player, R.cues.denied);

    if (line === full || !isOperator(player)) return;

    const now = system.currentTick;
    const last = lastDetail.get(player.id);

    if (last?.text === full && now - last.tick < R.noticeTicks * 4) return;

    lastDetail.set(player.id, { text: full, tick: now });
    tell(player, format("warn", full));
}

// ---------------------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------------------

function deliverSay(effect: SayEffect, recipients: readonly Player[]): void {

    for (const player of recipients) {

        if (effect.channel === "chat") tell(player, effect.text);
        else if (effect.channel === "bar") setActionBar(player, SOURCE, effect.text, { priority: ACTION_BAR_PRIORITY.alert, ttlTicks: R.noticeTicks });
        else showTitle(player, effect.text);

        if (effect.sound !== undefined) playFor(player, { id: effect.sound });
    }
}

function deliverReward(effect: RewardEffect, recipients: readonly Player[]): void {

    for (const player of recipients) {

        if (effect.coins > 0) {
            addCoins(player, effect.coins);
            tell(player, format("ok", `+${effect.coins} coins`));
        }

        if (effect.bounty > 0) {
            addBounty(player, effect.bounty);
            tell(player, format("bad", `+${effect.bounty} bounty on your head`));
        }
    }
}

function applyEffect(run: Run, robbery: Robbery, effect: Effect, actorId: string | undefined): void {

    if (effect.kind === "end") {
        endRun(run, effect.result);
        return;
    }

    const recipients = recipientsFor(effect.to, robbery, run, actorId);

    if (effect.kind === "say") deliverSay(effect, recipients);
    else deliverReward(effect, recipients);
}

/** Runs a list of effects: the ones with no delay now, the rest when their time comes (the shared loop fires them). */
function runEffects(run: Run, robbery: Robbery, effects: readonly Effect[], actorId: string | undefined): void {

    const now = system.currentTick;

    for (const effect of effects) {

        const delay = effect.delaySeconds ?? 0;

        if (delay <= 0) {
            applyEffect(run, robbery, effect, actorId);
            continue;
        }

        run.pending.push({ at: now + ticks(delay), effect, actorId });
    }
}

function firePending(run: Run, robbery: Robbery, now: number): void {

    if (run.pending.length === 0) return;

    const due = run.pending.filter((p) => p.at <= now);
    if (due.length === 0) return;

    for (const entry of due) run.pending.splice(run.pending.indexOf(entry), 1);

    for (const entry of due) applyEffect(run, robbery, entry.effect, entry.actorId);
}

// ---------------------------------------------------------------------------------------------------------
// Completing an element
// ---------------------------------------------------------------------------------------------------------

/**
 * Gives a frame's loot to the thief: into their bag, and what does not fit on the ground at their feet. With nobody (a command
 * or an NPC button completed it) it falls from the frame. Says what they took.
 */
function handOverLoot(robbery: Robbery, element: LootElement, actor: Player | undefined): void {

    const { stacks, problems } = lootStacks(element.table, element.items);

    if (problems.length > 0) warn(SOURCE, `${robbery.id}: ${element.name}: ${problems.join("; ")}`);
    if (stacks.length === 0) return;

    const taker = actor !== undefined && actor.isValid ? actor : undefined;
    const container = taker ? inventoryOf(taker) : undefined;
    const first = element.cells[0];
    const at: Vector3 = taker ? taker.location : first ? center(first) : { x: 0, y: 0, z: 0 };

    const took: string[] = [];
    const left: ItemStack[] = [];

    for (const stack of stacks) {

        // Worded before it is added: adding may change the stack.
        took.push(`${stack.amount > 1 ? `${stack.amount} ` : ""}${itemLabel(stack.typeId)}`);

        let rest: ItemStack | undefined = stack;

        if (container) {
            try {
                rest = container.addItem(stack);
            } catch (err) {
                warn(SOURCE, `${robbery.id}: ${element.name}: could not give ${stack.typeId}: ${err}`);
            }
        }

        if (rest) left.push(rest);
    }

    if (left.length > 0) dropItems(robbery.dimension, at, left);

    if (taker) tell(taker, format("ok", `You took ${took.join(", ")}.`));
}

/**
 * Notes every item frame of the robbery as one to show again, taken from or not. A script cannot read what a frame shows, so it
 * cannot know that one was emptied behind its back (a punch the game never reported, a hopper, a mob). Putting the site back
 * places every frame from its saved copy instead, which costs one small structure each and does not rest on a guess.
 */
function noteFrames(robbery: Robbery): void {

    for (const element of robbery.elements) {
        const cell = element.kind === "frame" ? element.cells[0] : undefined;
        if (cell) markDirty({ robbery: robbery.id, dimension: robbery.dimension, pos: cell, action: "refill" });
    }
}

/** Notes each block of the element as changed (saved now), then changes it. */
function changeWorld(robbery: Robbery, element: Element, actor: Player | undefined): void {

    const note = (cell: Pos, action: Dirty["action"]): void => {
        markDirty({ robbery: robbery.id, dimension: robbery.dimension, pos: cell, action });
    };

    if (element.kind === "door") {
        for (const cell of element.cells) note(cell, "close");
        if (!setDoor(robbery.dimension, element.cells, true)) warn(SOURCE, `${robbery.id}: ${element.name} could not be fully opened`);
        return;
    }

    if (element.kind === "chest") {
        for (const cell of element.cells) note(cell, "empty");
        const result = fillChest(robbery.dimension, element.cells, element.table, element.items);
        if (!result.ok) warn(SOURCE, `${robbery.id}: ${element.name} could not be filled${result.problem ? ` (${result.problem})` : ""}`);
        return;
    }

    if (element.kind === "frame") {
        const cell = element.cells[0];
        if (!cell) return;

        // Noted first, so a crash between emptying it and the end of the run still gets it filled again.
        note(cell, "refill");
        handOverLoot(robbery, element, actor);

        if (!emptyFrame(robbery.dimension, cell)) warn(SOURCE, `${robbery.id}: ${element.name} could not be emptied`);
    }
}

function complete(run: Run, robbery: Robbery, element: Element, actor: Player | undefined): void {

    if (run.done.has(element.id) || run.ended) return;

    run.done.add(element.id);
    if (actor) run.lastActorId = actor.id;

    changeWorld(robbery, element, actor);

    const dimension = dimensionOf(robbery.dimension);
    const first = element.cells[0];
    if (dimension && first) playAtPoint(dimension, R.cues.done, center(first));

    runEffects(run, robbery, element.onDone, run.lastActorId);

    cascade(run, robbery, actor);
}

/**
 * An element with nothing to lock it but something to wait on opens by itself the moment what it waits on is done. Not a frame:
 * its whole point is that someone takes from it, so it waits to be touched, however open it is.
 */
function cascade(run: Run, robbery: Robbery, actor: Player | undefined): void {

    const ready = robbery.elements.filter((element) => !run.done.has(element.id) && element.kind !== "frame"
        && element.locks.length === 0 && element.req.length > 0 && element.req.every((id) => run.done.has(id)));

    for (const element of ready) complete(run, robbery, element, actor);
}

// ---------------------------------------------------------------------------------------------------------
// Starting and ending
// ---------------------------------------------------------------------------------------------------------

function firstUnloaded(robbery: Robbery): string | undefined {

    for (const element of robbery.elements) {
        for (const cell of element.cells) {
            if (!isLoaded(robbery.dimension, cell)) return `${cell[0]}, ${cell[1]}, ${cell[2]}`;
        }
    }

    return undefined;
}

/** Seconds until a robbery may be started again, 0 when it may. */
export function cooldownLeftSeconds(id: string): number {
    return Math.max(0, Math.ceil(((cooldownUntil.get(id) ?? 0) - system.currentTick) / TICKS_PER_SECOND));
}

function begin(id: string, by: Player | undefined, test: boolean, holdsSlot: boolean): boolean {

    const robbery = getRobbery(id);
    if (!robbery) return false;

    const now = system.currentTick;

    const run: Run = {
        id, startedTick: now, test, holdsSlot, done: new Set(), picks: new Map(), pending: [],
        ended: false, result: undefined, resetAt: Infinity, lastAreaCheck: now, lastInside: now, lastActorId: by?.id
    };

    runs.set(id, run);

    noteFrames(robbery);

    debug(SOURCE, `${id} started${test ? " (test)" : ""}`);

    if (by) {
        playFor(by, R.cues.start);
        if (test) tell(by, format("info", "Test run: anyone can take part, and there is no cooldown."));
    }

    runEffects(run, robbery, robbery.hooks.start, by?.id);

    return true;
}

function ensureRegistered(id: string): void {

    if (registeredEvents.has(id)) return;
    registeredEvents.add(id);

    // The director asks the event to start; what to start with (who, test or not) is handed over in `launching`.
    registerEvent({
        id: eventId(id),
        label: "robbery",
        start: () => {
            const request = launching?.id === id ? launching : undefined;
            return begin(id, request?.by, request?.test === true, true);
        }
    });
}

/**
 * Why a robbery cannot be started right now, or undefined when it can: it exists, is finished, is not already under way or
 * being put back, is not cooling down (a test run ignores that and the round rule), its blocks are loaded, and, if it is
 * exclusive, nothing else holds the director's slot. Only reads, so a command callback (which may not change the world)
 * can ask it before deferring the start itself.
 */
export function whyCannotStart(id: string, options: { readonly test?: boolean } = {}): string | undefined {

    const robbery = getRobbery(id);
    if (!robbery) return `there is no robbery ${id}`;

    const unfinished = whyNotRunnable(robbery);
    if (unfinished.length > 0) return `it is not finished: ${unfinished.join("; ")}`;

    const existing = runs.get(id);
    if (existing && !existing.ended) return "it is already under way";
    if (existing || robberyIsDirty(id)) return "it is still being put back";

    if (options.test !== true) {
        const wait = cooldownLeftSeconds(id);
        if (wait > 0) return `it is closed for another ${clock(wait)}`;
        if (robbery.settings.roundOnly && !isPhase("ACTIVE")) return "it can only be robbed during a round";
    }

    const unloaded = firstUnloaded(robbery);
    if (unloaded) return `part of it is not loaded right now (${unloaded})`;

    // Ask before asking the director: its own refusal is a line to the whole world, and this one is only for this player.
    const holder = robbery.settings.exclusive ? activeEvent() : null;
    if (holder !== null) return `${holder} is in progress, and only one event can run at a time`;

    return undefined;
}

/** Starts a robbery if whyCannotStart finds nothing in the way. The reason is for the player who asked. */
export function startRobbery(id: string, options: { readonly by?: Player; readonly test?: boolean } = {}): RunOutcome {

    const why = whyCannotStart(id, options);
    if (why) return fail(why);

    const robbery = getRobbery(id);
    if (!robbery) return fail(`there is no robbery ${id}`);

    const test = options.test === true;

    if (!robbery.settings.exclusive) return begin(id, options.by, test, false) ? ok : fail("it could not start");

    ensureRegistered(id);
    launching = { id, by: options.by, test };

    try {
        const result = requestEvent(eventId(id));
        return result.status === "started" ? ok : fail("another event is in the way");
    } finally {
        launching = undefined;
    }
}

function endRun(run: Run, result: RunResult, reason?: string): void {

    if (run.ended) return;

    run.ended = true;
    run.result = result;

    const robbery = getRobbery(run.id);
    const now = system.currentTick;

    if (robbery && (result === "win" || result === "fail")) {
        runEffects(run, robbery, robbery.hooks[result], run.lastActorId);
        run.resetAt = now + ticks(robbery.settings.resetAfterSeconds);
        if (!run.test) cooldownUntil.set(run.id, now + ticks(robbery.settings.cooldownSeconds));
    } else {
        // Stopped by hand, or cut short by a round reset: nothing to announce, and the site goes back at once.
        run.resetAt = now;
    }

    if (reason) {
        const actor = playerById(run.lastActorId);
        if (actor) tell(actor, format("warn", reason));
    }

    debug(SOURCE, `${run.id} ended: ${result}`);

    if (run.holdsSlot) finishEvent(eventId(run.id));
}

/** Why a robbery cannot be stopped (it is not under way), or undefined. Only reads. */
export function whyCannotStop(id: string): string | undefined {

    const run = runs.get(id);

    return !run || run.ended ? "it is not under way" : undefined;
}

/** Stops a robbery that is under way: no win or fail effects, and its site is put back at once. */
export function stopRobbery(id: string): RunOutcome {

    const why = whyCannotStop(id);
    if (why) return fail(why);

    const run = runs.get(id);
    if (run) endRun(run, "stopped");

    return ok;
}

/**
 * Puts a robbery's site back right now, ending the run if there is one, and forgets its cooldown. Blocks in a chunk that
 * is not loaded stay noted and are put back when it loads: `left` counts them.
 */
export function resetSiteNow(id: string): { readonly cleaned: number; readonly left: number } {

    const run = runs.get(id);
    if (run && !run.ended) endRun(run, "stopped");

    runs.delete(id);
    cooldownUntil.delete(id);

    // Resetting by hand is how a builder fixes a site: every frame is shown again, including one nobody was seen taking from.
    const robbery = getRobbery(id);
    if (robbery) noteFrames(robbery);

    let cleaned = 0;
    let left = 0;

    for (const entry of dirtyEntries()) {

        if (entry.robbery !== id) continue;

        if (putBack(entry)) {
            clearDirty(entry);
            cleaned++;
        } else {
            left++;
        }
    }

    return { cleaned, left };
}

/**
 * Completes an element from outside (a command, an NPC button): its locks are skipped, but what it waits on is not. Starts
 * the robbery first if it is not under way.
 */
export function activateElement(id: string, elementId: string, actor?: Player): RunOutcome {

    const why = whyCannotActivate(id, elementId);
    if (why) return fail(why);

    const robbery = getRobbery(id);
    const element = robbery ? elementNamed(robbery, elementId) : undefined;
    if (!robbery || !element) return fail(`there is no robbery ${id}`);

    let run = runs.get(id);

    if (!run) {
        const started = startRobbery(id, { by: actor });
        if (!started.ok) return started;
        run = runs.get(id);
    }

    if (!run) return fail("it could not start");

    complete(run, robbery, element, actor);

    return ok;
}

/** An element by its id ("e2") or, failing that, its name (any case). */
function elementNamed(robbery: Robbery, text: string): Element | undefined {
    return findElement(robbery, text) ?? robbery.elements.find((e) => e.name.toLowerCase() === text.toLowerCase());
}

/** Why an element cannot be activated from outside right now, or undefined. Only reads. */
export function whyCannotActivate(id: string, elementId: string): string | undefined {

    const robbery = getRobbery(id);
    if (!robbery) return `there is no robbery ${id}`;

    const element = elementNamed(robbery, elementId);
    if (!element) return `${robbery.name} has no element ${elementId}`;

    const run = runs.get(id);

    // With no run it would start one, which has its own conditions, and nothing would be done yet.
    if (!run) {
        const blocked = whyCannotStart(id);
        if (blocked) return blocked;
    }

    if (run?.ended) return "it is over";
    if (run?.done.has(element.id)) return `${element.name} is already done`;

    const waiting = element.req.filter((required) => run?.done.has(required) !== true).map((required) => findElement(robbery, required)?.name ?? required);

    return waiting.length > 0 ? `${element.name} waits on ${waiting.join(", ")}` : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Touching an element
// ---------------------------------------------------------------------------------------------------------

/**
 * Whether the game should be stopped from doing its own thing with this block. Almost always yes: a bound chest does not
 * open, a bound door does not swing, a bound button does not press. The one exception is a chest that has been unlocked
 * this run, which a player is meant to open and empty. Answered at once, in the before-event, from what is in memory.
 */
export function interactionDecision(ref: Bound): "cancel" | "pass" {

    const run = runs.get(ref.robbery);

    if (run?.done.has(ref.element) !== true) return "cancel";

    const robbery = getRobbery(ref.robbery);
    const element = robbery ? findElement(robbery, ref.element) : undefined;

    return element?.kind === "chest" ? "pass" : "cancel";
}

function inventoryOf(player: Player): Container | undefined {

    try {
        return player.getComponent("minecraft:inventory")?.container ?? undefined;
    } catch {
        return undefined;
    }
}

function hasItem(player: Player, itemId: string): boolean {

    const container = inventoryOf(player);
    if (!container) return false;

    for (let slot = 0; slot < container.size; slot++) {
        if (container.getItem(slot)?.typeId === itemId) return true;
    }

    return false;
}

function takeOneItem(player: Player, itemId: string): boolean {

    const container = inventoryOf(player);
    if (!container) return false;

    for (let slot = 0; slot < container.size; slot++) {

        const stack = container.getItem(slot);
        if (stack?.typeId !== itemId) continue;

        if (stack.amount <= 1) {
            container.setItem(slot, undefined);
        } else {
            stack.amount -= 1;
            container.setItem(slot, stack);
        }

        return true;
    }

    return false;
}

/** What stops this player paying for the locks right now (a missing key, too few coins), or undefined. */
function whyCannotPay(player: Player, locks: readonly Lock[]): string | undefined {

    for (const lock of locks) {

        if (lock.kind === "key" && !hasItem(player, lock.item)) return `you need the ${itemLabel(lock.item)} for this`;

        if (lock.kind === "pay") {
            const have = getCoins(player);
            if (have < lock.coins) return `it costs ${lock.coins} coins and you have ${have}`;
        }
    }

    return undefined;
}

/** Takes the key and the coins. Only called after whyCannotPay said they are there. */
function takePayment(player: Player, locks: readonly Lock[]): void {

    for (const lock of locks) {

        if (lock.kind === "key" && lock.consume) takeOneItem(player, lock.item);

        if (lock.kind === "pay") {
            const taken = takeCoins(player, lock.coins);
            tell(player, format("info", `-${taken} coins`));
        }
    }
}

const CURVE: PickCurve = { max: R.pickSliderMax, range: R.pickProximityRange, floor: R.pickPitchFloor, spread: R.pickPitchSpread };

const paramsOf = (lock: PickLock): PickParams => ({ hits: lock.hits, tolerance: lock.tolerance, strikes: lock.strikes, jamTicks: ticks(lock.jamSeconds) });

/** The run, robbery and element as they are NOW, or undefined when the run is over or the element is not up for a try. */
function liveTarget(run: Run, elementId: string): { readonly robbery: Robbery; readonly element: Element } | undefined {

    if (runs.get(run.id) !== run || run.ended) return undefined;

    const robbery = getRobbery(run.id);
    const element = robbery ? findElement(robbery, elementId) : undefined;

    if (!robbery || !element) return undefined;

    return stateOf(run, element, system.currentTick) === "armed" ? { robbery, element } : undefined;
}

/** Everything is in order: pay, then complete. */
function finishLocks(player: Player, run: Run, elementId: string): void {

    const live = liveTarget(run, elementId);
    if (!live) return;

    const missing = whyCannotPay(player, live.element.locks);

    if (missing) {
        deny(player, missing);
        return;
    }

    takePayment(player, live.element.locks);
    complete(run, live.robbery, live.element, player);
}

/**
 * The pick lock: a slider form, a hidden target, a ping that rises as the guess gets closer (logic/lockpick.ts has the
 * rules). The form comes back after every miss or hit until it unlocks, jams, or the player closes it. The state is the
 * lock's, not the player's, so two players working one lock share its progress, and everything is read again after each
 * wait because the run, the lock or the element may have changed while the form was open.
 */
async function pickLoop(player: Player, run: Run, elementId: string): Promise<void> {

    const key = `${player.id}|${run.id}|${elementId}`;

    if (picking.has(key)) return;
    picking.add(key);

    try {
        for (;;) {

            const live = liveTarget(run, elementId);
            const lock = live?.element.locks.find((l): l is PickLock => l.kind === "pick");

            if (!live || !lock) return;

            const state = run.picks.get(elementId) ?? FRESH_PICK;
            const misses = lock.strikes > 0 ? `  §8|  §7Misses §e${state.strikes}/${lock.strikes}` : "";

            const form = new ModalFormData()
                .title(`§6${live.element.name}`)
                .slider(`§7Turn the pick... listen for the ping.\n§7Picks §e${state.hits}/${lock.hits}${misses}`, 0, R.pickSliderMax, { valueStep: 1, defaultValue: 50 });

            const response = await showForm(player, form);

            if (!response || response.canceled || !player.isValid) return;

            const guess = Number(response.formValues?.[0]);
            if (!Number.isFinite(guess)) return;

            const after = liveTarget(run, elementId);

            if (!after) {

                // Why it is no longer up for a try: someone opened it, or someone else's misses jammed it while this form was open.
                if (run.done.has(elementId)) {
                    tell(player, format("info", "Someone else got it open."));
                } else {
                    const gone = getRobbery(run.id);
                    const element = gone ? findElement(gone, elementId) : undefined;
                    if (!run.ended && element && stateOf(run, element, system.currentTick) === "jammed") deny(player, "the lock is jammed");
                }

                return;
            }

            // The lock may have been edited while the form was open: score against what it is now.
            const current = after.element.locks.find((l): l is PickLock => l.kind === "pick");
            if (!current) return;

            const now = system.currentTick;

            // Too soon after this player's last guess: show the slider again without scoring it.
            if (now - (lastGuessTick.get(player.id) ?? -Infinity) < R.pickGuessCooldownTicks) continue;
            lastGuessTick.set(player.id, now);

            const step = pickStep(run.picks.get(elementId) ?? FRESH_PICK, guess, paramsOf(current), CURVE, Math.random, now);
            run.picks.set(elementId, step.state);

            if (step.outcome === "waiting") {
                deny(player, "the lock is jammed");
                return;
            }

            if (step.outcome === "miss") {
                playFor(player, { ...R.cues.ping, pitch: step.pitch });
                tell(player, format("info", "...no luck. Listen closely and try again."));
                continue;
            }

            if (step.outcome === "hit") {
                playFor(player, R.cues.hit);
                tell(player, format("ok", `Found it! §7Correct picks: §e${step.state.hits}/${current.hits}`));
                continue;
            }

            if (step.outcome === "jam") {
                playFor(player, R.cues.jam);
                tell(player, format("bad", `The lock jams! It will take ${clock(current.jamSeconds)} to free.`));
                runEffects(run, after.robbery, after.element.onFail, player.id);
                return;
            }

            // unlocked
            playFor(player, R.cues.hit);
            run.picks.set(elementId, FRESH_PICK);
            finishLocks(player, run, elementId);
            return;
        }
    } finally {
        picking.delete(key);
    }
}

/** A player tries an element that is armed. */
function attempt(player: Player, run: Run, robbery: Robbery, element: Element): void {

    if (element.locks.length === 0) {
        complete(run, robbery, element, player);
        return;
    }

    const missing = whyCannotPay(player, element.locks);

    if (missing) {
        deny(player, missing);
        return;
    }

    if (!element.locks.some((lock) => lock.kind === "pick")) {
        finishLocks(player, run, element.id);
        return;
    }

    pickLoop(player, run, element.id).catch((err) => error(SOURCE, `the lock on ${element.name} failed: ${err}`));
}

/**
 * A player used a block bound to an element. Called from the glue after the before-event has already stopped the game's
 * own handling, from a tick (never from the before-event itself, which may not change the world).
 */
export function touch(player: Player, ref: Bound): void {

    try {
        handleTouch(player, ref);
    } catch (err) {
        error(SOURCE, `touching ${ref.robbery}/${ref.element} failed: ${err}`);
    }
}

function handleTouch(player: Player, ref: Bound): void {

    if (!player.isValid) return;

    const robbery = getRobbery(ref.robbery);
    const element = robbery ? findElement(robbery, ref.element) : undefined;

    if (!robbery || !element) return;

    let run = runs.get(robbery.id);

    const why = whyNotAllowed(player, robbery, run?.test === true);

    if (why) {
        deny(player, why);
        return;
    }

    if (!run) {

        // Only an element that waits on nothing can start it, and only when the robbery is set to start by touch.
        if (!robbery.settings.autoStart || element.req.length > 0) {
            deny(player, "it will not budge");
            return;
        }

        const started = startRobbery(robbery.id, { by: player });

        if (!started.ok) {
            deny(player, started.reason);
            return;
        }

        run = runs.get(robbery.id);
        if (!run) return;
    }

    if (run.ended) {
        if (!run.done.has(element.id)) deny(player, "it is over for now");
        return;
    }

    const state = stateOf(run, element, system.currentTick);

    if (state === "done") return;

    if (state === "sealed") {
        deny(player, "it is sealed until something else is done");
        return;
    }

    if (state === "jammed") {
        const left = Math.ceil(((run.picks.get(element.id)?.jammedUntil ?? 0) - system.currentTick) / TICKS_PER_SECOND);
        deny(player, `the lock is jammed for another ${clock(left)}`);
        return;
    }

    attempt(player, run, robbery, element);
}

// ---------------------------------------------------------------------------------------------------------
// Punching an item frame
// ---------------------------------------------------------------------------------------------------------

/** The tick each player's last punch on each frame was handled, so one swing reported twice, or a held button, is one punch. */
const lastFrameHit = new Map<string, number>();

/**
 * A player punched an item frame bound to an element. The game pops the item out of a frame on a punch; a script can see that
 * and cannot stop it. So it is undone a moment later: the item that appeared is taken away, the frame is put back as it was,
 * and the punch counts as trying to take it, the same as a right-click (locks and requirements and all). A frame already taken
 * from in this run is left empty, which is what it should be.
 *
 * `recent` maps the id of each dropped item that has appeared lately to the tick it did (the glue keeps it). Only an item on that
 * list is ever removed, so nothing else lying near a frame is touched. If the game never told us about the popped item, nothing is
 * removed and the frame is left alone, so the thief keeps the item the punch popped out as well as what the element gives them:
 * a missed undo costs the shop one item, and never takes anything from someone else's pocket.
 */
export function frameHit(player: Player, ref: Bound, recent: ReadonlyMap<string, number>): void {

    const key = `${player.id}|${ref.robbery}|${ref.element}`;
    const now = system.currentTick;

    if (now - (lastFrameHit.get(key) ?? -Infinity) < R.frameHitGapTicks) return;
    lastFrameHit.set(key, now);

    system.runTimeout(() => {
        try {
            afterPunch(player, ref, now, recent);
        } catch (err) {
            error(SOURCE, `undoing a punch on ${ref.robbery}/${ref.element} failed: ${err}`);
        }
    }, R.frameCleanupTicks);
}

function afterPunch(player: Player, ref: Bound, punchedAt: number, recent: ReadonlyMap<string, number>): void {

    const robbery = getRobbery(ref.robbery);
    const element = robbery ? findElement(robbery, ref.element) : undefined;
    const cell = element?.cells[0];

    if (!robbery || !element || element.kind !== "frame" || !cell) return;

    const stolen = runs.get(robbery.id)?.done.has(element.id) === true;

    const popped = new Set<string>();
    for (const [id, tick] of recent) if (tick >= punchedAt - R.frameRecentTicks) popped.add(id);

    const removed = removeItemsNear(robbery.dimension, center(cell), R.frameCleanupReach, popped);

    if (removed > 0 && !stolen) {
        const result = restoreFrame(robbery.dimension, robbery.id, cell);
        if (result !== "restored") warn(SOURCE, `${robbery.id}: the frame ${element.name} could not be put back after a punch (${result})`);
    }

    // Off unless /scriptevent rae:log_debug on: what a punch really does is not measured, so this is how it will be.
    debug(SOURCE, `punch on frame ${robbery.id}/${element.name}: ${popped.size} dropped item(s) appeared in the last ${R.frameRecentTicks} ticks, ${removed} removed near the frame, ${stolen ? "already taken from" : removed > 0 ? "put back" : "left as it was"}`);

    // The punch was an attempt to take it. If the frame was taken from already, that does nothing, as a right-click would not.
    if (player.isValid) touch(player, ref);
}

// ---------------------------------------------------------------------------------------------------------
// The shared loop: limits, area, delayed effects, and putting sites back
// ---------------------------------------------------------------------------------------------------------

/** Puts one noted block back. False when it cannot be reached yet (its chunk is not loaded). */
function putBack(entry: Dirty): boolean {

    if (!isLoaded(entry.dimension, entry.pos)) return false;

    if (entry.action === "close") return setDoor(entry.dimension, [entry.pos], false);

    if (entry.action === "refill") {

        const result = restoreFrame(entry.dimension, entry.robbery, entry.pos);

        // No saved copy: nothing can ever put it back, and waiting would keep the whole robbery from starting again. Say so, and go on.
        if (result === "missing") {
            warn(SOURCE, `${entry.robbery}: the frame at ${entry.pos.join(", ")} has no saved copy, so it cannot be put back if it was emptied. Bind it again, or press "Save what the frame shows now", to save one.`);
            return true;
        }

        return result === "restored";
    }

    return emptyChest(entry.dimension, [entry.pos]);
}

function watchArea(run: Run, robbery: Robbery, now: number): void {

    const limit = robbery.settings.failWhenEmptySeconds;
    if (limit <= 0 || !robbery.area) return;

    if (insideArea(robbery, run).length > 0) {
        run.lastInside = now;
        return;
    }

    if (now - run.lastInside >= ticks(limit)) endRun(run, "fail", "Everyone left, so the robbery is over.");
}

let lastJanitorTick = 0;

function janitor(now: number): void {

    for (const entry of dirtyEntries()) {

        const run = runs.get(entry.robbery);

        // Its robbery is still using it: leave it until that robbery has ended and its reset time has come.
        if (run && !(run.ended && now >= run.resetAt)) continue;

        if (putBack(entry)) clearDirty(entry);
    }

    // A run that has ended and been put back is finished with, and its robbery can be started again.
    for (const run of [...runs.values()]) {
        if (run.ended && now >= run.resetAt && !robberyIsDirty(run.id)) runs.delete(run.id);
    }
}

function loop(context: TickContext): void {

    // The usual case, all day: nothing is running and nothing is waiting to be put back.
    if (runs.size === 0 && dirtyCount() === 0) return;

    const now = context.tick;

    for (const run of [...runs.values()]) {

        const robbery = getRobbery(run.id);

        if (!robbery) {
            // Deleted while running. Whatever it changed is still noted, so the janitor puts that back.
            runs.delete(run.id);
            if (run.holdsSlot && !run.ended) finishEvent(eventId(run.id));
            continue;
        }

        firePending(run, robbery, now);

        if (run.ended) continue;

        const limit = robbery.settings.timeLimitSeconds;

        if (limit > 0 && now - run.startedTick >= ticks(limit)) {
            endRun(run, "fail", "Time is up.");
            continue;
        }

        if (now - run.lastAreaCheck >= R.areaCheckEvery) {
            run.lastAreaCheck = now;
            watchArea(run, robbery, now);
        }
    }

    if (now - lastJanitorTick >= R.janitorEvery) {
        lastJanitorTick = now;
        janitor(now);
    }
}

onTick("robbery:run", loop, { everyTicks: R.tickEvery });

// ---------------------------------------------------------------------------------------------------------
// Looking at a run
// ---------------------------------------------------------------------------------------------------------

export interface ElementView {
    readonly id: string;
    readonly name: string;
    readonly kind: Element["kind"];
    readonly state: ElementState;
}

export interface RunView {
    readonly id: string;
    readonly phase: "running" | "ended";
    readonly result: RunResult | undefined;
    readonly test: boolean;
    readonly elapsedSeconds: number;
    /** Seconds until the site is put back, once it has ended. */
    readonly resetInSeconds: number | undefined;
    readonly elements: readonly ElementView[];
}

export function viewOf(id: string): RunView | undefined {

    const run = runs.get(id);
    const robbery = getRobbery(id);

    if (!run || !robbery) return undefined;

    const now = system.currentTick;

    return {
        id,
        phase: run.ended ? "ended" : "running",
        result: run.result,
        test: run.test,
        elapsedSeconds: Math.floor((now - run.startedTick) / TICKS_PER_SECOND),
        resetInSeconds: run.ended && Number.isFinite(run.resetAt) ? Math.max(0, Math.ceil((run.resetAt - now) / TICKS_PER_SECOND)) : undefined,
        elements: robbery.elements.map((element) => ({ id: element.id, name: element.name, kind: element.kind, state: stateOf(run, element, now) }))
    };
}

/** Ids of the robberies that are under way (not the ones only waiting to be put back). */
export function runningIds(): string[] {
    return [...runs.values()].filter((run) => !run.ended).map((run) => run.id);
}

registerSystem({
    name: "robbery",
    reset() {
        // A round reset drops every run on the spot. Nothing about the site is lost: the blocks they changed are still
        // noted in the saved list, so the janitor puts them back on its next pass.
        runs.clear();
        cooldownUntil.clear();
        lastGuessTick.clear();
        lastDetail.clear();
        lastFrameHit.clear();
        picking.clear();
        launching = undefined;
    }
});
