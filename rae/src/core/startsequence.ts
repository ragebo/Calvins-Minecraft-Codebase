import { system, world, type Player, type Vector3 } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { START as S } from "../config/balance.js";
import { LAW_SPAWNS, OUTLAW_SPAWNS } from "../config/world.js";
import { pickShots, secondsPerShot } from "../logic/start.js";
import { clearCamera, flyDown, lock, playShot, unlock, unlockEveryone } from "./cinematic.js";
import { onSpawn } from "./events.js";
import { showForm } from "./forms.js";
import { error, warn } from "./log.js";
import { registerSystem } from "./registry.js";
import { beginActive, isPhase } from "./round.js";
import { allShots, startCommands } from "./startstore.js";
import { getRecord } from "./state.js";
import { onTick } from "./tick.js";
import { announce, showTitle } from "./ui.js";

/**
 * The start of a game, as a sequence (core/game.ts's begin() starts it): the operator's start commands, then a camera intro, then the
 * roles are revealed, law choose a spawn and play begins. This file holds the whole sequence; it must not import core/game.ts, which
 * calls it.
 *
 * Nothing in a sequence may hang a game: every step that waits has its own way to finish, and a step that fails says so and lets the
 * rest go on.
 */

const TICKS_PER_SECOND = 20;

/**
 * Which start the timers that are waiting belong to. A round reset, or another Start (which resets first), moves it on, and a timer that
 * wakes to find it has moved does nothing: that is how a cancelled intro stays cancelled with no way to take a timer back.
 */
let generation = 0;

/** The players a sequence has locked or put in a camera, by id: what a cancel has to let go. */
const held = new Map<string, Player>();

/** Which shot the last intro opened with, so the next one does not open with it too. Not kept across a reload. */
let lastOpeningShot: string | undefined;

function releaseHeld(): void {

    for (const player of held.values()) {
        unlock(player);
        clearCamera(player);
    }

    held.clear();
}

/** Stops whatever the sequence has waiting and lets every player it was holding go. Runs on every round reset, so a new start begins clean. */
export function cancelSequence(): void {
    generation++;
    releaseHeld();
}

registerSystem({ name: "startsequence", reset: cancelSequence });

/** Forgets everything the sequence remembers, as a script reload would. For tests. */
export function forgetIntro(): void {
    cancelSequence();
    lastOpeningShot = undefined;
}

// A reload (or a player's disconnect) in the middle of a cutscene would leave someone locked in a camera with nothing left that knows about
// it. So everyone is let go on the first tick after the scripts load, and a player who joins is let go unless a sequence is holding them.
const stopSafety = onTick("start:safety", () => {
    stopSafety();
    unlockEveryone();
}, { everyTicks: 1 });

onSpawn("start:unlock", 300, ({ player }) => {
    if (!held.has(player.id)) unlock(player);
});

// ---------------------------------------------------------------------------------------------------------
// The camera intro
// ---------------------------------------------------------------------------------------------------------

/**
 * Plays the camera intro for the players who are playing, then calls `then`. The intro is a few of the saved shots picked at random, one
 * after the other, `introSeconds` in all, with the players locked in place; they are let go, and have their own view back, just before
 * `then`. With the intro switched off, or no shot saved, `then` is called at once and nobody is touched: a start is never blocked by
 * missing setup. A reset or another Start in the meantime cancels it (`cancelSequence`) and `then` is never called.
 */
export function startIntro(playing: readonly Player[], then: () => void): void {

    const shots = S.introEnabled && S.introSeconds > 0 && playing.length > 0 ? pickShots(allShots(), S.shotsPerStart, lastOpeningShot, Math.random) : [];

    if (shots.length === 0) {
        then();
        return;
    }

    lastOpeningShot = shots[0]!.id;

    const token = generation;
    const seconds = secondsPerShot(S.introSeconds, shots.length);
    const gap = Math.max(1, Math.round(seconds * TICKS_PER_SECOND));

    for (const player of playing) {
        held.set(player.id, player);
        lock(player);
    }

    let next = 0;

    const step = (): void => {

        if (token !== generation) return;

        if (next >= shots.length) {
            releaseHeld();
            then();
            return;
        }

        const shot = shots[next++]!;

        for (const player of playing) playShot(player, shot, seconds);

        system.runTimeout(step, gap);
    };

    step();
}

// ---------------------------------------------------------------------------------------------------------
// The reveal, the spawns and the beginning of play
// ---------------------------------------------------------------------------------------------------------

const randomOf = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/** The law spawns are named as the game menu's teleport list names them. */
const lawSpawnName = (index: number): string => `Law spawn ${index + 1}`;

function place(player: Player, spawn: Vector3): void {

    // core/game.ts's teleportToSpawn does the same, and cannot be used from here: game.ts calls this file.
    if (!player.isValid) return;

    try {
        player.teleport(spawn);
    } catch (err) {
        error("start", `Could not place ${player.name} at a spawn: ${err}`);
    }
}

