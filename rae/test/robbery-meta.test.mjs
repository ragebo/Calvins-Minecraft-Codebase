import { test } from "node:test";
import assert from "node:assert/strict";
import { load, checks } from "./helpers.mjs";
import { L, bank, ok } from "./robbery-fixtures.mjs";

// logic/robberymeta.ts: the builder's forms as data. The contract is that a field list both builds a form and reads its
// answers back; that a wrong or missing answer is refused with a sentence, never turned into a default; that the answers of
// every lock, effect and settings form go through logic/robbery.ts's validators (the only judges of what is allowed); and
// that the plain-language summaries say what was built.

const M = await load("logic/robberymeta.js");
const { ROBBERY: R } = await load("config/balance.js");

const text = (key, value = "") => ({ kind: "text", key, label: key, placeholder: "", value });

// ---------------------------------------------------------------------------------------------------------
// Reading answers
// ---------------------------------------------------------------------------------------------------------

test("wholeNumber takes digits and nothing else", () => {
    const { check, done } = checks();

    check("plain", M.wholeNumber("12", "the delay", 0, 120).value === 12);
    check("surrounding spaces are fine", M.wholeNumber("  7 ", "the delay", 0, 120).value === 7);
    check("zero", M.wholeNumber("0", "the delay", 0, 120).value === 0);
    check("the bounds are included", M.wholeNumber("120", "the delay", 0, 120).ok && M.wholeNumber("0", "the delay", 0, 120).ok);
    for (const wrong of ["", "  ", "1.5", "-3", "+4", "12abc", "abc", "1e3", "1,000", "0x10"]) {
        check(`"${wrong}" is refused`, M.wholeNumber(wrong, "the delay", 0, 120).ok === false);
    }
    check("over the maximum is refused", M.wholeNumber("121", "the delay", 0, 120).ok === false);
    check("the reason names the thing and the range", /the delay must be a whole number from 0 to 120/.test(M.wholeNumber("x", "the delay", 0, 120).reason));
    done();
});

