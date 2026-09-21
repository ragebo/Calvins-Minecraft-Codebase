import { test } from "node:test";
import { fake, system, world, load, checks, strip, leftClick, aimStart, aimStop, pressQ } from "./helpers.mjs";

// The gun controls: left-click fires, a held right-click aims (zoom, and a scope for the bolt rifle), Q reloads and
// so does clicking an empty gun. Every event sequence here is the one the real game sent (content log, 2026-09-20:
// docs/test-cards/AIM-SPIKE.md), in the same order. Nothing in it depends on sneaking, which a horse takes.

const { GUNS, AMMO } = await load("config/guns.js");
const { AIM } = await load("config/balance.js");
await load("systems/guns.js");
const { listSystems } = await load("core/registry.js");

const guns = Object.values(GUNS);
const overworld = () => fake.dimension("overworld");
const resetGuns = () => listSystems().find((s) => s.name === "guns").reset();
const text = (p) => p.messages.map(strip).join("\n");

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
process.on("exit", () => { console.warn = realWarn; });

function armed(gun, name = "Deputy", options = {}) {
    fake.reset();
    resetGuns();
    warnings.length = 0;
    const p = fake.makePlayer(name, { location: { x: 1, y: 64, z: 2 }, holding: gun.itemId, ...options });
    p.giveAmmo(AMMO[gun.ammo].itemId, 64);
    fake.advance(200);
    overworld().played.length = 0;
    return p;
}

const heardShot = (gun) => overworld().played.some((pl) => pl.id === gun.sounds.fire[0].id);
const emptyMagazine = (p, gun) => {
    for (let i = 0; i < gun.magazineSize; i++) { leftClick(p); fake.advance(gun.fireRateTicks); }
    fake.advance(gun.reloadTicks + 60);
    overworld().played.length = 0; p.messages.length = 0;
};

// ---------------------------------------------------------------------------------------------------------
// Fire: left-click
// ---------------------------------------------------------------------------------------------------------

test("left-click fires every gun: at the air or a mob (Attack) and at a block (Mine), on foot or on a horse", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        for (const source of ["Attack", "Mine"]) {
            for (const riding of [false, true]) {
                const p = armed(gun, `fire-${gun.id}-${source}-${riding}`);
                if (riding) p.ridingOn = fake.makeEntity({ typeId: "minecraft:horse" });
                leftClick(p, source);
                check(`${gun.id}: ${source}${riding ? " on a horse" : ""} fires`, heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
            }
        }
    }
    done();
});

test("only Attack and Mine fire: the other swings a player makes (building, interacting, dropping) do not", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    for (const source of ["Build", "Interact", "DropItem", "Event", "None", "Place", "Throw", "Use"]) {
        const p = armed(gun, `swing-${source}`);
        leftClick(p, source);
        check(`${source} does not fire`, !heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
    }
    done();
});

test("a swing with something else in hand, or nothing, fires nothing", () => {
    const { check, done } = checks();
    const gun = GUNS.pistol;
    let p = armed(gun, "stick");
    p.holding = "minecraft:stick";
    leftClick(p);
    check("a stick", !heardShot(gun));

    p = armed(gun, "hands");
    p.holding = null;
    leftClick(p);
    check("empty hands", !heardShot(gun));

    p = armed(gun, "compass");
    p.holding = "bountysys:law_compass";
    leftClick(p);
    check("the law compass", !heardShot(gun));
    done();
});

test("right-click, held or not, never fires: itemUse comes with every aim", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        const p = armed(gun, `aimnofire-${gun.id}`);
        aimStart(p);
        fake.advance(20);
        aimStop(p);
        check(`${gun.id}: pressing, holding and releasing right-click fires no shot`, !heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
    }
    done();
});

test("sneaking does nothing to a gun: it neither reloads nor stops a shot", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "sneaker");
    p.isSneaking = true;
    leftClick(p);
    check("a click while sneaking fires", heardShot(gun));
    fake.advance(gun.fireRateTicks + 1);
    p.messages.length = 0;
    world.afterEvents.itemUse.emit({ itemStack: { typeId: gun.itemId }, source: p });
    check("sneak + use no longer reloads", !text(p).includes("Reloading") && !text(p).includes("Already"), text(p));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Auto-reload
