import { test } from "node:test";
import { fake, load, checks } from "./helpers.mjs";

// core/sound.ts: the one place Player.playSound/Dimension.playSound gets called. playFor is private
// (Player.playSound), playAt is positional (Dimension.playSound), and playSequence generalizes
// guns.ts's old playCue/playCues for both. Deliberately domain-agnostic: it knows nothing about a
// "gun" or a "jail" — callers pass a plain shouldPlay closure instead.
const { playFor, playAt, playSequence } = await load("core/sound.js");

const overworld = () => fake.dimension("overworld");

const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.error = realError; });

function fresh() {
    fake.reset();
    errors.length = 0;
}

test("playFor plays privately, with the cue's own volume and pitch, and nothing positional", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Solo");

    playFor(p, { id: "random.click", volume: 0.5, pitch: 1.2 });

    check("exactly one private sound", p.privateSounds.length === 1, JSON.stringify(p.privateSounds));
    check("the right id/volume/pitch", p.privateSounds[0].id === "random.click" && p.privateSounds[0].volume === 0.5 && p.privateSounds[0].pitch === 1.2, JSON.stringify(p.privateSounds));
    check("nothing played positionally", overworld().played.length === 0, JSON.stringify(overworld().played));
    done();
});

test("playAt plays positionally at the player's own location by default, or an explicit one when given", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Shooter", { location: { x: 5, y: 64, z: 5 } });

    playAt(p, { id: "firework.blast", volume: 2, pitch: 0.9 });
    playAt(p, { id: "random.explode", volume: 1, pitch: 1 }, { x: 1, y: 2, z: 3 });

    const played = overworld().played;
    check("first cue plays at the player's own location", played[0]?.id === "firework.blast" && played[0]?.location.x === 5 && played[0]?.location.y === 64 && played[0]?.location.z === 5, JSON.stringify(played));
    check("an explicit location overrides the player's own", played[1]?.id === "random.explode" && played[1]?.location.x === 1 && played[1]?.location.y === 2 && played[1]?.location.z === 3, JSON.stringify(played));
    check("nothing played privately", p.privateSounds.length === 0, JSON.stringify(p.privateSounds));
    done();
});

// Moved from guns-sounds.test.mjs's "a broken cue can never break firing, and is reported once" test
// (that file now only checks the gun-integration guarantee) and rewritten directly against this
// module: the dedup is core/sound.ts's own job now, reported via core/log.ts's error(), not the old
// "[GUN SOUND ERROR]" world.sendMessage.
test("a bad cue is caught, reported through core/log's error() exactly once per id, and never breaks the caller", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("BadCue", { location: { x: 0, y: 64, z: 0 } });

    let threw = null;
    try {
        playAt(p, { id: "some.sound", pitch: 0 });     // below the engine's 0.01 floor
        playAt(p, { id: "some.sound", pitch: 0 });      // same id again: must not re-report
        playAt(p, { id: "other.sound", volume: -1 });   // a different bad id: its own report
    } catch (e) { threw = e; }

    check("never throws out to the caller", threw === null, String(threw));
    check("the first bad id is reported exactly once", errors.filter((m) => m.includes("[sound]") && m.includes("some.sound")).length === 1, JSON.stringify(errors));
    check("a different bad id gets its own independent report", errors.some((m) => m.includes("[sound]") && m.includes("other.sound")), JSON.stringify(errors));
    check("nothing actually played for either bad cue", overworld().played.length === 0, JSON.stringify(overworld().played));
    done();
});

test("playFor also catches and reports a throwing call, never breaking the caller", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Solo2");
    const originalPlaySound = p.playSound;
    p.playSound = () => { throw new Error("boom"); };   // the fake never validates Player.playSound itself, so force the failure it's meant to guard against

    let threw = null;
    try {
        playFor(p, { id: "random.click" });
    } catch (e) { threw = e; } finally { p.playSound = originalPlaySound; }

    check("never throws out to the caller", threw === null, String(threw));
    check("reported via core/log's error()", errors.some((m) => m.includes("[sound]") && m.includes("random.click") && m.includes("boom")), JSON.stringify(errors));
    done();
});

test("playSequence: immediate cues play at once, delayed cues land on their own scheduled tick", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Seq", { location: { x: 0, y: 64, z: 0 } });
    const t0 = fake.tick;

    playSequence(p, [
        { id: "a", volume: 1, pitch: 1 },
        { id: "b", volume: 1, pitch: 1, delayTicks: 5 }
    ], { positional: true });

    let played = overworld().played;
    check("the immediate cue plays right away", played.some((x) => x.id === "a" && x.tick === t0), JSON.stringify(played));
    check("the delayed cue hasn't played yet", !played.some((x) => x.id === "b"), JSON.stringify(played));

    fake.advance(5);
    played = overworld().played;
    check("the delayed cue lands exactly on its own tick", played.some((x) => x.id === "b" && x.tick === t0 + 5), JSON.stringify(played));
    done();
});

test("playSequence defaults to private (playFor), not positional", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Priv");

    playSequence(p, [{ id: "a", volume: 1, pitch: 1 }]);

    check("plays privately by default", p.privateSounds.length === 1 && p.privateSounds[0].id === "a", JSON.stringify(p.privateSounds));
    check("nothing plays positionally", overworld().played.length === 0, JSON.stringify(overworld().played));
    done();
});

test("playSequence's shouldPlay gates only delayed cues: an immediate cue always plays, a delayed one is silenced once shouldPlay turns false", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Gate", { location: { x: 0, y: 64, z: 0 } });
    let allow = true;

    playSequence(p, [
        { id: "immediate", volume: 1, pitch: 1 },
        { id: "delayed", volume: 1, pitch: 1, delayTicks: 5 }
    ], { positional: true, shouldPlay: () => allow });

    allow = false;
    fake.advance(5);

    const played = overworld().played;
    check("the immediate cue always played, ungated", played.some((x) => x.id === "immediate"), JSON.stringify(played));
    check("the delayed cue is silenced once shouldPlay turns false", !played.some((x) => x.id === "delayed"), JSON.stringify(played));
    done();
});

test("playSequence never plays a delayed cue for a player who has since gone invalid, and throws nothing", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Gone", { location: { x: 0, y: 64, z: 0 } });

    playSequence(p, [{ id: "delayed", volume: 1, pitch: 1, delayTicks: 5 }], { positional: true });
    p.isValid = false;

    let threw = null;
    try { fake.advance(5); } catch (e) { threw = e; }

    check("advancing past the delay throws nothing", threw === null, String(threw));
    done();
});

test("playSequence keeps playing the rest of a sequence after one cue throws", () => {
    const { check, done } = checks();
    fresh();
    const p = fake.makePlayer("Partial", { location: { x: 0, y: 64, z: 0 } });

    playSequence(p, [
        { id: "bad", volume: 1, pitch: 0 },     // below the engine's 0.01 floor: throws
        { id: "good", volume: 1, pitch: 1 }
    ], { positional: true });

    const played = overworld().played;
    check("the bad cue never played", !played.some((x) => x.id === "bad"), JSON.stringify(played));
    check("the good cue still played", played.some((x) => x.id === "good"), JSON.stringify(played));
    done();
});