test("readAnswers reads every kind of field by key, and refuses what does not fit", () => {
    const { check, done } = checks();

    const fields = [
        text("name"),
        { kind: "number", key: "delay", label: "Delay", what: "the delay", min: 0, max: 120, value: 0 },
        { kind: "toggle", key: "on", label: "On", value: false },
        { kind: "slider", key: "hits", label: "Hits", min: 1, max: 10, step: 1, value: 2 },
        { kind: "choice", key: "to", label: "To", options: [{ value: "actor", label: "Actor" }, { value: "area", label: "Area" }], value: "actor" }
    ];

    const good = M.readAnswers(fields, ["  Vault  ", "15", true, 3.4, 1]);
    check("a good form reads", good.ok, good.reason);
    check("text is trimmed", good.value?.name === "Vault");
    check("a number box becomes a number", good.value?.delay === 15);
    check("a toggle is a boolean", good.value?.on === true);
    check("a slider is a whole number", good.value?.hits === 3);
    check("a choice is the value of the option picked, not its index", good.value?.to === "area");

    check("too few answers: the form came back incomplete", /incomplete/.test(M.readAnswers(fields, ["x", "1", true]).reason ?? ""));
    check("no answers at all", M.readAnswers(fields, undefined).ok === false);
    check("a bad number is refused with its name", /the delay must be a whole number/.test(M.readAnswers(fields, ["x", "ten", true, 3, 0]).reason ?? ""));
    check("a slider that is not a number is refused", M.readAnswers(fields, ["x", "1", true, "lots", 0]).ok === false);
    check("a choice with nothing picked is refused", /nothing picked/.test(M.readAnswers(fields, ["x", "1", true, 3, undefined]).reason ?? ""));
    check("a choice past the end is refused", M.readAnswers(fields, ["x", "1", true, 3, 9]).ok === false);
    check("a toggle that comes back as anything but true is off", M.readAnswers(fields, ["x", "1", "yes", 3, 0]).value?.on === false);
    check("extra answers are ignored", M.readAnswers(fields, ["x", "1", true, 3, 0, "extra"]).ok);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------------------------------------

/** Fills a field list in as a player would: every field keeps its current value, except those overridden by key. */
function fillIn(fields, overrides = {}) {
    return fields.map((f) => {
        const value = key => (key in overrides ? overrides[key] : undefined);
        const given = value(f.key);
        if (f.kind === "number") return String(given ?? f.value);
        if (f.kind === "choice") return typeof given === "number" ? given : f.options.findIndex((o) => o.value === (given ?? f.value));
        return given ?? f.value;
    });
}

const answer = (fields, overrides) => {
    const read = M.readAnswers(fields, fillIn(fields, overrides));
    assert.equal(read.ok, true, read.reason);
    return read.value;
};

test("every lock kind starts from a sensible default, and what the form returns passes the lock validator", () => {
    const { check, done } = checks();

    for (const kind of ["pick", "pay"]) {
        const fields = M.lockFields(kind);
        const lock = L.validateLock(M.lockFromAnswers(kind, answer(fields)));
        check(`a default ${kind} lock is valid as it stands`, lock.ok, lock.reason);
    }

    const key = L.validateLock(M.lockFromAnswers("key", answer(M.lockFields("key"))));
    check("a key lock with no item typed is refused by the validator, not by this file", key.ok === false && /item id/.test(key.reason ?? ""), JSON.stringify(key));

    const typed = L.validateLock(M.lockFromAnswers("key", answer(M.lockFields("key"), { item: "minecraft:iron_pickaxe", consume: false })));
    check("with an item typed it is valid", typed.ok && typed.value.item === "minecraft:iron_pickaxe" && typed.value.consume === false, JSON.stringify(typed));
    done();
});

test("editing a lock starts the form from its current values", () => {
    const { check, done } = checks();
    const pick = { kind: "pick", hits: 4, tolerance: 7, strikes: 0, jamSeconds: 90 };

    const fields = M.lockFields("pick", pick);
    const values = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    check("every field holds the lock's own value", values.hits === 4 && values.tolerance === 7 && values.strikes === 0 && values.jamSeconds === 90, JSON.stringify(values));

    const changed = L.validateLock(M.lockFromAnswers("pick", answer(fields, { hits: 6 })));
    check("a changed answer comes through, the rest kept", changed.ok && changed.value.hits === 6 && changed.value.tolerance === 7, JSON.stringify(changed));

    const pay = M.lockFields("pay", { kind: "pay", coins: 80 });
    check("a price form starts from the price", pay[0].value === 80);
    check("asking for a different kind's fields ignores a lock of another kind", M.lockFields("pay", pick)[0].value === 25);
    done();
});

test("the lock forms' ranges are the config's, so the form cannot offer what the validator refuses", () => {
    const { check, done } = checks();

    const pick = M.lockFields("pick");
    const by = (key) => pick.find((f) => f.key === key);
    check("picks needed", by("hits").min === 1 && by("hits").max === R.maxPickHits);
    check("tolerance", by("tolerance").max === Math.floor(R.pickSliderMax / 2));
    check("strikes can be 0 (never jams)", by("strikes").min === 0 && by("strikes").max === R.maxPickStrikes);
    check("jam seconds", by("jamSeconds").max === R.maxPickJamSeconds);

    const maxed = L.validateLock(M.lockFromAnswers("pick", answer(pick, { hits: R.maxPickHits, tolerance: Math.floor(R.pickSliderMax / 2), strikes: R.maxPickStrikes, jamSeconds: R.maxPickJamSeconds })));
    check("every top-of-range answer is accepted by the validator", maxed.ok, maxed.reason);
    done();
});

test("describeLock says what a lock is in plain words", () => {
    const { check, done } = checks();

    check("pick", M.describeLock({ kind: "pick", hits: 2, tolerance: 10, strikes: 3, jamSeconds: 20 }) === "Pick lock: 2 correct picks (+/-10), jams after 3 misses for 20s");
    check("a pick that never jams", /never jams/.test(M.describeLock({ kind: "pick", hits: 1, tolerance: 5, strikes: 0, jamSeconds: 0 })) && /1 correct pick /.test(M.describeLock({ kind: "pick", hits: 1, tolerance: 5, strikes: 0, jamSeconds: 0 })));
    check("key", M.describeLock({ kind: "key", item: "minecraft:iron_pickaxe", consume: true }) === "Key: iron pickaxe (used up)");
    check("a key that is kept", M.describeLock({ kind: "key", item: "minecraft:iron_pickaxe", consume: false }) === "Key: iron pickaxe");
    check("price", M.describeLock({ kind: "pay", coins: 25 }) === "Price: 25 coins");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------------------

test("a say effect: a blank sound adds none, a zero delay adds none, and the validator accepts the rest", () => {
    const { check, done } = checks();

    const fields = M.effectFields("say");
    const effect = L.validateEffect(M.effectFromAnswers("say", answer(fields, { text: "Alarm!", channel: "title", to: "law" })));

    check("valid", effect.ok, effect.reason);
    check("with what was asked", effect.value.text === "Alarm!" && effect.value.channel === "title" && effect.value.to === "law");
    check("no sound property", !("sound" in effect.value));
    check("no delay property", !("delaySeconds" in effect.value));

    const loud = L.validateEffect(M.effectFromAnswers("say", answer(fields, { text: "Hi", sound: "random.levelup", delaySeconds: 5 })));
    check("a sound and a delay are carried", loud.ok && loud.value.sound === "random.levelup" && loud.value.delaySeconds === 5, JSON.stringify(loud));

    check("an empty message is refused by the validator", L.validateEffect(M.effectFromAnswers("say", answer(fields))).ok === false);
    done();
});

test("reward and end effects", () => {
    const { check, done } = checks();

    const reward = L.validateEffect(M.effectFromAnswers("reward", answer(M.effectFields("reward"), { coins: 250, bounty: 50, to: "outlaws" })));
    check("a reward", reward.ok && reward.value.coins === 250 && reward.value.bounty === 50 && reward.value.to === "outlaws", JSON.stringify(reward));
    check("a reward of nothing is refused by the validator", L.validateEffect(M.effectFromAnswers("reward", answer(M.effectFields("reward"), { coins: 0, bounty: 0 }))).ok === false);

    const end = L.validateEffect(M.effectFromAnswers("end", answer(M.effectFields("end"), { result: "fail", delaySeconds: 3 })));
    check("an end", end.ok && end.value.result === "fail" && end.value.delaySeconds === 3, JSON.stringify(end));
    check("an end starts as a win", M.effectFields("end")[0].value === "win");

    check("editing starts from the effect's values", M.effectFields("reward", { kind: "reward", coins: 9, bounty: 4, to: "law", delaySeconds: 2 }).map((f) => f.value).join() === "9,4,law,2");
    done();
});

test("describeEffect reads each kind", () => {
    const { check, done } = checks();

    check("say", M.describeEffect({ kind: "say", text: "Alarm!", channel: "chat", to: "law" }) === 'Say "Alarm!" to all law (chat)');
    check("a long message is clipped", /\.\.\.\"/.test(M.describeEffect({ kind: "say", text: "x".repeat(80), channel: "bar", to: "all" })));
    check("a delay is shown", M.describeEffect({ kind: "say", text: "Hi", channel: "chat", to: "area", delaySeconds: 3 }).endsWith("after 3s"));
    check("reward with both", M.describeEffect({ kind: "reward", coins: 100, bounty: 250, to: "area" }) === "Pay 100 coins and 250 bounty to everyone in the area");
    check("reward with one", M.describeEffect({ kind: "reward", coins: 0, bounty: 250, to: "actor" }) === "Pay 250 bounty to the player who did it");
    check("end", M.describeEffect({ kind: "end", result: "win", delaySeconds: 3 }) === "End: won after 3s" && M.describeEffect({ kind: "end", result: "fail" }) === "End: failed");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

test("the settings form reflects the settings, and its answers are a patch setSettings accepts", () => {
    const { check, done } = checks();
    const settings = L.defaultSettings();

    const fields = M.settingsFields(settings);
    check("one field for each setting", fields.length === L.SETTING_KEYS.length && L.SETTING_KEYS.every((k) => fields.some((f) => f.key === k)));
    check("each starts at the current value", fields.every((f) => f.value === settings[f.key]));

    const patch = M.settingsFromAnswers(answer(fields, { roundOnly: true, cooldownSeconds: 30, protect: false }));
    check("the patch carries the change", patch.roundOnly === true && patch.cooldownSeconds === 30 && patch.protect === false, JSON.stringify(patch));

    const robbery = ok(L.newRobbery("bank", "Bank", "overworld"));
    const edited = L.setSettings(robbery, patch);
    check("setSettings accepts it", edited.ok, edited.reason);
    check("and applies it", edited.robbery.settings.cooldownSeconds === 30 && edited.robbery.settings.roundOnly === true);
    done();
});

test("a /rae:robbery_set value is read by the kind of setting it is for", () => {
    const { check, done } = checks();
    const parse = (key, value) => M.parseSettingValue(key, value);

    for (const on of ["on", "ON", "true", "yes", "1"]) check(`${on} turns a flag on`, parse("protect", on).value === true);
    for (const off of ["off", "false", "no", "0"]) check(`${off} turns a flag off`, parse("protect", off).value === false);
    check("a flag refuses a number", parse("protect", "30").ok === false && /on or off/.test(parse("protect", "30").reason));
    check("a flag refuses an object-prototype word", parse("protect", "constructor").ok === false && parse("protect", "toString").ok === false);

    check("seconds take a whole number", parse("cooldownSeconds", "90").value === 90);
    check("zero seconds is allowed", parse("timeLimitSeconds", "0").value === 0);
    check("seconds refuse words", parse("cooldownSeconds", "soon").ok === false);
    check("seconds refuse more than the limit", parse("cooldownSeconds", String(R.maxSettingSeconds + 1)).ok === false);
    check("every setting key is one or the other", L.SETTING_KEYS.every((k) => (L.isFlagSetting(k) ? parse(k, "on").ok : parse(k, "5").ok)));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------------------------------------

test("an item list is written as 'item amount, item amount' and round-trips", () => {
    const { check, done } = checks();

    const items = M.parseItemList("minecraft:diamond 2, minecraft:emerald").value;
    check("parsed", JSON.stringify(items) === JSON.stringify([["minecraft:diamond", 2], ["minecraft:emerald", 1]]), JSON.stringify(items));
    check("round trip", M.formatItemList(items) === "minecraft:diamond 2, minecraft:emerald");
    check("newlines separate too", M.parseItemList("minecraft:diamond 2\nminecraft:gold_ingot 5").value.length === 2);
    check("an empty list is no items", M.parseItemList("   ").value.length === 0 && M.parseItemList("").value.length === 0);
    check("a bad amount is refused with the item named", /amount for minecraft:diamond/.test(M.parseItemList("minecraft:diamond many").reason ?? ""));
    check("zero is refused", M.parseItemList("minecraft:diamond 0").ok === false);
    check("more than a stack is refused", M.parseItemList("minecraft:diamond 65").ok === false);
    check("extra words are refused", M.parseItemList("minecraft:diamond 2 extra").ok === false);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------------------

test("what a block is suggested to be, and what it may not be", () => {
    const { check, done } = checks();

    check("a door, trapdoor and gate suggest a door", ["door", "trapdoor", "gate"].every((c) => M.suggestKind(c) === "door"));
    check("a container suggests a chest", M.suggestKind("container") === "chest");
    check("a button, lever, plate, tripwire and anything else suggest a switch", ["button", "lever", "plate", "tripwire", "other"].every((c) => M.suggestKind(c) === "switch"));

    check("an iron door can be a door", M.whyBlockCannotBe("door", "minecraft:iron_door") === undefined);
    check("a trapdoor and a gate too", M.whyBlockCannotBe("door", "minecraft:trapdoor") === undefined && M.whyBlockCannotBe("door", "minecraft:fence_gate") === undefined);
    check("stone cannot be a door, and it says why", /does not open and close/.test(M.whyBlockCannotBe("door", "minecraft:stone") ?? ""));
    check("chests, barrels and shulker boxes can be chests", ["minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel", "minecraft:white_shulker_box", "minecraft:undyed_shulker_box"].every((id) => M.whyBlockCannotBe("chest", id) === undefined));
    check("an ender chest, a furnace and a hopper cannot", ["minecraft:ender_chest", "minecraft:furnace", "minecraft:hopper", "minecraft:stone"].every((id) => /cannot hold loot/.test(M.whyBlockCannotBe("chest", id) ?? "")));
    check("any real block can be a switch", ["minecraft:stone_button", "minecraft:lever", "minecraft:stone", "minecraft:iron_door"].every((id) => M.whyBlockCannotBe("switch", id) === undefined));
    check("air can be nothing", ["door", "chest", "switch"].every((kind) => /no block there/.test(M.whyBlockCannotBe(kind, "minecraft:air") ?? "")));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Reading a robbery
// ---------------------------------------------------------------------------------------------------------

test("the element screen says where it is, what locks it, what it waits for and what it does", () => {
    const { check, done } = checks();
    const { r, door, box } = bank();

    const doorLines = M.describeElement(r, door).join("\n").replace(/§./g, "");
    check("its name, kind and id", /Vault door \(door, e2\)/.test(doorLines), doorLines);
    check("both halves of its place", /104, 65, 170 {2}\| {2}104, 66, 170/.test(doorLines));
    check("locked by nothing", /Locked by: nothing/.test(doorLines));
    check("waits for the keypad by name", /Waits for: Keypad/.test(doorLines));
    check("no jam line without a pick lock", !/When jammed/.test(doorLines));

    const boxLines = M.describeElement(r, box).join("\n").replace(/§./g, "");
    check("a chest shows its loot", /Loot: table chests\/gold_2 \+ minecraft:diamond 2/.test(boxLines), boxLines);
    check("its locks in words", /Pick lock: 2 correct picks.*; Price: 25 coins/.test(boxLines));
    check("a pick lock shows the jam line, and the done line counts effects", /When jammed: 0 effects/.test(boxLines) && /When done: 2 effects/.test(boxLines), boxLines);

    const keypadLines = M.describeElement(r, r.elements[0]).join("\n").replace(/§./g, "");
    check("a root says it can start the robbery", /nothing \(it can start the robbery\)/.test(keypadLines));
    check("a pick lock shows its jam effects", /When jammed: 1 effect$/m.test(keypadLines), keypadLines);
    done();
});

test("the main menu summary says whether it is ready and what is missing", () => {
    const { check, done } = checks();
    const { r } = bank();

    const ready = M.describeRobbery(r, []).join("\n").replace(/§./g, "");
    check("name, id and dimension", /Saint Diego Bank \(bank, overworld\)/.test(ready), ready);
    check("elements and the area", /Elements: 3 {3}Area: 82, 60, 159 to 108, 80, 179/.test(ready), ready);
    check("the settings in plain words", /Cooldown 600s/.test(ready) && /Outlaws only: on/.test(ready));
    check("ready", /Ready to run/.test(ready));

    const notReady = M.describeRobbery(ok(L.newRobbery("empty", "Empty", "overworld")), ["it has no elements yet"]).join("\n").replace(/§./g, "");
    check("not ready: the reasons", /Not ready: it has no elements yet/.test(notReady) && /Area: not set/.test(notReady), notReady);
    done();
});
