import { test } from "node:test";
import assert from "node:assert/strict";
import { load, checks } from "./helpers.mjs";

// logic/shop.ts, the parts that turn what a builder TYPES into something exact: which shop a name means, which place three
// boxes of numbers mean, and a teleport sent somewhere else. Pure rules, no game.

const L = await load("logic/shop.js");
const { SHOP } = await load("config/balance.js");

const shop = (id, name) => {
    const made = L.newShop(id, name);
    assert.ok(made.ok, made.reason);
    return made.shop;
};

const withDeal = (base, deal) => {
    const added = L.addTrade(base, deal);
    assert.ok(added.ok, added.reason);
    return added.shop;
};

// ---------------------------------------------------------------------------------------------------------
// Which shop does this text mean?
// ---------------------------------------------------------------------------------------------------------

test("a shop is found by its id in any case, or by its name with spaces, underscores and hyphens read alike", () => {
    const { check, done } = checks();
    const shops = [shop("habiti", "Habiti the Horseman"), shop("mule_dealer", "Mule Dealer")];
    const idOf = (text, loose = false) => { const found = L.findShop(shops, text, loose); return found.ok ? found.value.id : `NO: ${found.reason}`; };

    check("the id", idOf("habiti") === "habiti" && idOf("mule_dealer") === "mule_dealer");
    check("the id in capitals", idOf("HABITI") === "habiti" && idOf("Mule_Dealer") === "mule_dealer");
    check("the name as it was given", idOf("Habiti the Horseman") === "habiti" && idOf("Mule Dealer") === "mule_dealer");
    check("the name in lower case", idOf("mule dealer") === "mule_dealer" && idOf("habiti the horseman") === "habiti");
    check("a hyphen or an underscore for a space", idOf("mule-dealer") === "mule_dealer" && idOf("habiti_the_horseman") === "habiti");
    check("spaces around and between", idOf("   mule    dealer  ") === "mule_dealer");
    done();
});

test("an id wins over another shop's name that happens to equal it", () => {
    const shops = [shop("stall", "Market"), shop("market", "Stall")];
    assert.equal(L.findShop(shops, "stall", false).value.id, "stall");
    assert.equal(L.findShop(shops, "market", false).value.id, "market");
});

test("text that fits two shops is refused, and names both so the builder can say which", () => {
    const { check, done } = checks();
    const shops = [shop("stall_a", "Stall"), shop("stall_b", "Stall")];

    const both = L.findShop(shops, "Stall", true);
    check("refused", !both.ok);
    check("both are named, with their ids", !both.ok && /Stall \(stall_a\)/.test(both.reason) && /Stall \(stall_b\)/.test(both.reason), both.reason);
    check("and told to use the id", !both.ok && /Use the id/.test(both.reason));
    check("the id itself still works", L.findShop(shops, "stall_a", true).ok === true);
    done();
});

test("loosely, one shop whose name starts with the text is enough; strictly, only the whole name is", () => {
    const { check, done } = checks();
    const shops = [shop("habiti", "Habiti the Horseman"), shop("mule_dealer", "Mule Dealer"), shop("hat_shop", "Hat Shop")];

    check("loose: a unique start", L.findShop(shops, "Mul", true).ok && L.findShop(shops, "Mul", true).value.id === "mule_dealer");
    check("loose: the start of the id works too", L.findShop(shops, "hab", true).ok && L.findShop(shops, "hab", true).value.id === "habiti");
    check("strict: the same start is refused", !L.findShop(shops, "Mul", false).ok);

    const shared = L.findShop(shops, "ha", true);
    check("loose: a start shared by two is refused and names them", !shared.ok && /Habiti the Horseman/.test(shared.reason) && /Hat Shop/.test(shared.reason), shared.reason);
    done();
});

