import { test } from "node:test";
import { fake, system, world, load, checks } from "./helpers.mjs";

// The director: one slot shared by the big scripted events, with a queue, cooldowns, announcements
// and weighted picks. These tests register their own small events (a, b, c) and never load the
// game's real ones, so every expectation is about the director alone. Time only moves when a test
// moves it, so every tick below is exact.

// The scheduler is the only place the game may start a tick loop, so count the loops started.
// (This file runs in its own process; the counting wrapper stays for the whole file.)
const loops = [];
const realRunInterval = system.runInterval;
system.runInterval = (fn, ticks) => { loops.push(ticks); return realRunInterval.call(system, fn, ticks); };

const LOAD_TICK = fake.tick;                            // the director's sweep counts from here, every 20 ticks
const { registerEvent, requestEvent, finishEvent, activeEvent, queuedEvents, pickWeighted, requestRandomEvent } = await load("core/director.js");
const { listSystems } = await load("core/registry.js");
const { listScriptEvents } = await load("core/events.js");

const SWEEP = 20;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const busy = (wanted, running) => `§cCan't start a ${wanted} event — ${running} is already in progress.`;

const IDS = ["a", "b", "c"];
const log = [];                                         // every start() that ran, as "<id>:start"
const outcome = {};                                     // what an event's start() returns; true unless a test says otherwise

/** Registers a plain event whose start() is recorded. `extra` adds to or overrides any of it. */
function define(id, extra = {}) {
    registerEvent({
        id,
        label: `${id} event`,
        start() { log.push(`${id}:start`); return outcome[id] ?? true; },
        ...extra
    });
}

/**
 * A quiet world and a director with nothing in it. Events can't be unregistered, so every test
 * starts from exactly the plain events a, b and c (registering an id again replaces it).
 */
function scene() {
    listSystems().find((s) => s.name === "director").reset();
    fake.reset();
    log.length = 0;
    for (const id of IDS) delete outcome[id];
    for (const id of IDS) define(id);
    fake.advanceTo(Math.ceil(fake.tick / SWEEP) * SWEEP + 3);
}

const emit = (id) => system.afterEvents.scriptEventReceive.emit({ id });

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

test("the director starts no loop of its own, and registers itself as a system", () => {
    const { check, done } = checks();
    check("loading it started exactly the scheduler's one loop", same(loops, [1]), JSON.stringify(loops));
    scene();
    requestEvent("a");
    requestEvent("b", { queue: true });
    finishEvent("a");
    fake.advance(SWEEP * 10);
    check("using it (queue, sweep and all) starts no other loop", same(loops, [1]), JSON.stringify(loops));
    check("it is registered as the system 'director'", listSystems().some((s) => s.name === "director"));
    done();
});

test("a free slot: the request starts the event, which then holds the slot", () => {
    const { check, done } = checks();
    scene();
    check("(setup) nothing runs and nobody waits", activeEvent() === null && same(queuedEvents(), []));

    const result = requestEvent("a");
    check("the result is started", same(result, { status: "started" }), JSON.stringify(result));
    check("it is the active event", activeEvent() === "a");
    check("its start() ran once", same(log, ["a:start"]), JSON.stringify(log));
    check("the director says nothing by default", fake.chat.length === 0, JSON.stringify(fake.chat));
    done();
});

test("a busy slot: the request is refused with the exact line and nothing starts", () => {
    const { check, done } = checks();
    scene();
    requestEvent("a");

    const result = requestEvent("b");
    check("rejected as busy, naming what holds the slot", same(result, { status: "rejected", reason: "busy", active: "a" }), JSON.stringify(result));
    check("the exact line, and only that", same(fake.chat, [busy("b", "a")]), JSON.stringify(fake.chat));
    check("b's start() never ran", same(log, ["a:start"]), JSON.stringify(log));
    check("a still holds the slot and nobody waits", activeEvent() === "a" && same(queuedEvents(), []));

    fake.chat.length = 0;
    const again = requestEvent("a");
    check("the running event asked again is refused the same way", same(again, { status: "rejected", reason: "busy", active: "a" }) && same(fake.chat, [busy("a", "a")]), JSON.stringify(fake.chat));
    check("...and does not start twice", same(log, ["a:start"]));
    done();
});

