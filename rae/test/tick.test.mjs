import { test } from "node:test";
import { fake, system, load, checks } from "./helpers.mjs";

// The tick scheduler: one loop for the whole game, handlers dispatched by their own cadence.
// Time only moves when a test moves it (fake.advance), so every expectation below is an exact tick.

// The scheduler is the only place the game may start a tick loop, so count the loops it starts.
// (This file runs in its own process; the counting wrapper stays for the whole file.)
const started = [];
const realRunInterval = system.runInterval;
system.runInterval = (fn, ticks) => { started.push(ticks); return realRunInterval.call(system, fn, ticks); };

const { onTick } = await load("core/tick.js");

// Registers through onTick and remembers the disposer, so every test can start from no handlers.
const disposers = [];
function on(name, fn, options) {
    const dispose = onTick(name, fn, options);
    disposers.push(dispose);
    return dispose;
}

/** Removes every handler, resets the fake world, and moves to a tick that is off both the 10 and 20 grid. */
function scene() {
    for (const dispose of disposers.splice(0)) dispose();
    fake.reset();
    fake.advanceTo(Math.ceil(fake.tick / 20) * 20 + 3);
    return fake.tick;
}

/** Records the tick (relative to t0) of every run of a handler. */
function recorder(name, t0, options) {
    const ticks = [];
    on(name, (ctx) => { ticks.push(ctx.tick - t0); }, options);
    return ticks;
}

const every = (period, count) => Array.from({ length: count }, (_, i) => (i + 1) * period);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test("the whole game runs on one loop that ticks every tick", () => {
    const { check, done } = checks();
    check("loading the scheduler started exactly one interval, of one tick", same(started, [1]), JSON.stringify(started));
    scene();
    on("a", () => {});
    on("b", () => {}, { everyTicks: 4 });
    on("c", () => {}, { everyTicks: 10 });
    fake.advance(100);
    check("registering and running handlers starts no other loop", same(started, [1]), JSON.stringify(started));
    done();
});

test("the default cadence is 20 ticks, first run 20 ticks after registration", () => {
    const { check, done } = checks();
    const t0 = scene();
    const ticks = recorder("default", t0);

    fake.advance(19);
    check("nothing before 20 ticks have passed", ticks.length === 0, JSON.stringify(ticks));
    fake.advance(1);
    check("first run on the 20th tick", same(ticks, [20]), JSON.stringify(ticks));
    fake.advance(60);
    check("then once every 20 ticks", same(ticks, every(20, 4)), JSON.stringify(ticks));
    done();
});

test("everyTicks sets the cadence: 1, 4 and 10", () => {
    const { check, done } = checks();
    const t0 = scene();
    const one = recorder("one", t0, { everyTicks: 1 });
    const four = recorder("four", t0, { everyTicks: 4 });
    const ten = recorder("ten", t0, { everyTicks: 10 });

    fake.advance(3);
    check("nothing runs every 4 or 10 ticks in the first 3", four.length === 0 && ten.length === 0 && same(one, [1, 2, 3]));
    fake.advance(37);
    check("everyTicks 1 runs on every tick", same(one, every(1, 40)), JSON.stringify(one));
    check("everyTicks 4 runs on ticks 4, 8, 12, ...", same(four, every(4, 10)), JSON.stringify(four));
    check("everyTicks 10 runs on ticks 10, 20, 30, 40", same(ten, every(10, 4)), JSON.stringify(ten));
    done();
});

test("each handler counts from its own registration tick, not from a shared grid", () => {
    const { check, done } = checks();
    const t0 = scene();
    check("(setup) the scene starts off the 10-tick grid", t0 % 10 !== 0, `(${t0})`);

    const early = recorder("early", t0, { everyTicks: 10 });
    fake.advance(4);
    const late = recorder("late", t0, { everyTicks: 10 });        // registered 4 ticks later

    fake.advance(6);
    check("the first handler's first run is 10 ticks after ITS registration", same(early, [10]), JSON.stringify(early));
    check("...and the later one has not run yet", late.length === 0, JSON.stringify(late));
    fake.advance(4);
    check("the later handler's first run is 10 ticks after ITS registration (14)", same(late, [14]), JSON.stringify(late));
    fake.advance(20);
    check("both keep their own phase", same(early, [10, 20, 30]) && same(late, [14, 24, 34]), `${JSON.stringify(early)} ${JSON.stringify(late)}`);
    done();
});

