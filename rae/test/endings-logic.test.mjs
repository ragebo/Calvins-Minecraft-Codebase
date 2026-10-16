import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { load, checks } from "./helpers.mjs";

// logic/endings.ts (tasks/endings, Task 1): an ending as data, and the rules that decide whether a group or one outlaw has met it. Nothing here
// knows the game: places, purses and statuses come in as plain values, so every rule is tested with plain values.

const { ENDINGS } = await load("config/balance.js");
const L = await load("logic/endings.js");

const PLACE = { x: 10, y: 65, z: 154 };

function boat(patch = {}) {
    const made = L.newEnding("group", "boat", "Escape boat", PLACE);
    if (!made.ok) throw new Error(made.reason);
    const edited = L.edit(made.value, { radius: 16, price: 250, ...patch });
    if (!edited.ok) throw new Error(edited.reason);
    return edited.value;
}

function solo(patch = {}) {
    const made = L.newEnding("solo", "lighthouse", "Lighthouse", PLACE);
    if (!made.ok) throw new Error(made.reason);
    const edited = L.edit(made.value, { radius: 4, price: 100, ...patch });
    if (!edited.ok) throw new Error(edited.reason);
    return edited.value;
}

const at = (x, y, z) => ({ x, y, z });
const member = (id, coins, where = PLACE) => ({ id, coins, at: where });

test("the ending caps and default texts are on the table", () => {
    const { check, done } = checks();
    check("twelve endings at most", ENDINGS.maxEndings === 12);
    check("a record is capped in characters", ENDINGS.maxChars === 2400);
    check("text caps", ENDINGS.maxName === 40 && ENDINGS.maxText === 160);
    check("a radius cap and a price cap", ENDINGS.maxRadius === 200 && ENDINGS.maxPrice === 1_000_000);
    check("default texts for both kinds", typeof ENDINGS.texts.group.headline === "string" && typeof ENDINGS.texts.solo.headline === "string");
    done();
});

test("a new ending has the defaults of its kind and is usable only once it has what its kind needs", () => {
    const { check, done } = checks();
    const group = L.newEnding("group", "pier", "Pier", PLACE);
    check("a group ending can be made", group.ok === true);
    check("it is on", group.value.enabled === true);
    check("its texts are the group defaults", group.value.texts.headline === ENDINGS.texts.group.headline);
    check("a radius from the config", group.value.radius === ENDINGS.defaultRadius);
    check("a price of zero (a free escape) is allowed for a group", group.value.price === 0);

    const lone = L.newEnding("solo", "tower", "Tower", PLACE);
    check("a solo ending is made too, asking for the default price so that it is usable at once", lone.ok === true && lone.value.price === ENDINGS.defaultSoloPrice && ENDINGS.defaultSoloPrice > 0, JSON.stringify(lone));
    check("its texts are the solo defaults", lone.value.texts.headline === ENDINGS.texts.solo.headline);

    const spaced = L.newEnding("group", "pier", "  Pier  ", at(1.23456, 2.5, 3));
    check("a name is trimmed", spaced.ok && spaced.value.name === "Pier");
    check("a place is kept to two decimals", spaced.ok && spaced.value.place.x === 1.23 && spaced.value.place.y === 2.5);

    check("a name that is empty gives no ending", L.newEnding("group", "pier", "", PLACE).ok === false);
    check("an id that is not legal gives no ending", L.newEnding("group", "Not Legal", "Pier", PLACE).ok === false);
    check("a kind that does not exist gives no ending", L.newEnding("party", "pier", "Pier", PLACE).ok === false);
    done();
});