test("finishEvent frees the slot, so the next request starts, in the same tick", () => {
    const { check, done } = checks();
    scene();
    requestEvent("a");
    finishEvent("a");
    check("the slot is free", activeEvent() === null);
    check("a finished event says nothing by default", fake.chat.length === 0);

    const result = requestEvent("b");
    check("the next request starts", same(result, { status: "started" }) && activeEvent() === "b");

    finishEvent("b");
    check("with no cooldown an event can start again at once", same(requestEvent("b"), { status: "started" }) && same(log, ["a:start", "b:start", "b:start"]), JSON.stringify(log));
    done();
});

test("finishEvent is idempotent and only ends the ACTIVE event with that id", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 100, announce: { end: "§6A ends" } });
    requestEvent("a");

    finishEvent("b");
    check("finishing an event that is not running changes nothing", activeEvent() === "a" && fake.chat.length === 0);
    finishEvent("nobody");
    check("finishing an unknown id is harmless", activeEvent() === "a");

    finishEvent("a");
    const T = fake.tick;
    check("finishing the active event frees the slot and announces once", activeEvent() === null && same(fake.chat, ["§6A ends"]), JSON.stringify(fake.chat));

    fake.advance(30);
    finishEvent("a");
    check("finishing it again does nothing: no second announcement", same(fake.chat, ["§6A ends"]), JSON.stringify(fake.chat));
    fake.advanceTo(T + 99);
    check("...and does not restart the cooldown, which still ends 100 ticks after the FIRST finish", requestEvent("a").status === "rejected");
    fake.advanceTo(T + 100);
    check("(the first cooldown ends on time)", requestEvent("a").status === "started");

    // A finish that arrives late, for an event that already ended, must not free a newer one.
    finishEvent("a");
    requestEvent("b");
    finishEvent("a");
    check("a stale finish for a can't end b", activeEvent() === "b");
    done();
});

test("a start() that returns false frees the slot at once and reports failed", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 100, announce: { start: "§6A begins", end: "§6A ends" } });
    outcome.a = false;

    const result = requestEvent("a");
    check("rejected as failed", same(result, { status: "rejected", reason: "failed" }), JSON.stringify(result));
    check("the slot is free again", activeEvent() === null);
    check("no announcement for an event that never began", fake.chat.length === 0, JSON.stringify(fake.chat));

    outcome.a = true;
    check("it earned no cooldown: it can be requested again at once", same(requestEvent("a"), { status: "started" }));
    finishEvent("a");
    check("...and it does now that it has run and finished", requestEvent("a").status === "rejected");
    check("another event was never blocked", requestEvent("b").status === "started");
    done();
});

test("a start() that throws is a failed start: slot freed, reported with console.error, never in chat", () => {
    const { check, done } = checks();
    scene();
    const reported = [];
    const realError = console.error;
    console.error = (...args) => reported.push(args.join(" "));

    let result;
    try {
        define("a", { start() { throw new Error("boom"); } });
        result = requestEvent("a");
    } finally {
        console.error = realError;
    }

    check("rejected as failed", same(result, { status: "rejected", reason: "failed" }), JSON.stringify(result));
    check("reported once, naming the event and the error", reported.length === 1 && reported[0].includes("a") && reported[0].includes("boom"), JSON.stringify(reported));
    check("nothing went to chat (no red bracketed line)", fake.chat.length === 0, JSON.stringify(fake.chat));
    check("the slot is free", activeEvent() === null && requestEvent("b").status === "started");
    done();
});