// ---------------------------------------------------------------------------------------------------------

test("clicking an empty gun clicks, tells nothing about keys, and reloads by itself", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        const p = armed(gun, `auto-${gun.id}`);
        emptyMagazine(p, gun);
        leftClick(p);
        check(`${gun.id}: a click`, p.privateSounds.some((s) => s.id === "random.click"));
        check(`${gun.id}: it starts a reload`, text(p).includes("Reloading"), text(p));
        check(`${gun.id}: no advice to sneak`, !/sneak/i.test(text(p)), text(p));
        fake.advance(gun.reloadTicks + 2);
        check(`${gun.id}: the magazine is full again`, text(p).includes(`${gun.magazineSize}/${gun.magazineSize}`), text(p));
        overworld().played.length = 0;
        leftClick(p);
        check(`${gun.id}: and the next click fires`, heardShot(gun));
    }
    done();
});

test("an empty gun with no ammo says so and does not start a reload; clicks during a reload do not restart it", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;

    let p = armed(gun, "dry");
    emptyMagazine(p, gun);
    for (let i = 0; i < p.container.size; i++) p.container.setItem(i, undefined);
    leftClick(p);
    check("no ammo: told so", /No .* left/.test(text(p)), text(p));
    check("no reload starts", !text(p).includes("Reloading"), text(p));

    p = armed(gun, "impatient");
    emptyMagazine(p, gun);
    leftClick(p);
    leftClick(p); fake.advance(gun.fireRateTicks + 1);
    leftClick(p); fake.advance(gun.fireRateTicks + 1);
    check("one reload, however many clicks", (text(p).match(/Reloading/g) ?? []).length === 1, text(p));
    fake.advance(gun.reloadTicks + 2);
    check("and it completes once", (text(p).match(/reloaded/g) ?? []).length === 1, text(p));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Aim
// ---------------------------------------------------------------------------------------------------------

test("holding right-click zooms to the gun's field of view, and letting go puts the view back", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        const p = armed(gun, `zoom-${gun.id}`);
        aimStart(p);
        check(`${gun.id}: zoomed to ${gun.aim.fov}, eased`, p.camera.fovCalls.length === 1 && p.camera.fovCalls[0].fov === gun.aim.fov && p.camera.fovCalls[0].easeOptions.easeTime === AIM.fovEaseSeconds, JSON.stringify(p.camera.fovCalls));
        aimStop(p);
        check(`${gun.id}: letting go resets the view`, p.camera.fovCalls.length === 2 && p.camera.fovCalls[1] === undefined, JSON.stringify(p.camera.fovCalls));
    }
    done();
});

test("every gun zooms in (the normal view is about 70), and the bolt rifle zooms furthest", () => {
    const { check, done } = checks();
    for (const gun of guns) check(`${gun.id}: fov ${gun.aim.fov} is a zoom`, gun.aim.fov > 5 && gun.aim.fov < 70);
    const others = guns.filter((g) => g.id !== "bolt_rifle");
    check("the bolt rifle zooms further than any other gun", others.every((g) => GUNS.bolt_rifle.aim.fov < g.aim.fov));
    check("only the bolt rifle has a scope", guns.filter((g) => g.aim.scope).map((g) => g.id).join() === "bolt_rifle", guns.filter((g) => g.aim.scope).map((g) => g.id).join());
    done();
});

test("the bolt rifle shows the scope while aimed and switches it off properly; the other guns show none", () => {
    const { check, done } = checks();

    const scoped = armed(GUNS.bolt_rifle, "sniper");
    aimStart(scoped);
    check("the scope title is sent", scoped.titles.at(-1) === AIM.scopeTitle, JSON.stringify(scoped.titles));
    aimStop(scoped);
    check("letting go overwrites it with the invisible one first", scoped.titles.at(-1) === AIM.scopeOffTitle, JSON.stringify(scoped.titles));
    fake.advance(AIM.scopeClearDelayTicks);
    check("then clears the title", JSON.stringify(scoped.titles) === JSON.stringify([AIM.scopeTitle, AIM.scopeOffTitle, ""]), JSON.stringify(scoped.titles));

    for (const gun of guns.filter((g) => g.id !== "bolt_rifle")) {
        const p = armed(gun, `plain-${gun.id}`);
        aimStart(p); fake.advance(10); aimStop(p); fake.advance(10);
        check(`${gun.id}: no scope title at all`, p.titles.length === 0, JSON.stringify(p.titles));
    }
    done();
});