test("a stopped handler stays stopped, and the stopper is safe to call again", () => {
    const { check, done } = checks();
    const t0 = scene();
    const ticks = [];
    const stop = on("job", (ctx) => { ticks.push(ctx.tick - t0); }, { everyTicks: 10 });
    const bystander = recorder("bystander", t0, { everyTicks: 10 });

    fake.advance(20);
    check("(setup) it ran twice", same(ticks, [10, 20]));
    check("the stopper is a function", typeof stop === "function");
    stop();
    fake.advance(40);
    check("no run after it is stopped", same(ticks, [10, 20]), JSON.stringify(ticks));
    check("other handlers are unaffected", same(bystander, every(10, 6)), JSON.stringify(bystander));

    stop();
    stop();
    fake.advance(20);
    check("stopping again is harmless", same(ticks, [10, 20]) && same(bystander, every(10, 8)));
    done();
});

test("a handler can stop itself while it is running, without disturbing the others", () => {
    const { check, done } = checks();
    const t0 = scene();
    const ticks = [];
    let stop;
    stop = on("selfish", (ctx) => {
        ticks.push(ctx.tick - t0);
        if (ticks.length === 2) stop();
    }, { everyTicks: 10 });
    const after = recorder("after-it", t0, { everyTicks: 10 });   // due on the same ticks, queued behind it

    fake.advance(100);
    check("it ran twice and stopped itself on the second run", same(ticks, [10, 20]), JSON.stringify(ticks));
    check("the handler queued behind it still ran every time, including on the tick it stopped", same(after, every(10, 10)), JSON.stringify(after));
    check("nothing was reported", fake.chat.length === 0, JSON.stringify(fake.chat));

    stop();                                                       // and once more from outside
    fake.advance(20);
    check("a later call to the stopper does nothing", same(ticks, [10, 20]) && after.length === 12);
    done();
});

test("registering a name that is already active replaces the old handler", () => {
    const { check, done } = checks();
    const t0 = scene();
    const first = [], second = [];
    const stopFirst = on("job", (ctx) => { first.push(ctx.tick - t0); }, { everyTicks: 10 });

    fake.advance(7);
    const stopSecond = on("job", (ctx) => { second.push(ctx.tick - t0); }, { everyTicks: 4 });   // at +7, different cadence
    fake.advance(30);                                              // +37
    check("the replaced handler never runs, not even the run it was due for at +10", first.length === 0, JSON.stringify(first));
    check("the replacement counts from its own registration (+7): first run +11, then every 4", same(second, [11, 15, 19, 23, 27, 31, 35]), JSON.stringify(second));

    stopFirst();                                                   // the stale stopper must not touch the replacement
    fake.advance(4);
    check("a stale stopper does not stop the replacement", same(second, [11, 15, 19, 23, 27, 31, 35, 39]), JSON.stringify(second));

    stopSecond();
    fake.advance(20);
    check("the replacement's own stopper does", second.length === 8, JSON.stringify(second));
    done();
});

test("a handler stopped by an earlier one on the same tick does not run", () => {
    const { check, done } = checks();
    scene();
    const runs = [];
    let stopLater;
    on("earlier", () => { runs.push("earlier"); stopLater(); });
    stopLater = on("later", () => { runs.push("later"); });        // due the same tick, queued behind "earlier"

    fake.advance(20);
    check("only the earlier handler ran on the shared tick", same(runs, ["earlier"]), JSON.stringify(runs));
    fake.advance(20);
    check("and the stopped one never comes back", same(runs, ["earlier", "earlier"]), JSON.stringify(runs));
    done();
});

