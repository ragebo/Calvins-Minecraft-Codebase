import { test } from "node:test";
import { fake, world, fakeApi, load, checks } from "./helpers.mjs";

// systems/liveconfig.ts: ONE /rae:config command (it was six: config_list, _get, _set_number, _set_bool, _set_coordinate and
// _reset), registered inside system.beforeEvents.startup (the one window CustomCommandRegistry allows registration in) as a
// family (core/commands.ts): an action word, a setting's id, a value. Every action delegates straight into
// core/configoverrides.ts. The registry comes from the shared fake (fake.startUp()), which enforces the real one's rules
// (namespaced names, enums registered before the commands that use them, argument counts and types, the permission level), and
// `run` acts out typing the command.

const { PlayerPermissionLevel, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } = fakeApi;
await load("systems/liveconfig.js");
const { getField, hasOverride, resetOverride } = await load("core/configoverrides.js");
const { listSystems, resetAllSystems } = await load("core/registry.js");
const { GUNS } = await load("config/guns.js");
const { TRAIN_VAULT_CHEST } = await load("config/world.js");

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, location: { x: 10.7, y: 70.2, z: -3.2 } });
const member = () => fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });
const originOf = (player) => ({ sourceEntity: player });
const commandBlockOrigin = () => ({ sourceEntity: undefined });

function startUp() {
    fake.reset();
    return fake.startUp();
}

/** Types `/rae:config <words>` as a player would, through the registry's own rules. */
const type = (registry, origin, ...words) => registry.run("rae:config", origin, ...words);

test("registration builds ONE command, operator-gated, with the actions and every setting's id as lists", () => {
    const registry = startUp();
    const { check, done } = checks();

    check("one command, not six", [...registry.commands.keys()].filter((n) => n.startsWith("rae:config")).join(",") === "rae:config", [...registry.commands.keys()].join(","));

    const def = registry.commands.get("rae:config").def;
    check("operator-only", def.permissionLevel === CommandPermissionLevel.GameDirectors);
    check("nothing is mandatory: typed alone it opens the editor", (def.mandatoryParameters ?? []).length === 0);
    check("an action list, the setting's id list, then a value", def.optionalParameters.map((p) => p.type).join() === [CustomCommandParamType.Enum, CustomCommandParamType.Enum, CustomCommandParamType.String].join());

    const actions = registry.enums.get("rae:config_action");
    check("the actions", ["list", "get", "set", "reset", "help"].every((a) => actions.includes(a)), String(actions));

    const ids = registry.enums.get("rae:config_field");
    check("the list of ids holds a number, a switch and a position", ["revolver.fireRateTicks", "revolver.aim.scope", "world.trainVaultChest"].every((id) => ids.includes(id)));
    check("and one entry for every registered setting", ids.length > 100, String(ids.length));
    done();
});

test("a member is turned away by the engine, bare or with an action", () => {
    const registry = startUp();
    const { check, done } = checks();

    check("refused for permission", type(registry, originOf(member())).refused === "permission" && type(registry, originOf(member()), "list").refused === "permission");
    done();
});

test("set rejects a non-integer for an integer-kind setting, says what it takes, and leaves the value alone", () => {
    const registry = startUp();
    const before = GUNS.revolver.magazineSize;

    const result = type(registry, originOf(operator()), "set", "revolver.magazineSize", "6.5");

    const { check, done } = checks();
    check("reports Failure", result.status === CustomCommandStatus.Failure, JSON.stringify(result));
    check("the message explains why, in words, and names what the setting takes", /whole number/.test(result.message ?? "") && /revolver\.magazineSize/.test(result.message ?? ""), JSON.stringify(result));
    check("the real config value is untouched", GUNS.revolver.magazineSize === before);

    const typo = type(registry, originOf(operator()), "set", "revolver.magazineSize", "six");
    check("text that is not a number says what is wanted", typo.status === CustomCommandStatus.Failure && /whole number/.test(typo.message ?? ""), JSON.stringify(typo));

    const low = type(registry, originOf(operator()), "set", "revolver.magazineSize", "0");
    check("a value out of range is refused with the range", low.status === CustomCommandStatus.Failure && /at least 1/.test(low.message ?? ""), JSON.stringify(low));
    done();
});

