// core/ui: the one writer for the title, the action bar and chat.
//
// The action bar is arbitrated: every line is posted under a source name and a priority, and only the winner reaches
// the screen. What a player was sent is read back from the fake player's `actionBar` array, one entry per packet.
// Time only moves when a test moves it (fake.advance), so every ttl boundary below is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { fake, load, checks, strip } from "./helpers.mjs";

const ui = await load("core/ui.js");
const { COMPASS } = await load("config/balance.js");
await load("systems/compass.js");   // the compass is the first real caller; the last test drives it
const { listSystems } = await load("core/registry.js");

const { ACTION_BAR_PRIORITY: PRIORITY, DEFAULT_ACTION_BAR_TTL_TICKS: TTL } = ui;
const AMBIENT = { priority: PRIORITY.ambient };
const ALERT = { priority: PRIORITY.alert };
const COMPASS_ITEM = "bountysys:law_compass";

const registered = (name) => listSystems().find((s) => s.name === name);

/** A world with the named players (ids fake-player-<name>), and nobody holding any line. */
function scene(...names) {
    fake.reset();
    registered("ui").reset();
    return names.map((name) => fake.makePlayer(name));
}

/** check() for action bars: passes when `player` has been sent exactly `lines`, in order. */
const barCheck = (check) => (name, player, ...lines) =>
    check(name, isDeepStrictEqual(player.actionBar, lines), `\n      sent ${JSON.stringify(player.actionBar)}\n      want ${JSON.stringify(lines)}`);

/** Records the exact arguments the player's setTitle receives, and still lets the call through. */
function recordTitles(player) {
    const calls = [];
    const original = player.onScreenDisplay.setTitle;
    player.onScreenDisplay.setTitle = (...args) => { calls.push(args); return original(...args); };
    return calls;
}

// ---------------------------------------------------------------------------
// Set-up
// ---------------------------------------------------------------------------

test("the priorities are ordered, and the ttl is a whole number of ticks that outlasts the compass's refresh", () => {
    const { check, done } = checks();
    check("ambient < tool < alert", PRIORITY.ambient < PRIORITY.tool && PRIORITY.tool < PRIORITY.alert, JSON.stringify(PRIORITY));
    check("the ttl is a positive whole number", Number.isInteger(TTL) && TTL > 0, `(${TTL})`);
    check("the compass posts again before its line can run out, so the bar never lapses between two posts",
        TTL > COMPASS.updateIntervalTicks, `(ttl ${TTL}, compass interval ${COMPASS.updateIntervalTicks})`);
    done();
});

test("registers as the ui system, and a round reset drops every held line", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    check("registered as ui", listSystems().some((s) => s.name === "ui"));
    const [p] = scene("Bob");
    ui.setActionBar(p, "danger", "ALERT", ALERT);
    ui.setActionBar(p, "hud", "HUD 1", AMBIENT);
    bar("(setup) the alert holds the bar against the hud line", p, "ALERT");
    registered("ui").reset();
    bar("a reset sends nothing by itself", p, "ALERT");
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("after the reset the old alert no longer blocks anything", p, "ALERT", "HUD 2");
    check("nothing went to chat", fake.chat.length === 0, JSON.stringify(fake.chat));
    done();
});

// ---------------------------------------------------------------------------
// Arbitration
// ---------------------------------------------------------------------------

test("priority: a later, lower-priority post is kept but sends nothing", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "compass", "COMPASS");                 // no options: the tool priority
    ui.setActionBar(p, "hud", "HUD", AMBIENT);
    bar("the ambient line did not overwrite the compass", p, "COMPASS");
    for (let i = 0; i < 5; i++) {
        fake.advance(4);
        ui.setActionBar(p, "compass", "COMPASS");
        ui.setActionBar(p, "hud", "HUD", AMBIENT);
    }
    bar("nor did it on any of the repeats", p, "COMPASS", "COMPASS", "COMPASS", "COMPASS", "COMPASS", "COMPASS");
    done();
});

