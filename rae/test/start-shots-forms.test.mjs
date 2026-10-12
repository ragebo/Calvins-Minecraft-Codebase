import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, world, system, fakeApi, load, checks, strip } from "./helpers.mjs";
import { ui, problems, press, fill, close, script, titleOf, buttonsOf } from "./robbery-ui.mjs";

// core/startforms.ts, the camera-shots half: the operator makes a shot by standing where it should start and pressing "Mark the start of a new
// shot here", then going where it ends and pressing "Mark the end here" (and, if they like, naming it). The marks are where the CAMERA is, so the
// operator's eyes and the way they face, not their feet. A pending start is kept on the operator, so it survives the screen closing; Preview plays
// one shot for the operator alone and gives their camera back. A stand-in plays the operator; what it cannot say is how it looks in the game.

const { PlayerPermissionLevel, InputPermissionCategory } = fakeApi;
const F = await load("core/startforms.js");
const store = await load("core/startstore.js");
const S = await load("core/startsequence.js");
const L = await load("logic/start.js");
const round = await load("core/round.js");
const { START } = await load("config/balance.js");

const bodyOf = (form) => strip(String(form.calls.find((c) => c[0] === "body")?.[1] ?? ""));
const labels = (form) => buttonsOf(form).map(strip);
const titled = (title) => [...ui.shown].reverse().find((f) => strip(titleOf(f)) === title);
const shotsScreen = () => titled("Camera shots");
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const moving = (p) => p.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Movement);

const PENDING = "rae:start:mark";

function scene() {
    fake.reset();
    store.forgetLoaded();
    S.forgetIntro();
    round.resetRound();
    ui.shown.length = 0;
    problems.length = 0;

    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator, location: { x: 10, y: 70, z: 20 } });
    op.rotation = { x: 5, y: 90 };
    const other = fake.makePlayer("Other");
    fake.advance(1);
    op.camera.calls.length = 0;
    other.camera.calls.length = 0;

    return { op, other };
}

const open = (player) => F.openStartEditor(player);

/** Where a camera would be if it were the player's eyes, and the way they face, as a mark. */
const markOf = (player) => {
    const head = player.getHeadLocation();
    const view = player.getRotation();
    return { x: head.x, y: head.y, z: head.z, pitch: view.x, yaw: view.y };
};

const round2 = (n) => Math.round(n * 100) / 100;
const rounded = (m) => ({ x: round2(m.x), y: round2(m.y), z: round2(m.z), pitch: round2(m.pitch), yaw: round2(m.yaw) });

function saveShot(id, name = "") {
    const made = L.makeShot(id, name, { x: 1, y: 70, z: 2, pitch: 0, yaw: 0 }, { x: 31, y: 80, z: 42, pitch: -10, yaw: 90 });
    assert.ok(made.ok, made.reason);
    assert.equal(store.saveShot(made.value).ok, true);
}

test("the main screen has a Camera shots button with how many there are", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1");
    script(close);

    await open(op);

    check("a button for the shots", labels(ui.shown[0]).some((l) => l === "Camera shots (1)"), labels(ui.shown[0]).join(" | "));
    check("the summary mentions the shots", /Camera shots: 1/.test(bodyOf(ui.shown[0])), bodyOf(ui.shown[0]));
    done();
});

test("with no shots the screen says a start has no intro yet, and offers to mark one", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Camera shots"), close);

    await open(op);

    const form = shotsScreen();
    check("it says there is no intro", /no intro/i.test(bodyOf(form)), bodyOf(form));
    check("the buttons are Mark the start and Back", labels(form).join("|") === "Mark the start of a new shot here|Back", labels(form).join(" | "));
    done();
});

test("marking the start remembers where the camera would be, on the operator, and the next screen offers the end", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Camera shots"), press("Mark the start"), close);

    await open(op);

    const form = shotsScreen();
    check("a pending start is kept on the operator", typeof op.getDynamicProperty(PENDING) === "string");
    check("the screen says it was marked, and says where", /Start marked/.test(bodyOf(form)) && bodyOf(form).includes("10"), bodyOf(form));
    check("the buttons now are Mark the end, Cancel marking and Back", labels(form).join("|") === "Mark the end here|Cancel marking|Back", labels(form).join(" | "));
    done();
});