test("set changes a number, shows before -> after, and reset puts it back", () => {
    const registry = startUp();
    const op = operator();
    const before = GUNS.pistol.fireRateTicks;

    const set = type(registry, originOf(op), "set", "pistol.fireRateTicks", String(before + 3));
    const { check, done } = checks();
    check("it worked and said from what to what", set.status === CustomCommandStatus.Success && set.message === `pistol.fireRateTicks: ${before} -> ${before + 3}.`, JSON.stringify(set));
    check("the real value changed", GUNS.pistol.fireRateTicks === before + 3);
    check("and it counts as changed", hasOverride("pistol.fireRateTicks"));

    const list = type(registry, originOf(op), "list");
    check("list shows what is changed, with its default", /Changed from the default \(1\):/.test(list.message) && new RegExp(`pistol\\.fireRateTicks = ${before + 3}  \\(default ${before}\\)`).test(list.message), list.message);
    check("and the groups", /Groups: .*Guns \(\d+\)/.test(list.message), list.message);

    const reset = type(registry, originOf(op), "reset", "pistol.fireRateTicks");
    check("reset put it back and said so", reset.status === CustomCommandStatus.Success && GUNS.pistol.fireRateTicks === before && /\(the default\)/.test(reset.message), JSON.stringify(reset));
    check("nothing is changed any more", /Nothing is changed/.test(type(registry, originOf(op), "list").message));
    done();
});

test("set takes on or off for a switch, and refuses anything else", () => {
    const registry = startUp();
    const op = operator();
    const before = getField("revolver.aim.scope").get();

    const { check, done } = checks();
    const off = type(registry, originOf(op), "set", "revolver.aim.scope", before ? "off" : "on");
    check("a word worked", off.status === CustomCommandStatus.Success && getField("revolver.aim.scope").get() === !before, JSON.stringify(off));

    const nonsense = type(registry, originOf(op), "set", "revolver.aim.scope", "maybe");
    check("a word that is not on or off is refused", nonsense.status === CustomCommandStatus.Failure && /on or off/.test(nonsense.message), JSON.stringify(nonsense));

    resetOverride(op, "revolver.aim.scope");
    check("reset restores it", getField("revolver.aim.scope").get() === before);
    done();
});

test("set takes a position as three numbers, as here, or as ~ ~ ~, and applies it in place", () => {
    const registry = startUp();
    const op = operator();
    const before = { ...TRAIN_VAULT_CHEST };

    const { check, done } = checks();

    const typed = type(registry, originOf(op), "set", "world.trainVaultChest", "1 65 2");
    check("three numbers", typed.status === CustomCommandStatus.Success && TRAIN_VAULT_CHEST.x === 1 && TRAIN_VAULT_CHEST.y === 65 && TRAIN_VAULT_CHEST.z === 2, JSON.stringify(TRAIN_VAULT_CHEST));

    const commas = type(registry, originOf(op), "set", "world.trainVaultChest", "3,66,4");
    check("or with commas", commas.status === CustomCommandStatus.Success && TRAIN_VAULT_CHEST.x === 3 && TRAIN_VAULT_CHEST.z === 4, JSON.stringify(TRAIN_VAULT_CHEST));

    const here = type(registry, originOf(op), "set", "world.trainVaultChest", "here");
    check("here is the middle of the block she stands in", here.status === CustomCommandStatus.Success && TRAIN_VAULT_CHEST.x === 10.5 && TRAIN_VAULT_CHEST.y === 70 && TRAIN_VAULT_CHEST.z === -3.5, JSON.stringify(TRAIN_VAULT_CHEST));

    const relative = type(registry, originOf(op), "set", "world.trainVaultChest", "~ ~1 ~-2");
    check("~ is relative to the same spot (the middle of her block), so ~ ~1 ~-2 is one up and two back from it", relative.status === CustomCommandStatus.Success && TRAIN_VAULT_CHEST.x === 10.5 && TRAIN_VAULT_CHEST.y === 71 && TRAIN_VAULT_CHEST.z === -5.5, JSON.stringify(TRAIN_VAULT_CHEST));

    const two = type(registry, originOf(op), "set", "world.trainVaultChest", "1 2");
    check("two numbers are refused with what a position is", two.status === CustomCommandStatus.Failure && /x, y, z/.test(two.message), JSON.stringify(two));

    resetOverride(op, "world.trainVaultChest");
    check("reset restores the position", TRAIN_VAULT_CHEST.x === before.x && TRAIN_VAULT_CHEST.y === before.y && TRAIN_VAULT_CHEST.z === before.z, JSON.stringify(TRAIN_VAULT_CHEST));
    done();
});

