import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { checks, load } from "./helpers.mjs";

// logic/telemetry.ts: the one-line JSON the add-on writes to the content log, and the rate limiter in front of it. Pure: the limits and the
// tick are passed in, so every case here is exact. The wire format is pinned on purpose: a tool outside the game reads these lines.

const T = await load("logic/telemetry.js");

const LIMITS = { textChars: 80, listItems: 8, lineChars: 600 };
const STAMP = { v: 1, w: "a3f9c1", b: "x7q2", n: 14, t: 123456, bv: "0.2.5" };
/** The keys a line's stamp (and the cut flag) use. A field of an event named like one of them would overwrite it. */
const RESERVED = ["v", "k", "w", "b", "n", "t", "bv", "cut"];
const event = (k, fields = {}) => ({ ...STAMP, k, ...fields });

/** What each kind of event holds besides the stamp: one realistic set of fields per kind. A kind added without one here fails the second test. */
const FIELDS = {
    "boot": {},
    "round.end": { reason: "law_win", dur: 4800, kills: 5, deaths: 4, lawKills: 3, outlawKills: 2, coins: 640 },
    "ending.escape": { id: "tower", p: "-4294967295", coins: 100, item: "minecraft:diamond", count: 2 },
    "robbery.start": { id: "bank", r: 1, test: false, p: "-4294967295", role: "outlaw", inside: 3 },
    "robbery.element": { id: "bank", r: 1, el: "e2", name: "Vault door", kind: "door", locks: ["pick"], after: 640, p: "-4294967295" },
    "robbery.pick": { id: "bank", r: 1, el: "e2", name: "Vault door", result: "jammed", hits: 1, misses: 3, p: "-4294967295" },
    "robbery.payout": { id: "bank", r: 1, coins: 300, bounty: 150, to: "area", players: 3 },
    "robbery.end": { id: "bank", r: 1, result: "win", test: false, dur: 3100, done: 5, of: 6, people: 3 },
    "shop.open": { id: "general", p: "-4294967295", role: "law" },
    "shop.trade": { id: "general", deal: "t1", face: "buy", spent: 20, got: 0, give: ["minecraft:bread x4"], take: [], svc: [], p: "-4294967295", role: "law" },
    "shop.refuse": { id: "general", deal: "t1", why: "you need 20 coins (you have 12)", p: "-4294967295" },
    "telemetry.dropped": { lines: 37 }
};

const SAMPLES = Object.fromEntries(Object.entries(FIELDS).map(([kind, fields]) => [kind, event(kind, fields)]));

/** A shop.trade with the given lists, for the cases that are about lists. */
const trade = (lists) => event("shop.trade", { id: "general", deal: "t1", face: "buy", spent: 1, got: 0, give: [], take: [], svc: [], p: "7", ...lists });

test("a line is compact JSON with the stamp first, then the fields as given, and it is logged under the 'telemetry' tag", () => {
    const { check, done } = checks();

    const line = T.toLine(SAMPLES["round.end"], LIMITS);

    check("the exact wire format", line === '{"v":1,"k":"round.end","w":"a3f9c1","b":"x7q2","n":14,"t":123456,"bv":"0.2.5","reason":"law_win","dur":4800,"kills":5,"deaths":4,"lawKills":3,"outlawKills":2,"coins":640}', line);
    check("the log source is 'telemetry'", T.TELEMETRY_SOURCE === "telemetry", String(T.TELEMETRY_SOURCE));
    check("this is schema version 1", T.TELEMETRY_VERSION === 1, String(T.TELEMETRY_VERSION));
    done();
});

test("every kind of event comes through unchanged and unflagged", () => {
    const { check, done } = checks();

    check("a sample exists for exactly the kinds there are", isDeepStrictEqual([...T.EVENT_KINDS].sort(), Object.keys(SAMPLES).sort()), JSON.stringify(T.EVENT_KINDS));

    for (const [kind, sample] of Object.entries(SAMPLES)) {
        const line = T.toLine(sample, LIMITS);
        const back = JSON.parse(line);

        check(`${kind}: nothing lost or changed`, isDeepStrictEqual(back, sample), line);
        check(`${kind}: not flagged as cut`, !("cut" in back), line);
        check(`${kind}: within the cap`, line.length <= LIMITS.lineChars, String(line.length));
    }

    done();
});

test("no kind has a field named like a stamp key: merged into the event it would overwrite the stamp, and the reader tells lines apart by it", () => {
    const { check, done } = checks();

    for (const [kind, fields] of Object.entries(FIELDS)) {
        const clash = Object.keys(fields).filter((key) => RESERVED.includes(key));
        check(`${kind} holds no stamp key`, clash.length === 0, `(${clash.join(", ")})`);
    }

    done();
});

