import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load, checks } from "./helpers.mjs";

const { CONFIG_SCHEMA, describeSchema, createMigrator, migrator } = await load("config/schema.js");
const { WORLD_SCHEMA_VERSION } = await load("config/world.js");
const { BALANCE_SCHEMA_VERSION } = await load("config/balance.js");
const { GUNS_SCHEMA_VERSION } = await load("config/guns.js");

/** A step that appends its own name to `data.log`, so a result shows exactly which steps ran, in order. */
const logging = (from, to) => ({ from, to, migrate: (data) => ({ ...data, log: [...data.log, `${from}>${to}`] }) });

/** The steps a successful result went through, or null for a failed one. */
const steps = (result) => (result.ok ? result.data.log : null);

// A regression in the cycle handling would spin forever, and a hung `npm test` is a poor way to find out.
// Running the call under a vm timeout turns an endless loop into an ordinary failing test.
const guarded = (fn) => vm.runInNewContext("fn()", { fn }, { timeout: 2000 });

test("same fingerprint: the data comes back untouched and no migration runs", () => {
    const { check, done } = checks();
    const ran = [];
    const spy = (from, to) => ({ from, to, migrate(data) { ran.push(`${from}>${to}`); return data; } });

    const m = createMigrator("v2");
    m.register(spy("v1", "v2"));
    m.register(spy("v2", "v3"));   // a step OUT of the current fingerprint must never be taken
    m.register(spy("v2", "v2"));

    const data = { coins: 5, nested: { list: [1, 2, 3] } };
    const before = structuredClone(data);
    const result = m.migrate("v2", data);
    check("ok", result.ok === true);
    check("the very same object comes back, not a copy", result.data === data);
    check("its contents are unchanged", isDeepStrictEqual(data, before));
    check("no migration ran", ran.length === 0, ran.join());

    // Whatever the data is, it is never inspected.
    for (const value of [undefined, null, 0, NaN, "", "text", false, [], {}]) {
        const again = m.migrate("v2", value);
        check(`passes a ${typeof value} (${String(value)}) through`, again.ok === true && Object.is(again.data, value));
    }
    done();
});

test("the exported migrator targets the running config", () => {
    const { check, done } = checks();
    const data = { coins: 5 };

    const same = migrator.migrate(describeSchema(), data);
    check("data saved under the running fingerprint passes through", same.ok === true && same.data === data);

    const bogus = "test-only@a-fingerprint-that-was-never-real";
    const refused = migrator.migrate(bogus, data);
    check("an unknown fingerprint is refused", refused.ok === false, JSON.stringify(refused));
    check("naming the saved and the running fingerprint", refused.reason?.includes(bogus) && refused.reason.includes(describeSchema()), refused.reason);
    done();
});

test("one registered migration upgrades saved data", () => {
    const m = createMigrator("balance@2,guns@1,world@1");
    m.register({
        from: "balance@1,guns@1,world@1",
        to: "balance@2,guns@1,world@1",
        migrate: (data) => ({ ...data, deathCoinsKept: data.deathCoinsKept * 100 })
    });
    const result = m.migrate("balance@1,guns@1,world@1", { deathCoinsKept: 0.5, coins: 12 });
    assert.deepEqual(result, { ok: true, data: { deathCoinsKept: 50, coins: 12 } });
});

test("a multi-step chain applies every step in order, each fed the previous step's output", () => {
    const { check, done } = checks();
    const m = createMigrator("v4");
    // Registered out of order on purpose: the chain is found by fingerprint, not by registration order.
    m.register(logging("v3", "v4"));
    m.register(logging("v1", "v2"));
    m.register(logging("v2", "v3"));

    const all = m.migrate("v1", { log: [] });
    check("v1 walks all three steps", isDeepStrictEqual(steps(all), ["v1>v2", "v2>v3", "v3>v4"]), JSON.stringify(all));
    const tail = m.migrate("v3", { log: [] });
    check("v3 only needs the last step", isDeepStrictEqual(steps(tail), ["v3>v4"]), JSON.stringify(tail));
    const carried = m.migrate("v2", { log: ["kept"] });
    check("data already in the object is carried along", isDeepStrictEqual(steps(carried), ["kept", "v2>v3", "v3>v4"]), JSON.stringify(carried));
    done();
});

test("the shortest chain wins, whatever order the steps were registered in", () => {
    const { check, done } = checks();

    // The long way round is registered first and the direct step last. Depth-first would take the detour.
    const detour = createMigrator("v4");
    for (const [from, to] of [["v1", "v2"], ["v2", "v3"], ["v3", "v4"], ["v1", "v4"]]) detour.register(logging(from, to));
    const direct = detour.migrate("v1", { log: [] });
    check("takes the one direct step, not the three-step detour", isDeepStrictEqual(steps(direct), ["v1>v4"]), JSON.stringify(direct));

    // Two equally short chains: the one whose first step was registered earlier is used, every time.
    const tie = createMigrator("z");
    for (const [from, to] of [["a", "x"], ["a", "y"], ["y", "z"], ["x", "z"]]) tie.register(logging(from, to));
    for (let attempt = 0; attempt < 3; attempt++) {
        const picked = tie.migrate("a", { log: [] });
        check(`tie, attempt ${attempt}: the chain that starts with the earlier step`, isDeepStrictEqual(steps(picked), ["a>x", "x>z"]), JSON.stringify(picked));
    }
    done();
});