test("a mutating action run from a command block (no player) is refused, not thrown", () => {
    const registry = startUp();
    const before = GUNS.pistol.fireRateTicks;

    const set = type(registry, commandBlockOrigin(), "set", "pistol.fireRateTicks", "5");
    const reset = type(registry, commandBlockOrigin(), "reset", "pistol.fireRateTicks");

    const { check, done } = checks();
    check("set reports Failure and asks for a player", set.status === CustomCommandStatus.Failure && /player/i.test(set.message ?? ""), JSON.stringify(set));
    check("so does reset", reset.status === CustomCommandStatus.Failure && /player/i.test(reset.message ?? ""), JSON.stringify(reset));
    check("unchanged", GUNS.pistol.fireRateTicks === before);

    const bare = type(registry, commandBlockOrigin());
    check("and the bare command says the editor is for a player and what a command block can use", bare.status === CustomCommandStatus.Failure && /player/.test(bare.message) && /set, get, reset or list/.test(bare.message), JSON.stringify(bare));
    done();
});

test("get and list need no player at all, and get says the default and what the setting takes", () => {
    const registry = startUp();

    const getResult = type(registry, commandBlockOrigin(), "get", "revolver.fireRateTicks");
    const listResult = type(registry, commandBlockOrigin(), "list");

    const { check, done } = checks();
    check("get succeeds with no sourceEntity at all", getResult.status === CustomCommandStatus.Success, JSON.stringify(getResult));
    check("and names the label, the default and the range", /revolver\.fireRateTicks = \d+/.test(getResult.message) && /default \d+/.test(getResult.message) && /whole number, at least 1/.test(getResult.message), getResult.message);
    check("list succeeds with no player", listResult.status === CustomCommandStatus.Success, JSON.stringify(listResult));

    check("an id the list does not hold never reaches the callback", type(registry, commandBlockOrigin(), "get", "not.a.setting").refused === "syntax");
    check("get without an id says what to type", /Which setting/.test(type(registry, commandBlockOrigin(), "get").message));
    done();
});

test("help lists the actions, and an unknown action word is the engine's to refuse", () => {
    const registry = startUp();
    const { check, done } = checks();

    const help = type(registry, commandBlockOrigin(), "help").message;
    check("help names every action with what follows it", /\/rae:config set <field> <value>/.test(help) && /\/rae:config reset <field>/.test(help) && /\/rae:config get <field>/.test(help) && /\/rae:config list/.test(help), help);
    check("and what the bare command does", /\/rae:config {2}opens the editor/.test(help), help);
    check("an unknown word is refused as a syntax error", type(registry, commandBlockOrigin(), "explode").refused === "syntax");
    done();
});

test("liveconfig registers as a system, and a round reset does not touch an active override", () => {
    fake.reset();
    startUp();
    const before = GUNS.revolver.fireRateTicks;

    const { check, done } = checks();
    check("registered under the right name", listSystems().some((s) => s.name === "liveconfig"));

    getField("revolver.fireRateTicks").set(before + 1);
    resetAllSystems();
    check("the live edit survives a round reset", GUNS.revolver.fireRateTicks === before + 1, String(GUNS.revolver.fireRateTicks));
    done();

    getField("revolver.fireRateTicks").set(before);
});