test("a record round-trips through serialize and parse", () => {
    const { check, done } = checks();
    const original = solo({ item: { id: "minecraft:emerald", count: 3 }, consumeItem: true, winSpot: at(1.5, 70, -3.25), texts: { headline: "§6{player} is out!" } });
    const text = L.serializeEnding(original);
    const back = L.parseEnding(text);
    check("it reads back", back.ok === true, JSON.stringify(back));
    check("equal in every field", isDeepStrictEqual(back.value, original), `${JSON.stringify(back.value)} vs ${JSON.stringify(original)}`);
    const off = boat({ enabled: false });
    check("an ending that is off stays off", L.parseEnding(L.serializeEnding(off)).value.enabled === false);
    const kept = solo({ item: { id: "minecraft:emerald", count: 1 }, consumeItem: false });
    check("an item that is only held stays only held", L.parseEnding(L.serializeEnding(kept)).value.consumeItem === false);
    const hand = JSON.parse(L.serializeEnding(boat()));
    hand.p = { x: 1.23456, y: 64.987, z: -2.005 };
    check("a place written by hand is rounded when read", (() => { const p = L.parseEnding(JSON.stringify(hand)).value.place; return p.x === 1.23 && p.y === 64.99; })());
    check("a group ending too", isDeepStrictEqual(L.parseEnding(L.serializeEnding(boat())).value, boat()));
    check("a place is kept to two decimals", L.parseEnding(L.serializeEnding(boat({ place: at(1.23456, 2, 3) }))).value.place.x === 1.23);
    check("an edit set the win spot, and it was saved and read back", original.winSpot?.x === 1.5 && back.value.winSpot?.z === -3.25, JSON.stringify(back.value.winSpot));
    check("an edit set the item, and it was saved and read back", original.item?.count === 3 && back.value.item?.id === "minecraft:emerald");
    done();
});

test("garbage is refused with a reason and never throws", () => {
    const { check, done } = checks();
    const good = JSON.parse(L.serializeEnding(boat()));
    const without = (key) => { const copy = { ...good }; delete copy[key]; return JSON.stringify(copy); };
    const cases = {
        "nothing": undefined, "empty": "", "not json": "{nope", "an array": "[]", "a number": "5", "null": "null",
        "another version": JSON.stringify({ ...good, v: 99 }), "no version": without("v"), "no id": without("id"), "no kind": without("k"), "no place": without("p"),
        "a kind that does not exist": JSON.stringify({ ...good, k: "party" }), "an id that is a number": JSON.stringify({ ...good, id: 5 }),
        "a place with a word in it": JSON.stringify({ ...good, p: { x: "a", y: 1, z: 2 } }), "a place that is NaN-like": JSON.stringify({ ...good, p: [1, 2] }),
        "a radius of text": JSON.stringify({ ...good, r: "big" }), "a price of text": JSON.stringify({ ...good, c: "lots" }),
        "texts that are numbers": JSON.stringify({ ...good, t: [1, 2, 3, 4] }), "too few texts": JSON.stringify({ ...good, t: ["a"] }),
        "a text over the cap": JSON.stringify({ ...good, t: ["x".repeat(ENDINGS.maxText + 1), "", "", ""] }),
        "an item that is a string": JSON.stringify({ ...good, i: "gold" })
    };

    for (const [label, text] of Object.entries(cases)) {
        let result;
        let threw = false;
        try { result = L.parseEnding(text); } catch { threw = true; }
        check(`${label}: no exception`, !threw);
        check(`${label}: refused, with a reason`, result?.ok === false && typeof result.reason === "string" && result.reason.length > 0, JSON.stringify(result));
    }
    done();
});

