import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { fake, world, system, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, fill, close, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// tasks/endings, Task 8: an ending's cinematic. An optional pan (a start mark and an end mark, a length, and who sees it) played AFTER the ending is announced, locking
// the players it is for and handing their cameras back; the winners are taken to the win spot only after it. The round's end never waits for it. It rides the start
// sequence's safety (core/startsequence.ts): a round reset in the middle, a player leaving or a failing camera call leaves nobody stuck. Time is the fake's.

const { InputPermissionCategory, PlayerPermissionLevel } = fakeApi;
await load("main.js");
const L = await load("logic/endings.js");
const store = await load("core/endingstore.js");
const round = await load("core/round.js");
const F = await load("core/endingforms.js");
const S = await load("core/startsequence.js");
const { ENDINGS } = await load("config/balance.js");

const PIER = { x: 200, y: 64, z: 300 };
const TOWER = { x: 400, y: 70, z: 400 };
const WIN = { x: 1000, y: 80, z: 1000 };
const START = { x: 10, y: 70, z: 10, pitch: 5, yaw: 30 };
const END = { x: 50, y: 80, z: 60, pitch: -10, yaw: 120 };
const at = (x, z, y = 70) => ({ x, y, z });
const ending = (player, id) => system.afterEvents.scriptEventReceive.emit({ id: "rae:ending", sourceEntity: player, message: id });
const moving = (player) => player.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement);
const pans = (player) => player.camera.calls.filter((c) => c.method === "setCamera");
const clears = (player) => player.camera.calls.filter((c) => c.method === "clear");
const tps = () => fake.dimension("overworld").commands.filter((c) => c.startsWith("tp @a[tag=winner]"));
const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const labels = (form) => buttonsOf(form).map(strip);

const pan = (patch = {}) => ({ start: START, end: END, seconds: 4, audience: "all", ...patch });

function scene() {
    fake.reset();
    round.resetRound();
    store.forgetEndings();
    S.forgetIntro();
    round.startRound();
    round.beginActive();
    fake.addObjective("coins");
    fake.addObjective("bounty");
    ui.shown.length = 0;
    problems.length = 0;
}

function cast(...specs) {
    const made = specs.map(([name, options]) => fake.makePlayer(name, { inventory: true, ...options }));
    fake.advance(1);
    for (const p of made) p.camera.calls.length = 0;
    return made;
}

function add(kind, id, place, patch = {}) {
    const made = L.newEnding(kind, id, id[0].toUpperCase() + id.slice(1), place);
    assert.ok(made.ok, made.reason);
    const edited = L.edit(made.value, patch);
    assert.ok(edited.ok, edited.reason);
    assert.equal(store.saveEnding(edited.value).ok, true);
}

const out = (name, x, z) => [name, { tags: ["outlaw"], location: at(x, z) }];

// ---------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------

test("a cinematic is two marks, a length and an audience: kept to two decimals, validated with a reason, removed with null", () => {
    const { check, done } = checks();
    const base = L.newEnding("group", "pier", "Pier", PIER).value;

    const made = L.edit(base, { cinematic: pan({ start: { x: 10.123, y: 70, z: 10, pitch: 5.555, yaw: 30 }, seconds: 4.567 }) });
    check("accepted", made.ok === true, JSON.stringify(made));
    check("the marks and the length are rounded to two decimals", made.value.cinematic.start.x === 10.12 && made.value.cinematic.start.pitch === 5.56 && made.value.cinematic.seconds === 4.57, JSON.stringify(made.value.cinematic));
    const roundedEnd = L.edit(base, { cinematic: pan({ end: { x: 50.456, y: 80, z: 60.004, pitch: -10, yaw: 120.999 } }) });
    check("the end mark is rounded too", roundedEnd.value.cinematic.end.x === 50.46 && roundedEnd.value.cinematic.end.z === 60 && roundedEnd.value.cinematic.end.yaw === 121, JSON.stringify(roundedEnd.value?.cinematic?.end));

    check("no length is refused", L.edit(base, { cinematic: pan({ seconds: 0 }) }).ok === false);
    check("a length over the cap is refused, with the cap", /at most 30 seconds/.test(L.edit(base, { cinematic: pan({ seconds: 31 }) }).reason ?? ""), L.edit(base, { cinematic: pan({ seconds: 31 }) }).reason);
    check("a length that is not a number is refused", L.edit(base, { cinematic: pan({ seconds: Number.NaN }) }).ok === false);
    check("an audience that is neither is refused", /all players or for the winners/.test(L.edit(base, { cinematic: pan({ audience: "law" }) }).reason ?? ""));
    const bad = L.edit(base, { cinematic: pan({ start: { ...START, pitch: 120 } }) });
    check("a mark the camera cannot have is refused with the shot's own reason", bad.ok === false && /^the cinematic: the start pitch/.test(bad.reason), JSON.stringify(bad));

    const gone = L.edit(made.value, { cinematic: null });
    check("null removes it", gone.ok === true && gone.value.cinematic === undefined);
    check("an edit that does not mention it leaves it", L.edit(made.value, { radius: 5 }).value.cinematic !== undefined);
    check("an ending without one has no shot", L.cinematicShot(base) === undefined);
    check("one with it has the shot the start sequence plays", L.cinematicShot(made.value)?.start.x === 10.12 && L.cinematicShot(made.value)?.id === "pier");
    done();
});

