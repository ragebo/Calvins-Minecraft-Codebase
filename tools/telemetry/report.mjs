// Turns the figures into what a person opens: one HTML file that stands alone (no script, nothing fetched from anywhere), and one CSV per kind of
// event for a spreadsheet. Pure, like aggregate.mjs: figures in, text out; the command line writes the files.
//
// The look follows the dataviz method: law is the first palette hue and outlaw the second wherever they appear, so a colour means the same thing
// all through the page, and "aborted" is neutral gray because it is context, not a side. Both colours pass the palette validator in light and dark
// (colour-blind separation and contrast against the page). Every number is also in the text next to its bar, so no colour carries a fact alone.

import { byTime } from "./aggregate.mjs";

const two = (n) => String(n).padStart(2, "0");

const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A length of ticks (20 to a second) as `4:00`, or `1:05:00` once it needs hours. */
export function clock(ticks) {

    const total = Math.round(ticks / 20);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

const when = (at) => at.slice(0, 16).replace("T", " ");
const day = (at) => at.slice(0, 10);
const count = (n) => Number(n).toLocaleString("en-US");
const one = (n) => String(Math.round(n * 10) / 10);
const percent = (share) => `${Math.round(share * 100)}%`;
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** How a round ended, in words, and the colour class that goes with it. */
const RESULTS = { law_win: ["Law won", "law"], outlaw_win: ["Outlaw won", "outlaw"], aborted: ["Aborted", "neutral"] };

/**
 * How a robbery run ended. A win and a fail are states, not sides, so they wear the fixed status colours (green and red) and not the law and
 * outlaw colours, which mean a side everywhere else on the page; each also has its label and its number in the text.
 */
const RUN_RESULTS = { win: ["Won", "good"], fail: ["Failed", "critical"], stopped: ["Stopped", "neutral"], round: ["Cut short by a round reset", "neutral"], unfinished: ["No end recorded", "neutral"] };

const STYLE = `
:root { color-scheme: light dark; --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e1e0d9; --border: rgba(11,11,11,0.10); --law: #2a78d6; --outlaw: #eb6834; --neutral: #898781; --good: #0ca30c; --critical: #d03b3b; }
@media (prefers-color-scheme: dark) {
  :root { --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --grid: #2c2c2a; --border: rgba(255,255,255,0.10); --law: #3987e5; --outlaw: #d95926; --neutral: #898781; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header, main { max-width: 64rem; margin: 0 auto; padding: 0 1rem; }
header { padding-top: 2rem; }
h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; margin: 0 0 0.75rem; }
p { margin: 0 0 0.6rem; }
.sub, .empty, .note { color: var(--ink-2); }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin: 1.25rem 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; }
.tile { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; }
.tile .label, .tile .hint { color: var(--ink-2); font-size: 0.85rem; }
.tile .value { font-size: 1.9rem; font-weight: 600; line-height: 1.2; }
.share { display: flex; gap: 2px; height: 14px; border-radius: 0 4px 4px 0; overflow: hidden; }
.share span { display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; list-style: none; padding: 0; margin: 0.6rem 0 1.25rem; }
.sw { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 2px; margin-right: 0.4rem; }
.law { background: var(--law); }
.outlaw { background: var(--outlaw); }
.neutral { background: var(--neutral); }
.good { background: var(--good); }
.critical { background: var(--critical); }
.wide { overflow-x: auto; margin-bottom: 1rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
caption { text-align: left; font-weight: 600; padding: 0 0 0.5rem; }
th, td { padding: 0.35rem 0.6rem; text-align: left; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; white-space: nowrap; }
th { color: var(--ink-2); font-weight: 600; }
.num { text-align: right; }
.track { display: inline-block; width: 5rem; margin-left: 0.5rem; vertical-align: middle; }
.bar { display: block; height: 6px; border-radius: 0 3px 3px 0; background: var(--neutral); }
`;

function tile(label, value, hint) {
    return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;
}

function roundsHtml(figures) {

    const r = figures.rounds;

    if (r.count === 0) return `<section aria-labelledby="rounds"><h2 id="rounds">Rounds</h2><p class="empty">No finished rounds in this data yet.</p></section>`;

    const wins = r.byReason.law_win ?? 0;
    const parts = [["law_win", "Law won"], ["outlaw_win", "Outlaw won"], ["aborted", "Aborted"]].map(([reason, label]) => ({ label, count: r.byReason[reason] ?? 0, cls: RESULTS[reason][1] }));
    const other = r.count - parts.reduce((total, part) => total + part.count, 0);

    if (other > 0) parts.push({ label: "Other", count: other, cls: "neutral" });

    const summary = parts.map((part, i) => `${i === 0 ? part.label : part.label[0].toLowerCase() + part.label.slice(1)} ${part.count}`).join(", ");

    const bar = parts.filter((part) => part.count > 0)
        .map((part) => `<span class="${part.cls}" style="flex: ${part.count} 1 0" title="${esc(part.label)}: ${part.count} of ${r.count} rounds"></span>`).join("");

    const legend = parts.map((part) => `<li><span class="sw ${part.cls}"></span>${esc(part.label)} <b>${count(part.count)}</b></li>`).join("");

    const longest = Math.max(1, ...r.latest.map((x) => x.dur));

    const rows = r.latest.map((x) => {
        const [label, cls] = RESULTS[x.reason] ?? [x.reason, "neutral"];

        return `<tr><td>${when(x.at)}</td><td>${esc(x.w)}</td><td><span class="sw ${cls}"></span>${esc(label)}</td>`
            + `<td class="num">${clock(x.dur)}<span class="track" aria-hidden="true"><span class="bar" style="width: ${Math.round((x.dur / longest) * 100)}%"></span></span></td>`
            + `<td class="num">${count(x.kills)}</td><td class="num">${count(x.deaths)}</td><td class="num">${count(x.lawKills)}</td><td class="num">${count(x.outlawKills)}</td><td class="num">${count(x.coins)}</td></tr>`;
    }).join("");

    return `<section aria-labelledby="rounds">
<h2 id="rounds">Rounds</h2>
<div class="tiles">
${tile("Rounds", count(r.count), "finished")}
${tile("Law win rate", r.lawWinShare === null ? "n/a" : percent(r.lawWinShare), r.decided === 0 ? "no round was decided" : `${wins} of ${r.decided} decided`)}
${tile("Median length", clock(r.length.median), `average ${clock(r.length.average)}`)}
${tile("Kills per round", one(r.kills.perRound), `${one(r.deaths.perRound)} deaths per round`)}
</div>
<div class="share" role="img" aria-label="${esc(summary)} of ${r.count} rounds">${bar}</div>
<ul class="legend">${legend}</ul>
<div class="wide"><table>
<caption>Latest rounds</caption>
<thead><tr><th scope="col">When</th><th scope="col">World</th><th scope="col">Result</th><th scope="col" class="num">Length</th><th scope="col" class="num">Kills</th><th scope="col" class="num">Deaths</th><th scope="col" class="num">Law kills</th><th scope="col" class="num">Outlaw kills</th><th scope="col" class="num">Coins at end</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>`;
}

/** A robbery's section: how its runs ended, its elements, and its newest runs. */
function robberyHtml(x, index) {

    const wins = x.byResult.win;
    const parts = Object.entries(RUN_RESULTS).map(([result, [label, cls]]) => ({ label, cls, count: x.byResult[result] ?? 0 }));
    const other = x.runs - parts.reduce((total, part) => total + part.count, 0);

    if (other > 0) parts.push({ label: "Other", cls: "neutral", count: other });

    const summary = parts.map((part, i) => `${i === 0 ? part.label : part.label[0].toLowerCase() + part.label.slice(1)} ${part.count}`).join(", ");
    const bar = parts.filter((part) => part.count > 0).map((part) => `<span class="${part.cls}" style="flex: ${part.count} 1 0" title="${esc(part.label)}: ${part.count} of ${x.runs} runs"></span>`).join("");
    const legend = parts.map((part) => `<li><span class="sw ${part.cls}"></span>${esc(part.label)} <b>${count(part.count)}</b></li>`).join("");

    const elementRows = x.elements.map((row) => `<tr><td>${esc(row.name || row.el)}${row.kind === null ? "" : ` (${esc(row.kind)})`}</td><td class="num">${count(row.completed)}</td>`
        + `<td class="num">${percent(row.share)}<span class="track" aria-hidden="true"><span class="bar" style="width: ${Math.round(row.share * 100)}%"></span></span></td>`
        + `<td class="num">${row.medianAfter === null ? "-" : clock(row.medianAfter)}</td><td class="num">${count(row.jams)}</td><td class="num">${row.avgMisses === null ? "-" : one(row.avgMisses)}</td></tr>`).join("");

    const runRows = x.latest.map((run) => {
        const [label, cls] = run.result === null ? RUN_RESULTS.unfinished : RUN_RESULTS[run.result] ?? [run.result, "neutral"];
        const ended = run.result !== null;

        return `<tr><td>${when(run.at)}</td><td>${esc(run.w)}</td><td><span class="sw ${cls}"></span>${esc(label)}</td>`
            + `<td class="num">${ended ? clock(run.dur) : "-"}</td><td class="num">${ended ? `${count(run.done)} of ${count(run.of)}` : "-"}</td><td class="num">${ended ? count(run.people) : "-"}</td>`
            + `<td class="num">${count(run.coins)}</td><td class="num">${count(run.bounty)}</td><td>${run.test ? "test" : ""}</td></tr>`;
    }).join("");

    return `<section aria-labelledby="robbery-${index}">
<h2 id="robbery-${index}">Robbery: ${esc(x.id)}</h2>
<div class="tiles">
${tile("Runs", count(x.runs), "recorded")}
${tile("Win rate", x.winShare === null ? "n/a" : percent(x.winShare), x.decided === 0 ? "none decided" : `${wins} of ${x.decided} decided`)}
${tile("Median length", x.length === null ? "n/a" : clock(x.length.median), x.length === null ? "no run ended" : `average ${clock(x.length.average)}`)}
${tile("Paid per run", `${one(x.coins.perRun)} coins`, `${one(x.bounty.perRun)} bounty`)}
</div>
<div class="share" role="img" aria-label="${esc(summary)} of ${x.runs} runs">${bar}</div>
<ul class="legend">${legend}</ul>
<div class="wide"><table>
<caption>Elements</caption>
<thead><tr><th scope="col">Element</th><th scope="col" class="num">Done in</th><th scope="col" class="num">Share of runs</th><th scope="col" class="num">Median time in</th><th scope="col" class="num">Jams</th><th scope="col" class="num">Average misses</th></tr></thead>
<tbody>${elementRows}</tbody>
</table></div>
${x.untouched > 0 ? `<p class="note">${plural(x.untouched, "more element")} ${x.untouched === 1 ? "was" : "were"} never touched in these runs.</p>` : ""}
<div class="wide"><table>
<caption>Latest runs</caption>
<thead><tr><th scope="col">When</th><th scope="col">World</th><th scope="col">Result</th><th scope="col" class="num">Length</th><th scope="col" class="num">Elements</th><th scope="col" class="num">People</th><th scope="col" class="num">Coins</th><th scope="col" class="num">Bounty</th><th scope="col">Note</th></tr></thead>
<tbody>${runRows}</tbody>
</table></div>
</section>`;
}

/** The robberies: a note about test runs where there is one to make, then a section for each robbery. */
function robberiesHtml(figures) {

    const r = figures.robberies;
    const note = r.includeTests ? "Test runs are included, and marked."
        : r.excludedTests > 0 ? `${plural(r.excludedTests, "test run")} ${r.excludedTests === 1 ? "is" : "are"} left out (run with --include-tests to see ${r.excludedTests === 1 ? "it" : "them"}).` : "";

    const intro = note === "" ? "" : `<section aria-labelledby="robberies"><h2 id="robberies">Robberies</h2><p class="note">${note}</p></section>`;

    return `${intro}${r.list.map(robberyHtml).join("\n")}`;
}

/** A shop's section: its visits and coins, the deals done most, the services, and why customers were turned away. */
function shopHtml(x, index) {

    const dealRows = x.topDeals.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(d.face)}</td><td class="num">${count(d.count)}</td><td class="num">${count(d.spent)}</td><td class="num">${count(d.got)}</td></tr>`).join("");
    const reasonRows = x.refusalReasons.map((r) => `<tr><td>${esc(r.why)}</td><td class="num">${count(r.count)}</td></tr>`).join("");

    const deals = x.trades === 0 ? `<p class="empty">No deals were done here yet.</p>` : `<div class="wide"><table>
<caption>Top deals</caption>
<thead><tr><th scope="col">Deal</th><th scope="col">Kind</th><th scope="col" class="num">Times</th><th scope="col" class="num">Coins paid</th><th scope="col" class="num">Coins received</th></tr></thead>
<tbody>${dealRows}</tbody>
</table></div>`;

    const services = x.services.length === 0 ? "" : `<p>Services done: ${x.services.map((s) => `${esc(s.kind)} ${count(s.count)}`).join(", ")}</p>`;

    const reasons = x.refusals === 0 ? "" : `<div class="wide"><table>
<caption>Why customers were refused</caption>
<thead><tr><th scope="col">Reason</th><th scope="col" class="num">Times</th></tr></thead>
<tbody>${reasonRows}</tbody>
</table></div>`;

    return `<section aria-labelledby="shop-${index}">
<h2 id="shop-${index}">Shop: ${esc(x.id)}</h2>
<div class="tiles">
${tile("Visits", count(x.opens), plural(x.customers, "customer"))}
${tile("Deals done", count(x.trades), x.tradesPerOpen === null ? "no visit recorded" : `${one(x.tradesPerOpen)} per visit`)}
${tile("Spent by customers", count(x.spent), "coins paid for goods and services")}
${tile("Paid to customers", count(x.got), "coins for what they sold")}
</div>
${deals}
${services}
${reasons}
</section>`;
}

/** Coins in against coins out, as far as the events can see, with the last round's total beside them. */
function flowHtml(figures) {

    const s = figures.shops;

    if (s.list.length === 0 && figures.robberies.list.length === 0) return "";

    const f = s.flow;
    const net = f.net > 0 ? `+${count(f.net)}` : f.net < 0 ? `-${count(-f.net)}` : "0";

    const round = f.lastRoundCoins === null ? "Last round ended with n/a: no round has finished in this data." : `Last round ended with ${count(f.lastRoundCoins)} coins held by the gang.`;

    return `<section aria-labelledby="flow">
<h2 id="flow">Coin flow</h2>
<div class="tiles">
${tile("Coins in", count(f.in), `${count(f.robberyCoins)} from robberies, ${count(f.shopSales)} from shop sales`)}
${tile("Coins out", count(f.out), "spent in shops")}
${tile("Net", net, "coins in minus coins out")}
</div>
<p>${round}</p>
<p class="note">Only robbery payouts and shop deals are counted. Robbery bounty (${count(f.robberyBounty)}) is not coins, and coins from anywhere else are not recorded.</p>
</section>`;
}

/** The coin flow first, as the overview, then a section for each shop. */
function shopsHtml(figures) {
    return `${flowHtml(figures)}${figures.shops.list.map(shopHtml).join("\n")}`;
}

function dataHtml(figures) {

    const d = figures.data;
    const i = d.ingest;

    const read = i === null ? "" : `<p>Last read: ${plural(i.files, "log file")}, ${plural(i.found, "telemetry line")}: ${count(i.added)} new, ${count(i.duplicates)} already known, ${count(i.skipped)} skipped (another format), ${count(i.damaged)} damaged, ${count(i.unfinished)} cut off (the game was still writing), ${count(i.unreadable)} unreadable.</p>`;

    const worlds = d.worlds.map((w) => `<tr><td>${esc(w.w)}</td><td class="num">${count(w.events)}</td><td>${when(w.firstAt)}</td><td>${when(w.lastAt)}</td></tr>`).join("");
    const builds = d.builds.map((b) => `<tr><td>${esc(b.bv)}</td><td class="num">${count(b.events)}</td></tr>`).join("");

    const tables = d.events === 0 ? "" : `<p>The game's scripts loaded ${plural(d.boots, "time")}.</p>
<div class="wide"><table><caption>Worlds</caption><thead><tr><th scope="col">World</th><th scope="col" class="num">Events</th><th scope="col">First</th><th scope="col">Last</th></tr></thead><tbody>${worlds}</tbody></table></div>
<div class="wide"><table><caption>Game builds</caption><thead><tr><th scope="col">Build</th><th scope="col" class="num">Events</th></tr></thead><tbody>${builds}</tbody></table></div>`;

    return `<section aria-labelledby="data">
<h2 id="data">About this data</h2>
${read}
<p>The game's rate limit dropped ${d.dropped === 0 ? "no lines" : plural(d.dropped, "line")}.</p>
${tables}
</section>`;
}

/**
 * The whole page. `generated` is when it was made, as text, so this stays a pure function of its input.
 */
export function renderReport(figures, { generated }) {

    const d = figures.data;
    const period = d.events === 0 ? "" : `, ${day(d.firstAt)} to ${day(d.lastAt)}`;
    const nothing = `<section aria-labelledby="none"><h2 id="none">No telemetry yet</h2><p class="empty">The game writes it when a world loads and when a round ends, so it needs a build that has telemetry in it and a world loaded since. Play, then run this again.</p></section>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RAE telemetry</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>RAE telemetry</h1>
<p class="sub">Made ${esc(generated)} from ${plural(d.events, "event")}${period}.</p>
${figures.world === null ? "" : `<p class="note">Showing world ${esc(figures.world)} only.</p>`}
</header>
<main>
${d.events === 0 ? nothing : roundsHtml(figures)}
${robberiesHtml(figures)}
${shopsHtml(figures)}
${dataHtml(figures)}
</main>
</body>
</html>
`;
}

const STAMP_COLUMNS = ["at", "w", "b", "n", "t", "bv"];

/** What the line's own `v` and `k` would add to every row: the file's name says the kind, and the version is the same all through. */
const LEFT_OUT = new Set(["v", "k"]);

/** A byte order mark. With it at the start of the file Excel reads the text as UTF-8, not as the local code page. */
const BOM = String.fromCharCode(0xfeff);

function cell(value) {

    if (value === undefined || value === null) return "";

    const text = Array.isArray(value) ? value.join(" | ") : typeof value === "object" ? JSON.stringify(value) : String(value);

    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One CSV per kind of event, as a map from the kind to the file's text: the stamp's columns, then the kind's own fields in the order they first
 * appear, a row per event oldest first, a list as its entries joined by " | ". A mark at the start lets Excel read it as UTF-8.
 */
export function toCsv(events) {

    const byKind = new Map();

    for (const event of [...events].sort(byTime)) {
        if (!byKind.has(event.k)) byKind.set(event.k, []);
        byKind.get(event.k).push(event);
    }

    const files = new Map();

    for (const [kind, list] of byKind) {

        const columns = [...STAMP_COLUMNS];

        for (const event of list) {
            for (const key of Object.keys(event)) {
                if (!columns.includes(key) && !LEFT_OUT.has(key)) columns.push(key);
            }
        }

        const rows = [columns.join(","), ...list.map((event) => columns.map((column) => cell(event[column])).join(","))];

        files.set(kind, `${BOM}${rows.join("\r\n")}\r\n`);
    }

    return files;
}