test("validate refuses what cannot work, and says why", () => {
    const { check, done } = checks();
    const why = (ending) => L.whyNotUsable(ending);

    check("a good group ending is fine", why(boat()) === undefined);
    check("a good solo ending is fine", why(solo()) === undefined);
    check("a radius of 0", /radius/.test(why({ ...boat(), radius: 0 })));
    check("a negative radius", /radius/.test(why({ ...boat(), radius: -3 })));
    check("a radius past the cap", /radius/.test(why({ ...boat(), radius: ENDINGS.maxRadius + 1 })));
    check("a negative price", /price/.test(why({ ...boat(), price: -1 })));
    check("a price that is not whole", /price/.test(why({ ...boat(), price: 2.5 })));
    check("a price past the cap", /price/.test(why({ ...boat(), price: ENDINGS.maxPrice + 1 })));
    check("a solo ending with neither coins nor item", /coins or an item/.test(why({ ...solo(), price: 0, item: undefined })));
    check("a solo ending with only an item is fine", why({ ...solo(), price: 0, item: { id: "minecraft:emerald", count: 1 } }) === undefined);
    check("a group ending paid in an item is refused", /coins/.test(why({ ...boat(), item: { id: "minecraft:emerald", count: 1 } })));
    check("an item id that is not an id", /item/.test(why({ ...solo(), item: { id: "Emerald!", count: 1 } })));
    check("an item count of 0", /item/.test(why({ ...solo(), item: { id: "minecraft:emerald", count: 0 } })));
    check("an item count that is not whole", /item/.test(why({ ...solo(), item: { id: "minecraft:emerald", count: 1.5 } })));
    check("an item count over the cap", /item/.test(why({ ...solo(), item: { id: "minecraft:emerald", count: 999 } })));
    check("an empty id", /id/.test(why({ ...boat(), id: "" })));
    check("an id that starts with a digit", /id/.test(why({ ...boat(), id: "9boat" })));
    check("an id that starts with a dash", /id/.test(why({ ...boat(), id: "-boat" })));
    check("a kind that is neither", /group or a solo/.test(why({ ...boat(), kind: "party" })));
    check("a radius that is not a number", /radius/.test(why({ ...boat(), radius: NaN })));
    check("a radius of infinity", /radius/.test(why({ ...boat(), radius: Infinity })));
    check("an item id past the cap", /item/.test(why({ ...solo(), item: { id: "minecraft:" + "a".repeat(51), count: 1 } })));
    check("an item count one past the cap", /item/.test(why({ ...solo(), item: { id: "minecraft:emerald", count: ENDINGS.maxItemCount + 1 } })));
    check("an item count at the cap is fine", why({ ...solo(), item: { id: "minecraft:emerald", count: ENDINGS.maxItemCount } }) === undefined);
    check("a text that is a number", /text/.test(why({ ...boat(), texts: { ...boat().texts, headline: 5 } })));
    check("a text at the cap is fine", why({ ...boat(), texts: { ...boat().texts, headline: "x".repeat(ENDINGS.maxText) } }) === undefined);
    check("a radius at the cap is fine", why({ ...boat(), radius: ENDINGS.maxRadius }) === undefined);
    check("a price at the cap is fine", why({ ...boat(), price: ENDINGS.maxPrice }) === undefined);
    check("a place at the edge of the world is fine", why({ ...boat(), place: at(30_000_000, 0, -30_000_000) }) === undefined);
    check("an id with a space", /id/.test(why({ ...boat(), id: "the boat" })));
    check("an id with capitals", /id/.test(why({ ...boat(), id: "Boat" })));
    check("an id that is too long", /id/.test(why({ ...boat(), id: "a".repeat(25) })));
    check("an empty name", /name/.test(why({ ...boat(), name: "" })));
    check("a name that is only spaces", /name/.test(why({ ...boat(), name: "   " })));
    check("a name past the cap", /name/.test(why({ ...boat(), name: "n".repeat(ENDINGS.maxName + 1) })));
    check("a control character in a name", /name/.test(why({ ...boat(), name: "bad\u0007name" })));
    check("a control character in a text", /text/.test(why({ ...boat(), texts: { ...boat().texts, detail: "line\nbreak" } })));
    check("a place that is not finite", /place/.test(why({ ...boat(), place: at(NaN, 1, 1) })));
    check("a place beyond the world", /place/.test(why({ ...boat(), place: at(31_000_000, 1, 1) })));
    check("a win spot that is not finite", /win spot/.test(why({ ...boat(), winSpot: at(1, Infinity, 1) })));
    done();
});

