import { test } from "node:test";
import { fake, fakeApi, load, checks } from "./helpers.mjs";

// core/commands.ts: a FAMILY is one command whose first word picks an action, so a whole area costs ONE entry in the command bar's
// list instead of one per action. The contract: the action word is matched without regard to case, words after it are trimmed and
// empty ones are nothing, a word that is not an action is told its actions (the engine refuses one the list does not hold, so
// this is the second guard), `help` is always there and lists every action with what follows it, a slot can be a list the command
// bar completes, and a registration mistake is reported to the log, never thrown out of the startup callback.

const { PlayerPermissionLevel, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } = fakeApi;
const C = await load("core/commands.js");

const calls = [];

const FAMILY = {
    name: "rae:widget",
    description: "A test family.",
    actionEnum: "rae:widget_action",
    first: { name: "what" },
    second: { name: "how", choices: { enumId: "rae:widget_how", values: ["fast", "slow"] } },
    bareHelp: "opens the widget menu",
    bare: (origin) => { calls.push(["bare"]); return C.ok("menu"); },
    actions: [
        { name: "spin", usage: "<what> [how]", description: "Spins a widget.", run: (origin, first, second) => { calls.push(["spin", first, second]); return C.ok(`spun ${first ?? "nothing"} ${second ?? ""}`.trim()); } },
        { name: "stop", usage: "", description: "Stops everything.", run: () => { calls.push(["stop"]); return C.ok("stopped"); } }
    ]
};

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });

// One subscription for the whole file (a startup handler cannot be taken back), registering whichever family a test chose.
let chosen = FAMILY;
fakeApi.system.beforeEvents.startup.subscribe((event) => C.registerFamily(event.customCommandRegistry, "test", chosen));

function register(family = FAMILY) {
    fake.reset();
    calls.length = 0;
    chosen = family;
    const logged = [];
    const warn = console.warn;
    console.warn = (...args) => logged.push(args.join(" "));

    try {
        const started = fake.startUp();
        return { ...started, logged };
    } finally {
        console.warn = warn;
    }
}

test("a family registers ONE operator-only command with the action list, a text slot and a list slot, all optional", () => {
    const { commands, enums } = register();
    const { check, done } = checks();

    check("one command", [...commands.keys()].join() === "rae:widget", [...commands.keys()].join());

    const def = commands.get("rae:widget").def;
    check("operator-only", def.permissionLevel === CommandPermissionLevel.GameDirectors);
    check("nothing mandatory", (def.mandatoryParameters ?? []).length === 0);
    check("action list, text, list", def.optionalParameters.map((p) => p.type).join() === [CustomCommandParamType.Enum, CustomCommandParamType.String, CustomCommandParamType.Enum].join(), JSON.stringify(def.optionalParameters));
    check("a text slot keeps its own name", def.optionalParameters[1].name === "what");
    check("a list slot is named after its list", def.optionalParameters[2].name === "rae:widget_how");
    check("the action list holds the actions and help", enums.get("rae:widget_action").join() === "spin,stop,help", String(enums.get("rae:widget_action")));
    check("the slot's list holds its choices", enums.get("rae:widget_how").join() === "fast,slow");
    done();
});

test("typing the command: no action is the bare behaviour, an action gets its words trimmed, case does not matter", () => {
    const registry = register();
    const { check, done } = checks();
    const op = { sourceEntity: operator() };

    check("bare", registry.run("rae:widget", op).message === "menu" && calls.at(-1)[0] === "bare");
    check("an action with words", registry.run("rae:widget", op, "spin", "gear", "fast").message === "spun gear fast" && calls.at(-1).join() === "spin,gear,fast");
    check("the action word in capitals, where the engine lets it through", C.runFamily(FAMILY, op, "SPIN", "gear").message === "spun gear" && calls.at(-1)[0] === "spin");
    check("a word that is only spaces is nothing", registry.run("rae:widget", op, "spin", "   ").message === "spun nothing" && calls.at(-1)[1] === undefined);
    check("an action that needs no words", registry.run("rae:widget", op, "stop").message === "stopped");
    check("an action word with spaces round it, where the engine lets it through", C.runFamily(FAMILY, op, " stop ").message === "stopped");
    done();
});

test("a word that is not an action is told the actions (the second guard behind the engine's own list), and help lists them all", () => {
    const registry = register();
    const { check, done } = checks();
    const op = { sourceEntity: operator() };

    check("the engine refuses a word its list does not hold", registry.run("rae:widget", op, "explode").refused === "syntax");

    const direct = C.runFamily(FAMILY, op, "explode");
    check("and the family answers one that gets past it with the actions", direct.status === CustomCommandStatus.Failure && /has no action "explode"/.test(direct.message) && /spin, stop, help/.test(direct.message), JSON.stringify(direct));

    const help = registry.run("rae:widget", op, "help");
    check("help is a success", help.status === CustomCommandStatus.Success);
    check("it starts with what the bare command does", help.message.split("\n")[0] === "/rae:widget  opens the widget menu", help.message);
    check("then each action with what follows it and what it does", help.message.includes("/rae:widget spin <what> [how]  Spins a widget.") && help.message.includes("/rae:widget stop  Stops everything."), help.message);
    check("an action with nothing after it has no stray space", !/\/rae:widget stop {2}  /.test(help.message) && !/\/rae:widget stop  {2}/.test(help.message));
    done();
});

test("a slot's list is enforced by the engine, so a value outside it never reaches the action", () => {
    const registry = register();
    const op = { sourceEntity: operator() };

    const { check, done } = checks();
    check("fast is accepted", registry.run("rae:widget", op, "spin", "gear", "fast").status === CustomCommandStatus.Success);
    check("sideways is refused as a syntax error", registry.run("rae:widget", op, "spin", "gear", "sideways").refused === "syntax");
    done();
});

test("a registration mistake is reported to the log and does not throw out of the startup callback", () => {
    const broken = { ...FAMILY, actionEnum: "bare_name" };      // an enum with no namespace: the real engine throws NamespaceNameError
    const { commands, logged } = register(broken);
    const { check, done } = checks();

    check("it did not register", commands.size === 0);
    check("the log heard of it, naming the command and the reason", logged.some((l) => /registering rae:widget failed: .*namespace/i.test(l)), logged.join("|"));
    done();
});
