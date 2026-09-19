import { world, system, type Player } from "@minecraft/server";
import { recordOf, stateVersion, type PlayerRecord } from "./state.js";

/**
 * Cached answers to "which players are ...?", read from core/state records.
 *
 * Five systems each re-implemented these filters with getAllPlayers() plus hasTag() calls, and
 * every one of those is an engine call. Here the player list is fetched at most once per tick,
 * and each answer is computed at most once per state change.
 */

let snapshotTick = -1;
let snapshot: readonly Player[] = [];
const answers = new Map<string, { readonly version: number; readonly players: readonly Player[] }>();

function everyone(): readonly Player[] {

    const tick = system.currentTick;

    if (tick !== snapshotTick) {
        snapshotTick = tick;
        snapshot = world.getAllPlayers();
        answers.clear();
    }

    return snapshot;
}

function ask(key: string, keep: (record: Readonly<PlayerRecord>) => boolean): readonly Player[] {

    const all = everyone();
    const version = stateVersion();
    const cached = answers.get(key);

    if (cached && cached.version === version) return cached.players;

    // A player whose handle went invalid (disconnected earlier this tick) and whom the game never
    // recorded has nothing to classify them by, so they are in no answer.
    const players = all.filter((player) => {
        const record = recordOf(player);
        return record !== undefined && keep(record);
    });
    answers.set(key, { version, players });

    return players;
}

/** Everyone currently in the world. */
export function players(): readonly Player[] {
    return everyone();
}

/** Law players who are still in the round. */
export function lawPlayers(): readonly Player[] {
    return ask("law", (r) => r.role === "law" && !r.eliminated);
}

/** Every outlaw, including jailed and eliminated ones. */
export function outlaws(): readonly Player[] {
    return ask("outlaws", (r) => r.role === "outlaw");
}

/** Outlaws who are still in the round (jailed or free). */
export function aliveOutlaws(): readonly Player[] {
    return ask("aliveOutlaws", (r) => r.role === "outlaw" && !r.eliminated);
}

/** Outlaws who are in the round and not in jail. */
export function freeOutlaws(): readonly Player[] {
    return ask("freeOutlaws", (r) => r.role === "outlaw" && !r.eliminated && !r.inJail);
}

/** Eliminated players, now spectating. */
export function spectators(): readonly Player[] {
    return ask("spectators", (r) => r.eliminated);
}

/** Players physically detained right now (in jail), whoever they are. Empty means the jail is empty. */
export function prisoners(): readonly Player[] {
    return ask("prisoners", (r) => r.inJail);
}
