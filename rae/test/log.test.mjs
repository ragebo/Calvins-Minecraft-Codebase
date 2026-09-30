import { test } from "node:test";
import { fake, system, fakeApi, load, checks } from "./helpers.mjs";

// core/log.ts: the one place a failure or a diagnostic goes. It is deliberately standalone (no
// core/ imports at all), has no registerSystem (the debug flag is a dev/ops toggle, not round
// state), and registers rae:log_debug directly on the raw engine signal instead of through
// core/events.ts's onScriptEvent — see the file's own comment for why.

const { PlayerPermissionLevel } = fakeApi;
const { setDebugLogging, debug, info, warn, error } = await load("core/log.js");

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.error = realError; });

/** A clean world, and the gate back to its off-by-default state (it is not tied to a round reset). */
function fresh() {
    fake.reset();
    warnings.length = 0;
    errors.length = 0;
    setDebugLogging(false);
}

test("debug() is silent until setDebugLogging(true), and info()/warn() always fire", () => {
    const { check, done } = checks();
    fresh();

    debug("test", "quiet by default");
    check("debug() is silent before the gate is opened", warnings.length === 0, JSON.stringify(warnings));

    info("test", "always on");
    check("info() fires unconditionally", warnings.includes("[test] always on"), JSON.stringify(warnings));

    warn("test", "also always on");
    check("warn() fires unconditionally", warnings.includes("[test] also always on"), JSON.stringify(warnings));

    warnings.length = 0;
    setDebugLogging(true);
    debug("test", "now loud");
    check("debug() fires once the gate is open", warnings.includes("[test] now loud"), JSON.stringify(warnings));

    warnings.length = 0;
    setDebugLogging(false);
    debug("test", "quiet again");
    check("debug() is silent again once the gate is closed", warnings.length === 0, JSON.stringify(warnings));
    done();
});

test("error() always reaches the console, and only operators among online players", () => {
    const { check, done } = checks();
    fresh();
    const member = fake.makePlayer("Member", { permission: PlayerPermissionLevel.Member });
    const visitor = fake.makePlayer("Visitor", { permission: PlayerPermissionLevel.Visitor });
    const chief = fake.makePlayer("Chief", { permission: PlayerPermissionLevel.Operator });

    error("test", "boom");

    check("the console always gets it", errors.includes("[test] boom"), JSON.stringify(errors));
    check("a member is told nothing", member.messages.length === 0, JSON.stringify(member.messages));
    check("a visitor is told nothing", visitor.messages.length === 0, JSON.stringify(visitor.messages));
    check("the operator is told", chief.messages.some((m) => m.includes("[test] boom")), JSON.stringify(chief.messages));
    done();
});

test("error() with nobody operator online still logs to the console and never throws", () => {
    const { check, done } = checks();
    fresh();
    fake.makePlayer("Member", { permission: PlayerPermissionLevel.Member });

    let threw = null;
    try {
        error("test", "nobody around to hear it");
    } catch (e) {
        threw = e;
    }

    check("it does not throw", threw === null, String(threw));
    check("the console still gets it", errors.includes("[test] nobody around to hear it"), JSON.stringify(errors));
    done();
});

test("error()'s `to` option messages only that player, replacing the operator broadcast rather than adding to it", () => {
    const { check, done } = checks();
    fresh();
    const chief = fake.makePlayer("Chief", { permission: PlayerPermissionLevel.Operator });
    const target = fake.makePlayer("Target", { permission: PlayerPermissionLevel.Member });

    error("test", "just for you", { to: target });

    check("the named recipient is told", target.messages.some((m) => m.includes("[test] just for you")), JSON.stringify(target.messages));
    check("the operator hears nothing: `to` replaces the broadcast, it doesn't add to it", chief.messages.length === 0, JSON.stringify(chief.messages));
    check("the console still gets it", errors.includes("[test] just for you"), JSON.stringify(errors));
    done();
});

test("error()'s `to` option never throws for a player whose handle has since gone invalid", () => {
    const { check, done } = checks();
    fresh();
    const gone = fake.makePlayer("Gone");
    gone.isValid = false;

    let threw = null;
    try {
        error("test", "too late", { to: gone });
    } catch (e) {
        threw = e;
    }

    check("it does not throw", threw === null, String(threw));
    check("the console still gets it", errors.includes("[test] too late"), JSON.stringify(errors));
    done();
});

test("rae:log_debug on|off round-trips the gate and replies to the player who sent it", () => {
    const { check, done } = checks();
    fresh();
    const player = fake.makePlayer("Ada");
    const say = (message) => system.afterEvents.scriptEventReceive.emit({ id: "rae:log_debug", sourceEntity: player, message });

    say("on");
    check("the sender is told it is on", player.messages.some((m) => /now on/.test(m)), JSON.stringify(player.messages));
    warnings.length = 0;
    debug("test", "loud now");
    check("debug() actually turned on", warnings.includes("[test] loud now"), JSON.stringify(warnings));

    player.messages.length = 0;
    say("off");
    check("the sender is told it is off", player.messages.some((m) => /now off/.test(m)), JSON.stringify(player.messages));
    warnings.length = 0;
    debug("test", "quiet now");
    check("debug() actually turned off", warnings.length === 0, JSON.stringify(warnings));

    // A command block (no sourceEntity) still flips the flag; it just gets no reply, since it can't read chat.
    system.afterEvents.scriptEventReceive.emit({ id: "rae:log_debug", sourceEntity: undefined, message: "on" });
    warnings.length = 0;
    debug("test", "loud from a command block");
    check("a command block can still switch it on", warnings.includes("[test] loud from a command block"), JSON.stringify(warnings));
    system.afterEvents.scriptEventReceive.emit({ id: "rae:log_debug", sourceEntity: undefined, message: "off" });

    // A bad argument is refused with a hint, and leaves the gate untouched.
    player.messages.length = 0;
    warnings.length = 0;
    say("maybe");
    check("an unrecognised argument gets a usage hint", player.messages.some((m) => /Usage/.test(m)), JSON.stringify(player.messages));
    debug("test", "still quiet");
    check("the gate is unchanged by the bad argument", warnings.length === 0, JSON.stringify(warnings));
    done();
});
