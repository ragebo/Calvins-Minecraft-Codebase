import { test } from "node:test";
import { fake, fakeApi, load, checks } from "./helpers.mjs";

// The live off switch for the telemetry lines: `telemetry.events`, set from the game with /rae:config (core/configoverrides.ts), read by
// core/telemetryevents.ts at every line. The point is that a world that is writing too much, or that the owner does not want counted, can be
// quieted with no redeploy; so the test is not only that the setting exists but that the emitter obeys it, typed the way an operator types it.

const lines = [];
const realWarn = console.warn;
console.warn = (...args) => { lines.push(args.join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

const { PlayerPermissionLevel, CustomCommandStatus } = fakeApi;
await load("systems/liveconfig.js");
const { getField, resetOverride } = await load("core/configoverrides.js");
const { emit } = await load("core/telemetryevents.js");
const { TELEMETRY } = await load("config/balance.js");

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
const member = () => fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });

const type = (registry, player, ...words) => registry.run("rae:config", { sourceEntity: player }, ...words);

/** The shop lines written so far: one `shop.open` is the probe, because nothing else writes one. */
const written = () => lines.filter((text) => text.startsWith("[telemetry] {") && text.includes('"k":"shop.open"')).length;

const probe = () => emit("shop.open", { id: "switch-probe", p: "p1" });

test("the switch is a registered on/off setting that says what it stops", () => {
    const { check, done } = checks();
    const field = getField("telemetry.events");

    check("it exists, is a switch, and has a group of its own", field?.kind === "boolean" && field.category === "Telemetry", JSON.stringify(field && { kind: field.kind, category: field.category }));
    check("its label says it is the content log lines and that off writes nothing", /telemetry/i.test(field?.label ?? "") && /content log/i.test(field?.label ?? "") && (field?.label ?? "").length > 30, field?.label);
    check("it reads the live value: on by default", field?.get() === true && TELEMETRY.events.enabled === true);
    done();
});

test("typed as /rae:config set telemetry.events off, the lines stop at once, and on starts them again", () => {
    const { check, done } = checks();

    fake.reset();
    const registry = fake.startUp();
    const op = operator();

    const before = written();
    probe();
    check("on, a line is written", written() === before + 1);

    const off = type(registry, op, "set", "telemetry.events", "off");
    check("off was accepted, and says from what to what", off.status === CustomCommandStatus.Success && /telemetry\.events: .*->/.test(off.message ?? ""), JSON.stringify(off));
    check("the setting itself changed", TELEMETRY.events.enabled === false);

    probe();
    probe();
    check("off, nothing is written", written() === before + 1, `${written() - before} lines`);

    const got = type(registry, op, "get", "telemetry.events");
    check("get tells the state and the default", got.status === CustomCommandStatus.Success && /telemetry\.events = /.test(got.message ?? "") && /default/.test(got.message ?? ""), JSON.stringify(got));

    const on = type(registry, op, "set", "telemetry.events", "on");
    probe();
    check("on again, lines are written again", on.status === CustomCommandStatus.Success && TELEMETRY.events.enabled === true && written() === before + 2, `${written() - before} lines`);

    resetOverride(op, "telemetry.events");
    done();
});

test("reset puts it back on, a word that is not on or off is refused, and a member is turned away by the game", () => {
    const { check, done } = checks();

    fake.reset();
    const registry = fake.startUp();
    const op = operator();

    type(registry, op, "set", "telemetry.events", "off");
    const reset = type(registry, op, "reset", "telemetry.events");
    check("reset turned it back on", reset.status === CustomCommandStatus.Success && TELEMETRY.events.enabled === true, JSON.stringify(reset));

    const nonsense = type(registry, op, "set", "telemetry.events", "maybe");
    check("nonsense is refused and the setting is left alone", nonsense.status === CustomCommandStatus.Failure && TELEMETRY.events.enabled === true, JSON.stringify(nonsense));

    check("a member is refused before the command runs", type(registry, member(), "set", "telemetry.events", "off").refused === "permission" && TELEMETRY.events.enabled === true);
    done();
});