test("a handler registered from inside a handler waits for its own first turn", () => {
    const { check, done } = checks();
    const t0 = scene();
    const child = [];
    let added = false;
    on("parent", () => {
        if (added) return;
        added = true;
        on("child", (ctx) => { child.push(ctx.tick - t0); }, { everyTicks: 1 });
    }, { everyTicks: 20 });

    fake.advance(20);
    check("the child does not run on the tick that registered it", child.length === 0, JSON.stringify(child));
    fake.advance(3);
    check("...it runs from the next tick on", same(child, [21, 22, 23]), JSON.stringify(child));
    done();
});

test("replacing a handler that is already queued for this tick skips both the old and the new for that tick", () => {
    const { check, done } = checks();
    const t0 = scene();
    const runs = [];
    let swapped = false;
    on("swapper", (ctx) => {
        if (swapped) return;
        swapped = true;
        runs.push(`swapper@${ctx.tick - t0}`);
        on("victim", (c) => { runs.push(`new@${c.tick - t0}`); }, { everyTicks: 20 });
    }, { everyTicks: 20 });
    on("victim", (ctx) => { runs.push(`old@${ctx.tick - t0}`); }, { everyTicks: 20 });

    fake.advance(20);
    check("the old victim is gone and the new one waits for its own turn", same(runs, ["swapper@20"]), JSON.stringify(runs));
    fake.advance(20);
    check("the new victim runs 20 ticks after it was registered", same(runs, ["swapper@20", "new@40"]), JSON.stringify(runs));
    done();
});

test("handlers due on the same tick run in the order they were registered", () => {
    const { check, done } = checks();
    scene();
    const order = [];
    on("a", () => { order.push("a"); }, { everyTicks: 10 });
    on("b", () => { order.push("b"); }, { everyTicks: 5 });
    on("c", () => { order.push("c"); }, { everyTicks: 10 });
    fake.advance(10);
    check("b (tick 5) first, then on tick 10: a, b, c", same(order, ["b", "a", "b", "c"]), JSON.stringify(order));
    done();
});

test("players are fetched lazily: once per tick at most, and only when a due handler reads them", () => {
    const { check, done } = checks();
    const t0 = scene();
    const alice = fake.makePlayer("Alice"), bob = fake.makePlayer("Bob");

    const snapshots = new Map();                                   // tick -> the arrays the readers saw
    const seen = (tick, players) => snapshots.set(tick, [...(snapshots.get(tick) ?? []), players]);
    on("reader-twice", (ctx) => { seen(ctx.tick - t0, ctx.players); void ctx.players; });   // every 20, reads it twice
    on("reader-once", (ctx) => { seen(ctx.tick - t0, ctx.players); }, { everyTicks: 10 });
    on("blind", () => {}, { everyTicks: 4 });                      // due often, never reads it

    const fetches = [];                                            // getAllPlayers calls made on each tick 1..40
    for (let i = 1; i <= 40; i++) {
        const before = fake.calls.getAllPlayers;
        fake.advance(1);
        fetches.push(fake.calls.getAllPlayers - before);
    }

    const expected = Array.from({ length: 40 }, (_, i) => ((i + 1) % 10 === 0 ? 1 : 0));
    check("one fetch on the ticks where a due handler reads players (10, 20, 30, 40), none on any other", same(fetches, expected), JSON.stringify(fetches));
    check("tick 4: a handler was due but never read players -> no fetch", fetches[3] === 0);
    check("tick 20: two handlers read players (one of them twice) -> still exactly one fetch", fetches[19] === 1, `(${fetches[19]})`);
    check("both readers on tick 20 saw the same snapshot", snapshots.get(20)?.length === 2 && snapshots.get(20)[0] === snapshots.get(20)[1]);
    check("the snapshot is the world's players", snapshots.get(20)?.[0].length === 2 && snapshots.get(20)[0].includes(alice) && snapshots.get(20)[0].includes(bob));
    check("each tick gets a fresh snapshot", snapshots.get(10)[0] !== snapshots.get(20)[0]);
    done();
});