test("nothing, blank and unknown text each get a sentence, never a guess", () => {
    const { check, done } = checks();
    const shops = [shop("habiti", "Habiti")];

    check("empty", L.findShop(shops, "", true).reason === "name a shop");
    check("blank", L.findShop(shops, "   ", true).reason === "name a shop");
    const unknown = L.findShop(shops, "Nobody Here", true);
    check("unknown says what was typed and where to look", !unknown.ok && /there is no shop "Nobody Here"/.test(unknown.reason) && /shop_list/.test(unknown.reason), unknown.reason);
    check("no shops at all", !L.findShop([], "habiti", true).ok);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Three boxes of numbers
// ---------------------------------------------------------------------------------------------------------

const read = (x, y, z, dimension = "overworld") => L.readDestination({ x, y, z }, dimension);

test("typed coordinates become a place: decimals and minus signs, to a hundredth of a block", () => {
    const { check, done } = checks();

    const plain = read("-251.5", "63", "186.5");
    check("a plain place", plain.ok && plain.value.x === -251.5 && plain.value.y === 63 && plain.value.z === 186.5 && plain.value.dimension === "overworld", JSON.stringify(plain));
    check("rounded to a hundredth", read("12.3456", "64", "-0.004").value.x === 12.35 && read("12.3456", "64", "-0.004").value.z === -0);
    check("spaces around a number are ignored", read("  10 ", " 70", "5  ").ok);
    check("a leading or trailing point is a number", read(".5", "5.", "0").ok && read(".5", "5.", "0").value.x === 0.5 && read(".5", "5.", "0").value.y === 5);
    check("any of the three dimensions", ["overworld", "nether", "the_end"].every((d) => read("0", "64", "0", d).ok));
    done();
});

test("a box that is blank, a word or not a plain number is refused by name, saying what was typed", () => {
    const { check, done } = checks();

    const blank = read("", "64", "0");
    check("blank X", !blank.ok && /^X is a number like -251\.5 \(it is blank\)$/.test(blank.reason), blank.reason);

    const word = read("0", "high", "0");
    check("a word in Y", !word.ok && /^Y is a number like -251\.5 \(you typed "high"\)$/.test(word.reason), word.reason);

    for (const odd of ["1e3", "0x10", "1,5", "--1", "Infinity", "NaN", "12 5", "+5", "~"]) {
        check(`"${odd}" is not a plain number`, !read("0", "64", odd).ok);
    }

    check("the first bad box is the one reported", /^X /.test(read("a", "b", "c").reason) && /^Y /.test(read("0", "b", "c").reason) && /^Z /.test(read("0", "0", "c").reason));
    done();
});

test("a height the world does not have, a place beyond the border, and an unknown dimension are refused", () => {
    const { check, done } = checks();

    check("the lowest height is allowed", read("0", String(SHOP.minTeleportY), "0").ok);
    check("one below is not", !read("0", String(SHOP.minTeleportY - 1), "0").ok);
    check("the highest height is allowed", read("0", String(SHOP.maxTeleportY), "0").ok);
    const tall = read("0", String(SHOP.maxTeleportY + 1), "0");
    check("one above is not, and says the range", !tall.ok && new RegExp(`${SHOP.minTeleportY} to ${SHOP.maxTeleportY}`).test(tall.reason), tall.reason);
    check("a typo like 6300 is caught", !read("0", "6300", "0").ok);

    check("the world border itself is allowed", read(String(SHOP.maxCoordinate), "64", String(-SHOP.maxCoordinate)).ok);
    check("beyond it, on X or Z, is not", !read(String(SHOP.maxCoordinate + 1), "64", "0").ok && !read("0", "64", String(-SHOP.maxCoordinate - 1)).ok);

    check("a dimension the game does not have", !read("0", "64", "0", "end").ok && !read("0", "64", "0", "").ok);
    done();
});

test("a saved teleport has the same limits, so data from any route obeys them", () => {
    const { check, done } = checks();
    const base = shop("habiti", "Habiti");
    const to = (y) => L.addTrade(base, L.teleportDeal({ x: 0, y, z: 0, dimension: "overworld" }, 10));

    check("the highest height saves", to(SHOP.maxTeleportY).ok);
    check("the lowest saves", to(SHOP.minTeleportY).ok);
    const tall = to(SHOP.maxTeleportY + 1);
    check("one above is refused with the range", !tall.ok && /height is -64 to 320/.test(tall.reason), tall.reason);
    check("one below too", !to(SHOP.minTeleportY - 1).ok);
    done();
});

test("a place reads in plain words with its dimension", () => {
    const { check, done } = checks();

    check("the overworld", L.describeDestination({ x: -251.5, y: 63, z: 186.5, dimension: "overworld" }) === "-251.5, 63, 186.5 in the overworld");
    check("the nether", L.describeDestination({ x: 10, y: 70, z: 10, dimension: "nether" }) === "10, 70, 10 in the nether");
    check("the end", L.describeDestination({ x: 0, y: 64, z: 0, dimension: "the_end" }) === "0, 64, 0 in the end");
    check("a dimension it does not know is named as it is", L.describeDestination({ x: 0, y: 0, z: 0, dimension: "mars" }) === "0, 0, 0 in mars");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// A teleport sent somewhere else
// ---------------------------------------------------------------------------------------------------------

const place = { x: -251.5, y: 63, z: 186.5, dimension: "overworld", name: "Angeles" };

test("retargeting changes where a deal's teleport goes and leaves every other reward alone", () => {
    const { check, done } = checks();
    const base = withDeal(shop("habiti", "Habiti"), {
        cost: { coins: 40, items: [] },
        rewards: [{ kind: "effect", effect: "speed", seconds: 30, amplifier: 1 }, { kind: "teleport", ...place }],
        requires: { role: "law" }
    });
    const [trade] = base.trades;

    const moved = L.retarget(trade, { x: 10, y: 70, z: -5, dimension: "nether" }, "Fort Maddrick");
    check("it works", moved.ok);

    const [effect, teleport] = moved.value;
    check("the teleport has the new place and name", teleport.x === 10 && teleport.y === 70 && teleport.z === -5 && teleport.dimension === "nether" && teleport.name === "Fort Maddrick", JSON.stringify(teleport));
    check("the effect is exactly as it was", JSON.stringify(effect) === JSON.stringify(trade.rewards[0]));

    const saved = L.updateTrade(base, trade.id, { rewards: moved.value });
    check("applied to the shop it is valid and keeps the price and who may take it", saved.ok && saved.shop.trades[0].cost.coins === 40 && saved.shop.trades[0].requires?.role === "law", JSON.stringify(saved));

    const again = L.parse(L.serialize(saved.shop));
    check("and it is saved and read back exactly", again.ok && JSON.stringify(again.value) === JSON.stringify(saved.shop));
    done();
});

test("an empty name takes the place's name off, and a name is tidied", () => {
    const { check, done } = checks();
    const base = withDeal(shop("habiti", "Habiti"), L.teleportDeal(place, 25));
    const [trade] = base.trades;

    check("an empty name clears it", L.retarget(trade, place, "").value[0].name === undefined && !("name" in L.retarget(trade, place, "   ").value[0]));
    check("colour codes and extra spaces are removed", L.retarget(trade, place, "  §aSaint   Diego ").value[0].name === "Saint Diego");
    check("the old name survives only if the new one says it", L.retarget(trade, place, "Angeles").value[0].name === "Angeles");
    done();
});

test("a deal that teleports no one cannot be retargeted, and a name that is too long is refused when applied", () => {
    const { check, done } = checks();
    const sword = withDeal(shop("habiti", "Habiti"), L.buyDeal({ type: "minecraft:iron_sword", amount: 1 }, 60));
    const refused = L.retarget(sword.trades[0], place, "x");
    check("no teleport: refused with a sentence", !refused.ok && /does not teleport anyone/.test(refused.reason), refused.reason);

    const base = withDeal(shop("habiti", "Habiti"), L.teleportDeal(place, 25));
    const rewards = L.retarget(base.trades[0], place, "N".repeat(SHOP.maxNameLength + 1));
    const applied = rewards.ok ? L.updateTrade(base, "t1", { rewards: rewards.value }) : rewards;
    check("a too-long name is caught by the whole-shop validation", !applied.ok && /place name/.test(applied.reason), applied.reason);

    check("teleportOf finds it, or says there is none", L.teleportOf(base.trades[0])?.name === "Angeles" && L.teleportOf(sword.trades[0]) === undefined);
    done();
});
