import { test } from "node:test";
import { fake, system, world, load, checks, strip, leftClick, rightClick, pressQ } from "./helpers.mjs";

// The gun controls: left-click fires, right-click toggles the aim (zoom, and a scope for the bolt rifle), Q reloads and
// so does clicking an empty gun. Every event sequence here is the one the real game sent (content log, 2026-09-20:
// docs/test-cards/AIM-SPIKE.md), in the same order. Nothing in it depends on sneaking, which a horse takes.

const { GUNS, AMMO, GATLING_AIM_PITCH_PROPERTY, GATLING_BARREL_SPIN_PROPERTY } = await load("config/guns.js");
const { AIM } = await load("config/balance.js");
await load("systems/guns.js");
const { listSystems } = await load("core/registry.js");

const guns = Object.values(GUNS);
// The Gatling gun is never held to fire (it's placed, then ridden) — every "for every gun" test in this
// file that exercises the held-item fire/aim/reload controls means "every gun you carry", so it excludes
// this one. Its own controls (place, mount, fire while ridden) have dedicated tests further down.
const heldGuns = guns.filter((gun) => !gun.automatic);
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
    for (let i = 0; i < gun.magazineSize; i++) {
        leftClick(p); fake.advance(gun.fireRateTicks);
        if (gun.primeTicks !== undefined) { leftClick(p); fake.advance(gun.primeTicks); }   // the prime click between shots, so this really does fire magazineSize times
    }
    fake.advance(gun.reloadTicks + 60);
    overworld().played.length = 0; p.messages.length = 0;
};

// ---------------------------------------------------------------------------------------------------------
// Fire: left-click
// ---------------------------------------------------------------------------------------------------------