test("expiry: a lower-priority source shows again once the winner's line has run out", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "compass", "COMPASS");
    fake.advance(TTL - 1);
    ui.setActionBar(p, "hud", "HUD 1", AMBIENT);
    bar("one tick before the ttl the compass line still holds the bar", p, "COMPASS");
    fake.advance(1);
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("exactly at the ttl it has run out and the ambient line is shown", p, "COMPASS", "HUD 2");
    done();
});

test("expiry: posting again restarts the ttl and replaces the line", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "compass", "OLD");
    fake.advance(TTL - 10);
    ui.setActionBar(p, "compass", "NEW");                     // runs out at 2*TTL - 10 ticks after the first post
    fake.advance(10);                                         // the first post's ttl is up by now
    ui.setActionBar(p, "hud", "HUD 1", AMBIENT);
    bar("the refresh kept the compass line alive past the first post's ttl", p, "OLD", "NEW");
    fake.advance(TTL - 11);
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("and it still holds one tick before the new ttl is up", p, "OLD", "NEW");
    fake.advance(1);
    ui.setActionBar(p, "hud", "HUD 3", AMBIENT);
    bar("then it runs out", p, "OLD", "NEW", "HUD 3");
    done();
});

test("expiry: ttlTicks sets how long a line holds the bar, and it is at least one tick", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "danger", "ALERT", { priority: PRIORITY.alert, ttlTicks: 10 });
    fake.advance(9);
    ui.setActionBar(p, "hud", "HUD 1", AMBIENT);
    bar("a ttl of 10 still holds at tick 9", p, "ALERT");
    fake.advance(1);
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("and has run out at tick 10, well before the default would have", p, "ALERT", "HUD 2");

    ui.setActionBar(p, "danger", "ALERT 2", { priority: PRIORITY.alert, ttlTicks: 0 });
    ui.setActionBar(p, "hud", "HUD 3", AMBIENT);
    bar("a ttl of 0 counts as one tick: it holds the bar for the tick it was posted in", p, "ALERT", "HUD 2", "ALERT 2");
    fake.advance(1);
    ui.setActionBar(p, "hud", "HUD 4", AMBIENT);
    bar("and is gone on the next", p, "ALERT", "HUD 2", "ALERT 2", "HUD 4");
    done();
});

test("equal priority: the latest post wins, and posting with no options ties with the tool priority", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "a", "A1");
    ui.setActionBar(p, "b", "B1", { priority: PRIORITY.tool });
    ui.setActionBar(p, "a", "A2");
    ui.setActionBar(p, "b", "B2");
    bar("every post goes out, the newest one taking the bar each time", p, "A1", "B1", "A2", "B2");
    done();
});

test("a higher priority displaces a lower one at once, and holds the bar while it is fresh", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "hud", "HUD", AMBIENT);
    ui.setActionBar(p, "compass", "COMPASS");
    ui.setActionBar(p, "danger", "ALERT", ALERT);
    bar("each step up went out immediately", p, "HUD", "COMPASS", "ALERT");
    ui.setActionBar(p, "compass", "COMPASS");
    ui.setActionBar(p, "hud", "HUD", AMBIENT);
    bar("the alert holds the bar against both", p, "HUD", "COMPASS", "ALERT");
    fake.advance(TTL - 1);
    ui.setActionBar(p, "compass", "COMPASS");
    bar("right up to the last tick of its ttl", p, "HUD", "COMPASS", "ALERT");
    fake.advance(1);
    ui.setActionBar(p, "compass", "COMPASS 2");
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("then the compass takes over, and the ambient line still waits behind it", p, "HUD", "COMPASS", "ALERT", "COMPASS 2");
    done();
});

// ---------------------------------------------------------------------------
// clearActionBar
// ---------------------------------------------------------------------------