test("aiming twice, letting go twice, or aiming with something else in hand does nothing extra", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "twice");

    aimStart(p);
    aimStart(p);
    check("two starts, one zoom", p.camera.fovCalls.length === 1, JSON.stringify(p.camera.fovCalls));
    aimStop(p);
    aimStop(p);
    check("two stops, one reset (the game sends both a release and a stop)", p.camera.fovCalls.length === 2, JSON.stringify(p.camera.fovCalls));

    const q = armed(gun, "stick-aimer");
    q.holding = "minecraft:stick";
    aimStart(q); aimStop(q);
    check("another item's aim is not ours", q.camera.fovCalls.length === 0);
    done();
});

test("either event the game sends on letting go ends the aim by itself (it sends a release and a stop)", () => {
    const { check, done } = checks();
    const gun = GUNS.pistol;

    let p = armed(gun, "release-only");
    aimStart(p);
    world.afterEvents.itemReleaseUse.emit({ itemStack: { typeId: gun.itemId }, source: p, useDuration: 23980 });
    check("the release alone resets the view", p.camera.fovCalls.length === 2 && p.camera.fovCalls[1] === undefined, JSON.stringify(p.camera.fovCalls));

    p = armed(gun, "stop-only");
    aimStart(p);
    world.afterEvents.itemStopUse.emit({ itemStack: { typeId: gun.itemId }, source: p, useDuration: 23980 });
    check("the stop alone resets the view", p.camera.fovCalls.length === 2 && p.camera.fovCalls[1] === undefined, JSON.stringify(p.camera.fovCalls));

    p = armed(gun, "stop-without-item");
    aimStart(p);
    world.afterEvents.itemStopUse.emit({ itemStack: undefined, source: p, useDuration: 0 });
    check("a stop with no item named ends nothing and throws nothing", p.camera.fovCalls.length === 1, JSON.stringify(p.camera.fovCalls));
    done();
});

test("switching away while aimed, or dying or leaving, ends the aim without throwing", () => {
    const { check, done } = checks();
    const gun = GUNS.bolt_rifle;

    let p = armed(gun, "switcher");
    aimStart(p);
    p.holding = "minecraft:stick";                             // the hotbar moved on; the game may send no stop
    fake.advance(8);
    check("the zoom is reset", p.camera.fovCalls.at(-1) === undefined && p.camera.fovCalls.length === 2, JSON.stringify(p.camera.fovCalls));
    fake.advance(AIM.scopeClearDelayTicks + 2);
    check("and the scope is switched off", p.titles.at(-1) === "" && p.titles.includes(AIM.scopeOffTitle), JSON.stringify(p.titles));

    p = armed(gun, "leaver");
    aimStart(p);
    p.isValid = false;
    let threw = null;
    try { fake.advance(30); } catch (e) { threw = e; }
    check("a player who leaves mid-aim throws nothing", threw === null, threw ? String(threw) : "");
    done();
});

test("two players aim independently", () => {
    const { check, done } = checks();
    const a = armed(GUNS.revolver, "A");
    const b = fake.makePlayer("B", { location: { x: 5, y: 64, z: 5 }, holding: GUNS.pump_shotgun.itemId });

    aimStart(a); aimStart(b);
    aimStop(a);
    check("A is back to normal", a.camera.fovCalls.at(-1) === undefined);
    check("B is still zoomed", b.camera.fovCalls.length === 1 && b.camera.fovCalls[0].fov === GUNS.pump_shotgun.aim.fov, JSON.stringify(b.camera.fovCalls));
    fake.advance(20);
    check("and stays zoomed while A's aim is over", b.camera.fovCalls.length === 1, JSON.stringify(b.camera.fovCalls));
    aimStop(b);
    check("B is back to normal too", b.camera.fovCalls.at(-1) === undefined);
    done();
});