test("marking the end saves a shot from the eyes and facing at the two moments, and asks for an optional name", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const start = markOf(op);

    script(
        press("Camera shots"), press("Mark the start"),
        // The operator walks somewhere else and looks another way before pressing the end.
        (form) => { op.teleport({ x: 40, y: 90, z: 60 }); op.rotation = { x: -10, y: 180 }; return press("Mark the end")(form); },
        fill({ Name: "Bridge" }),
        close
    );

    await open(op);

    const end = rounded({ ...markOf(op) });
    const saved = store.getShot("s1");
    check("a shot was saved, named", saved?.name === "Bridge", JSON.stringify(saved));
    check("its start is where the camera was at the first press", JSON.stringify(saved?.start) === JSON.stringify(rounded(start)), JSON.stringify(saved?.start));
    check("its end is where it was at the second", JSON.stringify(saved?.end) === JSON.stringify(end), JSON.stringify(saved?.end));
    check("the name box asked for an optional name", ui.shown.some((f) => f.kind === "modal" && f.calls.some((c) => c[0] === "textField" && /optional/i.test(strip(String(c[1]))))));
    check("the pending start is gone", op.getDynamicProperty(PENDING) === undefined);
    check("the list shows it, numbered by name", labels(shotsScreen()).some((l) => l.startsWith("1. Bridge")), labels(shotsScreen()).join(" | "));
    check("and the screen says it was saved", /Saved/.test(bodyOf(shotsScreen())), bodyOf(shotsScreen()));
    done();
});

test("the end is taken when the button is pressed, not after the name box, so typing a name cannot move the camera", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(
        press("Camera shots"), press("Mark the start"), press("Mark the end"),
        // While the name box is open the operator wanders off; where the shot ends is where they stood at the press.
        (form) => { op.teleport({ x: 500, y: 100, z: 500 }); op.rotation = { x: 40, y: -90 }; return fill({ Name: "Moved" })(form); },
        close
    );
    const atPress = rounded(markOf(op));

    await open(op);

    check("the shot's end is where the camera was at the press", JSON.stringify(store.getShot("s1")?.end) === JSON.stringify(atPress), JSON.stringify(store.getShot("s1")?.end));
    done();
});

test("the shots screen says how many there are, how many a start plays and for how long", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1");
    script(press("Camera shots"), close);

    await open(op);

    check("N of the most, and what a start does with them", new RegExp(`1 of ${START.maxShots} shots`).test(bodyOf(shotsScreen())) && new RegExp(`plays ${START.shotsPerStart} of them at random, ${START.introSeconds} seconds in all`).test(bodyOf(shotsScreen())), bodyOf(shotsScreen()));
    done();
});

test("a shot with no name is listed by its id", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Camera shots"), press("Mark the start"), press("Mark the end"), fill({ Name: "" }), close);

    await open(op);

    check("saved without a name", store.getShot("s1")?.name === "");
    check("listed as s1", labels(shotsScreen()).some((l) => l.startsWith("1. s1")), labels(shotsScreen()).join(" | "));
    done();
});

test("a name that is too long comes straight back in the box with the reason, and what was typed kept", async () => {
    const { check, done } = checks();
    const { op } = scene();
    const tooLong = "n".repeat(START.maxNameChars + 1);
    script(press("Camera shots"), press("Mark the start"), press("Mark the end"), fill({ Name: tooLong }), fill({ Name: "Short" }), close);

    await open(op);

    const boxes = ui.shown.filter((f) => f.kind === "modal");
    check("the box came back, with why in its title", boxes.length >= 2 && /Not saved/.test(strip(titleOf(boxes[1]))) && strip(titleOf(boxes[1])).includes(String(START.maxNameChars)), boxes.map((b) => titleOf(b)).join(" || "));
    check("with what was typed still in it", boxes[1].calls.find((c) => c[0] === "textField")?.[3]?.defaultValue === tooLong);
    check("then a good name saved it", store.getShot("s1")?.name === "Short");
    done();
});

test("closing the name box saves nothing and keeps the start mark", async () => {
    const { check, done } = checks();
    const { op } = scene();
    script(press("Camera shots"), press("Mark the start"), press("Mark the end"), close, close);

    await open(op);

    check("no shot", store.allShots().length === 0);
    check("the start is still marked", typeof op.getDynamicProperty(PENDING) === "string");
    check("and the screen says it was not saved", /Not saved/.test(bodyOf(shotsScreen())), bodyOf(shotsScreen()));
    done();
});