test("left-click fires every gun: at the air or a mob (Attack) and at a block (Mine), on foot or on a horse", () => {
    const { check, done } = checks();
    for (const gun of heldGuns) {
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

test("a right-click never fires: it only aims", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        const p = armed(gun, `aimnofire-${gun.id}`);
        rightClick(p);
        fake.advance(20);
        rightClick(p);
        check(`${gun.id}: two right-clicks fire no shot`, !heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
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
// Priming: the revolver and the repeater (semi_rifle) need their action manually cycled between shots
// (config/guns.ts's primeTicks) -- a click after the shot cycles it instead of firing, and only the click
// after that fires again. Needing two clicks instead of one is what actually slows these two guns down.
// ---------------------------------------------------------------------------------------------------------

const primingGuns = guns.filter((gun) => gun.primeTicks !== undefined);
const heardPrime = (gun) => overworld().played.some((pl) => gun.sounds.prime?.some((cue) => cue.id === pl.id));

test("config: exactly the revolver and the repeater need manual priming, and the semi-auto is now called Repeater", () => {
    const { check, done } = checks();
    check("revolver and semi_rifle have primeTicks; no other gun does", primingGuns.map((g) => g.id).sort().join() === "revolver,semi_rifle", primingGuns.map((g) => g.id).join());
    for (const gun of primingGuns) check(`${gun.id}: has its own priming sound`, gun.sounds.prime !== undefined && gun.sounds.prime.length > 0);
    check("semi_rifle (the old Semi-Auto Rifle) is now called Repeater", GUNS.semi_rifle.displayName === "Repeater", GUNS.semi_rifle.displayName);
    done();
});

test("a manual-priming gun needs a click to cycle the action before the next shot: fire, prime, fire", () => {
    const { check, done } = checks();
    for (const gun of primingGuns) {
        const p = armed(gun, `cycle-${gun.id}`);

        leftClick(p);
        check(`${gun.id}: the first click fires`, heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));

        fake.advance(gun.primeTicks);
        overworld().played.length = 0;
        leftClick(p);
        check(`${gun.id}: the very next click does not fire again`, !heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
        check(`${gun.id}: it plays the priming sound instead`, heardPrime(gun), JSON.stringify(overworld().played.map((x) => x.id)));

        fake.advance(gun.fireRateTicks);
        overworld().played.length = 0;
        leftClick(p);
        check(`${gun.id}: and the click after that fires again`, heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
    }
    done();
});

test("a priming click too soon after the shot is ignored, same as a too-soon fire", () => {
    const { check, done } = checks();
    for (const gun of primingGuns) {
        const p = armed(gun, `too-soon-${gun.id}`);

        leftClick(p);
        overworld().played.length = 0;

        leftClick(p);   // immediately: primeTicks has not elapsed at all yet
        check(`${gun.id}: too soon to cycle it: nothing plays`, overworld().played.length === 0, JSON.stringify(overworld().played.map((x) => x.id)));

        fake.advance(gun.primeTicks);
        leftClick(p);
        check(`${gun.id}: once primeTicks has actually passed, the same click cycles it`, heardPrime(gun), JSON.stringify(overworld().played.map((x) => x.id)));
    }
    done();
});

test("reloading a gun that needs priming leaves it ready to fire at once, not still needing a cycle", () => {
    const { check, done } = checks();
    for (const gun of primingGuns) {
        const p = armed(gun, `reload-primed-${gun.id}`);

        leftClick(p);   // now needs priming
        check(`${gun.id}: (setup) fired once`, heardShot(gun));

        pressQ(p);
        check(`${gun.id}: (setup) a reload starts`, text(p).includes("Reloading"), text(p));
        fake.advance(gun.reloadTicks + 2);
        overworld().played.length = 0;

        leftClick(p);
        check(`${gun.id}: the first click after the reload fires; it is not spent on a leftover prime`, heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
    }
    done();
});

test("a system reset clears a pending prime: the next click fires instead of cycling", () => {
    const { check, done } = checks();
    for (const gun of primingGuns) {
        const p = armed(gun, `reset-primed-${gun.id}`);

        leftClick(p);   // now needs priming
        check(`${gun.id}: (setup) fired once`, heardShot(gun));

        resetGuns();
        overworld().played.length = 0;

        leftClick(p);
        check(`${gun.id}: fires right away after a reset, rather than cycling first`, heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Auto-reload
// ---------------------------------------------------------------------------------------------------------

test("clicking an empty gun clicks, tells nothing about keys, and reloads by itself", () => {
    const { check, done } = checks();
    for (const gun of heldGuns) {
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

// Right-click TOGGLES the aim; it is not a hold. While an item is in use the game sends no attack input (as with a
// drawn bow), so a held aim could never fire. The owner found this the first time they shot through a scope.

test("a right-click toggles the aim: the first zooms to the gun's field of view, the second puts the view back", () => {
    const { check, done } = checks();
    for (const gun of heldGuns) {
        const p = armed(gun, `zoom-${gun.id}`);
        rightClick(p);
        check(`${gun.id}: zoomed to ${gun.aim.fov}, eased`, p.camera.fovCalls.length === 1 && p.camera.fovCalls[0].fov === gun.aim.fov && p.camera.fovCalls[0].easeOptions.easeTime === AIM.fovEaseSeconds, JSON.stringify(p.camera.fovCalls));
        fake.advance(40);
        check(`${gun.id}: the aim stays on with nothing held down`, p.camera.fovCalls.length === 1, JSON.stringify(p.camera.fovCalls));
        rightClick(p);
        check(`${gun.id}: the second click resets the view`, p.camera.fovCalls.length === 2 && p.camera.fovCalls[1] === undefined, JSON.stringify(p.camera.fovCalls));
        rightClick(p);
        check(`${gun.id}: and the third aims again`, p.camera.fovCalls.length === 3 && p.camera.fovCalls[2].fov === gun.aim.fov, JSON.stringify(p.camera.fovCalls));
    }
    done();
});

test("you can fire while aimed, again and again, and the aim stays on (the reason it is a toggle)", () => {
    const { check, done } = checks();
    // Guns with more than one round: the second click is a shot. (The bolt rifle holds one, so its second click is an auto-reload; below.)
    for (const gun of [GUNS.revolver, GUNS.semi_rifle, GUNS.pump_shotgun]) {
        const p = armed(gun, `aimed-fire-${gun.id}`);
        rightClick(p);
        const titles = p.titles.length;
        leftClick(p);
        check(`${gun.id}: a click while aimed fires`, heardShot(gun), JSON.stringify(overworld().played.map((x) => x.id)));
        fake.advance(gun.fireRateTicks);
        if (gun.primeTicks !== undefined) { leftClick(p); fake.advance(gun.primeTicks); }   // a manual-action gun needs this prime click before it can fire again
        overworld().played.length = 0;
        leftClick(p);
        check(`${gun.id}: and again`, heardShot(gun));
        check(`${gun.id}: the aim was not touched by the shots`, p.camera.fovCalls.length === 1 && p.titles.length === titles, `${JSON.stringify(p.camera.fovCalls)} ${JSON.stringify(p.titles)}`);
        rightClick(p);
        check(`${gun.id}: the next right-click ends it`, p.camera.fovCalls.at(-1) === undefined);
    }
    done();
});

test("the bolt rifle fires through its scope and the scope stays up, then reloads by itself", () => {
    const { check, done } = checks();
    const gun = GUNS.bolt_rifle;
    const p = armed(gun, "scoped-shot");
    rightClick(p);
    leftClick(p);
    check("the shot is fired while scoped", heardShot(gun));
    check("the scope is still up (only the scope title was sent)", JSON.stringify(p.titles) === JSON.stringify([AIM.scopeTitle]), JSON.stringify(p.titles));
    check("and the zoom was not reset", p.camera.fovCalls.length === 1, JSON.stringify(p.camera.fovCalls));
    fake.advance(gun.fireRateTicks);
    leftClick(p);
    check("the next click, with the chamber empty, reloads by itself and still stays scoped", text(p).includes("Reloading") && p.camera.fovCalls.length === 1, text(p));
    fake.advance(gun.reloadTicks + 2);
    overworld().played.length = 0;
    leftClick(p);
    check("and fires again after it", heardShot(gun));
    done();
});

test("every gun's zoom is inside the range the engine accepts and zooms in; the bolt rifle zooms furthest", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        check(`${gun.id}: fov ${gun.aim.fov} is inside ${AIM.fovMin}..${AIM.fovMax} (the engine refuses anything else)`, gun.aim.fov >= AIM.fovMin && gun.aim.fov <= AIM.fovMax);
        check(`${gun.id}: it is a zoom (the normal view is about 70)`, gun.aim.fov < 70);
    }
    const others = guns.filter((g) => g.id !== "bolt_rifle");
    check("the bolt rifle zooms further than any other gun", others.every((g) => GUNS.bolt_rifle.aim.fov < g.aim.fov));
    check("only the bolt rifle has a scope", guns.filter((g) => g.aim.scope).map((g) => g.id).join() === "bolt_rifle", guns.filter((g) => g.aim.scope).map((g) => g.id).join());
    done();
});

test("a zoom outside the engine's range is clamped into it instead of being refused", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const original = gun.aim.fov;
    try {
        gun.aim.fov = 10;
        let p = armed(gun, "too-close");
        rightClick(p);
        check("below the range: the minimum", p.camera.fovCalls[0]?.fov === AIM.fovMin, JSON.stringify(p.camera.fovCalls));

        gun.aim.fov = 300;
        p = armed(gun, "too-far");
        rightClick(p);
        check("above the range: the maximum", p.camera.fovCalls[0]?.fov === AIM.fovMax, JSON.stringify(p.camera.fovCalls));
        check("and nothing is reported as a failure", warnings.length === 0, warnings.join("|"));
    } finally { gun.aim.fov = original; }
    done();
});

test("the bolt rifle shows the scope while aimed and switches it off properly; the other guns show none", () => {
    const { check, done } = checks();

    const scoped = armed(GUNS.bolt_rifle, "sniper");
    rightClick(scoped);
    check("the scope title is sent", scoped.titles.at(-1) === AIM.scopeTitle, JSON.stringify(scoped.titles));
    rightClick(scoped);
    check("aiming down overwrites it with the invisible one first", scoped.titles.at(-1) === AIM.scopeOffTitle, JSON.stringify(scoped.titles));
    fake.advance(AIM.scopeClearDelayTicks);
    check("then clears the title", JSON.stringify(scoped.titles) === JSON.stringify([AIM.scopeTitle, AIM.scopeOffTitle, ""]), JSON.stringify(scoped.titles));

    for (const gun of guns.filter((g) => g.id !== "bolt_rifle")) {
        const p = armed(gun, `plain-${gun.id}`);
        rightClick(p); fake.advance(10); rightClick(p); fake.advance(10);
        check(`${gun.id}: no scope title at all`, p.titles.length === 0, JSON.stringify(p.titles));
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// GUN-07 spike: the hit-marker overlay shares the scope's one title channel (core/aim.ts's flashHitMarker),
// since a per-player custom property to bind a HUD image to isn't available (only an entity this addon's own
// behavior pack defines can declare one — never the vanilla player). A landed projectile hit is the trigger
// here (the hitscan path is already covered in guns-pellets.test.mjs); fire for real so the bullet entity's
// own gunId dynamic property is genuine, then simulate the hit the fake world doesn't do on its own.
// ---------------------------------------------------------------------------------------------------------

/** Fires `gun` for real (a genuine bullet, with its gunId set exactly as fireProjectile sets it), then
 *  simulates that bullet landing on `target` — the fake world has no real projectile physics. */
function fireAndHit(p, gun, target) {
    const dim = overworld();
    leftClick(p);
    const bullet = dim.spawned.at(-1);
    world.afterEvents.projectileHitEntity.emit({ projectile: bullet, getEntityHit: () => ({ entity: target }), source: p });
}

test("a landed hit flashes the hit-marker title and clears it properly, when the shooter wasn't aiming", () => {
    const { check, done } = checks();
    const gun = GUNS.pistol;
    const p = armed(gun, "unaimed-hitter");
    const target = fake.makeEntity({ typeId: "minecraft:pillager" });

    fireAndHit(p, gun, target);
    check("the hit-marker title is sent", p.titles.at(-1) === AIM.hitMarkerTitle, JSON.stringify(p.titles));

    fake.advance(AIM.hitMarkerFlashTicks);
    check("overwritten with the invisible one first, same as hideScope's own clear", p.titles.at(-1) === AIM.scopeOffTitle, JSON.stringify(p.titles));

    fake.advance(AIM.scopeClearDelayTicks);
    check("then properly cleared, not left stuck on the flash", JSON.stringify(p.titles) === JSON.stringify([AIM.hitMarkerTitle, AIM.scopeOffTitle, ""]), JSON.stringify(p.titles));
    done();
});

test("a landed hit while scoped flashes the hit-marker, then restores the scope instead of clearing it", () => {
    const { check, done } = checks();
    const gun = GUNS.bolt_rifle;
    const p = armed(gun, "scoped-hitter");
    const target = fake.makeEntity({ typeId: "minecraft:pillager" });

    rightClick(p);   // aims with the scope on
    check("(setup) scoped", p.titles.at(-1) === AIM.scopeTitle, JSON.stringify(p.titles));

    fireAndHit(p, gun, target);
    check("the hit-marker title interrupts the scope", p.titles.at(-1) === AIM.hitMarkerTitle, JSON.stringify(p.titles));

    fake.advance(AIM.hitMarkerFlashTicks);   // the flash's own duration
    check("the scope switch comes back, not a clear", p.titles.at(-1) === AIM.scopeTitle, JSON.stringify(p.titles));

    fake.advance(50);
    check("and the scope stays up (it wasn't a one-off re-show)", p.titles.at(-1) === AIM.scopeTitle, JSON.stringify(p.titles));
    done();
});

test("aiming slows the player for as long as it lasts, by the gun's amount, and stops when it ends", () => {
    const { check, done } = checks();

    const sniper = armed(GUNS.bolt_rifle, "slow-sniper");
    rightClick(sniper);
    const first = sniper.effects.filter((e) => e.id === "slowness");
    check("slowness at once, at the gun's amplifier, with no particles", first.length === 1 && first[0].amplifier === GUNS.bolt_rifle.aim.slowness && first[0].showParticles === false && first[0].duration === AIM.slowEffectTicks, JSON.stringify(first));
    fake.advance(12);
    check("refreshed while the aim lasts (every 4 ticks)", sniper.effects.filter((e) => e.id === "slowness").length === 4, String(sniper.effects.filter((e) => e.id === "slowness").length));
    check("and the refresh outlasts the gap between refreshes", AIM.slowEffectTicks > 4);
    rightClick(sniper);
    const count = sniper.effects.length;
    fake.advance(20);
    check("no more once it ends", sniper.effects.length === count, `${count} -> ${sniper.effects.length}`);

    const revolver = armed(GUNS.revolver, "quick");
    rightClick(revolver); fake.advance(12);
    check("a gun with no slowness setting slows nobody", revolver.effects.length === 0, JSON.stringify(revolver.effects));

    check("the scoped rifle slows most", GUNS.bolt_rifle.aim.slowness > GUNS.pump_shotgun.aim.slowness && GUNS.pump_shotgun.aim.slowness >= 0);
    done();
});

test("a failing slowdown never breaks aiming or firing, and is reported once", () => {
    const { check, done } = checks();
    const gun = GUNS.bolt_rifle;
    const p = armed(gun, "no-slow");
    p.addEffect = () => { throw new Error("no such effect"); };

    let threw = null;
    try { rightClick(p); leftClick(p); fake.advance(20); rightClick(p); } catch (e) { threw = e; }

    check("nothing is thrown", threw === null, threw ? String(threw) : "");
    check("the shot still fired and the zoom still worked", heardShot(gun) && p.camera.fovCalls.length === 2, JSON.stringify(p.camera.fovCalls));
    check("reported once", warnings.filter((w) => w.startsWith("[aim] slowing the player failed")).length === 1, warnings.join("|"));
    done();
});

test("a right-click with something else in hand does not aim", () => {
    const { check, done } = checks();
    const p = armed(GUNS.revolver, "stick-aimer");
    p.holding = "minecraft:stick";
    rightClick(p);
    check("no zoom", p.camera.fovCalls.length === 0);
    done();
});

test("switching away while aimed, or dying or leaving, ends the aim without throwing", () => {
    const { check, done } = checks();
    const gun = GUNS.bolt_rifle;

    let p = armed(gun, "switcher");
    rightClick(p);
    p.holding = "minecraft:stick";                             // the hotbar moved on; nothing tells a script
    fake.advance(8);
    check("the zoom is reset", p.camera.fovCalls.at(-1) === undefined && p.camera.fovCalls.length === 2, JSON.stringify(p.camera.fovCalls));
    fake.advance(AIM.scopeClearDelayTicks + 2);
    check("and the scope is switched off", p.titles.at(-1) === "" && p.titles.includes(AIM.scopeOffTitle), JSON.stringify(p.titles));

    p = armed(gun, "leaver");
    rightClick(p);
    p.isValid = false;
    let threw = null;
    try { fake.advance(30); } catch (e) { threw = e; }
    check("a player who leaves mid-aim throws nothing", threw === null, threw ? String(threw) : "");

    p = armed(GUNS.revolver, "hopper");
    rightClick(p);
    p.holding = GUNS.pistol.itemId;                            // to another gun: still an end to this aim
    fake.advance(8);
    check("moving to another gun ends the aim too", p.camera.fovCalls.at(-1) === undefined);
    rightClick(p);
    check("and the next click aims with the new gun", p.camera.fovCalls.at(-1)?.fov === GUNS.pistol.aim.fov, JSON.stringify(p.camera.fovCalls));
    done();
});

test("two players aim independently", () => {
    const { check, done } = checks();
    const a = armed(GUNS.revolver, "A");
    const b = fake.makePlayer("B", { location: { x: 5, y: 64, z: 5 }, holding: GUNS.pump_shotgun.itemId });

    rightClick(a); rightClick(b);
    rightClick(a);
    check("A is back to normal", a.camera.fovCalls.at(-1) === undefined);
    check("B is still zoomed", b.camera.fovCalls.length === 1 && b.camera.fovCalls[0].fov === GUNS.pump_shotgun.aim.fov, JSON.stringify(b.camera.fovCalls));
    fake.advance(20);
    check("and stays zoomed while A's aim is over", b.camera.fovCalls.length === 1, JSON.stringify(b.camera.fovCalls));
    rightClick(b);
    check("B is back to normal too", b.camera.fovCalls.at(-1) === undefined);
    done();
});

test("a system reset ends every aim", () => {
    const { check, done } = checks();
    const p = armed(GUNS.bolt_rifle, "resetter");
    rightClick(p);
    resetGuns();
    check("the zoom is reset", p.camera.fovCalls.at(-1) === undefined && p.camera.fovCalls.length === 2, JSON.stringify(p.camera.fovCalls));
    fake.advance(AIM.scopeClearDelayTicks);
    check("the scope is off", p.titles.at(-1) === "");
    rightClick(p);
    check("and the next click aims afresh", p.camera.fovCalls.at(-1)?.fov === GUNS.bolt_rifle.aim.fov);
    done();
});

test("a camera that refuses never breaks aiming or firing, and is reported once", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "refused");
    fake.cameraError = "the camera is busy";

    let threw = null;
    try {
        rightClick(p); leftClick(p); rightClick(p);
        fake.advance(gun.fireRateTicks + 1);
        rightClick(p); leftClick(p); rightClick(p);
    } catch (e) { threw = e; }

    check("nothing is thrown", threw === null, threw ? String(threw) : "");
    check("the shots still fire", heardShot(gun));
    check("reported once each for zoom, reset and the shot's own recoil shake, not on every attempt", warnings.filter((w) => w.startsWith("[aim] zoom failed")).length === 1 && warnings.filter((w) => w.startsWith("[aim] zoom reset failed")).length === 1 && warnings.filter((w) => w.startsWith("[aim] shake failed")).length === 1, warnings.join("|"));
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Reload: Q
// ---------------------------------------------------------------------------------------------------------

test("Q takes the gun back and reloads it, on foot or on a horse, for every gun", () => {
    const { check, done } = checks();
    for (const gun of heldGuns) {
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

test("a drop event with no items, or items that are not a normal array, throws nothing (once, in the real game, items was not iterable)", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "odd-drop", { selectedSlotIndex: 2 });

    let threw = null;
    try {
        for (const items of [undefined, null, 5, {}, "text"]) world.afterEvents.entityItemDrop.emit({ entity: p, items });
    } catch (e) { threw = e; }
    check("none of them throws", threw === null, threw ? String(threw) : "");
    check("and none of them does anything", text(p) === "", text(p));

    // An array-like list of the items (a length and indexes) is still read, so a real Q in that shape still works.
    const stack = fake.makeItemStack(gun.itemId);
    const dropped = fake.makeEntity({ typeId: "minecraft:item", itemStack: stack, location: p.location });
    world.afterEvents.entityItemDrop.emit({ entity: p, items: { length: 1, 0: dropped } });
    world.afterEvents.playerInventoryItemChange.emit({ player: p, slot: 2, itemStack: undefined, beforeItemStack: stack });
    world.afterEvents.playerSwingStart.emit({ swingSource: "DropItem", heldItemStack: stack, player: p });
    check("an array-like list of items still counts as a Q", !dropped.isValid && p.container.getItem(2)?.typeId === gun.itemId);
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

// ---------------------------------------------------------------------------------------------------------
// GUN-09: the ammo/reload readout. Chat was too slow to read in a fight, so this reads the same loaded-
// rounds/reload state the chat lines already track and posts it to the action bar instead (core/ui.ts),
// refreshed every few ticks the way compass.ts's own readout already is.
// ---------------------------------------------------------------------------------------------------------

const ammoLine = (p) => p.actionBar.filter((line) => /\d+\/\d+|Reloading/.test(line)).at(-1);

test("holding a gun posts its name and loaded/max to the action bar, for every held gun", () => {
    const { check, done } = checks();
    for (const gun of heldGuns) {
        const p = armed(gun);
        const line = ammoLine(p);
        check(`${gun.id}: a readout line was posted`, line !== undefined, JSON.stringify(p.actionBar));
        check(`${gun.id}: shows the gun's name and a full magazine`, line?.includes(gun.displayName) && line?.includes(`${gun.magazineSize}/${gun.magazineSize}`), line);
    }
    done();
});

test("firing drops the loaded count shown, and reloading shows a countdown that reaches the full count again", () => {
    const { check, done } = checks();
    const gun = GUNS.pistol;   // no priming, simplest case
    const p = armed(gun);

    leftClick(p);
    fake.advance(8);   // (n+1)*everyTicks for the readout's own 4-tick cadence: guarantees it ran regardless of phase
    check("down by one after firing", ammoLine(p)?.includes(`${gun.magazineSize - 1}/${gun.magazineSize}`), ammoLine(p));

    pressQ(p);
    fake.advance(8);
    const duringReload = ammoLine(p);
    check("shows a reloading line, not a plain count, while reloading", duringReload?.includes("Reloading") && duringReload?.includes(gun.displayName), duringReload);

    fake.advance(gun.reloadTicks + 8);
    check("back to a full magazine once the reload actually finishes", ammoLine(p)?.includes(`${gun.magazineSize}/${gun.magazineSize}`), ammoLine(p));
    done();
});

test("nothing is posted for a player holding something that isn't a gun", () => {
    const { check, done } = checks();
    fake.reset();
    resetGuns();
    const p = fake.makePlayer("Bystander", { holding: "minecraft:stick", location: { x: 1, y: 64, z: 2 } });
    fake.advance(20);
    check("no ammo/reload line for a non-gun item", ammoLine(p) === undefined, JSON.stringify(p.actionBar));
    done();
});

test("the readout never throws for a player who becomes invalid between ticks", () => {
    const { check, done } = checks();
    const p = armed(GUNS.pistol);
    p.isValid = false;   // the player disconnects while still "holding" the gun as far as the fake knows
    let threw = null;
    try { fake.advance(50); } catch (e) { threw = e; }
    check("nothing thrown", threw === null, threw ? String(threw) : "");
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The Gatling gun: placed, then ridden, rather than held and fired directly like every other gun. A swing
// while riding it TOGGLES a self-sustaining fire loop (no held-button signal exists for a swing in this
// engine — confirmed in a real playtest that holding doesn't even repeat it), rather than firing once per
// swing like every other gun: one click starts it, it fires and reschedules itself on its own, accelerating,
// until a second click, an empty magazine, or a dismount stops it.
// ---------------------------------------------------------------------------------------------------------

const GATLING = GUNS.gatling_gun;
const FIRE_ID = GATLING.sounds.fire[0].id;
const shotsFired = () => overworld().played.filter((pl) => pl.id === FIRE_ID);

/** A generous upper bound on the ticks a full n-shot burst could possibly take: every real delay in the
 *  ramp is at most fireRateTicksStart, so this many ticks always leaves time for at least n shots. */
const ticksFor = (n) => GATLING.automatic.fireRateTicksStart * n;

/** A player already manning a placed Gatling gun: riding its mount, never holding the item, ammo in reserve. */
function manned(name = "Gunner") {
    fake.reset();
    resetGuns();
    const p = fake.makePlayer(name, { location: { x: 1, y: 64, z: 2 } });
    p.giveAmmo(AMMO[GATLING.ammo].itemId, 400);
    p.ridingOn = fake.makeEntity({ typeId: GATLING.automatic.mountEntityId });
    fake.advance(200);
    overworld().played.length = 0;
    return p;
}

test("right-clicking it plants it where you're looking, facing the way you were, and takes it out of your hand", () => {
    const { check, done } = checks();
    const p = armed(GATLING, "placer", { selectedSlotIndex: 0 });
    p.container.setItem(0, fake.makeItemStack(GATLING.itemId));   // the fake's `holding` drives the swing/aim logic; placement itself reads and clears the real slot
    p.setRotation({ x: 0, y: 123 });

    const dim = overworld();
    const originalRay = dim.getBlockFromRay;
    dim.getBlockFromRay = () => ({ block: { location: { x: 5, y: 63, z: 5 } }, faceLocation: { x: 0.5, y: 1, z: 0.5 } });

    try {
        rightClick(p);

        const placed = dim.getEntities({ type: GATLING.automatic.mountEntityId });
        check("one placed", placed.length === 1, String(placed.length));
        check("at the spot the raycast found", placed[0]?.location.x === 5.5 && placed[0]?.location.y === 64 && placed[0]?.location.z === 5.5, JSON.stringify(placed[0]?.location));
        check("facing the way the placer was facing", placed[0]?.getRotation().y === 123, JSON.stringify(placed[0]?.getRotation()));
        check("gone from the slot it was placed from (max_stack_size 1: never a stack to shrink)", p.container.getItem(0) === undefined, String(p.container.getItem(0)?.typeId));
    } finally {
        dim.getBlockFromRay = originalRay;
    }
    done();
});

test("nothing in range to place it on: told so, and it stays in hand", () => {
    const { check, done } = checks();
    const p = armed(GATLING, "nowhere", { selectedSlotIndex: 0 });
    p.container.setItem(0, fake.makeItemStack(GATLING.itemId));

    const dim = overworld();
    const originalRay = dim.getBlockFromRay;
    dim.getBlockFromRay = () => undefined;

    try {
        rightClick(p);
        check("told nothing was in range", /nothing in range/i.test(text(p)), text(p));
        check("nothing placed", dim.getEntities({ type: GATLING.automatic.mountEntityId }).length === 0);
        check("still in the slot", p.container.getItem(0)?.typeId === GATLING.itemId, String(p.container.getItem(0)?.typeId));
    } finally {
        dim.getBlockFromRay = originalRay;
    }
    done();
});

test("holding it and clicking does nothing: it only fires once it's placed and ridden", () => {
    const { check, done } = checks();
    const p = armed(GATLING, "holder");
    leftClick(p);
    fake.advance(20);
    check("no shot", shotsFired().length === 0, JSON.stringify(overworld().played));
    done();
});

test("one click starts it firing on its own, accelerating with no further clicks, until a second click stops it", () => {
    const { check, done } = checks();
    const p = manned();

    leftClick(p);
    check("the first click fires at once", shotsFired().length === 1, JSON.stringify(overworld().played.map((x) => x.id)));

    // No more clicks at all from here: if it only fired once, this proves it, and if it kept going, this is
    // long enough for well past a full spin-up's worth of shots.
    fake.advance(ticksFor(GATLING.automatic.spinUpShots + 3));
    const shots = shotsFired();
    check("it kept firing well past the first click, with no further input at all", shots.length >= GATLING.automatic.spinUpShots, String(shots.length));
    check("later shots are pitched higher than the first (the ramp is real, not a fixed rate)", shots.at(-1).pitch > shots[0].pitch, JSON.stringify(shots.map((s) => s.pitch)));

    leftClick(p);   // the second click stops it
    const countAtToggleOff = overworld().played.length;
    fake.advance(200);
    check("stopped: nothing more plays after the toggle-off click", overworld().played.length === countAtToggleOff, `${countAtToggleOff} -> ${overworld().played.length}`);
    done();
});

test("running dry stops the loop and starts a reload on its own; firing needs a fresh click once it's full again", () => {
    const { check, done } = checks();
    const p = manned();

    leftClick(p);
    fake.advance(ticksFor(GATLING.magazineSize + GATLING.automatic.spinUpShots + 5));   // the whole magazine, burned through on its own

    check("it starts a reload once the magazine actually empties on its own", text(p).includes("Reloading"), text(p));
    check("exactly one dry click (the loop stops itself; it doesn't keep dry-clicking)", p.privateSounds.filter((s) => s.id === "random.click").length === 1, String(p.privateSounds.length));

    overworld().played.length = 0;
    fake.advance(GATLING.reloadTicks + 5);
    check("it actually refills (the reload finishes for a ridden gun, not just a held one)", text(p).includes(`${GATLING.magazineSize}/${GATLING.magazineSize}`), text(p));
    check("nothing fires on its own just because the reload finished", shotsFired().length === 0, JSON.stringify(overworld().played));

    leftClick(p);
    check("a fresh click after reloading starts it again", shotsFired().length === 1);
    done();
});

test("dismounting mid-reload doesn't finish it (same rule as swapping away from a held gun)", () => {
    const { check, done } = checks();
    const originalMagazine = GATLING.magazineSize;
    try {
        // A magazine of 1 empties, and so starts a reload, predictably right after the first shot — draining
        // a real 90-round one first would risk the 100-tick reload finishing before the dismount below ever
        // runs, since the drain itself takes many hundreds of ticks.
        GATLING.magazineSize = 1;
        const p = manned();
        leftClick(p);
        fake.advance(ticksFor(2));
        check("(setup) a reload is in progress", text(p).includes("Reloading"), text(p));

        p.ridingOn = undefined;   // dismounted mid-reload
        fake.advance(GATLING.reloadTicks + 5);
        check("no refill", !text(p).includes("reloaded"), text(p));
    } finally {
        GATLING.magazineSize = originalMagazine;
    }
    done();
});

test("dismounting mid-burst stops the loop: it won't keep firing into empty air on its own forever", () => {
    const { check, done } = checks();
    const p = manned();
    leftClick(p);
    fake.advance(20);
    check("(setup) it's actually firing", shotsFired().length > 0);

    const countAtDismount = overworld().played.length;
    p.ridingOn = undefined;
    fake.advance(200);
    check("nothing more plays after dismounting", overworld().played.length === countAtDismount, `${countAtDismount} -> ${overworld().played.length}`);
    done();
});

test("a system reset stops the fire loop outright: the next click starts a fresh one, not a continuation", () => {
    const { check, done } = checks();
    const p = manned();
    leftClick(p);
    fake.advance(20);   // a burst is well underway

    resetGuns();
    const countAtReset = overworld().played.length;
    fake.advance(200);   // if the old loop's own scheduled step were still pending, it would fire into this window
    check("the old loop is really gone: nothing more plays just from time passing after the reset", overworld().played.length === countAtReset, `${countAtReset} -> ${overworld().played.length}`);

    overworld().played.length = 0;
    leftClick(p);
    check("a fresh click starts it again from scratch", shotsFired().length === 1);
    done();
});

test("a manned gun turns to follow whoever is riding it, in yaw and pitch, every tick", () => {
    const { check, done } = checks();
    const p = manned();
    const mount = p.ridingOn;

    p.setRotation({ x: 15, y: 200 });
    fake.advance(1);
    check("yaw follows the rider", mount.getRotation().y === 200, JSON.stringify(mount.getRotation()));
    check("the pitch property follows the rider", mount.getProperty(GATLING_AIM_PITCH_PROPERTY) === 15, String(mount.getProperty(GATLING_AIM_PITCH_PROPERTY)));

    p.setRotation({ x: -40, y: 10 });
    fake.advance(1);
    check("keeps updating as they keep looking around", mount.getRotation().y === 10 && mount.getProperty(GATLING_AIM_PITCH_PROPERTY) === -40, JSON.stringify({ yaw: mount.getRotation().y, pitch: mount.getProperty(GATLING_AIM_PITCH_PROPERTY) }));
    done();
});

test("aim tracking stops cleanly once the rider dismounts, no error", () => {
    const { check, done } = checks();
    const p = manned();
    p.ridingOn = undefined;
    let threw = null;
    try { fake.advance(5); } catch (e) { threw = e; }
    check("nothing thrown", threw === null, threw ? String(threw) : "");
    done();
});

/** The forward rotation from `prev` to `next`, correct even across a 360 -> 0 wrap, as long as the real
 *  per-tick step is well under 180 degrees (true here: spinDegreesSpunUp tops out at 40). */
const wrappedDelta = (next, prev) => ((next - prev) % 360 + 360) % 360;

test("the barrels spin while firing, and the per-tick rate ramps up the same way the fire rate does", () => {
    const { check, done } = checks();
    const p = manned();
    const mount = p.ridingOn;

    leftClick(p);
    const early = mount.getProperty(GATLING_BARREL_SPIN_PROPERTY) ?? 0;
    fake.advance(1);
    const earlyDelta = wrappedDelta(mount.getProperty(GATLING_BARREL_SPIN_PROPERTY), early);
    check("spinning from the very first tick of firing", earlyDelta > 0, String(earlyDelta));

    fake.advance(ticksFor(GATLING.automatic.spinUpShots + 3));   // well into the spun-up part of the burst
    const late = mount.getProperty(GATLING_BARREL_SPIN_PROPERTY);
    fake.advance(1);
    const lateDelta = wrappedDelta(mount.getProperty(GATLING_BARREL_SPIN_PROPERTY), late);

    check("(setup) actually spun up (well past spinUpShots by now)", shotsFired().length > GATLING.automatic.spinUpShots, String(shotsFired().length));
    check("later ticks turn the barrels faster than the first tick, same ramp as the fire rate", lateDelta > earlyDelta, `${earlyDelta} -> ${lateDelta}`);
    done();
});

test("the barrel-spin property stays within [0, 360) even after many full turns' worth of firing", () => {
    const { check, done } = checks();
    const p = manned();
    const mount = p.ridingOn;

    leftClick(p);
    fake.advance(ticksFor(GATLING.magazineSize + GATLING.automatic.spinUpShots + 5));   // the whole magazine, several turns' worth of spin at this rate

    const synced = mount.getProperty(GATLING_BARREL_SPIN_PROPERTY);
    check("wrapped into [0, 360), not left to grow unbounded (setProperty throws outside a property's declared range in the real game)", typeof synced === "number" && synced >= 0 && synced < 360, String(synced));
    done();
});

test("the barrels stop advancing once firing stops, coasting to a halt instead of snapping back to 0", () => {
    const { check, done } = checks();
    const p = manned();
    const mount = p.ridingOn;

    leftClick(p);
    fake.advance(ticksFor(5));
    leftClick(p);   // the second click stops the loop
    const stoppedAt = mount.getProperty(GATLING_BARREL_SPIN_PROPERTY);
    check("(setup) it had actually spun somewhere before stopping", typeof stoppedAt === "number" && stoppedAt > 0, String(stoppedAt));

    fake.advance(50);   // aim tracking (yaw/pitch) keeps running every tick regardless; only the spin should freeze
    check("frozen exactly where it stopped, not reset to 0 and not still advancing", mount.getProperty(GATLING_BARREL_SPIN_PROPERTY) === stoppedAt, `${stoppedAt} -> ${mount.getProperty(GATLING_BARREL_SPIN_PROPERTY)}`);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// GUN-03: recoil. core/aim.ts's shakeCamera (Camera.addShake) fires on every shot, scaled per gun by
// config/guns.ts's recoil. A shake, not a literal forced view angle -- see core/aim.ts's own doc for why.
// ---------------------------------------------------------------------------------------------------------

test("every held gun shakes the shooter's camera on each shot, matching its own recoil config", () => {
    const { check, done } = checks();
    for (const gun of heldGuns) {
        const p = armed(gun);
        leftClick(p);
        check(`${gun.id}: exactly one shake`, p.camera.shakes.length === 1, String(p.camera.shakes.length));
        const shake = p.camera.shakes[0];
        check(`${gun.id}: rotational, matching the configured intensity and duration`, shake?.type === "Rotational" && shake?.intensity === gun.recoil.intensity && shake?.duration === gun.recoil.duration, JSON.stringify(shake));
    }
    done();
});

test("the Gatling gun shakes the camera on every shot of its own automatic loop too", () => {
    const { check, done } = checks();
    const gun = GUNS.gatling_gun;
    const p = manned();

    leftClick(p);   // starts the self-sustaining loop
    fake.advance(ticksFor(4));

    check("at least a few shakes landed, one per shot fired", p.camera.shakes.length >= 3, String(p.camera.shakes.length));
    check("every one matches the Gatling gun's own (small) recoil value", p.camera.shakes.every((s) => s.type === "Rotational" && s.intensity === gun.recoil.intensity && s.duration === gun.recoil.duration), JSON.stringify(p.camera.shakes));
    done();
});

test("the ammo readout shows while manning the Gatling gun too, not just while holding a gun in hand", () => {
    const { check, done } = checks();
    const p = manned();
    check("a readout line with the Gatling gun's own name and a full magazine", ammoLine(p)?.includes(GATLING.displayName) && ammoLine(p)?.includes(`${GATLING.magazineSize}/${GATLING.magazineSize}`), ammoLine(p));
    done();
});

test("recoil config sanity: every gun's intensity is within the engine's own 0-4 cap, and duration is a real, short amount of time", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        check(`${gun.id}: intensity is positive and at most 4`, gun.recoil.intensity > 0 && gun.recoil.intensity <= 4, String(gun.recoil.intensity));
        check(`${gun.id}: duration is a positive fraction of a second, not a lingering shake`, gun.recoil.duration > 0 && gun.recoil.duration <= 0.5, String(gun.recoil.duration));
    }
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