test("a system reset ends every aim", () => {
    const { check, done } = checks();
    const p = armed(GUNS.bolt_rifle, "resetter");
    aimStart(p);
    resetGuns();
    check("the zoom is reset", p.camera.fovCalls.at(-1) === undefined && p.camera.fovCalls.length === 2, JSON.stringify(p.camera.fovCalls));
    fake.advance(AIM.scopeClearDelayTicks);
    check("the scope is off", p.titles.at(-1) === "");
    done();
});

test("a camera that refuses never breaks aiming or firing, and is reported once", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "refused");
    fake.cameraError = "the camera is busy";

    let threw = null;
    try {
        aimStart(p); leftClick(p); aimStop(p);
        fake.advance(gun.fireRateTicks + 1);
        aimStart(p); leftClick(p); aimStop(p);
    } catch (e) { threw = e; }

    check("nothing is thrown", threw === null, threw ? String(threw) : "");
    check("the shots still fire", heardShot(gun));
    check("reported once each for zoom and reset, not on every aim", warnings.filter((w) => w.startsWith("[aim] zoom failed")).length === 1 && warnings.filter((w) => w.startsWith("[aim] zoom reset failed")).length === 1, warnings.join("|"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Reload: Q
// ---------------------------------------------------------------------------------------------------------

test("Q takes the gun back and reloads it, on foot or on a horse, for every gun", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        for (const riding of [false, true]) {
            const p = armed(gun, `q-${gun.id}-${riding}`, { selectedSlotIndex: 4 });
            if (riding) p.ridingOn = fake.makeEntity({ typeId: "minecraft:horse" });
            emptyMagazine(p, gun);
            overworld().played.length = 0;

            const dropped = pressQ(p);
            const where = `${gun.id}${riding ? " on a horse" : ""}`;
            check(`${where}: the gun is back in the slot it left`, p.container.getItem(4)?.typeId === gun.itemId, String(p.container.getItem(4)?.typeId));
            check(`${where}: the dropped item is gone from the world`, !dropped.isValid);
            check(`${where}: a reload starts`, text(p).includes("Reloading"), text(p));
            fake.advance(gun.reloadTicks + 2);
            check(`${where}: and refills the magazine`, text(p).includes(`${gun.magazineSize}/${gun.magazineSize}`), text(p));
        }
    }
    done();
});

test("Q on a full gun still keeps it, and says it is full", () => {
    const { check, done } = checks();
    const gun = GUNS.pistol;
    const p = armed(gun, "full", { selectedSlotIndex: 2 });
    const dropped = pressQ(p);
    check("kept", p.container.getItem(2)?.typeId === gun.itemId && !dropped.isValid);
    check("told it is full", text(p).includes("Already fully loaded"), text(p));
    done();
});

test("Q puts the gun in another slot when its own is taken, and keeps it on the ground when there is no room", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;

    let p = armed(gun, "taken", { selectedSlotIndex: 0 });   // slot 0 holds the ammo
    let dropped = pressQ(p);
    const found = Array.from({ length: p.container.size }, (_, i) => p.container.getItem(i)).filter((s) => s?.typeId === gun.itemId);
    check("the gun went somewhere else in the inventory", found.length === 1 && !dropped.isValid, `${found.length} in the inventory, dropped valid: ${dropped.isValid}`);

    p = armed(gun, "packed", { selectedSlotIndex: 0 });
    p.container.addItem = () => ({ typeId: gun.itemId, amount: 1 });    // the engine hands back what did not fit
    dropped = pressQ(p);
    check("no room: the drop is left on the ground", dropped.isValid);
    check("and the player is told", /No room/.test(text(p)), text(p));
    check("and no reload starts for a gun that is not in hand", !text(p).includes("Reloading"), text(p));
    done();
});

test("a drop that is not Q is left alone: dying, or dragging the gun out of the inventory screen", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "dragger");
    const stack = fake.makeItemStack(gun.itemId);
    const dropped = fake.makeEntity({ typeId: "minecraft:item", itemStack: stack, location: p.location });

    // The drop and the slot emptying, with no DropItem swing.
    world.afterEvents.entityItemDrop.emit({ entity: p, items: [dropped] });
    world.afterEvents.playerInventoryItemChange.emit({ player: p, slot: 0, itemStack: undefined, beforeItemStack: stack });
    fake.advance(5);

    check("the item stays dropped", dropped.isValid);
    check("no reload", !text(p).includes("Reloading") && !text(p).includes("Already"), text(p));
    check("nothing came back to the inventory", Array.from({ length: p.container.size }, (_, i) => p.container.getItem(i)).every((s) => s?.typeId !== gun.itemId));
    done();
});

