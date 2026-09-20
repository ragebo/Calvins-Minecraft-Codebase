import { test } from "node:test";
import { fake, system, load, checks } from "./helpers.mjs";

// `/scriptevent <id> <message>`: the handler gets the player who ran it and the text after the id.

const { onScriptEvent } = await load("core/events.js");

const emit = (event) => system.afterEvents.scriptEventReceive.emit(event);

test("a handler receives the message text after the id", () => {
    const { check, done } = checks();
    fake.reset();
    const seen = [];
    onScriptEvent("test:message", (player, message) => seen.push({ player, message }));
    const player = fake.makePlayer("Ada");

    emit({ id: "test:message", sourceEntity: player, message: "Depot North" });
    emit({ id: "test:message", sourceEntity: player, message: "" });
    emit({ id: "test:message", sourceEntity: player });                   // an event that carries no message at all

    check("three calls", seen.length === 3, JSON.stringify(seen.map((s) => s.message)));
    check("the text arrives whole, spaces kept", seen[0]?.message === "Depot North", seen[0]?.message);
    check("an empty message stays empty", seen[1]?.message === "");
    check("a missing message becomes an empty string", seen[2]?.message === "", String(seen[2]?.message));
    check("the player still arrives first", seen[0]?.player === player);
    done();
});

test("a handler that ignores the message keeps working", () => {
    const { check, done } = checks();
    fake.reset();
    let calls = 0;
    onScriptEvent("test:plain", () => { calls++; });
    emit({ id: "test:plain", message: "ignored" });
    check("called once", calls === 1, String(calls));
    done();
});
