import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeApi, load, checks } from "./helpers.mjs";

// The two switches that decide how a click on a shop NPC reaches the shop are live-editable (core/configoverrides.ts), so the
// answer to the NPC probe can be applied in the game without a redeploy. They must change the very object systems/shoptalk.ts
// reads, and survive a script reload like every other override.

const { PlayerPermissionLevel } = fakeApi;
const configoverrides = await load("core/configoverrides.js");
const { SHOP } = await load("config/balance.js");

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });

test("shop.interceptClicks and shop.useDialogueScene are registered, boolean, and in their own category", () => {
    const { check, done } = checks();
    for (const id of ["shop.interceptClicks", "shop.useDialogueScene"]) {
        const field = configoverrides.getField(id);
        check(`${id} exists`, field !== undefined);
        check(`${id} is a boolean`, field?.kind === "boolean");
        check(`${id} is under Shops`, field?.category === "Shops");
        check(`${id} says what it does`, (field?.label ?? "").length > 20);
    }
    check("the Shops category is listed", configoverrides.listCategories().includes("Shops"));
    done();
});

test("turning interception off changes the object the click handler reads, and reset puts it back", () => {
    fake.reset();
    const { check, done } = checks();
    const op = operator();

    check("on by default", SHOP.interceptClicks === true);

    const off = configoverrides.setOverride(op, "shop.interceptClicks", false);
    check("the change is accepted", off.ok === true, JSON.stringify(off));
    check("and SHOP itself changed", SHOP.interceptClicks === false);

    const back = configoverrides.resetOverride(op, "shop.interceptClicks");
    check("reset is accepted", back.ok === true);
    check("and the default is back", SHOP.interceptClicks === true);
    done();
});

test("only an operator can change them", () => {
    fake.reset();
    const member = fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member });
    const refused = configoverrides.setOverride(member, "shop.useDialogueScene", false);
    assert.equal(refused.ok, false);
    assert.equal(SHOP.useDialogueScene, true);
});

test("a number is not a switch", () => {
    fake.reset();
    const refused = configoverrides.setOverride(operator(), "shop.interceptClicks", 1);
    assert.equal(refused.ok, false);
    assert.equal(SHOP.interceptClicks, true);
});