test("an unknown id is rejected as unknown, says nothing, and is not queued", () => {
    const { check, done } = checks();
    scene();
    check("rejected as unknown", same(requestEvent("nope"), { status: "rejected", reason: "unknown" }));
    check("also when asked to queue", same(requestEvent("nope", { queue: true }), { status: "rejected", reason: "unknown" }) && same(queuedEvents(), []));
    check("nothing was said or started", fake.chat.length === 0 && log.length === 0 && activeEvent() === null);

    requestEvent("a");
    fake.chat.length = 0;
    check("unknown is answered even while the slot is busy, silently", same(requestEvent("nope"), { status: "rejected", reason: "unknown" }) && fake.chat.length === 0);
    done();
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test("queue: a request that can't start waits in line, first come first served, and starts the moment the slot frees", () => {
    const { check, done } = checks();
    scene();
    requestEvent("a");

    const b = requestEvent("b", { queue: true });
    const c = requestEvent("c", { queue: true });
    check("b is first in line", same(b, { status: "queued", position: 1 }), JSON.stringify(b));
    check("c is second", same(c, { status: "queued", position: 2 }), JSON.stringify(c));
    check("asking again keeps the place in line", same(requestEvent("b", { queue: true }), { status: "queued", position: 1 }) && same(queuedEvents(), ["b", "c"]), JSON.stringify(queuedEvents()));
    check("queuing says nothing and starts nothing", fake.chat.length === 0 && same(log, ["a:start"]), JSON.stringify(log));

    finishEvent("a");
    check("b starts in the very tick a finishes", activeEvent() === "b" && same(log, ["a:start", "b:start"]), JSON.stringify(log));
    check("c is first in line now", same(queuedEvents(), ["c"]));

    finishEvent("b");
    check("then c", activeEvent() === "c" && same(queuedEvents(), []) && same(log, ["a:start", "b:start", "c:start"]));

    finishEvent("c");
    check("then the slot is free", activeEvent() === null);
    done();
});

test("queue: with a free slot a queued request just starts, and the list it hands out is a copy", () => {
    const { check, done } = checks();
    scene();
    check("it starts at once instead of queuing", same(requestEvent("a", { queue: true }), { status: "started" }) && activeEvent() === "a");

    requestEvent("b", { queue: true });
    queuedEvents().push("c");
    check("changing the returned list changes nothing", same(queuedEvents(), ["b"]), JSON.stringify(queuedEvents()));
    done();
});

test("queue: an event that fails to start is skipped, and the slot goes on to the next in line", () => {
    const { check, done } = checks();
    scene();
    outcome.b = false;
    requestEvent("a");
    requestEvent("b", { queue: true });
    requestEvent("c", { queue: true });

    finishEvent("a");
    check("b was tried and failed, so c holds the slot", same(log, ["a:start", "b:start", "c:start"]) && activeEvent() === "c", JSON.stringify(log));
    check("the line is empty", same(queuedEvents(), []));
    done();
});

test("queue: an event waiting out its cooldown is passed over, then starts on the first sweep after the cooldown ends", () => {
    const { check, done } = checks();
    scene();
    const starts = [];
    define("a", { cooldownTicks: 100, start() { starts.push(fake.tick); return true; } });

    requestEvent("a");
    finishEvent("a");
    const readyAt = fake.tick + 100;

    const waiting = requestEvent("a", { queue: true });
    check("cooling down with a free slot: it is queued, not rejected", same(waiting, { status: "queued", position: 1 }), JSON.stringify(waiting));

    check("another event still starts at once: the slot is free and it is ready", same(requestEvent("b"), { status: "started" }) && activeEvent() === "b");
    check("a third joins the line behind a", same(requestEvent("c", { queue: true }), { status: "queued", position: 2 }) && same(queuedEvents(), ["a", "c"]));

    finishEvent("b");
    check("a is cooling, so c is started ahead of it", activeEvent() === "c" && same(queuedEvents(), ["a"]), JSON.stringify(queuedEvents()));
    finishEvent("c");
    check("a keeps waiting: the slot is free but its cooldown is not over", activeEvent() === null && same(queuedEvents(), ["a"]) && starts.length === 1);

    fake.advanceTo(readyAt - 1);
    check("nothing starts before the cooldown ends", starts.length === 1 && activeEvent() === null);

    fake.advanceTo(readyAt + SWEEP);
    check("a started again, once", starts.length === 2, JSON.stringify(starts));
    check("...no earlier than its cooldown and no later than one sweep after", starts[1] >= readyAt && starts[1] < readyAt + SWEEP, JSON.stringify({ readyAt, starts }));
    check("...on a sweep tick (every 20 ticks from the load)", (starts[1] - LOAD_TICK) % SWEEP === 0, JSON.stringify({ start: starts[1], load: LOAD_TICK }));
    check("it holds the slot now and the line is empty", activeEvent() === "a" && same(queuedEvents(), []));
    done();
});

test("queue: an event that starts some other way stops waiting, so it does not start a second time", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 100 });
    requestEvent("a");
    finishEvent("a");
    const readyAt = fake.tick + 100;                    // scene() starts 3 ticks past a sweep, so this is 3 past one too

    requestEvent("a", { queue: true });
    check("(setup) a waits out its cooldown", same(queuedEvents(), ["a"]));

    fake.advanceTo(readyAt);
    check("(setup) the cooldown is over but no sweep has run yet", activeEvent() === null && same(queuedEvents(), ["a"]));

    check("asked for directly, a starts", same(requestEvent("a"), { status: "started" }) && activeEvent() === "a");
    check("...and is no longer in the line", same(queuedEvents(), []), JSON.stringify(queuedEvents()));

    finishEvent("a");
    fake.advance(100 + SWEEP);
    check("nothing starts it again once its new cooldown is over", same(log, ["a:start", "a:start"]) && activeEvent() === null, JSON.stringify(log));
    done();
});

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

