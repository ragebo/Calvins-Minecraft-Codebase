// Turns the archive's events into the figures a report shows (tasks/plan.md). Pure: events in, plain numbers and lists out, so every figure
// can be checked by hand. One section per area: the rounds, the robberies, the shops with the coin flow they add up to, and the data panel.
// Times stay in ticks and counts stay raw; report.mjs decides how they read.

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

/** How many deals, and how many refusal reasons, a shop's section lists. */
const TOP = 5;

const coins = (n) => `${n} coin${n === 1 ? "" : "s"}`;

/** A field that should be a list of texts; anything else counts as empty. */
const listOf = (value) => (Array.isArray(value) ? value : []);

/** Most first; the same count by name, so the order never depends on the order the events came in. */
const ranked = (items, name) => items.sort((a, b) => b.count - a.count || (a[name] < b[name] ? -1 : a[name] > b[name] ? 1 : 0));

/** A deal in words, as what the customer got for what they paid: "Iron Sword for 60 coins", "8 coins for Feather x3", "Bread x4 for free". */
function dealLabel(trade) {

    const got = [...listOf(trade.give), ...(num(trade.got) > 0 ? [coins(trade.got)] : []), ...listOf(trade.svc)];
    const paid = [...listOf(trade.take), ...(num(trade.spent) > 0 ? [coins(trade.spent)] : [])];

    return `${got.length === 0 ? "nothing" : got.join(", ")} for ${paid.length === 0 ? "free" : paid.join(", ")}`;
}

/**
 * The shops, one figure set each, newest activity first. A visit is a `shop.open`, a deal done a `shop.trade`, a deal turned down a `shop.refuse`.
 * The same deal at another price (a shop's owner edited it) is another line in the top deals, because the label holds the price. A refusal
 * reason has its numbers taken out ("you need 60 coins" and "you need 90 coins" are one reason), or every price would be a reason of its own.
 */
function shopsSection(events) {

    const shops = new Map();

    for (const e of events) {

        if (!e.k.startsWith("shop.")) continue;

        const shop = shops.get(e.id) ?? { id: e.id, lastAt: e.at, opens: 0, people: new Set(), trades: 0, refusals: 0, spent: 0, got: 0, deals: new Map(), services: new Map(), reasons: new Map() };

        shops.set(e.id, shop);
        shop.lastAt = e.at;                 // oldest first, so the last one seen is the newest
        if (typeof e.p === "string") shop.people.add(e.p);

        if (e.k === "shop.open") shop.opens++;
        else if (e.k === "shop.trade") {

            shop.trades++;
            shop.spent += num(e.spent);
            shop.got += num(e.got);

            const label = dealLabel(e);
            const deal = shop.deals.get(`${e.deal}|${label}`) ?? { deal: e.deal, label, face: e.face, count: 0, spent: 0, got: 0 };

            deal.count++;
            deal.spent += num(e.spent);
            deal.got += num(e.got);
            shop.deals.set(`${e.deal}|${label}`, deal);

            for (const kind of listOf(e.svc)) shop.services.set(kind, (shop.services.get(kind) ?? 0) + 1);
        }
        else if (e.k === "shop.refuse") {

            shop.refusals++;

            const why = String(e.why ?? "").replace(/\d+/g, "#");

            shop.reasons.set(why, (shop.reasons.get(why) ?? 0) + 1);
        }
    }

    return [...shops.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.id < b.id ? -1 : 1)).map((shop) => ({
        id: shop.id,
        lastAt: shop.lastAt,
        opens: shop.opens,
        customers: shop.people.size,
        trades: shop.trades,
        refusals: shop.refusals,
        tradesPerOpen: shop.opens === 0 ? null : shop.trades / shop.opens,
        spent: shop.spent,
        got: shop.got,
        topDeals: ranked([...shop.deals.values()], "label").slice(0, TOP),
        services: ranked([...shop.services].map(([kind, n]) => ({ kind, count: n })), "kind"),
        refusalReasons: ranked([...shop.reasons].map(([why, n]) => ({ why, count: n })), "why").slice(0, TOP)
    }));
}

/**
 * Where the coins these events can see went: in from robbery payouts and shop sales, out to shop purchases. The robberies' figures are the ones
 * the page shows (so with test runs left out they are left out here), and the round's total is the newest round's, for comparison. Bounty is not
 * coins, so it is kept apart. Coins from anywhere else (a kill's reward, say) are not in any event, so they are not here.
 */
function coinFlow(robberies, shops, rounds) {

    const robberyCoins = sum(robberies.list.map((x) => x.coins.total));
    const shopSales = sum(shops.map((x) => x.got));
    const out = sum(shops.map((x) => x.spent));

    return {
        robberyCoins,
        robberyBounty: sum(robberies.list.map((x) => x.bounty.total)),
        shopSales,
        in: robberyCoins + shopSales,
        out,
        net: robberyCoins + shopSales - out,
        lastRoundCoins: rounds.coins === null ? null : rounds.coins.last
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

    const rounds = roundsSection(chosen);
    const robberies = robberiesSection(chosen, includeTests === true);
    const shops = shopsSection(chosen);

    return { world: world ?? null, rounds, robberies, shops: { list: shops, flow: coinFlow(robberies, shops, rounds) }, data: dataSection(sorted, ingest) };
}