test("a cinematic survives saving and reading, and a damaged one is a reason, never an exception", () => {
    const { check, done } = checks();
    const made = L.edit(L.newEnding("solo", "tower", "Tower", TOWER).value, { cinematic: pan({ audience: "winners" }) });
    const back = L.parseEnding(L.serializeEnding(made.value));
    check("the same ending comes back", back.ok && isDeepStrictEqual(back.value, made.value), JSON.stringify(back));

    const raw = JSON.parse(L.serializeEnding(made.value));
    const damage = (cn) => L.parseEnding(JSON.stringify({ ...raw, cn }));
    check("not a record", damage("x").ok === false);
    check("no length", /saved cinematic/.test(damage({ ...raw.cn, s: "4" }).reason ?? ""), damage({ ...raw.cn, s: "4" }).reason);
    check("a made-up audience", /saved cinematic/.test(damage({ ...raw.cn, au: "everyone" }).reason ?? ""), damage({ ...raw.cn, au: "everyone" }).reason);
    check("a start that is not five numbers", /cinematic start/.test(damage({ ...raw.cn, a: [1, 2] }).reason ?? ""), damage({ ...raw.cn, a: [1, 2] }).reason);
    check("an end that is not five numbers", /cinematic end/.test(damage({ ...raw.cn, b: "no" }).reason ?? ""));
    check("a length past the cap is not readable", damage({ ...raw.cn, s: 99 }).ok === false);
    check("an ending saved before cinematics existed still reads", L.parseEnding(L.serializeEnding(L.newEnding("group", "pier", "Pier", PIER).value)).ok === true);
    done();
});

