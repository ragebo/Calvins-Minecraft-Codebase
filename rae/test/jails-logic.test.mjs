import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { checks, load } from "./helpers.mjs";

// logic/jails.ts: a jail is a place prisoners are sent, an optional door trigger (where a redstone block is placed when the jailbreak succeeds) and buttons (blocks
// a player right-clicks to start the lockpick). Pure rules: validation with a reason an operator can read, edits that return a new record, a saved text that
// parses back (and never throws, whatever it holds).

const L = await load("logic/jails.js");
const { JAILS } = await load("config/balance.js");

const SPOT = { x: 10.5, y: 64, z: -20.5 };
const door = (n = 0) => ({ x: 100 + n, y: 62, z: 200 });
const at = (n) => ({ x: n, y: 70, z: 5 });
const made = (patch = {}) => {
    const first = L.newJail("town", "Town", SPOT);
    if (!first.ok) throw new Error(first.reason);
    const next = L.edit(first.value, patch);
    if (!next.ok) throw new Error(next.reason);
    return next.value;
};

test("a new jail is on, has the spot it was given, and no door trigger and no buttons yet", () => {
    const { check, done } = checks();
    const r = L.newJail("town", "  Town  ", { x: 10.123, y: 64, z: -20.456 });

    check("accepted", r.ok === true, JSON.stringify(r));
    check("the name is trimmed", r.value.name === "Town");
    check("the spot is kept to two decimals", r.value.jail.x === 10.12 && r.value.jail.z === -20.46, JSON.stringify(r.value.jail));
    check("on, with no door and no buttons", r.value.enabled === true && r.value.doorTrigger === undefined && r.value.buttons.length === 0);
    check("a version", r.value.version === L.JAIL_VERSION);
    done();
});

test("a jail that cannot be one is refused with the reason", () => {
    const { check, done } = checks();
    const why = (id, name, spot = SPOT) => { const r = L.newJail(id, name, spot); return r.ok ? "" : r.reason; };

    check("a bad id", /id must be/.test(why("Town Jail", "x")));
    check("an id that starts with a digit", /id must be/.test(why("1jail", "x")));
    check("an empty name", /name cannot be empty/.test(why("a", "   ")));
    check("a long name", /at most 40/.test(why("a", "x".repeat(41))));
    check("a name with a control character", /control character/.test(why("a", "bad\nname")));
    check("a spot that is not numbers", /jail spot must be three numbers/.test(why("a", "x", { x: Number.NaN, y: 1, z: 1 })));
    check("a spot outside the world", /outside the world/.test(why("a", "x", { x: 4e7, y: 1, z: 1 })));
    done();
});

test("an edit returns a new jail and leaves the old one alone, and the id never changes", () => {
    const { check, done } = checks();
    const base = made();
    const before = JSON.stringify(base);

    const next = L.edit(base, { name: "New name", enabled: false, jail: { x: 1.234, y: 70, z: 2 }, doorTrigger: door(), buttons: [at(1), at(2)] });

    check("accepted", next.ok === true, JSON.stringify(next));
    check("every field changed", next.value.name === "New name" && next.value.enabled === false && next.value.jail.x === 1.23 && next.value.doorTrigger.x === 100 && next.value.buttons.length === 2);
    check("the id is the same", next.value.id === "town");
    check("the original was not touched", JSON.stringify(base) === before);
    check("null takes the door trigger away", L.edit(next.value, { doorTrigger: null }).value.doorTrigger === undefined);
    check("an edit that does not mention the door keeps it", L.edit(next.value, { name: "Again" }).value.doorTrigger.x === 100);
    done();
});

test("a door trigger and a button are blocks: whole numbers, none twice, none the same block as the door, and no more than the most a jail may have", () => {
    const { check, done } = checks();
    const base = made();
    const why = (patch) => { const r = L.edit(base, patch); return r.ok ? "" : r.reason; };

    check("a door trigger with a fraction", /door trigger must be a block/.test(why({ doorTrigger: { x: 1.5, y: 62, z: 2 } })));
    check("a button with a fraction", /button 1 must be a block/.test(why({ buttons: [{ x: 1, y: 70.5, z: 2 }] })));
    check("a button that is not numbers", /button 1 must be three numbers/.test(why({ buttons: [{ x: "1", y: 1, z: 1 }] })));
    check("a button outside the world", /outside the world/.test(why({ buttons: [{ x: 4e7, y: 1, z: 1 }] })));
    check("a button listed twice", /button 2 is listed twice/.test(why({ buttons: [at(1), at(1)] })));
    check("a button that is the door trigger", /button 1 is the door trigger/.test(why({ doorTrigger: at(1), buttons: [at(1)] })));
    check(`more than ${JAILS.maxButtons} buttons`, new RegExp(`at most ${JAILS.maxButtons} buttons`).test(why({ buttons: Array.from({ length: JAILS.maxButtons + 1 }, (_, i) => at(i)) })));
    check(`exactly ${JAILS.maxButtons} is fine`, L.edit(base, { buttons: Array.from({ length: JAILS.maxButtons }, (_, i) => at(i)) }).ok === true);
    done();
});

