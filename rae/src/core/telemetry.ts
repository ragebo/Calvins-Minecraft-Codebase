import { system } from "@minecraft/server";
import { TELEMETRY } from "../config/balance.js";
import { onDeath } from "./events.js";
import { getCoins } from "./economy.js";
import { registerPersistable } from "./persist.js";
import { players } from "./players.js";
import { onPhase, type EndReason } from "./round.js";
import { recordOf } from "./state.js";

/**
 * Round-by-round history: who won, how long it took, who killed whom, and the gang's combined
 * money when it ended. Kept across a round reset and a world reload — like core/economy.ts's coin
 * balances, this is a record of what already happened, not live round state, so nothing here is
 * cleared by resetRound(). There is deliberately no registerSystem/reset(): a round reset must
 * never erase the history of the round that just finished.
 */

export interface RoundRecord {
    readonly startedAtTick: number;
    readonly endedAtTick: number;
    readonly durationTicks: number;
    readonly reason: EndReason | "aborted";
    readonly kills: number;
    readonly deaths: number;
    readonly lawKills: number;
    readonly outlawKills: number;
    /** Sum of every player's coin balance the moment the round ended. A snapshot of the gang's
     *  combined money, not a transaction ledger. */
    readonly totalCoinsAtEnd: number;
}

// Newest first, capped at TELEMETRY.maxStoredRounds (a ring buffer: the oldest is dropped).
const rounds: RoundRecord[] = [];

// Lifetime totals across every round ever recorded, including ones the ring buffer above has
// already dropped — the same "never goes back down" accounting core/economy.ts's coins use.
const totals = { kills: 0, deaths: 0 };

/** The round currently being played, or null between rounds (also true before the first ACTIVE
 *  this session, and after a round is recorded) — guards against recording a round that never
 *  really started. */
let startedAtTick: number | null = null;
let roundKills = 0;
let roundDeaths = 0;
let roundLawKills = 0;
let roundOutlawKills = 0;

export function recentRounds(): readonly RoundRecord[] {
    return rounds;
}

export function totalKills(): number {
    return totals.kills;
}

export function totalDeaths(): number {
    return totals.deaths;
}

function totalCoinsNow(): number {

    let sum = 0;

    for (const player of players()) {
        sum += getCoins(player);
    }

    return sum;
}

/** Records the round in progress and clears it. A no-op if none was actually in progress (a
 *  stray phase change before the first round, or one already recorded). */
function pushRecord(reason: EndReason | "aborted"): void {

    if (startedAtTick === null) return;

    const endedAtTick = system.currentTick;

    rounds.unshift({
        startedAtTick,
        endedAtTick,
        durationTicks: endedAtTick - startedAtTick,
        reason,
        kills: roundKills,
        deaths: roundDeaths,
        lawKills: roundLawKills,
        outlawKills: roundOutlawKills,
        totalCoinsAtEnd: totalCoinsNow()
    });

    if (rounds.length > TELEMETRY.maxStoredRounds) rounds.length = TELEMETRY.maxStoredRounds;

    totals.kills += roundKills;
    totals.deaths += roundDeaths;

    startedAtTick = null;
    roundKills = 0;
    roundDeaths = 0;
    roundLawKills = 0;
    roundOutlawKills = 0;
}

// Order 300: after every reward-granting handler (jail:capture 100, endgame:law-win-check 150,
// train/ranch/raid:*:kill-reward 200) has already done its job. This only ever counts a PLAYER
// dying; killing a mob (a train guard, a ranch raider) is not a round-combat stat and is already
// covered by those reward handlers.
onDeath("telemetry:round-stats", 300, (ctx) => {

    if (ctx.dead.typeId !== "minecraft:player") return;

    roundDeaths++;

    if (!ctx.killer) return;

    roundKills++;

    const killerRecord = recordOf(ctx.killer);

    if (killerRecord?.role === "law") roundLawKills++;
    else if (killerRecord?.role === "outlaw") roundOutlawKills++;
});

onPhase("ACTIVE", () => {
    startedAtTick = system.currentTick;
    roundKills = 0;
    roundDeaths = 0;
    roundLawKills = 0;
    roundOutlawKills = 0;
});

// change.reason is correctly set here by endRound(): always "law_win" or "outlaw_win" in
// practice. The fallback exists only because PhaseChange.reason is typed optional; it should
// never actually be needed on this path.
onPhase("ENDED", (change) => {
    pushRecord(change.reason ?? "aborted");
});

// resetRound() can drop straight to IDLE from any phase, bypassing ENDING/ENDED entirely. Only
// count it as a round worth recording when it interrupted actual play: a SETUP -> IDLE
// cancellation never reached ACTIVE (no start tick, no kills, nobody placed), and an
// ENDING/ENDED -> IDLE reset already got its real record from the ENDED handler above, so
// recording it again here would double-count it. resetRound()'s own IDLE transition never sets a
// reason, so "aborted" is assigned here rather than read off change.reason.
onPhase("IDLE", (change) => {
    if (change.from !== "ACTIVE") return;
    pushRecord("aborted");
});

registerPersistable({
    key: "telemetry",
    version: 1,
    save: () => ({ rounds, totals }),
    restore(data, savedVersion) {

        if (savedVersion !== 1) return;

        const parsed = data as { rounds?: RoundRecord[]; totals?: { kills?: number; deaths?: number } };

        if (parsed.rounds) {
            rounds.length = 0;
            rounds.push(...parsed.rounds.slice(0, TELEMETRY.maxStoredRounds));
        }

        if (parsed.totals) {
            if (typeof parsed.totals.kills === "number") totals.kills = parsed.totals.kills;
            if (typeof parsed.totals.deaths === "number") totals.deaths = parsed.totals.deaths;
        }
    }
});