test("the worst case record, with a cinematic at the edges of the world, still fits the store's cap", () => {
    const { check, done } = checks();
    const worst = "\"\\".repeat(ENDINGS.maxText / 2);
    const edge = { x: -30_000_000, y: -63.75, z: 30_000_000, pitch: -89.99, yaw: -179.99 };
    const made = L.edit(L.newEnding("solo", "tower", "Tower", TOWER).value, {
        item: { id: "minecraft:" + "a".repeat(40), count: 64 }, name: "\\\"".repeat(ENDINGS.maxName / 2),
        place: { x: -30_000_000, y: -64.25, z: 30_000_000 }, winSpot: { x: -30_000_000, y: 319.75, z: 30_000_000 },
        texts: { headline: worst, detail: worst, gather: worst, outlawsOnly: worst },
        cinematic: { start: edge, end: { ...edge, y: 319.75 }, seconds: ENDINGS.maxCinematicSeconds, audience: "winners" }
    });
    check("such an ending is valid", made.ok === true, JSON.stringify(made));
    const size = L.serializeEnding(made.value).length;
    check(`and is ${size} characters, inside ${ENDINGS.maxChars}`, size <= ENDINGS.maxChars);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Playing it
// ---------------------------------------------------------------------------------------------------------

test("a group ending with a pan: announced and ended at once, every player locked and put in the camera, and only afterwards are the winners taken to the win spot", () => {
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, winSpot: WIN, cinematic: pan({ seconds: 4, audience: "all" }) });
    const { check, done } = checks();
    const [a, b, law] = cast(out("A", PIER.x, PIER.z), out("B", PIER.x + 1, PIER.z), ["Law", { tags: ["law"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);

    ending(a, "pier");

    check("the round has ended already", round.getPhase() === "ENDED" && round.lastEnd() === "outlaw_win", `${round.getPhase()} ${round.lastEnd()}`);
    check("the announcement came first", fake.chat.map(strip).includes("THE OUTLAWS HAVE ESCAPED!"));
    check("everyone, the law too, is locked", [a, b, law].every((p) => !moving(p)));
    check("everyone's camera went to the start and eased to the end over the seconds", [a, b, law].every((p) => pans(p).length === 2 && pans(p)[0].options.location.x === 10 && pans(p)[1].options.location.x === 50 && pans(p)[1].options.easeOptions.easeTime === 4));
    check("nobody has been moved yet", tps().length === 0, tps().join(" | "));
    check("and S says they are held", [a, b, law].every((p) => S.isHeld(p)));

    fake.advance(79);
    check("not a tick early", tps().length === 0 && !moving(a));

    fake.advance(1);
    check("then everyone has their view and movement back", [a, b, law].every((p) => moving(p) && clears(p).length === 1 && !S.isHeld(p)));
    check("and the winners are taken to the win spot, once", tps().length === 1 && tps()[0] === `tp @a[tag=winner] ${WIN.x} ${WIN.y} ${WIN.z}`, tps().join(" | "));
    done();
});

test("an audience of winners moves only the gang's cameras", () => {
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, cinematic: pan({ audience: "winners" }) });
    const { check, done } = checks();
    const [a, b, law] = cast(out("A", PIER.x, PIER.z), out("B", PIER.x + 1, PIER.z), ["Law", { tags: ["law"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);

    ending(a, "pier");

    check("the gang is in the camera and locked", pans(a).length === 2 && pans(b).length === 2 && !moving(a) && !moving(b));
    check("the law is left alone", pans(law).length === 0 && moving(law) && !S.isHeld(law));
    done();
});

test("a solo ending: the escaper alone with winners, everyone with all; they are taken to the win spot only afterwards", () => {
    const { check, done } = checks();

    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 100, winSpot: WIN, cinematic: pan({ audience: "winners" }) });
    let [a, b] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    fake.setScore("coins", "A", 100);
    ending(a, "tower");

    check("winners: the escaper's camera only", pans(a).length === 2 && pans(b).length === 0 && !moving(a) && moving(b));
    check("not moved yet, and the round goes on", a.teleports.length === 0 && round.getPhase() === "ACTIVE");
    fake.advance(80);
    check("then moved to the win spot and released", a.teleports.length === 1 && a.teleports[0].x === WIN.x && moving(a) && clears(a).length === 1, JSON.stringify(a.teleports));

    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 100, winSpot: WIN, cinematic: pan({ audience: "all" }) });
    [a, b] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    fake.setScore("coins", "A", 100);
    ending(a, "tower");
    check("all: everyone's camera", pans(a).length === 2 && pans(b).length === 2 && !moving(b));
    fake.advance(80);
    check("and only the escaper is moved", a.teleports.length === 1 && b.teleports.length === 0 && moving(b));
    done();
});

test("an ending with no cinematic has no camera, no lock and no delay", () => {
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, winSpot: WIN });
    const { check, done } = checks();
    const [a, b] = cast(out("A", PIER.x, PIER.z), out("B", PIER.x + 1, PIER.z));
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);

    ending(a, "pier");

    check("moved at once", tps().length === 1);
    check("nobody locked, nobody in a camera", [a, b].every((p) => moving(p) && p.camera.calls.length === 0 && !S.isHeld(p)));
    done();
});

test("a round reset in the middle lets everyone go at once, and the winners are never moved", () => {
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, winSpot: WIN, cinematic: pan({ seconds: 6 }) });
    const { check, done } = checks();
    const [a, b] = cast(out("A", PIER.x, PIER.z), out("B", PIER.x + 1, PIER.z));
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);
    ending(a, "pier");
    fake.advance(30);

    round.resetRound();

    check("released at once, with their own view back", [a, b].every((p) => moving(p) && clears(p).length >= 1 && !S.isHeld(p)));
    fake.advance(400);
    check("and nobody is taken anywhere afterwards", tps().length === 0 && [a, b].every((p) => moving(p)));
    done();
});

test("a player who leaves in the middle, and a camera that fails, leave nobody stuck and do not stop the winners being moved", () => {
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, winSpot: WIN, cinematic: pan({ seconds: 3 }) });
    const { check, done } = checks();
    const [a, b, law] = cast(out("A", PIER.x, PIER.z), out("B", PIER.x + 1, PIER.z), ["Law", { tags: ["law"], location: at(900, 900) }]);
    fake.setScore("coins", "A", 100);
    fake.setScore("coins", "B", 100);
    law.camera.setCamera = () => { throw new Error("no camera today"); };

    ending(a, "pier");
    b.isValid = false;
    fake.advance(60);

    check("the one whose camera failed is still let go", moving(law) && !S.isHeld(law));
    check("the one who stayed is let go", moving(a) && !S.isHeld(a));
    check("the winners were still moved", tps().length === 1, tps().join(" | "));
    done();
});

