import { test } from "node:test";
import { fake, world, load, checks } from "./helpers.mjs";

// systems/horse.ts: a horse is given the standard speed a tick after it spawns. A horse the shop's mount service spawned and then took back
// (a deal that failed part-way) is already gone by then, and that must not be reported as an error to every operator in chat.

const { HORSE } = await load("config/balance.js");
await load("systems/horse.js");

const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args.join(" "));
process.on("exit", () => { console.error = realError; });

function spawnHorse() {
    const horse = fake.makeEntity({ typeId: "minecraft:horse" });
    horse.speeds = [];
    const original = horse.getComponent.bind(horse);
    horse.getComponent = (id) => { const found = original(id); return id === "minecraft:movement" ? { setCurrentValue(v) { horse.speeds.push(v); } } : found; };      // the original throws for a horse that is gone
    world.afterEvents.entitySpawn.emit({ entity: horse });
    return horse;
}

test("a horse that spawns is given the standard speed a tick later", () => {
    const { check, done } = checks();
    fake.reset();
    errors.length = 0;
    const horse = spawnHorse();
    check("not yet, the horse has to finish spawning", horse.speeds.length === 0);
    fake.advance(1);
    check("then its speed is the config's", JSON.stringify(horse.speeds) === JSON.stringify([HORSE.speed]), JSON.stringify(horse.speeds));
    check("no error", errors.length === 0, errors.join(" | "));
    done();
});

test("a horse that is gone by then is left alone, with no error for anyone", () => {
    const { check, done } = checks();
    fake.reset();
    errors.length = 0;
    const operator = fake.makePlayer("Op", { permission: 2 });
    const horse = spawnHorse();
    horse.remove();                                      // taken back in the same tick, as an undone deal does
    let threw = false;
    try { fake.advance(1); } catch { threw = true; }
    check("nothing thrown", !threw);
    check("nothing logged as an error", errors.length === 0, errors.join(" | "));
    check("and no operator was told anything", operator.messages.length === 0, JSON.stringify(operator.messages));
    done();
});

test("an animal that is not a horse is not touched", () => {
    const { check, done } = checks();
    fake.reset();
    const mule = fake.makeEntity({ typeId: "minecraft:mule" });
    mule.speeds = [];
    mule.getComponent = (id) => id === "minecraft:movement" ? { setCurrentValue(v) { mule.speeds.push(v); } } : undefined;
    world.afterEvents.entitySpawn.emit({ entity: mule });
    fake.advance(2);
    check("no speed set", mule.speeds.length === 0);
    done();
});
