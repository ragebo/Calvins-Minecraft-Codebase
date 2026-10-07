import { test } from "node:test";
import { fake, system, world, fakeApi, load, checks } from "./helpers.mjs";

// systems/liveconfig.ts: six /rae:config_* custom commands, registered inside
// system.beforeEvents.startup (the one window CustomCommandRegistry allows registration in), each
// delegating straight into core/configoverrides.ts. The registry comes from the shared fake (fake.startUp()), which
// enforces the real one's rules; a test invokes a registered command's callback directly.

const { PlayerPermissionLevel, CommandPermissionLevel, CustomCommandStatus } = fakeApi;
await load("systems/liveconfig.js");
const { getField } = await load("core/configoverrides.js");
const { listSystems, resetAllSystems } = await load("core/registry.js");
const { GUNS } = await load("config/guns.js");
const { BOAT_NPC } = await load("config/world.js");

/**
 * Fires the one-shot startup event liveconfig.ts's commands register inside. The registry is the fake's validating one
 * (namespaced names, enums registered before the commands that use them, startup only), so the mistake that once
 * silently killed all six commands in the real game now fails here.
 */
function startUp() {
    return fake.startUp();
}

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
const originOf = (player) => ({ sourceEntity: player });
const commandBlockOrigin = () => ({ sourceEntity: undefined });

test("registration builds six commands, all operator-gated, plus the field/category enums", () => {
    fake.reset();
    const registry = startUp();

    const { check, done } = checks();
    const names = [...registry.commands.keys()].sort();
    check("exactly the six expected commands", names.join(",") === [
        "rae:config_get", "rae:config_list", "rae:config_reset",
        "rae:config_set_bool", "rae:config_set_coordinate", "rae:config_set_number"
    ].sort().join(","), names.join(","));

    check("every command requires GameDirectors (operator-only)",
        [...registry.commands.values()].every((c) => c.def.permissionLevel === CommandPermissionLevel.GameDirectors));

    const numberField = [...registry.enums.entries()].find(([, values]) => values.includes("revolver.fireRateTicks"));
    const vectorField = [...registry.enums.entries()].find(([, values]) => values.includes("world.boatNpc"));
    const boolField = [...registry.enums.entries()].find(([, values]) => values.includes("revolver.aim.scope"));
    check("a numeric-field enum contains a known gun field", numberField !== undefined);
    check("a vector3-field enum contains a known world field", vectorField !== undefined);
    check("a boolean-field enum contains a known gun field", boolField !== undefined);
    check("the numeric enum does not also list a vector3 field", !numberField[1].includes("world.boatNpc"));
    check("a category enum lists human categories", [...registry.enums.values()].some((values) => values.includes("Guns") && values.includes("World")));
    done();
});

test("rae:config_set_number rejects a non-integer for an integer-kind field, and delegates real validation", () => {
    fake.reset();
    const registry = startUp();
    const before = GUNS.revolver.magazineSize;

    const { callback } = registry.commands.get("rae:config_set_number");
    const result = callback(originOf(operator()), "revolver.magazineSize", 6.5);

    const { check, done } = checks();
    check("reports Failure", result.status === CustomCommandStatus.Failure, JSON.stringify(result));
    check("message explains why", /whole number/.test(result.message ?? ""), JSON.stringify(result));
    check("the real config value is untouched", GUNS.revolver.magazineSize === before);
    done();
});

test("rae:config_set_coordinate maps a Location-shaped argument to x/y/z and applies it in place", () => {
    fake.reset();
    const registry = startUp();
    const before = { ...BOAT_NPC };

    const { callback } = registry.commands.get("rae:config_set_coordinate");
    const location = { x: 1, y: 65, z: 2, dimension: world.getDimension("overworld") };
    const result = callback(originOf(operator()), "world.boatNpc", location);

    const { check, done } = checks();
    check("reports Success", result.status === CustomCommandStatus.Success, JSON.stringify(result));
    check("BOAT_NPC itself was mutated", BOAT_NPC.x === 1 && BOAT_NPC.y === 65 && BOAT_NPC.z === 2, JSON.stringify(BOAT_NPC));
    done();

    getField("world.boatNpc").set(before);
});

test("a mutating command run from a command block (no player) is refused, not thrown", () => {
    fake.reset();
    const registry = startUp();
    const before = GUNS.pistol.fireRateTicks;

    const { callback } = registry.commands.get("rae:config_set_number");
    const result = callback(commandBlockOrigin(), "pistol.fireRateTicks", 5);

    const { check, done } = checks();
    check("reports Failure", result.status === CustomCommandStatus.Failure, JSON.stringify(result));
    check("asks for a player", /player/i.test(result.message ?? ""), JSON.stringify(result));
    check("unchanged", GUNS.pistol.fireRateTicks === before);
    done();
});

test("rae:config_list reports fields for a known category and fails cleanly for an unknown one", () => {
    fake.reset();
    const registry = startUp();
    const { callback } = registry.commands.get("rae:config_list");

    const guns = callback({}, "Guns");
    const bogus = callback({}, "NotACategory");

    const { check, done } = checks();
    check("Guns category succeeds and mentions a gun field", guns.status === CustomCommandStatus.Success && guns.message.includes("fireRateTicks"), guns.message);
    check("an unknown category fails cleanly", bogus.status === CustomCommandStatus.Failure, JSON.stringify(bogus));
    done();
});

test("rae:config_get and rae:config_list need no player at all", () => {
    fake.reset();
    const registry = startUp();

    const getResult = registry.commands.get("rae:config_get").callback({}, "revolver.fireRateTicks");
    const listResult = registry.commands.get("rae:config_list").callback({}, undefined);

    const { check, done } = checks();
    check("get succeeds with no sourceEntity at all", getResult.status === CustomCommandStatus.Success, JSON.stringify(getResult));
    check("list succeeds with no category and no sourceEntity", listResult.status === CustomCommandStatus.Success, JSON.stringify(listResult));
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