test("an ending whose audience has nobody left calls straight on", () => {
    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 100, winSpot: WIN, cinematic: pan({ audience: "winners" }) });
    const { check, done } = checks();
    const [a] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    fake.setScore("coins", "A", 100);
    S.playPan([], { version: 1, id: "x", name: "", start: START, end: END }, 3, () => { fake.chat.push("§r-called"); });
    check("no audience means `then` at once", fake.chat.some((m) => /-called/.test(m)));

    fake.chat.length = 0;
    const gone = fake.makePlayer("Gone");
    fake.advance(1);
    gone.isValid = false;
    S.playPan([gone], { version: 1, id: "x", name: "", start: START, end: END }, 3, () => { fake.chat.push("§r-called-again"); });
    check("an audience that has all left is the same: `then` at once, and nobody is held", fake.chat.some((m) => /-called-again/.test(m)) && !S.isHeld(gone));
    assert.ok(a);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------------------------------------

function operator() {
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, inventory: true, location: { x: 10, y: 70, z: 10 } });
    fake.advance(1);
    op.camera.calls.length = 0;
    return op;
}

test("an operator makes a pan by marking the start, walking, and marking the end; it keeps its default length and gets the audience of its kind", async () => {
    const { check, done } = checks();
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100 });
    add("solo", "tower", TOWER, { radius: 5, price: 100 });
    const op = operator();
    op.rotation = { x: 5, y: 30 };

    script(
        press("Pier"), press("Cinematic"), press("Mark the start of the pan"),
        (form) => { op.teleport({ x: 50, y: 80, z: 60 }); op.rotation = { x: -10, y: 120 }; return press("Mark the end")(form); },
        close, close, close
    );
    await F.openEndingsEditor(op);

    const made = store.getEnding("pier")?.cinematic;
    check("the pan is saved from the camera's eyes", made?.start.x === 10 && made.start.y === 71.6 && made.end.x === 50 && made.end.y === 81.6 && made.end.yaw === 120, JSON.stringify(made));
    check("with the default length and, for a group ending, everyone", made?.seconds === ENDINGS.defaultCinematicSeconds && made.audience === "all", JSON.stringify(made));

    ui.shown.length = 0;
    script(press("Tower"), press("Cinematic"), press("Mark the start of the pan"), press("Mark the end"), close, close, close);
    await F.openEndingsEditor(op);
    check("a solo ending's pan is for the winner", store.getEnding("tower")?.cinematic?.audience === "winners", JSON.stringify(store.getEnding("tower")?.cinematic));
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("length and audience are edited in a box that refuses a bad length with the reason", async () => {
    const { check, done } = checks();
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, cinematic: pan({ seconds: 4, audience: "all" }) });
    const op = operator();

    script(press("Pier"), press("Cinematic"), press("Length and audience"), fill({ Length: "99" }), fill({ Length: "12", "every player": false }), close, close, close);
    await F.openEndingsEditor(op);

    check("the long one was refused with the cap", ui.shown.some((f) => /^Not saved: the cinematic must last more than 0 and at most 30 seconds/.test(strip(titleOf(f)))), ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    const saved = store.getEnding("pier")?.cinematic;
    check("then the good length and the audience were saved", saved?.seconds === 12 && saved.audience === "winners", JSON.stringify(saved));
    check("the marks are as they were", saved?.start.x === START.x && saved.end.x === END.x);
    done();
});

test("Preview plays the pan for the operator alone, closes the menus, and is refused while a game is starting; Remove takes it away", async () => {
    const { check, done } = checks();
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, cinematic: pan({ seconds: 4 }) });
    const [other] = cast(out("Other", 900, 900));
    const op = operator();

    script(press("Pier"), press("Cinematic"), press("Preview"));
    await F.openEndingsEditor(op);

    check("the operator is in the camera and locked", pans(op).length === 2 && !moving(op));
    check("nobody else is", pans(other).length === 0 && moving(other));
    check("the menus closed so the screen is not over the camera", ui.shown.length === 3, ui.shown.map((f) => strip(titleOf(f))).join(" | "));
    fake.advance(80);
    check("the camera comes back after the seconds", moving(op) && clears(op).length === 1);

    round.resetRound();
    round.startRound();
    ui.shown.length = 0;
    script(press("Pier"), press("Cinematic"), press("Preview"), close, close, close);
    await F.openEndingsEditor(op);
    const last = [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith("Cinematic"));
    check("while a game is starting it says so and plays nothing", /game is starting/.test(bodyOf(last)) && moving(op), bodyOf(last));

    round.resetRound();
    ui.shown.length = 0;
    script(press("Pier"), press("Cinematic"), press("Remove the cinematic"), close, close, close);
    await F.openEndingsEditor(op);
    check("Remove takes it away", store.getEnding("pier")?.cinematic === undefined);
    check("the stand-in found everything", problems.length === 0, problems.join(" | "));
    done();
});