test("a DropItem swing alone, or a drop of something that is not a gun, does nothing", () => {
    const { check, done } = checks();
    const gun = GUNS.pistol;

    let p = armed(gun, "swing-only");
    world.afterEvents.playerSwingStart.emit({ swingSource: "DropItem", heldItemStack: fake.makeItemStack(gun.itemId), player: p });
    check("a swing with no drop", !text(p).includes("Reloading") && !text(p).includes("Already"), text(p));

    p = armed(gun, "stick-dropper");
    p.holding = "minecraft:stick";
    const dropped = pressQ(p);
    check("a stick stays dropped", dropped.isValid);
    check("and says nothing", text(p) === "", text(p));
    done();
});

test("the drop and the swing may arrive in either order, and a stale swing from an earlier tick does not count", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;

    let p = armed(gun, "swing-first", { selectedSlotIndex: 3 });
    const stack = fake.makeItemStack(gun.itemId);
    const dropped = fake.makeEntity({ typeId: "minecraft:item", itemStack: stack, location: p.location });
    world.afterEvents.playerSwingStart.emit({ swingSource: "DropItem", heldItemStack: stack, player: p });
    world.afterEvents.playerInventoryItemChange.emit({ player: p, slot: 3, itemStack: undefined, beforeItemStack: stack });
    world.afterEvents.entityItemDrop.emit({ entity: p, items: [dropped] });
    check("swing, slot, drop: still Q", !dropped.isValid && p.container.getItem(3)?.typeId === gun.itemId);

    p = armed(gun, "stale");
    world.afterEvents.playerSwingStart.emit({ swingSource: "DropItem", heldItemStack: fake.makeItemStack(gun.itemId), player: p });
    fake.advance(1);
    const later = fake.makeEntity({ typeId: "minecraft:item", itemStack: fake.makeItemStack(gun.itemId), location: p.location });
    world.afterEvents.entityItemDrop.emit({ entity: p, items: [later] });
    check("a swing one tick earlier does not turn a later drop into Q", later.isValid);
    done();
});

test("two players pressing Q in the same tick are each handled", () => {
    const { check, done } = checks();
    const a = armed(GUNS.revolver, "A", { selectedSlotIndex: 1 });
    const b = fake.makePlayer("B", { location: { x: 9, y: 64, z: 9 }, holding: GUNS.pistol.itemId, selectedSlotIndex: 5 });
    b.giveAmmo(AMMO.handgun_ammo.itemId, 64);

    const da = pressQ(a);
    const db = pressQ(b);
    check("both drops are taken back", !da.isValid && !db.isValid);
    check("each into its own slot", a.container.getItem(1)?.typeId === GUNS.revolver.itemId && b.container.getItem(5)?.typeId === GUNS.pistol.itemId);
    done();
});

test("a reload started by Q is lost, as before, if the player swaps away before it finishes", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;
    const p = armed(gun, "swapper");
    emptyMagazine(p, gun);
    pressQ(p);
    p.holding = "minecraft:stick";
    fake.advance(gun.reloadTicks + 5);
    check("no refill", !text(p).includes("reloaded"), text(p));
    done();
});

test("a system reset forgets a half-seen drop", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "forgetful");
    const stack = fake.makeItemStack(gun.itemId);
    const dropped = fake.makeEntity({ typeId: "minecraft:item", itemStack: stack, location: p.location });
    world.afterEvents.entityItemDrop.emit({ entity: p, items: [dropped] });
    resetGuns();
    world.afterEvents.playerSwingStart.emit({ swingSource: "DropItem", heldItemStack: stack, player: p });
    check("the swing after a reset does not complete the old drop", dropped.isValid);
    done();
});

test("the guns file no longer asks for sneaking anywhere", async () => {
    const { check, done } = checks();
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../src/systems/guns.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("no isSneaking in the gun code", !/isSneaking/.test(code));
    check("no advice to sneak in a message", !/[Ss]neak \+ use/.test(code));
    done();
});