test("no chain: ok is false and the reason names both fingerprints", () => {
    const { check, done } = checks();
    const saved = "balance@1,guns@1,world@1";
    const current = "balance@3,guns@1,world@1";
    const ran = [];
    const m = createMigrator(current);

    const bare = m.migrate(saved, { keep: "me" });
    check("nothing registered: ok is false", bare.ok === false, JSON.stringify(bare));
    check("the reason names the saved fingerprint", bare.reason?.includes(saved), bare.reason);
    check("the reason names the current fingerprint", bare.reason?.includes(current), bare.reason);
    check("a refusal carries no data", !("data" in bare));

    // A step that leads somewhere, but not to the current fingerprint.
    m.register({ from: saved, to: "balance@2,guns@1,world@1", migrate(data) { ran.push("1>2"); return data; } });
    const partial = m.migrate(saved, {});
    check("a chain that stops short is no chain", partial.ok === false && partial.reason.includes(saved) && partial.reason.includes(current), JSON.stringify(partial));
    check("no step runs when the chain is incomplete", ran.length === 0, ran.join());

    // A fingerprint nobody registered anything for.
    const unknown = m.migrate("something else entirely", {});
    check("an unknown fingerprint is refused, naming both", unknown.ok === false && unknown.reason.includes("something else entirely") && unknown.reason.includes(current), JSON.stringify(unknown));

    // Steps are one-way: a step is not usable backwards.
    const oneWay = createMigrator("v1");
    oneWay.register(logging("v1", "v2"));
    const backwards = oneWay.migrate("v2", { log: [] });
    check("v1>v2 does not get v2 to v1", backwards.ok === false && backwards.reason.includes('"v2"') && backwards.reason.includes('"v1"'), JSON.stringify(backwards));
    done();
});

test("cycles in the registered migrations cannot hang the search", () => {
    const { check, done } = checks();

    // A and B only lead to each other; C is where we need to end up.
    const closed = createMigrator("C");
    closed.register(logging("A", "B"));
    closed.register(logging("B", "A"));
    for (const saved of ["A", "B", "D"]) {
        const result = guarded(() => closed.migrate(saved, { log: [] }));
        check(`from ${saved}: terminates with ok:false naming both ends`, result.ok === false && result.reason.includes(`"${saved}"`) && result.reason.includes('"C"'), JSON.stringify(result));
    }

    // A cycle with a way out: the exit is still found and the loop is not walked.
    const exit = createMigrator("C");
    exit.register(logging("A", "B"));
    exit.register(logging("B", "A"));
    exit.register(logging("B", "C"));
    const out = guarded(() => exit.migrate("A", { log: [] }));
    check("A>B, B>A, B>C: leaves the cycle after one lap at most", isDeepStrictEqual(steps(out), ["A>B", "B>C"]), JSON.stringify(out));

    // A longer loop, again with the exit at the far side.
    const ring = createMigrator("D");
    for (const [from, to] of [["A", "B"], ["B", "C"], ["C", "A"], ["C", "D"]]) ring.register(logging(from, to));
    const around = guarded(() => ring.migrate("A", { log: [] }));
    check("a three-step ring with an exit", isDeepStrictEqual(steps(around), ["A>B", "B>C", "C>D"]), JSON.stringify(around));

    // A step that leads back to where it started must never be taken.
    const selfLoop = createMigrator("C");
    selfLoop.register(logging("A", "A"));
    selfLoop.register(logging("A", "C"));
    const skipped = guarded(() => selfLoop.migrate("A", { log: [] }));
    check("a self-loop is skipped", isDeepStrictEqual(steps(skipped), ["A>C"]), JSON.stringify(skipped));
    done();
});