test("a marked start is kept until the end is marked, and cancelling it forgets it", async () => {
    const { check, done } = checks();
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100 });
    const op = operator();

    script(press("Pier"), press("Cinematic"), press("Mark the start of the pan"), close, close, close);
    await F.openEndingsEditor(op);
    const marked = [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith("Cinematic"));
    check("the screen says the start is marked and offers the end", /Start marked at 10, 72, 10/.test(bodyOf(marked)) && labels(marked).includes("Mark the end here") && labels(marked).includes("Cancel marking"), `${bodyOf(marked)} | ${labels(marked).join(", ")}`);
    check("nothing was saved by marking a start", store.getEnding("pier")?.cinematic === undefined);

    ui.shown.length = 0;
    script(press("Pier"), press("Cinematic"), press("Cancel marking"), close, close, close);
    await F.openEndingsEditor(op);
    const again = [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith("Cinematic"));
    check("after Cancel there is no start any more", !/Start marked/.test(bodyOf(again)) && labels(again).includes("Mark the start of the pan here"), `${bodyOf(again)} | ${labels(again).join(", ")}`);
    done();
});

test("a new pan marked over an old one keeps its length and audience, and a mark the camera cannot have is refused with the start kept", async () => {
    const { check, done } = checks();
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100, cinematic: pan({ seconds: 12, audience: "winners" }) });
    const op = operator();

    script(
        press("Pier"), press("Cinematic"), press("Mark a new pan"),
        (form) => { op.teleport({ x: 70, y: 90, z: 70 }); return press("Mark the end")(form); },
        close, close, close
    );
    await F.openEndingsEditor(op);
    const kept = store.getEnding("pier")?.cinematic;
    check("the marks are new and the length and audience are as they were", kept?.end.x === 70 && kept.start.x === 10 && kept.seconds === 12 && kept.audience === "winners", JSON.stringify(kept));

    ui.shown.length = 0;
    script(
        press("Pier"), press("Cinematic"), press("Mark a new pan"),
        (form) => { op.teleport({ x: 70, y: 900, z: 70 }); return press("Mark the end")(form); },
        close, close, close
    );
    await F.openEndingsEditor(op);
    const after = [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith("Cinematic"));
    check("a height outside the world is refused, with the reason", /Not saved: the cinematic: the end height/.test(bodyOf(after)), bodyOf(after));
    check("the pan is as it was and the start mark is kept for another try", store.getEnding("pier")?.cinematic?.end.x === 70 && /Start marked/.test(bodyOf(after)) && labels(after).includes("Mark the end here"), `${bodyOf(after)} | ${labels(after).join(", ")}`);
    done();
});

test("Preview, Length and Remove are offered only when there is a pan", async () => {
    const { check, done } = checks();
    scene();
    add("group", "pier", PIER, { radius: 10, price: 100 });
    add("group", "dock", TOWER, { radius: 10, price: 100, cinematic: pan() });
    const op = operator();

    script(press("Pier"), press("Cinematic"), close, close, close);
    await F.openEndingsEditor(op);
    const none = [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith("Cinematic"));
    check("without one: Mark the start and Back", labels(none).join("|") === "Mark the start of the pan here|Back", labels(none).join("|"));

    ui.shown.length = 0;
    script(press("Dock"), press("Cinematic"), close, close, close);
    await F.openEndingsEditor(op);
    const some = [...ui.shown].reverse().find((f) => strip(titleOf(f)).startsWith("Cinematic"));
    check("with one: all the buttons", labels(some).join("|") === "Mark a new pan: its start here|Length and audience|Preview|Remove the cinematic|Back", labels(some).join("|"));
    check("and the list says it is set", ui.shown.some((f) => labels(f).includes("Cinematic (set)")));
    done();
});

test("an escaper who leaves in the middle of the pan breaks nothing", () => {
    scene();
    add("solo", "tower", TOWER, { radius: 5, price: 100, winSpot: WIN, cinematic: pan({ audience: "winners" }) });
    const { check, done } = checks();
    const [a, b] = cast(out("A", TOWER.x, TOWER.z), out("B", 900, 900));
    fake.setScore("coins", "A", 100);
    ending(a, "tower");
    a.isValid = false;

    fake.advance(100);

    check("nothing was thrown, nobody else was touched, and the round carries on", moving(b) && pans(b).length === 0 && round.getPhase() === "ACTIVE");
    done();
});

void world;