test("a text longer than the limit is cut to it and ends in '...', the rest of the line is untouched, and the line says it was cut", () => {
    const { check, done } = checks();

    const refuse = (why) => T.toLine(event("shop.refuse", { id: "general", deal: "t1", why, p: "7" }), LIMITS);

    const line = refuse("x".repeat(5000));
    const back = JSON.parse(line);       // throws if the line is not valid JSON

    check("the whole line is within the cap", line.length <= LIMITS.lineChars, String(line.length));
    check("the text is exactly the limit long", back.why.length === LIMITS.textChars, String(back.why.length));
    check("it ends in three dots", back.why.endsWith("..."), back.why);
    check("it keeps the start of the text", back.why.startsWith("xxxx"), back.why);
    check("the line is flagged", back.cut === 1, line);
    check("the other fields are untouched", back.id === "general" && back.deal === "t1" && back.p === "7", line);

    check("a text exactly at the limit is not cut", !("cut" in JSON.parse(refuse("y".repeat(LIMITS.textChars)))));
    done();
});

test("a list keeps its first entries up to the limit, an entry is cut like any text, and the line says it was cut", () => {
    const { check, done } = checks();

    const items = Array.from({ length: 20 }, (_, i) => `item_${i}`);

    const long = JSON.parse(T.toLine(trade({ give: items }), LIMITS));
    check("only the first entries stay", isDeepStrictEqual(long.give, items.slice(0, LIMITS.listItems)), JSON.stringify(long.give));
    check("flagged", long.cut === 1);

    const exact = JSON.parse(T.toLine(trade({ give: items.slice(0, LIMITS.listItems) }), LIMITS));
    check("exactly the limit is not cut", exact.give.length === LIMITS.listItems && !("cut" in exact));

    const wide = JSON.parse(T.toLine(trade({ give: ["z".repeat(200)] }), LIMITS));
    check("an entry is cut to the text limit", wide.give[0].length === LIMITS.textChars && wide.give[0].endsWith("..."), wide.give[0]);
    check("and that flags it too", wide.cut === 1);
    done();
});

test("a line still over the cap loses whole fields, the biggest first, stops as soon as it fits, and never loses the stamp", () => {
    const { check, done } = checks();

    // 79 characters: under the text limit, so only the line cap can touch it. Eight of them is 657 characters on its own.
    const wide = "w".repeat(79);
    const line = T.toLine(event("shop.trade", { id: "general", deal: wide, face: "buy", spent: 20, got: 0, give: Array(8).fill(wide), take: [wide], svc: [], p: "7", role: "law" }), LIMITS);
    const back = JSON.parse(line);

    check("the line fits", line.length <= LIMITS.lineChars, String(line.length));
    check("the biggest field went", !("give" in back), line);
    check("and it stopped there: the smaller facts are kept", "take" in back && back.deal === wide && back.spent === 20 && back.role === "law", line);
    check("flagged", back.cut === 1, line);
    check("the stamp is whole", back.v === 1 && back.k === "shop.trade" && back.w === "a3f9c1" && back.b === "x7q2" && back.n === 14 && back.t === 123456 && back.bv === "0.2.5", line);
    done();
});

test("a field left undefined is left out of the line, not written as null", () => {
    const { check, done } = checks();

    const line = T.toLine(event("robbery.start", { id: "bank", r: 1, test: false, p: undefined, role: undefined, inside: 0 }), LIMITS);
    const back = JSON.parse(line);

    check("no p and no role", !("p" in back) && !("role" in back), line);
    check("no null anywhere", !line.includes("null"), line);
    check("a false and a zero are kept", back.test === false && back.inside === 0, line);

    // The cap weighs every field to find the biggest, and JSON.stringify(undefined) has no length: an undefined one must never get that far.
    const crowded = JSON.parse(T.toLine(event("robbery.element", { id: "bank", r: 1, el: "e2", kind: "door", locks: Array(8).fill("l".repeat(79)), after: 5, p: undefined }), LIMITS));
    check("an undefined field does not trip the cap", !("locks" in crowded) && crowded.el === "e2" && !("p" in crowded), JSON.stringify(crowded));
    done();
});

test("the stamp is never cut, and a cap nothing could meet still gives valid JSON with the stamp whole", () => {
    const { check, done } = checks();

    const tight = { textChars: 3, listItems: 1, lineChars: 10 };
    const line = T.toLine(event("robbery.end", { id: "bank", r: 1, result: "win", test: false, dur: 9, done: 1, of: 2, people: 1 }), tight);
    const back = JSON.parse(line);

    check("only the stamp and the flag are left", Object.keys(back).sort().join() === "b,bv,cut,k,n,t,v,w", line);
    check("the stamp is whole, though the text limit is 3", back.k === "robbery.end" && back.w === "a3f9c1" && back.bv === "0.2.5" && back.n === 14 && back.t === 123456, line);
    check("flagged", back.cut === 1, line);
    done();
});