test("clearActionBar: the winner gives way to the next best line at once, and then to an empty bar", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "hud", "HUD", AMBIENT);
    ui.setActionBar(p, "compass", "COMPASS");
    ui.setActionBar(p, "danger", "ALERT", ALERT);
    ui.clearActionBar(p, "danger");
    bar("the alert's next best is the compass line", p, "HUD", "COMPASS", "ALERT", "COMPASS");
    ui.clearActionBar(p, "compass");
    bar("after that, the ambient line", p, "HUD", "COMPASS", "ALERT", "COMPASS", "HUD");
    ui.clearActionBar(p, "hud");
    bar("with nothing left, the bar is emptied with an empty string", p, "HUD", "COMPASS", "ALERT", "COMPASS", "HUD", "");
    done();
});

test("clearActionBar: a line that is not on screen, or was never posted, sends nothing; a cleared line stays gone", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p, q, d] = scene("Bob", "Cy", "Dee");
    ui.setActionBar(p, "danger", "ALERT", ALERT);
    ui.setActionBar(p, "hud", "HUD", AMBIENT);
    ui.clearActionBar(p, "hud");
    bar("clearing a line hidden behind the alert changes nothing on screen", p, "ALERT");
    ui.clearActionBar(p, "nobody");
    bar("clearing a source that never posted sends nothing", p, "ALERT");
    ui.clearActionBar(q, "danger");
    check("nor does clearing for a player who never posted anything", q.actionBar.length === 0);
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("the alert still holds the bar afterwards", p, "ALERT");
    ui.clearActionBar(p, "danger");
    bar("clearing it hands the bar to the ambient line posted since", p, "ALERT", "HUD 2");
    ui.clearActionBar(p, "danger");
    bar("clearing it a second time sends nothing", p, "ALERT", "HUD 2");

    ui.setActionBar(d, "compass", "COMPASS");
    ui.clearActionBar(d, "compass");
    ui.setActionBar(d, "hud", "HUD", AMBIENT);
    bar("a cleared line no longer holds the bar against lower priorities", d, "COMPASS", "", "HUD");
    done();
});

test("clearActionBar: a line that has run out is never brought back or cleared again", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "danger", "ALERT", ALERT);
    ui.setActionBar(p, "hud", "HUD", { priority: PRIORITY.ambient, ttlTicks: 10 });   // kept behind the alert
    fake.advance(11);                                         // the ambient line has run out, the alert has not
    ui.clearActionBar(p, "danger");
    bar("clearing the alert empties the bar rather than resurrecting the stale ambient line", p, "ALERT", "");

    ui.setActionBar(p, "compass", "COMPASS");
    fake.advance(TTL);
    ui.clearActionBar(p, "compass");
    bar("clearing a line that already ran out sends nothing", p, "ALERT", "", "COMPASS");
    done();
});

// ---------------------------------------------------------------------------
// One table per player id
// ---------------------------------------------------------------------------

function twoPlayers(nameA, nameB) {
    const { check, done } = checks();
    const bar = barCheck(check);
    fake.reset();
    registered("ui").reset();
    const a = fake.makePlayer(nameA, { id: "id-a" });
    const b = fake.makePlayer(nameB, { id: "id-b" });
    ui.setActionBar(a, "danger", "ALERT A", ALERT);
    ui.setActionBar(b, "hud", "HUD B", AMBIENT);
    bar("b's line is not held back by a's alert", b, "HUD B");
    ui.setActionBar(a, "hud", "HUD A", AMBIENT);
    bar("a's own ambient line still loses to a's alert", a, "ALERT A");
    ui.clearActionBar(a, "danger");
    bar("clearing a's alert shows a's next best line", a, "ALERT A", "HUD A");
    bar("and sends b nothing", b, "HUD B");
    ui.clearActionBar(b, "hud");
    bar("clearing b's only line empties b's bar", b, "HUD B", "");
    bar("and leaves a's alone", a, "ALERT A", "HUD A");
    done();
}

test("players are independent of each other", () => twoPlayers("Ann", "Bea"));

test("two players with the same name and different ids are independent (keyed by id, never the name)", () => twoPlayers("Twin", "Twin"));

// ---------------------------------------------------------------------------
// Never de-duplicate
// ---------------------------------------------------------------------------