test("edit applies a change and re-checks it: a refused change leaves the ending as it was", () => {
    const { check, done } = checks();
    const original = boat();

    const renamed = L.edit(original, { name: "Pier ferry", enabled: false, texts: { gather: "§cAll aboard!" } });
    check("a good change applies", renamed.ok && renamed.value.name === "Pier ferry" && renamed.value.enabled === false);
    check("a changed text leaves the others", renamed.value.texts.gather === "§cAll aboard!" && renamed.value.texts.headline === original.texts.headline);
    check("the original is untouched", original.name === "Escape boat" && original.enabled === true);

    const worded = L.edit(original, { texts: { headline: "Custom headline" } });
    const again = L.edit(worded.value, { texts: { detail: "Custom detail" } });
    check("an edit keeps the texts an earlier edit set", again.ok && again.value.texts.headline === "Custom headline" && again.value.texts.detail === "Custom detail");

    const refused = L.edit(original, { price: -5 });
    check("a bad change is refused with a reason", refused.ok === false && /price/.test(refused.reason));

    const cleared = L.edit(solo({ item: { id: "minecraft:emerald", count: 1 }, winSpot: at(1, 2, 3) }), { item: null, winSpot: null });
    check("null clears an item and a win spot", cleared.ok && cleared.value.item === undefined && cleared.value.winSpot === undefined);

    const sameKind = L.edit(original, { kind: "solo" });
    check("a kind cannot be changed by an edit", sameKind.ok && sameKind.value.kind === "group");
    check("nor can the id", L.edit(original, { id: "other" }).value.id === "boat");
    done();
});

test("the worst case record fits the store's cap", () => {
    const { check, done } = checks();
    const worst = "\"\\".repeat(ENDINGS.maxText / 2);                       // every character needs escaping in JSON
    const made = L.edit(solo({ item: { id: "minecraft:" + "a".repeat(40), count: 64 } }), {
        name: "\\\"".repeat(ENDINGS.maxName / 2),
        place: at(-30_000_000, -64.25, 30_000_000), winSpot: at(-30_000_000, 319.75, 30_000_000),
        texts: { headline: worst, detail: worst, gather: worst, outlawsOnly: worst }
    });
    check("such an ending is valid", made.ok === true, JSON.stringify(made));
    const size = L.serializeEnding(made.value).length;
    check(`and is ${size} characters, inside ${ENDINGS.maxChars}`, size <= ENDINGS.maxChars);
    done();
});

test("texts fill in the amount, the player and the count, and leave anything else alone", () => {
    const { check, done } = checks();
    check("the amount", L.fillText("pooled {coins} coins", { coins: 500 }) === "pooled 500 coins");
    check("the player", L.fillText("{player} escaped", { player: "Ada" }) === "Ada escaped");
    check("the count, twice", L.fillText("{count} of {count}", { count: 3 }) === "3 of 3");
    check("an unknown name stays as typed", L.fillText("{nobody} {coins}", { coins: 1 }) === "{nobody} 1");
    check("a value that is not given stays as typed", L.fillText("{coins}", {}) === "{coins}");
    check("a dollar sign in a name is not a pattern", L.fillText("{player}", { player: "A$&B" }) === "A$&B");
    done();
});

test("ids are made from names, never taken twice, and always legal", () => {
    const { check, done } = checks();
    check("a plain name", L.endingIdFrom("Escape Boat", new Set()) === "escape_boat");
    check("punctuation and capitals", L.endingIdFrom("The Lighthouse!!", new Set()) === "the_lighthouse");
    check("taken, so numbered", L.endingIdFrom("Escape Boat", new Set(["escape_boat"])) === "escape_boat_2");
    check("taken twice", L.endingIdFrom("Escape Boat", new Set(["escape_boat", "escape_boat_2"])) === "escape_boat_3");
    check("a name with nothing to make an id from", L.endingIdFrom("!!!", new Set()) === "ending");
    check("a name that starts with a digit", /^[a-z]/.test(L.endingIdFrom("7 seas", new Set())));
    check("a long name stays inside the limit", L.endingIdFrom("x".repeat(80), new Set()).length <= 24);
    check("a long name, taken, stays inside the limit", L.endingIdFrom("x".repeat(80), new Set(["x".repeat(24)])).length <= 24);
    check("every id it makes is legal", ["Escape Boat", "a", "ZZZ top", "ending", "9 lives"].every((n) => L.whyNotUsable({ ...boat(), id: L.endingIdFrom(n, new Set()) }) === undefined));
    done();
});