test("addButton adds one, removeButton takes number N away, and both say why when they cannot", () => {
    const { check, done } = checks();
    const one = L.addButton(made(), at(1));
    const two = L.addButton(one.value, at(2));

    check("a button is added", one.ok && one.value.buttons.length === 1 && two.value.buttons.length === 2);
    check("adding the same one again is refused", L.addButton(two.value, at(2)).ok === false);
    const gone = L.removeButton(two.value, 0);
    check("the first is removed and the second stays", gone.ok && gone.value.buttons.length === 1 && gone.value.buttons[0].x === 2, JSON.stringify(gone));
    check("a button that is not there", /no button 3/.test(L.removeButton(two.value, 2).reason ?? ""));
    check("a negative one", L.removeButton(two.value, -1).ok === false);
    check("a fraction", L.removeButton(two.value, 0.5).ok === false);
    done();
});

test("an id is made from a name, and numbered when it is taken", () => {
    const { check, done } = checks();
    const id = (name, taken = []) => L.jailIdFrom(name, new Set(taken));

    check("lower case with underscores", id("Town Jail") === "town_jail");
    check("a name of nothing legal is 'jail'", id("!!!") === "jail");
    check("digits and underscores at the front are dropped", id("12 Jail") === "jail");
    check("a taken id is numbered", id("Town", ["town"]) === "town_2");
    check("and again", id("Town", ["town", "town_2"]) === "town_3");
    check("a long name stays within 24 characters, numbered or not", id("a".repeat(40)).length <= 24 && id("a".repeat(40), ["a".repeat(24)]).length <= 24);
    check("every id it makes is a legal one", ["Town Jail", "!!!", "12 Jail", "Zebra Crossing 9"].every((name) => L.newJail(id(name), "x", SPOT).ok));
    done();
});

test("a jail survives saving and reading, with or without a door trigger and buttons", () => {
    const { check, done } = checks();

    for (const jail of [made(), made({ doorTrigger: door(), buttons: [at(1), at(2), at(3)] }), made({ enabled: false })]) {
        const back = L.parseJail(L.serializeJail(jail));
        check(`${jail.buttons.length} buttons, door ${jail.doorTrigger ? "set" : "none"}, ${jail.enabled ? "on" : "off"}: the same jail comes back`, back.ok && isDeepStrictEqual(back.value, jail), JSON.stringify(back));
    }
    done();
});

test("a saved jail that is damaged is a reason and never an exception", () => {
    const { check, done } = checks();
    const good = JSON.parse(L.serializeJail(made({ doorTrigger: door(), buttons: [at(1)] })));
    const read = (patch) => L.parseJail(JSON.stringify({ ...good, ...patch }));
    const reason = (patch) => { const r = read(patch); return r.ok ? "" : r.reason; };

    check("nothing", L.parseJail(undefined).ok === false && L.parseJail("").ok === false);
    check("not JSON", /not valid JSON/.test(L.parseJail("{nope").reason));
    check("JSON of another shape", ["[]", "3", "null", "\"x\""].every((text) => L.parseJail(text).ok === false));
    check("a version it does not know", /different version/.test(reason({ v: 2 })));
    check("no id", /no id/.test(reason({ id: 5 })));
    check("no name", /no name/.test(reason({ nm: null })));
    check("a spot that is not three numbers", /jail spot is not three numbers/.test(reason({ j: [1, 2] })));
    check("a door that is not three numbers", /door trigger is not three numbers/.test(reason({ d: "x" })));
    check("buttons that are not a list", /buttons are not a list/.test(reason({ b: 7 })));
    check("a button that is not three numbers", /button 1 is not three numbers/.test(reason({ b: [[1, 2]] })));
    check("a record that parses but breaks a rule is refused with that rule", /door trigger must be a block/.test(reason({ d: [1.5, 2, 3] })));
    check("a missing 'on' means on, as an old save did", read({ on: undefined }).value.enabled === true);
    check("only exactly false is off", read({ on: false }).value.enabled === false && read({ on: 0 }).value.enabled === true);
    check("a missing door is allowed", JSON.parse(L.serializeJail(made())).d === undefined && L.parseJail(L.serializeJail(made())).ok);
    done();
});

test("the biggest record a jail can be fits inside the cap the store refuses over", () => {
    const { check, done } = checks();
    const edge = { x: -29_999_999, y: -9_999, z: 29_999_999 };
    const worst = made({
        name: "\"\\".repeat(JAILS.maxName / 2),
        jail: { x: -29_999_999.99, y: -9_999.99, z: 29_999_999.99 },
        doorTrigger: edge,
        buttons: Array.from({ length: JAILS.maxButtons }, (_, i) => ({ x: -29_999_990 - i, y: -9_990, z: 29_999_990 - i }))
    });
    const size = L.serializeJail(worst).length;

    check(`it is ${size} characters, inside ${JAILS.maxChars}`, size <= JAILS.maxChars);
    check("and it is a valid jail", L.whyNotUsable(worst) === undefined);
    done();
});

test("places compare and print as whole numbers", () => {
    const { check, done } = checks();

    check("the same place", L.samePlace({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }));
    check("a different one", !L.samePlace({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 }) && !L.samePlace({ x: 1, y: 2, z: 3 }, { x: 0, y: 2, z: 3 }) && !L.samePlace({ x: 1, y: 2, z: 3 }, { x: 1, y: 0, z: 3 }));
    check("printed as the block it is in (a spot in the middle of block 10 is block 10, not 11)", L.placeText({ x: 10.5, y: 64.4, z: -20.5 }) === "10, 64, -21", L.placeText({ x: 10.5, y: 64.4, z: -20.5 }));
    done();
});
