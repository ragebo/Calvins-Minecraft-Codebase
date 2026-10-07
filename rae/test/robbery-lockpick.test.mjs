import { test } from "node:test";
import { checks, load } from "./helpers.mjs";

// logic/lockpick.ts: the jailbreak's slider game as pure rules. The random source and the tick are passed in, so
// every case here is exact: a target is fixed with a fake `random`, and a guess is a number.

const P = await load("logic/lockpick.js");

const curve = { max: 100, range: 50, floor: 0.5, spread: 1.5 };
const params = { hits: 2, tolerance: 10, strikes: 3, jamTicks: 400 };
/** A "random" that always rolls the same target: random() * max = 40 when random() is 0.4. */
const at40 = () => 0.4;

test("the first guess rolls the hidden target; a guess within tolerance (edge included) is a hit", () => {
    const { check, done } = checks();

    const exact = P.pickStep(P.FRESH_PICK, 40, params, curve, at40, 0);
    check("right on it is a hit", exact.outcome === "hit", JSON.stringify(exact));
    check("a hit counts one", exact.state.hits === 1);

    const edge = P.pickStep(P.FRESH_PICK, 50, params, curve, at40, 0);
    check("exactly the tolerance away still counts", edge.outcome === "hit", JSON.stringify(edge));

    const just = P.pickStep(P.FRESH_PICK, 50.01, params, curve, at40, 0);
    check("just past the tolerance is a miss", just.outcome === "miss", JSON.stringify(just));
    check("the distance is reported", Math.abs(just.distance - 10.01) < 1e-9, String(just.distance));
    done();
});

test("a miss keeps the target (so repeated pings mean something) and ping pitch rises as the guess gets closer", () => {
    const { check, done } = checks();

    const first = P.pickStep(P.FRESH_PICK, 90, params, curve, at40, 0);
    check("a miss", first.outcome === "miss");
    check("the target is remembered", first.state.target === 40, String(first.state.target));

    const neverRolledAgain = () => { throw new Error("the target must not be re-rolled on a miss"); };
    const second = P.pickStep(first.state, 70, params, curve, neverRolledAgain, 1);
    const third = P.pickStep(second.state, 55, params, curve, neverRolledAgain, 2);
    check("colder to warmer: the pitch climbs", first.pitch < second.pitch && second.pitch < third.pitch, `${first.pitch} ${second.pitch} ${third.pitch}`);
    check("as cold as it gets is the floor", Math.abs(P.pitchFor(500, curve) - curve.floor) < 1e-9);
    check("right on it would be floor + spread", Math.abs(P.pitchFor(0, curve) - (curve.floor + curve.spread)) < 1e-9);
    check("proximity is 0..1", P.proximity(0, curve) === 1 && P.proximity(25, curve) === 0.5 && P.proximity(50, curve) === 0 && P.proximity(500, curve) === 0);
    done();
});

test("a hit re-rolls the target and clears the misses; enough hits unlock it", () => {
    const { check, done } = checks();

    let step = P.pickStep(P.FRESH_PICK, 90, params, curve, at40, 0);     // one miss
    check("one strike so far", step.state.strikes === 1);

    step = P.pickStep(step.state, 41, params, curve, at40, 1);           // a hit
    check("a hit", step.outcome === "hit");
    check("misses are cleared by a hit", step.state.strikes === 0);
    check("the target is re-rolled (undefined until the next guess)", step.state.target === undefined);

    const at80 = () => 0.8;
    step = P.pickStep(step.state, 80, params, curve, at80, 2);           // the second hit, against a new target of 80
    check("the last needed hit unlocks it", step.outcome === "unlocked", JSON.stringify(step));
    check("hits are counted", step.state.hits === 2);
    done();
});

test("too many misses in a row jam the lock: progress is lost, the target is re-rolled, and it waits", () => {
    const { check, done } = checks();

    let step = P.pickStep(P.FRESH_PICK, 41, params, curve, at40, 0);     // a hit first: hits = 1
    check("one hit banked", step.state.hits === 1);

    step = P.pickStep(step.state, 95, params, curve, at40, 10);
    step = P.pickStep(step.state, 96, params, curve, at40, 11);
    check("two misses: still working", step.outcome === "miss" && step.state.strikes === 2);

    step = P.pickStep(step.state, 97, params, curve, at40, 12);
    check("the third miss jams it", step.outcome === "jam", JSON.stringify(step));
    check("the jam lasts jamTicks from now", step.state.jammedUntil === 12 + params.jamTicks);
    check("progress is lost: no hits, no strikes, no target", step.state.hits === 0 && step.state.strikes === 0 && step.state.target === undefined);
    check("a jam still plays the ping", step.pitch > 0);

    const jammed = step.state;
    const during = P.pickStep(jammed, 40, params, curve, at40, 12 + params.jamTicks - 1);
    check("a guess while jammed does nothing, even a perfect one", during.outcome === "waiting" && during.state === jammed, JSON.stringify(during));

    const after = P.pickStep(jammed, 40, params, curve, at40, 12 + params.jamTicks);
    check("it works again the very tick the jam ends", after.outcome === "hit", JSON.stringify(after));
    done();
});

test("strikes of 0 means it never jams, however many misses", () => {
    const { check, done } = checks();
    const forgiving = { ...params, strikes: 0 };

    let state = P.FRESH_PICK;
    let step;
    for (let i = 0; i < 50; i++) {
        step = P.pickStep(state, 99, forgiving, curve, at40, i);
        state = step.state;
    }

    check("fifty misses and still just missing", step.outcome === "miss" && step.state.strikes === 50, JSON.stringify(step));
    check("and the same target is still the one", step.state.target === 40);
    done();
});

test("one hit is enough when hits is 1; the target is rolled across the whole slider", () => {
    const { check, done } = checks();
    const quick = { ...params, hits: 1 };

    check("a single required hit unlocks at once", P.pickStep(P.FRESH_PICK, 40, quick, curve, at40, 0).outcome === "unlocked");
    check("rollTarget spans 0 up to the maximum", P.rollTarget(() => 0, 100) === 0 && P.rollTarget(() => 0.999, 100) < 100 && P.rollTarget(() => 0.5, 200) === 100);
    done();
});