test("a pending start is still there when the editor is opened again, and Cancel marking clears it", async () => {
    const { check, done } = checks();
    const { op } = scene();

    script(press("Camera shots"), press("Mark the start"), close, close);
    await open(op);
    check("marked", typeof op.getDynamicProperty(PENDING) === "string");

    ui.shown.length = 0;
    script(press("Camera shots"), close, close);
    await open(op);
    check("reopened, it still offers the end", labels(shotsScreen()).includes("Mark the end here") && /Start marked/.test(bodyOf(shotsScreen())), labels(shotsScreen()).join(" | "));

    ui.shown.length = 0;
    script(press("Camera shots"), press("Cancel marking"), close, close);
    await open(op);
    check("Cancel marking clears it", op.getDynamicProperty(PENDING) === undefined);
    check("and the screen offers a new start again", labels(shotsScreen()).includes("Mark the start of a new shot here"));
    done();
});

test("a damaged pending mark is ignored, as if none were made", async () => {
    const { check, done } = checks();
    const { op } = scene();

    // Text that is not a mark, a mark of the wrong size, a mark with a string in it, and a number too big to be one (1e999 reads as Infinity).
    for (const damaged of ["this is not a mark", "[1,2,3]", '[1,"2",3,4,5]', "[1e999,2,3,4,5]", "{}"]) {
        ui.shown.length = 0;
        op.setDynamicProperty(PENDING, damaged);
        script(press("Camera shots"), close);

        await open(op);

        check(`${damaged}: it offers a new start`, labels(shotsScreen()).includes("Mark the start of a new shot here") && !labels(shotsScreen()).includes("Mark the end here") && !/Start marked/.test(bodyOf(shotsScreen())), labels(shotsScreen()).join(" | "));
    }
    done();
});

test("when the list is full a new start is refused at once, with the cap", async () => {
    const { check, done } = checks();
    const { op } = scene();
    for (let i = 1; i <= START.maxShots; i++) saveShot(`s${i}`);
    script(press("Camera shots"), press("Mark the start"), close);

    await open(op);

    check("nothing was marked", op.getDynamicProperty(PENDING) === undefined);
    check("the screen says why, with the most", new RegExp(String(START.maxShots)).test(bodyOf(shotsScreen())) && /room|full/i.test(bodyOf(shotsScreen())), bodyOf(shotsScreen()));
    done();
});

test("a shot's screen shows where it goes, and previewing it plays it for the operator alone and gives the camera back", async () => {
    const { check, done } = checks();
    const { op, other } = scene();
    saveShot("s1", "Bridge");
    const phase = round.getPhase();
    script(press("Camera shots"), press("1. "), press("Preview"), close);

    await open(op);
    await settle();

    const shot = titled("Shot: Bridge");
    check("its screen says where it starts and ends", /1, 70, 2/.test(bodyOf(shot)) && /31, 80, 42/.test(bodyOf(shot)), bodyOf(shot));
    check("the buttons are Preview, Delete and Back", labels(shot).join("|") === "Preview|Delete|Back", labels(shot).join(" | "));

    const seconds = START.introSeconds / START.shotsPerStart;
    check("the operator's camera: appear at the start, ease to the end over its share of the intro", op.camera.calls.length === 2 && op.camera.calls[0].options.location.x === 1 && op.camera.calls[1].options.easeOptions.easeTime === seconds, JSON.stringify(op.camera.calls));
    check("locked while it plays", !moving(op));
    check("nobody else's camera was touched", other.camera.calls.length === 0 && moving(other));
    check("the round did not change", round.getPhase() === phase);
    check("the menu did not come back over the camera", ui.shown.filter((f) => strip(titleOf(f)) === "Camera shots").length === 1, String(ui.shown.length));

    fake.advance(seconds * 20 - 1);
    check("a tick before the end it is still playing", !moving(op) && op.camera.calls.length === 2);
    fake.advance(1);
    check("at the end the camera is handed back and they can move", moving(op) && op.camera.calls.at(-1).method === "clear");
    done();
});