test("an unchanged line is sent again on every post", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    // The client fades an action bar about two seconds after its LAST packet, so a source keeps its line up by repeating it.
    for (let i = 0; i < 5; i++) {
        ui.setActionBar(p, "compass", "SAME");
        fake.advance(COMPASS.updateIntervalTicks);
    }
    bar("five identical posts send five packets", p, ...Array(5).fill("SAME"));
    ui.setActionBar(p, "danger", "SAME", ALERT);
    ui.setActionBar(p, "danger", "SAME", ALERT);
    bar("the same text from another source is sent as well, each time", p, ...Array(7).fill("SAME"));
    done();
});

test("nonsense options fall back to the defaults instead of making a line immortal or unbeatable", () => {
    const { check, done } = checks();
    const bar = barCheck(check);
    const [p] = scene("Bob");
    ui.setActionBar(p, "compass", "COMPASS", { ttlTicks: NaN });
    fake.advance(TTL - 1);
    ui.setActionBar(p, "hud", "HUD 1", AMBIENT);
    bar("a NaN ttl is the default: it still holds one tick before it is up", p, "COMPASS");
    fake.advance(1);
    ui.setActionBar(p, "hud", "HUD 2", AMBIENT);
    bar("and it does run out, rather than holding the bar for ever", p, "COMPASS", "HUD 2");

    ui.setActionBar(p, "compass", "COMPASS 2", { priority: NaN });
    bar("a NaN priority is the default, the tool priority, which beats the ambient line", p, "COMPASS", "HUD 2", "COMPASS 2");
    ui.setActionBar(p, "hud", "HUD 3", AMBIENT);
    bar("and keeps beating it", p, "COMPASS", "HUD 2", "COMPASS 2");
    done();
});

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

test("showTitle: no options passes the title alone; options use the engine's names and fill in the timings left out", () => {
    const { check, done } = checks();
    const [p] = scene("Bob");
    const calls = recordTitles(p);
    const last = () => JSON.stringify(calls.at(-1));

    ui.showTitle(p, "§eRolling...");
    check("no options: exactly one argument, the title", isDeepStrictEqual(calls.at(-1), ["§eRolling..."]), last());
    check("and it reaches the screen", p.titles.at(-1) === "§eRolling...");

    ui.showTitle(p, "Chapter 1", { subtitle: "Trouble", fadeInTicks: 2, stayTicks: 100, fadeOutTicks: 4 });
    check("every option, under the engine's names (fadeInDuration, stayDuration, fadeOutDuration, subtitle)",
        isDeepStrictEqual(calls.at(-1), ["Chapter 1", { subtitle: "Trouble", fadeInDuration: 2, stayDuration: 100, fadeOutDuration: 4 }]), last());

    ui.showTitle(p, "T", { subtitle: "S" });
    const subtitleOnly = calls.at(-1)[1];
    const timings = (o) => [o.fadeInDuration, o.stayDuration, o.fadeOutDuration];
    check("a subtitle alone still carries all three timings, as numbers the engine accepts",
        subtitleOnly.subtitle === "S" && timings(subtitleOnly).every((n) => Number.isFinite(n) && n >= 0), last());

    ui.showTitle(p, "T", { stayTicks: 100 });
    const stayOnly = calls.at(-1)[1];
    check("one timing alone: it is kept, the others are filled in, and there is no subtitle key at all",
        stayOnly.stayDuration === 100 && timings(stayOnly).every(Number.isFinite) && !("subtitle" in stayOnly), last());

    ui.showTitle(p, "T", { fadeInTicks: 0, stayTicks: 0, fadeOutTicks: 0 });
    check("zero is a real timing, not a missing one",
        isDeepStrictEqual(calls.at(-1)[1], { fadeInDuration: 0, stayDuration: 0, fadeOutDuration: 0 }), last());
    done();
});

