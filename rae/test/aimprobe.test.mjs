import { test } from "node:test";
import { fake, system, world, load, checks, strip } from "./helpers.mjs";

// `/scriptevent rae:aim_spike` records what the game reports for clicks, holds, drops and off-hand swaps, and
// drives the zoom and the scope overlay. These tests cannot say what the real game reports. They check that the
// spike RECORDS what it is told correctly, stays silent when logging is off, and cleans up.

const { AIM_SPIKE: A } = await load("config/balance.js");
await load("systems/aimprobe.js");
const { resetAllSystems } = await load("core/registry.js");

const logs = [];
const realWarn = console.warn;
console.warn = (...args) => logs.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

const say = (player, message) => system.afterEvents.scriptEventReceive.emit({ id: "rae:aim_spike", sourceEntity: player, message });
const lines = () => logs.filter((l) => l.startsWith("[aim-spike]")).map((l) => l.slice("[aim-spike] ".length));
const text = (player) => player.messages.map(strip).join("\n");

function fresh(options = {}) {
    resetAllSystems();
    fake.reset();
    logs.length = 0;
    const player = fake.makePlayer("Ada", { location: { x: 0, y: 64, z: 0 }, ...options });
    return player;
}

const item = (typeId) => ({ typeId });

function emitEverything(player) {
    world.afterEvents.playerSwingStart.emit({ swingSource: "Attack", heldItemStack: item("bountysys:revolver"), player });
    world.afterEvents.itemUse.emit({ itemStack: item("bountysys:aim_probe_plain"), source: player });
    world.afterEvents.itemStartUse.emit({ itemStack: item("bountysys:aim_probe_plain"), source: player, useDuration: 1200 });
    world.afterEvents.itemStopUse.emit({ itemStack: item("bountysys:aim_probe_plain"), source: player, useDuration: 1100 });
    world.afterEvents.itemReleaseUse.emit({ itemStack: item("bountysys:aim_probe_bow"), source: player, useDuration: 1000 });
    world.afterEvents.itemCompleteUse.emit({ itemStack: item("bountysys:aim_probe_spyglass"), source: player, useDuration: 0 });
    world.afterEvents.entityHitEntity.emit({ damagingEntity: player, hitEntity: { typeId: "minecraft:cow" } });
    world.afterEvents.entityItemDrop.emit({ entity: player, items: [{ getComponent: () => ({ itemStack: item("bountysys:revolver") }) }] });
    world.afterEvents.playerInventoryItemChange.emit({ player, slot: 3, itemStack: undefined, beforeItemStack: item("bountysys:revolver") });
}

test("nothing is logged until `log on`, and everything stops again at `log off`", () => {
    const { check, done } = checks();
    const p = fresh();

    emitEverything(p);
    check("silent by default", lines().length === 0, lines().join("\n"));

    say(p, "log on");
    check("it says logging is on", /Logging on/.test(text(p)), text(p));
    emitEverything(p);
    check("each of the nine kinds of event writes one line", lines().length === 9, lines().join("\n"));

    say(p, "log off");
    const count = lines().length;
    emitEverything(p);
    check("off again: silent", lines().length === count, `${count} -> ${lines().length}`);
    done();
});

test("each line carries what a later reader needs: the swing source, the held item, the use duration and whether the player was riding", () => {
    const { check, done } = checks();
    const p = fresh();
    say(p, "log on");
    emitEverything(p);
    const all = lines().join("\n");

    check("swing: source, held item, player, riding and sneaking", /swing source=Attack held=bountysys:revolver Ada riding=false sneaking=false/.test(all), all);
    check("itemUse names the item", /itemUse bountysys:aim_probe_plain Ada/.test(all), all);
    check("start, stop, release and complete each carry the use duration", /itemStartUse bountysys:aim_probe_plain useDuration=1200/.test(all) && /itemStopUse bountysys:aim_probe_plain useDuration=1100/.test(all) && /itemReleaseUse bountysys:aim_probe_bow useDuration=1000/.test(all) && /itemCompleteUse bountysys:aim_probe_spyglass useDuration=0/.test(all), all);
    check("a hit names the target", /hit minecraft:cow by Ada/.test(all), all);
    check("a drop names the dropped item", /itemDrop \[bountysys:revolver\] by Ada/.test(all), all);
    check("an inventory change gives the slot and both sides", /inventory slot=3 bountysys:revolver -> none Ada/.test(all), all);

    // Riding and sneaking are read from the player each time.
    logs.length = 0;
    p.ridingOn = fake.makeEntity({ typeId: "minecraft:horse" });
    p.isSneaking = true;
    world.afterEvents.playerSwingStart.emit({ swingSource: "Attack", heldItemStack: undefined, player: p });
    check("riding and sneaking are reported, and no held item reads as none", /swing source=Attack held=none Ada riding=true sneaking=true/.test(lines().join("\n")), lines().join("\n"));
    done();
});