test("cooldown: an event is blocked for cooldownTicks after it finishes, and the refusal says how long", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 100 });                // 5 seconds
    requestEvent("a");
    check("(setup) no cooldown while it runs", activeEvent() === "a");
    finishEvent("a");
    const T = fake.tick;

    const result = requestEvent("a");
    check("rejected as cooldown", same(result, { status: "rejected", reason: "cooldown" }), JSON.stringify(result));
    check("the line gives the seconds left", same(fake.chat, ["§cCan't start a a event yet — 5s of cooldown left."]), JSON.stringify(fake.chat));
    check("it did not start", same(log, ["a:start"]) && activeEvent() === null);

    // Seconds are rounded up: a partial second still counts.
    for (const [after, seconds] of [[1, 5], [20, 4], [21, 4], [79, 2], [80, 1], [99, 1]]) {
        fake.advanceTo(T + after);
        fake.chat.length = 0;
        requestEvent("a");
        check(`${after} ticks in: ${seconds}s left`, same(fake.chat, [`§cCan't start a a event yet — ${seconds}s of cooldown left.`]), JSON.stringify(fake.chat));
    }

    fake.advanceTo(T + 100);
    check("exactly cooldownTicks after it finished, it starts again", same(requestEvent("a"), { status: "started" }), JSON.stringify(log));
    done();
});

test("cooldown: it blocks only its own event, and a busy slot is reported before a cooldown", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 100 });
    requestEvent("a");
    finishEvent("a");

    check("another event starts during a's cooldown", same(requestEvent("b"), { status: "started" }) && activeEvent() === "b");

    fake.chat.length = 0;
    const result = requestEvent("a");
    check("while b runs, a is refused as busy (the slot blocks first)", same(result, { status: "rejected", reason: "busy", active: "b" }) && same(fake.chat, [busy("a", "b")]), JSON.stringify(fake.chat));
    done();
});

test("cooldown: the default is none, and a cooldown is forgotten by a reset", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 1000 });
    requestEvent("a");
    finishEvent("a");
    check("(setup) a is cooling down", requestEvent("a").status === "rejected");

    listSystems().find((s) => s.name === "director").reset();
    check("after a round reset it is not", requestEvent("a").status === "started");

    define("b");                                        // no cooldownTicks
    finishEvent("a");
    const first = requestEvent("b");
    finishEvent("b");
    const second = requestEvent("b");
    check("an event without cooldownTicks can start again the moment it finishes", first.status === "started" && second.status === "started", JSON.stringify([first, second]));
    done();
});

// ---------------------------------------------------------------------------
// Triggers, wording, announcements
// ---------------------------------------------------------------------------

test("a trigger registers the script event, which requests the event the way a command block does", () => {
    const { check, done } = checks();
    scene();
    define("a", { trigger: "test:a" });
    define("b", { trigger: "test:b" });
    check("both script events are registered", ["test:a", "test:b"].every((id) => listScriptEvents().includes(id)), JSON.stringify(listScriptEvents()));

    emit("test:a");
    check("the first starts its event", activeEvent() === "a" && same(log, ["a:start"]));
    check("...silently", fake.chat.length === 0);

    emit("test:b");
    check("the second is refused with the exact line and starts nothing", same(fake.chat, [busy("b", "a")]) && same(log, ["a:start"]), JSON.stringify(fake.chat));

    finishEvent("a");
    emit("test:b");
    check("once a has finished, the second starts", activeEvent() === "b" && same(log, ["a:start", "b:start"]));
    done();
});