test("the group verdict: all present and enough money passes, and the cost comes from the group in order", () => {
    const { check, done } = checks();
    const ending = boat();
    const ok = L.groupVerdict(ending, [member("a", 100), member("b", 600)]);

    check("it passes", ok.ok === true, JSON.stringify(ok));
    check("500 is owed: 250 each for two", ok.owed === 500);
    check("the first member pays what they have, the second the rest", JSON.stringify(ok.charges) === JSON.stringify([{ id: "a", take: 100 }, { id: "b", take: 400 }]), JSON.stringify(ok.charges));

    const exact = L.groupVerdict(ending, [member("a", 250), member("b", 250)]);
    check("exactly enough passes", exact.ok === true && JSON.stringify(exact.charges) === JSON.stringify([{ id: "a", take: 250 }, { id: "b", take: 250 }]));

    const rich = L.groupVerdict(ending, [member("a", 9999), member("b", 9999)]);
    check("a rich first member pays it all", JSON.stringify(rich.charges) === JSON.stringify([{ id: "a", take: 500 }]), JSON.stringify(rich.charges));

    check("nothing is ever taken beyond what is owed", [ok, exact, rich].every((v) => v.charges.reduce((sum, c) => sum + c.take, 0) === v.owed));
    check("a free ending takes nothing", L.groupVerdict(boat({ price: 0 }), [member("a", 0)]).charges.length === 0);
    const nearlyThere = L.groupVerdict(ending, [member("a", 250), member("b", 249)]);
    check("one coin short is short", nearlyThere.ok === false && nearlyThere.why === "poor" && nearlyThere.need === 500 && nearlyThere.have === 499, JSON.stringify(nearlyThere));
    const owing = L.groupVerdict(ending, [member("a", -100), member("b", 550)]);
    check("a purse below zero counts as nothing, not as a debt", owing.ok === true && JSON.stringify(owing.charges) === JSON.stringify([{ id: "b", take: 500 }]), JSON.stringify(owing));
    check("a member with no money is never charged a negative", L.groupVerdict(ending, [member("a", -50), member("b", 700)]).charges.every((c) => c.take > 0));
    done();
});

test("the group verdict names who is missing, and how many coins are short", () => {
    const { check, done } = checks();
    const ending = boat();

    const apart = L.groupVerdict(ending, [member("a", 500), member("b", 500, at(10, 65, 180)), member("c", 500, at(10, 65, 154))]);
    check("someone away: refused as 'gather'", apart.ok === false && apart.why === "gather");
    check("and the missing member is named", JSON.stringify(apart.missing) === JSON.stringify(["b"]), JSON.stringify(apart));

    const poor = L.groupVerdict(ending, [member("a", 100), member("b", 100)]);
    check("short of money: refused as 'poor'", poor.ok === false && poor.why === "poor");
    check("with what is needed and what they hold", poor.need === 500 && poor.have === 200, JSON.stringify(poor));

    const nobody = L.groupVerdict(ending, []);
    check("nobody at all: refused", nobody.ok === false && nobody.why === "nobody");

    const both = L.groupVerdict(ending, [member("a", 0), member("b", 0, at(500, 65, 154))]);
    check("away AND poor says 'gather' first (the boat's order)", both.ok === false && both.why === "gather");

    const edge = L.groupVerdict(ending, [member("a", 500, at(10 + 16, 65, 154)), member("b", 500, at(10, 65, 154 + 16))]);
    check("exactly at the radius is present", edge.ok === true);
    const justOut = L.groupVerdict(ending, [member("a", 500, at(10 + 16.01, 65, 154))]);
    check("a hair outside is not", justOut.ok === false && justOut.why === "gather");
    const high = L.groupVerdict(ending, [member("a", 500, at(10, 65 + 17, 154))]);
    check("height counts: 17 up is out", high.ok === false && high.why === "gather");
    done();
});