test("hits by mobs, and drops by mobs, are not logged (only the player's own)", () => {
    const { check, done } = checks();
    const p = fresh();
    say(p, "log on");
    const mob = fake.makeEntity({ typeId: "minecraft:zombie" });
    world.afterEvents.entityHitEntity.emit({ damagingEntity: mob, hitEntity: p });
    world.afterEvents.entityItemDrop.emit({ entity: mob, items: [] });
    check("nothing logged", lines().length === 0, lines().join("\n"));
    done();
});

test("the off-hand is read while logging is on, and a change (a swap) is logged once with the main hand beside it", () => {
    const { check, done } = checks();
    const p = fresh({ holding: "bountysys:revolver" });
    say(p, "log on");
    fake.advance(A.offhandPollTicks * 3);
    check("no change, no line", lines().filter((l) => l.startsWith("offhand")).length === 0, lines().join("\n"));

    p.offhand = "bountysys:revolver";
    p.holding = null;
    fake.advance(A.offhandPollTicks * 2);
    const swaps = lines().filter((l) => l.startsWith("offhand"));
    check("the swap is logged once", swaps.length === 1 && /offhand none -> bountysys:revolver \(main hand none\) Ada/.test(swaps[0]), swaps.join("\n"));

    p.offhand = null;
    fake.advance(A.offhandPollTicks * 2);
    check("and the swap back", lines().filter((l) => l.startsWith("offhand")).length === 2 && /offhand bountysys:revolver -> none/.test(lines().at(-1)), lines().join("\n"));

    say(p, "log off");
    p.offhand = "minecraft:shield";
    const count = lines().length;
    fake.advance(A.offhandPollTicks * 4);
    check("polling stops with logging", lines().length === count, lines().join("\n"));
    done();
});

test("fov sets the camera's field of view with an ease, and reset puts it back", () => {
    const { check, done } = checks();
    const p = fresh();

    say(p, "fov 30");
    check("the camera was given the field of view and the ease time", p.camera.fovCalls.length === 1 && p.camera.fovCalls[0].fov === 30 && p.camera.fovCalls[0].easeOptions.easeTime === A.fovEaseSeconds, JSON.stringify(p.camera.fovCalls));
    check("and the player is told", /Field of view 30/.test(text(p)), text(p));

    say(p, "fov reset");
    check("reset calls setFov with nothing", p.camera.fovCalls.length === 2 && p.camera.fovCalls[1] === undefined, JSON.stringify(p.camera.fovCalls));

    for (const bad of ["fov", "fov abc", "fov 0", "fov -5", "fov 180", "fov 400"]) {
        p.messages.length = 0;
        say(p, bad);
        check(`"${bad}" is refused with a hint`, /between 1 and 179/.test(text(p)), text(p));
    }
    check("a refused value never reaches the camera", p.camera.fovCalls.length === 2, String(p.camera.fovCalls.length));
    done();
});

test("a camera that refuses is reported to the player and the log, not thrown", () => {
    const { check, done } = checks();
    const p = fresh();
    fake.cameraError = "the camera is busy";
    say(p, "fov 30");
    check("the player is told", /The camera refused: Error: the camera is busy/.test(text(p)), text(p));
    check("the log says it failed", lines().some((l) => /fov 30 FAILED: Error: the camera is busy/.test(l)), lines().join("\n"));
    done();
});