const L = await load("logic/shop.js");

/** A deal as the shop holds it: the builder's new-deal shape with an id. */
const deal = (spec) => ({ id: "t1", ...spec });
const sword = { type: "minecraft:iron_sword", amount: 1 };

test("a deal's facts: which shape it has, the coins each way, the items each way and the services it does", () => {
    const { check, done } = checks();
    const facts = (spec) => JSON.stringify(T.tradeFacts(deal(spec)));

    check("buying: coins out, an item in", facts(L.buyDeal(sword, 60)) === JSON.stringify({ face: "buy", spent: 60, got: 0, give: ["Iron Sword"], take: [], svc: [] }), facts(L.buyDeal(sword, 60)));
    check("selling: an item out, coins in", facts(L.sellDeal({ type: "minecraft:feather", amount: 3 }, 8)) === JSON.stringify({ face: "sell", spent: 0, got: 8, give: [], take: ["Feather x3"], svc: [] }), facts(L.sellDeal({ type: "minecraft:feather", amount: 3 }, 8)));
    check("trading: items both ways and a little coin", facts(L.swapDeal({ type: "minecraft:diamond", amount: 1 }, [{ type: "minecraft:gold_ingot", amount: 2 }], 10)) === JSON.stringify({ face: "trade", spent: 10, got: 0, give: ["Diamond"], take: ["Gold Ingot x2"], svc: [] }));
    check("a service: coins out, its kind named, no item", facts(L.effectDeal("regeneration", 10, 2, 20)) === JSON.stringify({ face: "service", spent: 20, got: 0, give: [], take: [], svc: ["effect"] }), facts(L.effectDeal("regeneration", 10, 2, 20)));
    check("an enchantment and a mount are their own kinds", T.tradeFacts(deal(L.enchantDeal("flame", 1, 30))).svc.join() === "enchant" && T.tradeFacts(deal(L.mountDeal("minecraft:horse", 100))).svc.join() === "mount");
    check("two coin rewards are added up", T.tradeFacts(deal({ cost: { coins: 0, items: [{ type: "minecraft:feather", amount: 1 }] }, rewards: [{ kind: "coins", amount: 5 }, { kind: "coins", amount: 7 }] })).got === 12);
    check("something for nothing is a gift", T.tradeFacts(deal({ cost: { coins: 0, items: [] }, rewards: [{ kind: "item", item: sword }] })).face === "gift");
    done();
});

test("a rate limiter lets max lines through per window and refuses the rest, and never writes into the state it was given", () => {
    const { check, done } = checks();

    // Frozen states: a limiter that changed one in place would throw here (modules run in strict mode).
    let state = Object.freeze(T.FRESH_LIMITER);
    const allowed = [];

    for (const tick of [0, 1, 2, 3, 4]) {
        const step = T.limitStep(state, tick, 3, 100);
        allowed.push(step.allowed);
        state = Object.freeze(step.state);
    }

    check("three in, two out", isDeepStrictEqual(allowed, [true, true, true, false, false]), JSON.stringify(allowed));
    check("a limit of 0 lets nothing through", T.limitStep(T.FRESH_LIMITER, 0, 0, 100).allowed === false);
    done();
});

test("how many lines were refused is told once, to the first line of the next window, and a window with none refused tells nothing", () => {
    const { check, done } = checks();

    let state = T.FRESH_LIMITER;
    const told = [];

    for (const tick of [0, 1, 2, 3, 4, 99, 100, 101, 250]) {
        const step = T.limitStep(state, tick, 3, 100);
        told.push([tick, step.allowed, step.dropped]);
        state = step.state;
    }

    check("refusals counted, then told at the new window only", isDeepStrictEqual(told, [
        [0, true, 0], [1, true, 0], [2, true, 0],
        [3, false, 0], [4, false, 0], [99, false, 0],
        [100, true, 3],
        [101, true, 0],
        [250, true, 0]
    ]), JSON.stringify(told));
    done();
});

test("the window opens at the first line, not at tick 0, and a clock that went backwards starts a new one", () => {
    const { check, done } = checks();

    const first = T.limitStep(T.FRESH_LIMITER, 5000, 1, 100);
    const inside = T.limitStep(first.state, 5099, 1, 100);
    const next = T.limitStep(inside.state, 5100, 1, 100);

    check("the first line opens a window at its own tick", first.allowed && first.state.since === 5000, JSON.stringify(first));
    check("the limit holds until 100 ticks after that", !inside.allowed, JSON.stringify(inside));
    check("then a new window opens and tells of the one refusal", next.allowed && next.dropped === 1, JSON.stringify(next));

    const back = T.limitStep(inside.state, 40, 1, 100);       // the clock restarted: a reload, or a test
    check("a clock gone backwards is a new window", back.allowed && back.dropped === 1 && back.state.since === 40, JSON.stringify(back));
    done();
});