test("a tick with nothing due does nothing at all", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Alice");
    on("slow", (ctx) => { void ctx.players; }, { everyTicks: 20 });
    fake.advance(19);
    check("no player query and no chat on the 19 ticks before it is due", fake.calls.getAllPlayers === 0 && fake.chat.length === 0, `(${fake.calls.getAllPlayers} queries)`);
    fake.advance(1);
    check("one query once it is due", fake.calls.getAllPlayers === 1);
    done();
});

test("every handler on a tick sees the same context", () => {
    const { check, done } = checks();
    scene();
    const seen = [];
    on("a", (ctx) => { seen.push(ctx); }, { everyTicks: 5 });
    on("b", (ctx) => { seen.push(ctx); }, { everyTicks: 5 });
    fake.advance(5);
    check("both ran", seen.length === 2);
    check("the tick is system.currentTick", seen.every((ctx) => ctx.tick === system.currentTick && ctx.tick === fake.tick), JSON.stringify(seen.map((c) => c.tick)));
    check("they share one context object", seen[0] === seen[1]);
    done();
});

test("a throwing handler does not stop the others and is reported with the exact message", () => {
    const { check, done } = checks();
    scene();
    const order = [];
    on("first", () => { order.push("first"); });
    on("bad", () => { order.push("bad"); throw new Error("boom"); });
    on("thrower-of-strings", () => { order.push("strings"); throw "oops"; });
    on("last", () => { order.push("last"); });

    fake.advance(20);
    check("every handler ran, in order", same(order, ["first", "bad", "strings", "last"]), JSON.stringify(order));
    check("each failure is reported with the exact chat message",
        same(fake.chat, ["§c[TICK ERROR] bad: Error: boom", "§c[TICK ERROR] thrower-of-strings: oops"]), JSON.stringify(fake.chat));

    fake.advance(20);
    check("a handler that threw runs again on its next tick, and is reported again", order.length === 8 && fake.chat.length === 4, `(${order.length} runs, ${fake.chat.length} messages)`);
    done();
});

test("a stall does not make a handler catch up in a burst: it runs once, then carries on from its own phase", () => {
    const { check, done } = checks();
    const t0 = scene();
    const ticks = recorder("steady", t0, { everyTicks: 10 });

    fake.advance(10);
    check("(setup) first run at +10", same(ticks, [10]));

    // The server stalls: 55 ticks go by without the loop getting a turn.
    fake.tick += 55;
    fake.advance(1);                                               // the loop's next turn, at +66
    check("one run for the whole stall, not one per missed period", same(ticks, [10, 66]), JSON.stringify(ticks));
    fake.advance(3);                                               // +67 .. +69
    check("the next run keeps the handler's own grid (+70), not 10 ticks after the late run (+76)", same(ticks, [10, 66]), JSON.stringify(ticks));
    fake.advance(1);
    check("...and it comes at +70", same(ticks, [10, 66, 70]), JSON.stringify(ticks));
    fake.advance(10);
    check("then every 10 again", same(ticks, [10, 66, 70, 80]), JSON.stringify(ticks));
    done();
});

test("a nonsense cadence is made safe: whole ticks, at least 1, otherwise the default", () => {
    const { check, done } = checks();
    const t0 = scene();
    const cases = [[0, 1], [-5, 1], [2.9, 2], [NaN, 20], [Infinity, 20], [undefined, 20]];
    const runs = cases.map(([input, effective]) => ({ input, effective, ticks: recorder(`odd-${String(input)}`, t0, { everyTicks: input }) }));

    fake.advance(40);
    for (const { input, effective, ticks } of runs) {
        check(`everyTicks ${String(input)} behaves as every ${effective} ticks`, same(ticks, every(effective, Math.floor(40 / effective))), JSON.stringify(ticks));
    }
    done();
});
