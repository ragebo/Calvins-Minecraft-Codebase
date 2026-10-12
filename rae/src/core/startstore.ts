import { START as S } from "../config/balance.js";
import { parseCommands, parseShot, serializeCommands, serializeShot, type Shot } from "../logic/start.js";
import { createRecordStore, type PlainResult, type SaveResult } from "./recordstore.js";

/**
 * Where the start sequence's authored parts live, both on core/recordstore.ts (the store shops and robberies use): the camera
 * shots, one world property each (`rae:start:shot:<id>`), and the operator's list of start commands, one (`rae:start:commands:list`).
 * The rules (written at once, a save that does not fit is refused, an unreadable save is listed and never overwritten, one level
 * of undo) are the record store's; this file says what each thing is and how big it may be.
 *
 * The command list is the one with a rule of its own, because what it holds is run on every player at the start of every game:
 *   - never saved means the defaults (config/balance.ts START);
 *   - saved empty means run nothing, a choice an operator can make;
 *   - saved but unreadable means run nothing too, and say why. A damaged list must never quietly turn into the defaults, which
 *     empty bags and zero coins.
 */

const shots = createRecordStore<Shot>({
    source: "start",
    noun: "shot",
    prefix: "rae:start:shot:",
    maxRecords: S.maxShots,
    maxChars: S.maxShotChars,
    parse: parseShot,
    serialize: serializeShot,
    idOf: (shot) => shot.id
});

/** The list is one record, so it needs an id and a wrapper to go through the same store. */
interface CommandList {
    readonly id: string;
    readonly commands: readonly string[];
}

const COMMANDS_ID = "list";

const commands = createRecordStore<CommandList>({
    source: "start",
    noun: "command list",
    prefix: "rae:start:commands:",
    maxRecords: 1,
    maxChars: S.maxCommandListChars,
    parse(text) {
        const parsed = parseCommands(text);
        return parsed.ok ? { ok: true, value: { id: COMMANDS_ID, commands: parsed.value } } : parsed;
    },
    serialize: (list) => serializeCommands(list.commands),
    idOf: (list) => list.id
});

// ---------------------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------------------

/** Every saved shot, readable or not, by id. */
export const listStoredShots = shots.list;

/** The shot with this id, or undefined when there is none or it cannot be read. */
export const getShot = shots.value;

/** The number in a shot's id, so `s2` comes before `s10`; an id of any other shape goes last. */
const numberOf = (id: string): number => {
    const found = /^s(\d+)$/.exec(id);
    return found ? Number(found[1]) : Number.MAX_SAFE_INTEGER;
};

/** Every readable shot, in the order they were made. */
export const allShots = (): readonly Shot[] => [...shots.all()].sort((a, b) => numberOf(a.id) - numberOf(b.id) || (a.id < b.id ? -1 : 1));

export const shotsVersion = shots.version;
export const saveShot = shots.save;
export const deleteShot = shots.remove;
export const shotUndoAvailable = shots.undoAvailable;
export const undoShot = shots.undo;

// ---------------------------------------------------------------------------------------------------------
// The start commands
// ---------------------------------------------------------------------------------------------------------

/** What a Start runs, in order. A copy: nothing that changes it can change the config's defaults or what is saved. */
export function startCommands(): string[] {

    const saved = commands.get(COMMANDS_ID);

    if (saved === undefined) return [...S.defaultCommands];
    if (!saved.ok) return [];

    return [...saved.value.commands];
}

/** True while no list is saved, so the defaults are in use. */
export const commandsAreDefault = (): boolean => commands.get(COMMANDS_ID) === undefined;

/** Why the saved list cannot be read, or undefined when it can (or none is saved). */
export function commandsProblem(): string | undefined {

    const saved = commands.get(COMMANDS_ID);

    return saved !== undefined && !saved.ok ? saved.problem : undefined;
}

export function saveStartCommands(list: readonly string[]): SaveResult<CommandList> {
    return commands.save({ id: COMMANDS_ID, commands: list });
}

/** Back to the defaults: the saved list, readable or not, is removed (undo is not offered for it). Fine when nothing was saved. */
export function resetStartCommands(): PlainResult {

    if (commands.get(COMMANDS_ID) === undefined) return { ok: true };

    return commands.remove(COMMANDS_ID);
}

/** Forgets everything read so far (what a script reload leaves). For tests. */
export function forgetLoaded(): void {
    shots.forget();
    commands.forget();
}