test("busyMessage lets an event word its own refusal; undefined falls back to the director's line", () => {
    const { check, done } = checks();
    scene();
    define("a", { busyMessage: (holder) => (holder === "a" ? "§cA is still going." : undefined) });

    requestEvent("a");
    requestEvent("a");
    check("asked again while it runs, it words the refusal itself", same(fake.chat, ["§cA is still going."]), JSON.stringify(fake.chat));

    finishEvent("a");
    requestEvent("b");
    fake.chat.length = 0;
    const result = requestEvent("a");
    check("while b runs it returns undefined, so the director's line is used", same(fake.chat, [busy("a", "b")]) && same(result, { status: "rejected", reason: "busy", active: "b" }), JSON.stringify(fake.chat));

    fake.chat.length = 0;
    requestEvent("a", { queue: true });
    check("a queued request is not refused, so nothing is worded", fake.chat.length === 0 && same(queuedEvents(), ["a"]));
    done();
});

test("announcements: the director says the start after a good start and the end when the event finishes, nothing else", () => {
    const { check, done } = checks();
    scene();
    define("a", {
        announce: { start: "§6A begins", end: "§6A ends" },
        start() { log.push("a:start"); world.sendMessage("a's own line"); return true; }
    });
    define("b", { announce: { start: "§6B begins", end: "§6B ends" } });
    define("c", { announce: { end: "§6C ends" } });

    requestEvent("a");
    check("the start line comes after whatever the event said while starting", same(fake.chat, ["a's own line", "§6A begins"]), JSON.stringify(fake.chat));
    finishEvent("a");
    check("the end line comes when it finishes", same(fake.chat, ["a's own line", "§6A begins", "§6A ends"]), JSON.stringify(fake.chat));

    fake.chat.length = 0;
    outcome.b = false;
    requestEvent("b");
    check("an event that could not start announces nothing", fake.chat.length === 0, JSON.stringify(fake.chat));

    outcome.b = true;
    requestEvent("b");
    requestEvent("a");
    check("a refused request announces nothing but the refusal", same(fake.chat, ["§6B begins", busy("a", "b")]), JSON.stringify(fake.chat));

    fake.chat.length = 0;
    finishEvent("b");
    requestEvent("c");
    finishEvent("c");
    check("each half is optional", same(fake.chat, ["§6B ends", "§6C ends"]), JSON.stringify(fake.chat));
    done();
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

test("a round reset drops the running event, the queue and every cooldown, but keeps the registered events", () => {
    const { check, done } = checks();
    scene();
    define("a", { cooldownTicks: 500, announce: { end: "§6A ends" } });
    requestEvent("a");
    finishEvent("a");                                   // a is cooling down
    requestEvent("b");                                  // b runs
    requestEvent("c", { queue: true });                 // c waits behind it
    requestEvent("a", { queue: true });                 // and so does a
    fake.chat.length = 0;
    log.length = 0;

    listSystems().find((s) => s.name === "director").reset();

    check("nothing runs and nobody waits", activeEvent() === null && same(queuedEvents(), []), JSON.stringify(queuedEvents()));
    check("a reset announces nothing", fake.chat.length === 0, JSON.stringify(fake.chat));

    check("a's cooldown is gone", same(requestEvent("a"), { status: "started" }));
    finishEvent("a");
    fake.advance(SWEEP * 5);
    check("the queued events never start after a reset", same(log, ["a:start"]), JSON.stringify(log));
    check("the registered events are still there", same(requestEvent("c"), { status: "started" }) && activeEvent() === "c");
    done();
});

// ---------------------------------------------------------------------------
// Picking an event by weight
// ---------------------------------------------------------------------------

test("pickWeighted: chance follows weight, steered by the random number it is given", () => {
    const { check, done } = checks();
    const weights = { a: 1, b: 3, c: 0 };
    const pick = (random, ids = ["a", "b", "c"]) => pickWeighted(ids, (id) => weights[id], () => random);

    check("0 lands on the first", pick(0) === "a");
    check("just under a's quarter of the range is still a", pick(0.2499) === "a");
    check("a quarter of the way in is where b begins", pick(0.25) === "b");
    check("the top of the range is b", pick(0.9999) === "b");
    check("weight 0 is never picked, wherever it stands in the list", [0, 0.3, 0.7, 0.9999].every((r) => pick(r) !== "c" && pick(r, ["c", "a", "b"]) !== "c"));
    check("the order of the list decides who owns which part of the range", pick(0.1, ["b", "a"]) === "b" && pick(0.9, ["b", "a"]) === "a");

    // 400 evenly spread rolls split exactly like the weights: 1 : 3.
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 400; i++) counts[pickWeighted(["a", "b"], (id) => weights[id], () => i / 400)]++;
    check("400 evenly spread rolls split 100 : 300", counts.a === 100 && counts.b === 300, JSON.stringify(counts));
    done();
});

test("pickWeighted: nothing to pick, junk weights, a roll at the very top, and the default random", () => {
    const { check, done } = checks();
    check("an empty list gives undefined", pickWeighted([], () => 1, () => 0) === undefined);
    check("all-zero weights give undefined", pickWeighted(["a", "b"], () => 0, () => 0.5) === undefined);
    check("a weight that is negative, NaN or infinite never wins", [0, 0.5, 0.9999].every((r) =>
        pickWeighted(["a", "b", "c", "d"], (id) => ({ a: -5, b: NaN, c: Infinity, d: 2 })[id], () => r) === "d"));
    check("a roll of exactly 1 (outside its contract) lands on the last pickable id", pickWeighted(["a", "b", "c"], (id) => ({ a: 1, b: 3, c: 0 })[id], () => 1) === "b");
    check("without a random function it still picks one of the ids", ["a", "b"].includes(pickWeighted(["a", "b"], () => 1)));
    done();
});

test("requestRandomEvent: picks by weight among events that are not cooling down, and starts the pick", () => {
    const { check, done } = checks();
    scene();
    define("a", { weight: 1 });
    define("b", { weight: 3 });
    define("c", { weight: 0 });

    check("0 picks a", same(requestRandomEvent(() => 0), { status: "started" }) && activeEvent() === "a");
    finishEvent("a");
    check("0.5 picks b", same(requestRandomEvent(() => 0.5), { status: "started" }) && activeEvent() === "b");
    finishEvent("b");
    check("0.9999 picks b", same(requestRandomEvent(() => 0.9999), { status: "started" }) && activeEvent() === "b");
    check("c has weight 0 and never ran", !log.includes("c:start"), JSON.stringify(log));
    check("a pick is silent", fake.chat.length === 0, JSON.stringify(fake.chat));
    done();
});

test("requestRandomEvent skips events that are cooling down, and says why when nothing is left", () => {
    const { check, done } = checks();
    scene();
    for (const id of IDS) define(id, { weight: id === "a" ? 100 : 1, cooldownTicks: 1000 });

    requestEvent("a");
    finishEvent("a");
    check("a dominates the weights but is cooling, so b is picked", same(requestRandomEvent(() => 0), { status: "started" }) && activeEvent() === "b", JSON.stringify(log));
    finishEvent("b");
    check("then c", same(requestRandomEvent(() => 0), { status: "started" }) && activeEvent() === "c");
    finishEvent("c");

    fake.chat.length = 0;
    const before = log.length;
    const result = requestRandomEvent(() => 0);
    check("with everything cooling down it is rejected as cooldown", same(result, { status: "rejected", reason: "cooldown" }), JSON.stringify(result));
    check("...silently, and nothing started", fake.chat.length === 0 && log.length === before && activeEvent() === null);
    done();
});

test("requestRandomEvent is silent when busy, and rejects when nothing can be picked or the pick fails", () => {
    const { check, done } = checks();
    scene();
    requestEvent("a");
    fake.chat.length = 0;
    const busyResult = requestRandomEvent(() => 0);
    check("busy: rejected with the holder, silently, and it does not queue", same(busyResult, { status: "rejected", reason: "busy", active: "a" }) && fake.chat.length === 0 && same(queuedEvents(), []), JSON.stringify(busyResult));
    finishEvent("a");

    for (const id of IDS) define(id, { weight: 0 });
    check("every weight 0: nothing to pick", same(requestRandomEvent(() => 0), { status: "rejected", reason: "unknown" }));

    define("a", { weight: 1 });
    outcome.a = false;
    check("a pick that fails to start is rejected as failed", same(requestRandomEvent(() => 0), { status: "rejected", reason: "failed" }));
    check("...and the slot is free", activeEvent() === null);
    done();
});

test("nothing is picked on its own: the director only starts what is asked of it", () => {
    const { check, done } = checks();
    scene();
    fake.advance(SWEEP * 100);
    check("no event started by itself", log.length === 0 && activeEvent() === null && fake.chat.length === 0, JSON.stringify(log));
    done();
});