test("a migration that throws yields ok:false and never propagates", () => {
    const { check, done } = checks();
    const m = createMigrator("v3");
    m.register(logging("v1", "v2"));
    m.register({ from: "v2", to: "v3", migrate() { throw new Error("boom"); } });

    let result;
    try {
        result = m.migrate("v1", { log: [] });
    } catch (error) {
        assert.fail(`migrate() threw instead of reporting: ${error}`);
    }
    check("ok is false", result.ok === false, JSON.stringify(result));
    check("the reason carries the cause", result.reason?.includes("boom"), result.reason);
    check("the reason names both fingerprints", result.reason?.includes('"v1"') && result.reason.includes('"v3"'), result.reason);
    check("the reason names the step that failed", result.reason?.includes('"v2" -> "v3"'), result.reason);
    check("no half-migrated data is handed back", !("data" in result));

    // The migrator is still usable afterwards.
    const fine = m.migrate("v3", { log: [] });
    check("later calls are unaffected", fine.ok === true);

    // Anything at all can be thrown, not only an Error, and a broken step must not escape either.
    const throwers = [
        ["a string", () => { throw "nope"; }],
        ["a number", () => { throw 42; }],
        ["null", () => { throw null; }],
        ["undefined", () => { throw undefined; }],
        ["a plain object", () => { throw { code: 7 }; }],
        ["an object that cannot be printed", () => { throw Object.create(null); }],
        ["a TypeError", () => null.property],
        ["a step with no migrate function at all", undefined]
    ];
    for (const [label, migrate] of throwers) {
        const t = createMigrator("b");
        t.register({ from: "a", to: "b", migrate });
        let r;
        try {
            r = t.migrate("a", {});
        } catch {
            check(`${label}: escaped from migrate()`, false);
            continue;
        }
        check(`${label}: ok is false with a reason`, r.ok === false && typeof r.reason === "string" && r.reason.length > 0, JSON.stringify(r));
    }
    done();
});

test("describeSchema: canonical, sorted, and independent of key order", () => {
    const { check, done } = checks();
    check("documented format", describeSchema({ world: 1, balance: 1, guns: 1 }) === "balance@1,guns@1,world@1");
    check("key order does not matter", describeSchema({ guns: 3, world: 1, balance: 2 }) === describeSchema({ balance: 2, world: 1, guns: 3 }));
    check("and the result is sorted", describeSchema({ guns: 3, world: 1, balance: 2 }) === "balance@2,guns@3,world@1");
    check("sorted by key, not by version", describeSchema({ b: 1, a: 9 }) === "a@9,b@1");
    check("a version change changes the fingerprint", describeSchema({ a: 1, b: 1 }) !== describeSchema({ a: 1, b: 2 }));
    check("a new key changes the fingerprint", describeSchema({ a: 1 }) !== describeSchema({ a: 1, b: 1 }));
    check("plain code-unit order, never a locale order", describeSchema({ b: 1, B: 1, a: 1 }) === "B@1,a@1,b@1");
    check("empty schema", describeSchema({}) === "");
    check("the default is the running CONFIG_SCHEMA", describeSchema() === describeSchema(CONFIG_SCHEMA));
    check("stable from call to call", describeSchema() === describeSchema());

    const input = { z: 1, a: 2 };
    describeSchema(input);
    check("the input is left as it was", Object.keys(input).join() === "z,a");
    done();
});

test("each config file exports its schema version as a positive integer", () => {
    const { check, done } = checks();
    const versions = { WORLD_SCHEMA_VERSION, BALANCE_SCHEMA_VERSION, GUNS_SCHEMA_VERSION };
    for (const [name, value] of Object.entries(versions)) {
        check(`${name} is a positive integer`, Number.isInteger(value) && value > 0, `got ${String(value)}`);
    }
    check("CONFIG_SCHEMA is built from exactly these three", isDeepStrictEqual({ ...CONFIG_SCHEMA }, { balance: BALANCE_SCHEMA_VERSION, guns: GUNS_SCHEMA_VERSION, world: WORLD_SCHEMA_VERSION }));
    check("CONFIG_SCHEMA is frozen, so the fingerprint cannot drift at runtime", Object.isFrozen(CONFIG_SCHEMA));
    check("the fingerprint is made of them", describeSchema() === `balance@${BALANCE_SCHEMA_VERSION},guns@${GUNS_SCHEMA_VERSION},world@${WORLD_SCHEMA_VERSION}`);
    done();
});

test("migrators are independent of each other and see steps registered later", () => {
    const { check, done } = checks();
    const a = createMigrator("v2");
    const b = createMigrator("v2");

    check("before any registration, a cannot migrate", a.migrate("v1", { log: [] }).ok === false);
    a.register(logging("v1", "v2"));
    check("a can once a step is registered", isDeepStrictEqual(steps(a.migrate("v1", { log: [] })), ["v1>v2"]));
    check("b never saw that step", b.migrate("v1", { log: [] }).ok === false);
    check("nor did the exported migrator", migrator.migrate("v1", { log: [] }).ok === false);
    done();
});

test("schema.js is pure: it imports only its sibling config files, never the game API", () => {
    const { check, done } = checks();
    const compiled = path.resolve(import.meta.dirname, "..", ".test-build", "config", "schema.js");
    const code = readFileSync(compiled, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")        // comments may say anything
        .replace(/^\s*\/\/.*$/gm, "");
    const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);

    check("it imports the three config files", ["./balance.js", "./guns.js", "./world.js"].every((s) => specifiers.includes(s)), specifiers.join());
    check("every import is a sibling file", specifiers.every((s) => /^\.\/[a-z]+\.js$/.test(s)), specifiers.join());
    check("no game API import", !specifiers.some((s) => s.startsWith("@minecraft")), specifiers.join());
    done();
});
