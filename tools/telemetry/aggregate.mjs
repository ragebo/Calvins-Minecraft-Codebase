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

/** How many of a robbery's newest runs the page lists. */
const LATEST_RUNS = 20;

/** The number in an element id ("e12" is 12), so elements come out in the order they were built. */
const buildOrder = (el) => Number(String(el).replace(/\D/g, "")) || 0;

/**
 * The robberies, one figure set each. A run is its start, elements, picks, payouts and end, all sharing the robbery's id and the run's number;
 * two boots can both have a run 1, so a run is told apart by world + boot + robbery + number. A run whose start (or end) was lost to a cut log
 * or a closed world still counts: the first line seen makes it, and one with no end is "unfinished". Test runs are left out unless asked for.
 */
function robberiesSection(events, includeTests) {

    const runs = new Map();

    for (const e of events) {

        if (!e.k.startsWith("robbery.")) continue;

        const key = `${e.w}|${e.b}|${e.id}|${e.r}`;
        const run = runs.get(key) ?? { id: e.id, w: e.w, r: e.r, at: e.at, lastAt: e.at, test: false, elements: [], picks: [], coins: 0, bounty: 0, end: null };

        runs.set(key, run);
        run.lastAt = e.at;                  // oldest first, so the last one seen is the newest

        if (e.test === true) run.test = true;

        if (e.k === "robbery.start") run.at = e.at;
        else if (e.k === "robbery.element") run.elements.push(e);
        else if (e.k === "robbery.pick") run.picks.push(e);
        else if (e.k === "robbery.payout") { run.coins += num(e.coins); run.bounty += num(e.bounty); }
        else if (e.k === "robbery.end") run.end = e;
    }

    const all = [...runs.values()];
    const kept = includeTests ? all : all.filter((run) => !run.test);
    const byRobbery = new Map();

    for (const run of kept) byRobbery.set(run.id, [...(byRobbery.get(run.id) ?? []), run]);

    const list = [...byRobbery].map(([id, own]) => robberyFigures(id, own)).sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));

    return { list, excludedTests: all.length - kept.length, includeTests };
}

function robberyFigures(id, runs) {

    const ended = runs.filter((run) => run.end !== null);
    const byResult = { win: 0, fail: 0, stopped: 0, round: 0, unfinished: 0 };

    for (const run of runs) {
        const result = run.end === null ? "unfinished" : run.end.result;
        byResult[result] = (byResult[result] ?? 0) + 1;
    }

    const decided = byResult.win + byResult.fail;
    const lengths = ended.map((run) => num(run.end.dur));
    const coins = sum(runs.map((run) => run.coins));
    const bounty = sum(runs.map((run) => run.bounty));

    const rows = new Map();
    const rowOf = (el) => rows.get(el) ?? rows.set(el, { el, name: "", kind: null, completed: 0, afters: [], jams: 0, misses: [] }).get(el);

    for (const run of runs) {

        for (const e of run.elements) {
            const row = rowOf(e.el);
            row.completed++;
            row.afters.push(num(e.after));
            if (!row.name) row.name = e.name ?? "";
            if (row.kind === null) row.kind = e.kind ?? null;
        }

        for (const e of run.picks) {
            const row = rowOf(e.el);
            if (e.result === "jammed") row.jams++;
            row.misses.push(num(e.misses));
            if (!row.name) row.name = e.name ?? "";
        }
    }

    // How many elements the robbery has is what its newest ended run says: a builder may have added or taken away elements since the older ones.
    const newest = ended.length === 0 ? null : ended.reduce((latest, run) => (run.lastAt > latest.lastAt ? run : latest));
    const of = newest === null ? 0 : num(newest.end.of);

    return {
        id,
        runs: runs.length,
        lastAt: runs.reduce((newest, run) => (run.lastAt > newest ? run.lastAt : newest), ""),
        byResult,
        decided,
        winShare: decided === 0 ? null : byResult.win / decided,
        length: ended.length === 0 ? null : { average: average(lengths), median: median(lengths) },
        elementsDone: ended.length === 0 ? null : { average: average(ended.map((run) => num(run.end.done))), of },
        coins: { total: coins, perRun: coins / runs.length },
        bounty: { total: bounty, perRun: bounty / runs.length },
        elements: [...rows.values()].sort((a, b) => buildOrder(a.el) - buildOrder(b.el)).map((row) => ({
            el: row.el, name: row.name, kind: row.kind, completed: row.completed, share: row.completed / runs.length,
            medianAfter: median(row.afters), jams: row.jams, avgMisses: average(row.misses)
        })),
        untouched: Math.max(0, of - rows.size),
        latest: [...runs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, LATEST_RUNS).map((run) => ({
            at: run.at, w: run.w, r: run.r, test: run.test,
            result: run.end === null ? null : run.end.result,
            dur: run.end === null ? null : num(run.end.dur), done: run.end === null ? null : num(run.end.done), of: run.end === null ? null : num(run.end.of), people: run.end === null ? null : num(run.end.people),
            coins: run.coins, bounty: run.bounty
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
 * All the figures for one report. `world` narrows the rounds and the robberies to one world; the data panel always covers everything, so the
 * other worlds' ids are there to pick from. `includeTests` brings a builder's test runs of a robbery in (they are left out otherwise).
 * `ingest` is what the last read of the logs found, passed through for the panel.
 */
export function summarize(events, { world, ingest, includeTests } = {}) {

    const sorted = [...events].sort(byTime);
    const chosen = world === undefined ? sorted : sorted.filter((e) => e.w === world);

    return { world: world ?? null, rounds: roundsSection(chosen), robberies: robberiesSection(chosen, includeTests === true), data: dataSection(sorted, ingest) };
}