/**
 * The end of a start, once the intro (if any) is over: the roles are revealed, outlaws are put at a random outlaw spawn and fly down to it,
 * law players choose a spawn from a screen, and play begins. Everyone playing is locked from the reveal until play begins, so nobody has a head
 * start on someone still choosing.
 *
 * Play begins when every law player has chosen AND the outlaws' fly-down is over, or when the countdown runs out, whichever way the start goes:
 * `finish` is the one place it happens, and it happens once. A law player who closes the screen gets a random spawn at once; one who never
 * answers gets one when the countdown ends. A script cannot close a form, so an answer that comes after that is ignored. A round reset or
 * another Start in the meantime cancels all of it (`alive` stops being true) and everyone is let go.
 */
export function startPlacement(playing: readonly Player[]): void {

    const token = generation;
    const alive = (): boolean => token === generation && isPhase("SETUP");
    const here = playing.filter((player) => player.isValid);

    for (const player of here) showTitle(player, getRecord(player).role === "law" ? "§9LAWMAN" : "§cOUTLAW");
    announce("§aRoles Assigned!");

    for (const player of here) {
        held.set(player.id, player);
        lock(player);
    }

    const law = here.filter((player) => getRecord(player).role === "law");
    const outlaws = here.filter((player) => getRecord(player).role === "outlaw");

    for (const player of outlaws) {
        const spawn = randomOf(OUTLAW_SPAWNS);

        place(player, spawn);
        flyDown(player, spawn, S.flyDownSeconds);
    }

    const pending = new Set(law.map((player) => player.id));
    let flyDownOver = outlaws.length === 0;
    let finished = false;

    const placeLaw = (player: Player, choice: number | undefined): void => place(player, LAW_SPAWNS[choice ?? -1] ?? randomOf(LAW_SPAWNS));

    const finish = (force: boolean): void => {

        if (finished || !alive()) return;

        // Someone who left is not going to choose.
        for (const player of law) {
            if (pending.has(player.id) && !player.isValid) pending.delete(player.id);
        }

        if (!force && (pending.size > 0 || !flyDownOver)) return;

        finished = true;

        for (const player of law) {
            if (pending.has(player.id)) placeLaw(player, undefined);
        }

        pending.clear();
        releaseHeld();
        beginActive();
    };

    async function ask(player: Player): Promise<void> {

        let choice: number | undefined;

        try {
            const form = new ActionFormData()
                .title("Choose your spawn")
                .body(`Where do you want to start?\n§7You have ${S.pickSeconds} seconds. If you do not choose, you get a random spawn.`);

            LAW_SPAWNS.forEach((_, index) => form.button(lawSpawnName(index)));

            const response = await showForm(player, form);

            if (response && !response.canceled) choice = response.selection;
        } catch (err) {
            warn("start", `The spawn screen failed for ${player.name}: ${err}`);
        }

        // Too late if play has begun or this start was cancelled; and a player who has been placed cannot choose twice.
        if (finished || !alive() || !pending.has(player.id)) return;

        pending.delete(player.id);
        placeLaw(player, choice);
        finish(false);
    }

    const flyDownTicks = outlaws.length > 0 ? Math.round(S.flyDownSeconds * TICKS_PER_SECOND) : 0;
    const pickTicks = Math.round(S.pickSeconds * TICKS_PER_SECOND);

    if (flyDownTicks > 0) {
        system.runTimeout(() => {
            flyDownOver = true;
            finish(false);
        }, flyDownTicks);
    } else {
        flyDownOver = true;
    }

    // The countdown never ends before the fly-down does, so a short one cannot cut a camera short.
    if (law.length > 0) system.runTimeout(() => finish(true), Math.max(pickTicks, flyDownTicks));

    for (const player of law) void ask(player);

    // Nobody to ask and nothing to wait for: play begins at once.
    finish(false);
}

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

export interface CommandFailure {
    /** Its place in the list, from 1: the number an operator sees on the screen. */
    readonly number: number;
    readonly command: string;
    readonly reason: string;
}

export interface CommandReport {
    /** How many ran without the game refusing them. A command that ran but matched no one counts as run. */
    readonly ran: number;
    readonly failed: readonly CommandFailure[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/**
 * Runs the operator's start commands in order, as the server, in the overworld. Selectors like `@a[tag=law]` work (the roles are already
 * assigned when this runs); `@s` does not, because there is no one it could mean. A command the game refuses is reported to `by` (whoever
 * pressed Start; every operator online when it is not known) and the rest still run: one bad line must not leave a game half set up.
 */
export function runStartCommands(by?: Player): CommandReport {

    const list = startCommands();
    const failed: CommandFailure[] = [];

    list.forEach((command, index) => {
        try {
            world.getDimension("overworld").runCommand(command);
        } catch (err) {
            failed.push({ number: index + 1, command, reason: errorText(err) });
        }
    });

    for (const failure of failed) {
        error("start", `Start command ${failure.number} (${failure.command}) did not run: ${failure.reason}`, by ? { to: by } : undefined);
    }

    return { ran: list.length - failed.length, failed };
}
