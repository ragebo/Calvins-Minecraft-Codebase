// Turns the archive's events into the figures a report shows (tasks/plan.md). Pure: events in, plain numbers and lists out, so every figure
// can be checked by hand. One section per area: this file has the rounds and the data panel, and the robbery and shop sections are added
// beside them. Times stay in ticks and counts stay raw; report.mjs decides how they read.

/** Oldest first. `at` sorts as text; the boot and the line number settle two lines in the same second. */
export const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.b < b.b ? -1 : a.b > b.b ? 1 : a.n - b.n);

/** A number from an event field; a missing or damaged one counts as 0 rather than turning a whole figure into NaN. */
const num = (value) => (Number.isFinite(value) ? value : 0);

const sum = (numbers) => numbers.reduce((total, n) => total + n, 0);

const average = (numbers) => (numbers.length === 0 ? null : sum(numbers) / numbers.length);

function median(numbers) {

    if (numbers.length === 0) return null;

    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** How many of the newest rounds the page lists. */
const LATEST_ROUNDS = 20;

function roundsSection(events) {

    const rounds = events.filter((e) => e.k === "round.end");

    const byReason = {};
    for (const r of rounds) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;

    const lawWins = byReason.law_win ?? 0;
    const decided = lawWins + (byReason.outlaw_win ?? 0);

    const lengths = rounds.map((r) => num(r.dur));
    const kills = sum(rounds.map((r) => num(r.kills)));
    const deaths = sum(rounds.map((r) => num(r.deaths)));
    const coins = rounds.map((r) => num(r.coins));

    return {
        count: rounds.length,
        byReason,
        decided,
        lawWinShare: decided === 0 ? null : lawWins / decided,
        length: rounds.length === 0 ? null : { average: average(lengths), median: median(lengths), shortest: Math.min(...lengths), longest: Math.max(...lengths) },
        kills: { total: kills, perRound: rounds.length === 0 ? null : kills / rounds.length },
        deaths: { total: deaths, perRound: rounds.length === 0 ? null : deaths / rounds.length },
        lawKills: sum(rounds.map((r) => num(r.lawKills))),
        outlawKills: sum(rounds.map((r) => num(r.outlawKills))),
        coins: rounds.length === 0 ? null : { average: average(coins), median: median(coins), last: coins[coins.length - 1] },
        latest: rounds.slice(-LATEST_ROUNDS).reverse().map((r) => ({
            at: r.at, w: r.w, reason: r.reason, dur: num(r.dur), kills: num(r.kills), deaths: num(r.deaths), lawKills: num(r.lawKills), outlawKills: num(r.outlawKills), coins: num(r.coins)
        }))
    };
}

/** What the page says about the data itself: how much of it, from which worlds and builds, and what was lost on the way. */
function dataSection(events, ingest) {

    const worlds = new Map();
    const builds = new Map();
    const boots = new Set();
    let dropped = 0;

    for (const e of events) {

        const world = worlds.get(e.w) ?? { w: e.w, events: 0, firstAt: e.at, lastAt: e.at };

        world.events++;
        world.lastAt = e.at;                // oldest first, so the last one seen is the newest
        worlds.set(e.w, world);

        builds.set(e.bv, (builds.get(e.bv) ?? 0) + 1);
        boots.add(`${e.w}|${e.b}`);

        if (e.k === "telemetry.dropped") dropped += num(e.lines);
    }

    return {
        events: events.length,
        firstAt: events.length === 0 ? null : events[0].at,
        lastAt: events.length === 0 ? null : events[events.length - 1].at,
        worlds: [...worlds.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : b.events - a.events)),
        builds: [...builds].map(([bv, count]) => ({ bv, events: count })).sort((a, b) => b.events - a.events || (a.bv < b.bv ? 1 : -1)),
        boots: boots.size,
        dropped,
        ingest: ingest ?? null
    };
}

/**
 * All the figures for one report. `world` narrows the rounds to one world; the data panel always covers everything, so the other worlds'
 * ids are there to pick from. `ingest` is what the last read of the logs found, passed through for the panel.
 */
export function summarize(events, { world, ingest } = {}) {

    const sorted = [...events].sort(byTime);
    const chosen = world === undefined ? sorted : sorted.filter((e) => e.w === world);

    return { world: world ?? null, rounds: roundsSection(chosen), data: dataSection(sorted, ingest) };
}