test("a preview is refused while a game is starting, and when the intro has no length", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1", "Bridge");

    round.startRound();
    script(press("Camera shots"), press("1. "), press("Preview"), close, close);
    await open(op);
    check("no camera while a start is under way", op.camera.calls.length === 0 && moving(op));
    check("it says why", /starting/i.test(bodyOf(titled("Shot: Bridge") ?? titled("Camera shots"))), bodyOf(titled("Shot: Bridge") ?? titled("Camera shots")));
    round.resetRound();

    ui.shown.length = 0;
    const before = START.introSeconds;
    START.introSeconds = 0;
    try {
        script(press("Camera shots"), press("1. "), press("Preview"), close, close);
        await open(op);
        check("no camera for an intro of no seconds", op.camera.calls.length === 0 && moving(op));
        check("it says so", /nothing to preview|0/.test(bodyOf(titled("Shot: Bridge") ?? titled("Camera shots"))));
    } finally {
        START.introSeconds = before;
    }
    done();
});

test("a Start in the middle of a preview lets the operator go at once, and the preview's own end does nothing more", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1", "Bridge");
    script(press("Camera shots"), press("1. "), press("Preview"), close);

    await open(op);
    await settle();
    fake.advance(30);
    round.resetRound();

    check("let go: movement back and camera cleared", moving(op) && op.camera.calls.at(-1).method === "clear");

    const seen = op.camera.calls.length;
    fake.advance(200);
    check("the preview's own timer did nothing more", op.camera.calls.length === seen);
    done();
});

test("a second preview in the middle of the first keeps the camera until its own end", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1", "Bridge");
    const seconds = START.introSeconds / START.shotsPerStart;

    script(press("Camera shots"), press("1. "), press("Preview"));
    await open(op);
    await settle();
    fake.advance(50);

    ui.shown.length = 0;
    script(press("Camera shots"), press("1. "), press("Preview"));
    await open(op);
    await settle();

    fake.advance(seconds * 20 - 50);
    check("the first preview's end did not take the second one's camera away", !moving(op) && op.camera.calls.every((c) => c.method !== "clear"), op.camera.calls.map((c) => c.method).join());

    fake.advance(50);
    check("the second one's own end did", moving(op) && op.camera.calls.at(-1).method === "clear");
    done();
});

test("deleting a shot is one button, with nothing to confirm", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1", "Bridge");
    saveShot("s2", "Roof");
    script(press("Camera shots"), press("1. "), press("Delete"), close, close);

    await open(op);

    check("the first is gone and the second stays", store.getShot("s1") === undefined && store.getShot("s2") !== undefined);
    check("the list screen says so and now starts at 1. Roof", /Deleted/.test(bodyOf(shotsScreen())) && labels(shotsScreen())[0].startsWith("1. Roof"), `${bodyOf(shotsScreen())} | ${labels(shotsScreen()).join(" | ")}`);
    done();
});

test("a shot that cannot be read is listed with why and can be deleted, and does not take its id's place", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1", "Bridge");
    world.setDynamicProperty("rae:start:shot:s2", "this is not a shot");
    store.forgetLoaded();
    script(press("Camera shots"), close);

    await open(op);

    const buttons = labels(shotsScreen());
    check("both are listed, the damaged one marked", buttons.some((l) => l.includes("s2") && /cannot be read/.test(l)), buttons.join(" | "));

    ui.shown.length = 0;
    script(press("Camera shots"), press("s2"), press("Delete"), close, close);
    await open(op);
    check("deleting it removes the record", world.getDynamicProperty("rae:start:shot:s2") === undefined && store.getShot("s1") !== undefined);
    done();
});

test("a new shot takes the id after the highest, counting a damaged one too, so it never writes over it", async () => {
    const { check, done } = checks();
    const { op } = scene();
    saveShot("s1");
    world.setDynamicProperty("rae:start:shot:s2", "this is not a shot");
    store.forgetLoaded();
    script(press("Camera shots"), press("Mark the start"), press("Mark the end"), fill({ Name: "New" }), close);

    await open(op);

    check("the new one is s3", store.getShot("s3")?.name === "New", store.allShots().map((s) => s.id).join());
    check("the damaged one was left alone", world.getDynamicProperty("rae:start:shot:s2") === "this is not a shot");
    done();
});

test("the screens had no problems with the stand-in's choices", () => {
    assert.deepEqual(problems, []);
});