test("scope on sends the title that switches the overlay, held for a long time with no fades; off clears it", () => {
    const { check, done } = checks();
    const p = fresh();

    say(p, "scope on");
    check("the title is the configured switch", p.titles.at(-1) === A.scopeTitle, JSON.stringify(p.titles));
    check("held long, with no fade in or out", p.titleOptions.at(-1)?.stayDuration === A.scopeStayTicks && p.titleOptions.at(-1)?.fadeInDuration === 0 && p.titleOptions.at(-1)?.fadeOutDuration === 0, JSON.stringify(p.titleOptions.at(-1)));
    check("the title draws nothing itself (formatting codes only)", strip(A.scopeTitle) === "", JSON.stringify(strip(A.scopeTitle)));

    // The first real-game run could not switch the overlay off by clearing the title: the HUD keeps the last text it
    // was given. So off overwrites the switch text with a different one that draws nothing, and clears afterwards.
    say(p, "scope off");
    check("off first overwrites the switch text with a different, invisible one", p.titles.at(-1) === A.scopeOffTitle && A.scopeOffTitle !== A.scopeTitle && strip(A.scopeOffTitle) === "", JSON.stringify(p.titles));
    check("briefly, with no fades", p.titleOptions.at(-1)?.stayDuration === 1 && p.titleOptions.at(-1)?.fadeInDuration === 0 && p.titleOptions.at(-1)?.fadeOutDuration === 0, JSON.stringify(p.titleOptions.at(-1)));
    check("and does not clear yet, so the overwrite reaches the HUD first", p.titles.at(-1) !== "", JSON.stringify(p.titles));
    fake.advance(A.scopeClearDelayTicks - 1);
    check("still not cleared just before the delay", p.titles.at(-1) === A.scopeOffTitle, JSON.stringify(p.titles));
    fake.advance(1);
    check("then clears the title", p.titles.at(-1) === "", JSON.stringify(p.titles));
    check("in that order: switch, overwrite, clear", JSON.stringify(p.titles) === JSON.stringify([A.scopeTitle, A.scopeOffTitle, ""]), JSON.stringify(p.titles));
    check("both are logged", lines().includes("scope on") && lines().includes("scope off"), lines().join("\n"));
    done();
});

test("a reset puts everything back: logging off, the field of view, the scope", () => {
    const { check, done } = checks();
    const p = fresh();                                       // only zoomed
    const q = fake.makePlayer("Bea");                         // only scoped
    say(p, "log on");
    say(p, "fov 30");
    say(q, "scope on");
    const calls = p.camera.fovCalls.length;

    resetAllSystems();
    check("a player who only zoomed gets the field of view put back", p.camera.fovCalls.length === calls + 1 && p.camera.fovCalls.at(-1) === undefined, JSON.stringify(p.camera.fovCalls));
    check("a player who only put on the scope has the overlay switched off the same way (overwrite, then clear)", q.titles.at(-1) === A.scopeOffTitle, JSON.stringify(q.titles));
    fake.advance(A.scopeClearDelayTicks);
    check("and the title cleared after the delay", q.titles.at(-1) === "" && JSON.stringify(q.titles) === JSON.stringify([A.scopeTitle, A.scopeOffTitle, ""]), JSON.stringify(q.titles));

    logs.length = 0;
    emitEverything(p);
    check("logging is off", lines().length === 0, lines().join("\n"));
    done();
});

test("a reset after a player who used the spike has left reports no error", () => {
    const { check, done } = checks();
    const p = fresh();
    const q = fake.makePlayer("Bea");
    say(q, "fov 40");
    say(q, "scope on");
    q.remove();
    fake.chat.length = 0;

    let threw = false;
    try { resetAllSystems(); fake.advance(A.scopeClearDelayTicks + 2); } catch { threw = true; }
    check("it does not throw, not even when the delayed clear comes due after the player left", !threw);
    check("and the reset reports no error (the registry sends one to chat when a system fails)", !fake.chat.some((m) => /RESET ERROR/.test(m)), fake.chat.join("|"));
    check("the player who is still here is unaffected", p.isValid);

    // A player who switches the scope off and leaves before the delayed clear comes due.
    const r = fake.makePlayer("Cy");
    say(r, "scope on");
    say(r, "scope off");
    r.remove();
    let threwLater = false;
    try { fake.advance(A.scopeClearDelayTicks + 2); } catch { threwLater = true; }
    check("a delayed clear for a player who left is skipped, not thrown", !threwLater);
    done();
});

test("usage is shown for anything else, and the command needs a player", () => {
    const { check, done } = checks();
    const p = fresh();

    for (const message of ["", "help", "log", "log maybe", "scope", "scope dim", "fly"]) {
        p.messages.length = 0;
        say(p, message);
        check(`"${message}" shows the usage`, /Usage: \/scriptevent rae:aim_spike/.test(text(p)), text(p));
    }

    logs.length = 0;
    say(undefined, "log on");
    check("run without a player: one log line, and logging stays off", logs.some((l) => /has to be run by a player/.test(l)), logs.join("|"));
    logs.length = 0;
    emitEverything(p);
    check("still off", lines().length === 0, lines().join("\n"));
    done();
});