test("clearTitle sets an empty title, which is how the engine clears one", () => {
    const [p] = scene("Bob");
    const calls = recordTitles(p);
    ui.showTitle(p, "LAWMAN");
    ui.clearTitle(p);
    assert.deepEqual(calls, [["LAWMAN"], [""]]);
    assert.deepEqual(p.titles, ["LAWMAN", ""]);
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

test("format, tell and announce", () => {
    const { check, done } = checks();
    check("the tones are the colour codes the game already uses",
        isDeepStrictEqual({ ...ui.TONE }, { ok: "§a", warn: "§e", bad: "§c", info: "§7", accent: "§6", law: "§9" }), JSON.stringify(ui.TONE));
    for (const tone of Object.keys(ui.TONE)) {
        check(`format("${tone}") is the tone's code in front of the text and nothing after it`,
            ui.format(tone, "text") === `${ui.TONE[tone]}text`, ui.format(tone, "text"));
    }
    check("the visible text is untouched", strip(ui.format("bad", "Only law can use the compass.")) === "Only law can use the compass.");

    const [p, q] = scene("Bob", "Cy");
    ui.tell(p, "psst");
    check("tell reaches that player only, and not world chat", isDeepStrictEqual(p.messages, ["psst"]) && q.messages.length === 0 && fake.chat.length === 0,
        `${JSON.stringify(p.messages)} ${JSON.stringify(q.messages)} ${JSON.stringify(fake.chat)}`);
    ui.announce("hear ye");
    check("announce goes to world chat and to no player's private messages",
        isDeepStrictEqual(fake.chat, ["hear ye"]) && p.messages.length === 1 && q.messages.length === 0, JSON.stringify(fake.chat));
    done();
});

test("an engine failure reaches the caller, and nothing is reported to chat", () => {
    const [p] = scene("Bob");
    p.isValid = false;                                        // the fake throws InvalidEntityError for a removed player, as the game does
    assert.throws(() => ui.setActionBar(p, "compass", "COMPASS"), /InvalidEntityError/);
    assert.throws(() => ui.showTitle(p, "T"), /InvalidEntityError/);
    assert.deepEqual(fake.chat, []);
});

// ---------------------------------------------------------------------------
// The compass, the first real caller
// ---------------------------------------------------------------------------

test("the compass posts through core/ui: it keeps refreshing, an ambient line cannot overwrite it, and it lets go after it is put away", () => {
    const { check, done } = checks();
    fake.reset();
    registered("ui").reset();
    registered("compass").reset();
    const sheriff = fake.makePlayer("Sheriff", { tags: ["law"], holding: COMPASS_ITEM });
    fake.makePlayer("Near", { tags: ["outlaw"], location: { x: 10, y: 64, z: 0 } });

    // Five compass passes, each followed by an ambient post that must lose.
    for (let i = 0; i < 5; i++) {
        fake.advance(COMPASS.updateIntervalTicks);
        ui.setActionBar(sheriff, "hud", "HUD", AMBIENT);
    }
    const readouts = [...sheriff.actionBar];
    check("every pass sent its readout, although the text never changed", readouts.length === 5 && new Set(readouts).size === 1,
        `(${readouts.length} packets, ${new Set(readouts).size} distinct)`);
    check("and it is the compass readout", strip(readouts[0] ?? "").includes("NEAREST") && strip(readouts[0] ?? "").includes("Near"), strip(readouts[0] ?? ""));
    check("the ambient line never got through while the compass was held", !readouts.includes("HUD"));

    // Put the compass away. It stops posting, and its last post keeps the bar until its ttl is up: which is somewhere in
    // the last COMPASS.updateIntervalTicks ticks before now, plus the ttl.
    sheriff.holding = null;
    fake.advance(TTL - COMPASS.updateIntervalTicks);
    ui.setActionBar(sheriff, "hud", "HUD", AMBIENT);
    check("the compass's last post still holds the bar for its ttl", !sheriff.actionBar.includes("HUD"), JSON.stringify(sheriff.actionBar.slice(5)));
    fake.advance(COMPASS.updateIntervalTicks);
    ui.setActionBar(sheriff, "hud", "HUD", AMBIENT);
    check("once that has run out the ambient line is shown", sheriff.actionBar.at(-1) === "HUD" && sheriff.actionBar.length === 6, JSON.stringify(sheriff.actionBar.slice(5)));
    done();
});