test("the solo verdict: the radius, the coins and the item, each with its own reason", () => {
    const { check, done } = checks();
    const coins = solo();
    const alone = (coinsHeld, where = PLACE, itemCount = 0) => ({ coins: coinsHeld, at: where, itemCount });

    const ok = L.soloVerdict(coins, alone(150));
    check("enough coins at the place passes and takes the price", ok.ok === true && ok.takeCoins === 100 && ok.takeItem === 0, JSON.stringify(ok));
    check("exactly enough passes", L.soloVerdict(coins, alone(100)).ok === true);
    check("a short purse says so and how much is missing", (() => { const v = L.soloVerdict(coins, alone(99)); return v.ok === false && v.why === "poor" && v.need === 100 && v.have === 99; })());
    check("at the radius edge is in", L.soloVerdict(coins, alone(100, at(10 + 4, 65, 154))).ok === true);
    check("a hair outside is out", (() => { const v = L.soloVerdict(coins, alone(100, at(10 + 4.01, 65, 154))); return v.ok === false && v.why === "far"; })());
    check("far wins over poor", L.soloVerdict(coins, alone(0, at(900, 65, 154))).why === "far");

    const item = solo({ price: 0, item: { id: "minecraft:emerald", count: 3 }, consumeItem: true });
    const withItem = L.soloVerdict(item, alone(0, PLACE, 5));
    check("item only: passes and takes the stack when consumed", withItem.ok === true && withItem.takeCoins === 0 && withItem.takeItem === 3, JSON.stringify(withItem));
    check("the item kept: nothing taken", L.soloVerdict(solo({ price: 0, item: { id: "minecraft:emerald", count: 3 }, consumeItem: false }), alone(0, PLACE, 3)).takeItem === 0);
    check("too few of the item says so", (() => { const v = L.soloVerdict(item, alone(0, PLACE, 2)); return v.ok === false && v.why === "item" && v.need === 3 && v.have === 2; })());

    const brokeWithItem = L.soloVerdict(solo({ price: 0, item: { id: "minecraft:emerald", count: 1 } }), alone(-5, PLACE, 1));
    check("a purse below zero counts as nothing, so an item-only ending still passes", brokeWithItem.ok === true, JSON.stringify(brokeWithItem));
    check("one coin short is short", L.soloVerdict(coins, alone(99)).ok === false);

    const both = solo({ price: 50, item: { id: "minecraft:emerald", count: 1 }, consumeItem: true });
    check("both asked for: both given", (() => { const v = L.soloVerdict(both, alone(50, PLACE, 1)); return v.ok && v.takeCoins === 50 && v.takeItem === 1; })());
    check("both asked for: coins but no item is refused as 'item'", L.soloVerdict(both, alone(500, PLACE, 0)).why === "item");
    check("both asked for: item but no coins is refused as 'poor'", L.soloVerdict(both, alone(10, PLACE, 5)).why === "poor");
    done();
});

test("the tally counts who escaped and who was captured, and the round verdict follows the agreed rule", () => {
    const { check, done } = checks();
    const free = { escaped: false, eliminated: false, inJail: false };
    const escaped = { escaped: true, eliminated: false, inJail: false };
    const jailed = { escaped: false, eliminated: false, inJail: true };
    const dead = { escaped: false, eliminated: true, inJail: false };

    check("a tally", JSON.stringify(L.tally([escaped, escaped, jailed, dead, free])) === JSON.stringify({ escaped: 2, captured: 2, free: 1, total: 5 }));
    check("a player counts once: escaped wins over jailed", L.tally([{ escaped: true, eliminated: false, inJail: true }]).captured === 0);
    check("nobody", L.tally([]).total === 0);

    check("nobody assigned: running", L.roundVerdict([]) === "running");
    check("one free outlaw: running", L.roundVerdict([free, jailed, escaped]) === "running");
    check("none escaped, all jailed or eliminated: law wins", L.roundVerdict([jailed, dead]) === "law_win");
    check("some escaped, the rest jailed or eliminated: law wins", L.roundVerdict([escaped, jailed, dead]) === "law_win");
    check("everyone escaped: the outlaws win", L.roundVerdict([escaped, escaped]) === "outlaw_win");
    check("one outlaw who escaped: the outlaws win", L.roundVerdict([escaped]) === "outlaw_win");
    check("an escaper beside a free outlaw: running", L.roundVerdict([escaped, free]) === "running");
    done();
});
