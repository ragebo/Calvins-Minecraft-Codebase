import { test } from "node:test";
import { fake, world, load, checks, knownGameSounds } from "./helpers.mjs";

const { GUNS, AMMO } = await load("config/guns.js");
await load("systems/guns.js");
const { listSystems } = await load("core/registry.js");

const guns = Object.values(GUNS);
const overworld = () => fake.dimension("overworld");
const resetGuns = () => listSystems().find((s) => s.name === "guns").reset();
const use = (p) => world.afterEvents.itemUse.emit({ itemStack: { typeId: p.holding }, source: p });

function armed(gun, name = "Deputy") {
    fake.reset();
    resetGuns();
    const p = fake.makePlayer(name, { location: { x: 1, y: 64, z: 2 }, holding: gun.itemId });
    p.giveAmmo(AMMO[gun.ammo].itemId, 64);
    fake.advance(200);
    overworld().played.length = 0;
    return p;
}

function emptyMagazine(p, gun) {
    for (let i = 0; i < gun.magazineSize; i++) { use(p); fake.advance(gun.fireRateTicks); }
    fake.advance(80);
    overworld().played.length = 0; p.messages.length = 0; p.privateSounds.length = 0;
}

test("config: every cue is valid for the engine and the game", (t) => {
    const { check, done } = checks();
    const known = knownGameSounds();
    if (known === null) t.diagnostic("game data not found: skipping the 'id exists in this game build' checks");

    const signatures = new Set();
    for (const gun of guns) {
        const { fire, reload } = gun.sounds;
        check(`${gun.id}: has fire and reload cues`, fire.length >= 1 && reload.length >= 1);
        for (const [phase, cues] of [["fire", fire], ["reload", reload]]) {
            for (const cue of cues) {
                const where = `${gun.id}.${phase} ${cue.id}`;
                if (known !== null) check(`${where}: id exists in this game build`, known.has(cue.id));
                check(`${where}: pitch >= 0.01 (engine throws below)`, cue.pitch >= 0.01);
                check(`${where}: volume >= 0 (engine throws below)`, cue.volume >= 0);
                check(`${where}: delay is a whole number of ticks`, cue.delayTicks === undefined || (Number.isInteger(cue.delayTicks) && cue.delayTicks >= 1));
            }
        }
        check(`${gun.id}: reload cues land before the reload finishes`, reload.every((c) => (c.delayTicks ?? 0) < gun.reloadTicks));
        check(`${gun.id}: fire cues finish before the next shot is allowed`, fire.every((c) => (c.delayTicks ?? 0) < gun.fireRateTicks));
        signatures.add(JSON.stringify(fire));
    }
    check("each gun has its own distinct firing sound", signatures.size === guns.length);
    done();
});

test("firing plays each gun's cues on schedule, at the shooter, with the configured volume and pitch", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        const p = armed(gun, `fire-${gun.id}`);
        const t0 = fake.tick;
        use(p);
        fake.advance(60);

        const played = overworld().played;
        const onSchedule = gun.sounds.fire.every((c) => played.some((pl) =>
            pl.id === c.id && pl.volume === c.volume && pl.pitch === c.pitch && pl.tick === t0 + (c.delayTicks ?? 0)));
        check(`${gun.id}: every fire cue plays on its scheduled tick`, onSchedule, JSON.stringify(played.map((x) => `${x.id}@${x.tick - t0}`)));
        check(`${gun.id}: nothing extra plays`, played.length === gun.sounds.fire.length, `(${played.length} played, ${gun.sounds.fire.length} configured)`);
        check(`${gun.id}: played at the shooter's position`, played.every((pl) => pl.location.x === 1 && pl.location.y === 64 && pl.location.z === 2));
        check(`${gun.id}: never plays the old bow placeholder`, !played.some((pl) => pl.id === "random.bow"));
    }
    done();
});

test("an empty gun clicks privately and plays nothing to the world", () => {
    const gun = GUNS.revolver;
    const p = armed(gun);
    emptyMagazine(p, gun);
    use(p);
    const { check, done } = checks();
    check("private click", p.privateSounds.some((s) => s.id === "random.click"));
    check("no world sound", overworld().played.length === 0);
    done();
});

test("reloading plays each gun's sequence on schedule and still refills the magazine", () => {
    const { check, done } = checks();
    for (const gun of guns) {
        const p = armed(gun, `reload-${gun.id}`);
        emptyMagazine(p, gun);

        const t0 = fake.tick;
        p.isSneaking = true;
        use(p);
        fake.advance(gun.reloadTicks + 5);
        p.isSneaking = false;

        const played = overworld().played;
        const onSchedule = gun.sounds.reload.every((c) => played.some((pl) =>
            pl.id === c.id && pl.volume === c.volume && pl.pitch === c.pitch && pl.tick === t0 + (c.delayTicks ?? 0)));
        check(`${gun.id}: every reload cue plays on its scheduled tick`, onSchedule, JSON.stringify(played.map((x) => `${x.id}@${x.tick - t0}`)));
        check(`${gun.id}: nothing extra plays during reload`, played.length === gun.sounds.reload.length);
        check(`${gun.id}: the magazine refills`, p.messages.some((m) => m.includes("reloaded") && m.includes(`${gun.magazineSize}/${gun.magazineSize}`)), JSON.stringify(p.messages));
        check(`${gun.id}: the old level-up chime is gone`, !p.privateSounds.some((s) => s.id === "random.levelup"));
    }
    done();
});

test("reload edge cases", () => {
    const { check, done } = checks();
    const gun = GUNS.pump_shotgun;

    let p = armed(gun, "full");
    p.isSneaking = true; use(p);
    fake.advance(100);
    check("reloading an already-full gun plays nothing", overworld().played.length === 0 && p.messages.some((m) => m.includes("Already fully loaded")));

    p = armed(gun, "noammo");
    use(p); fake.advance(gun.fireRateTicks);
    p.container.setItem(0, undefined); overworld().played.length = 0;
    p.isSneaking = true; use(p);
    fake.advance(100);
    check("reloading with no ammo plays nothing", overworld().played.length === 0 && p.messages.some((m) => m.includes("left")));

    p = armed(gun, "midswap");
    emptyMagazine(p, gun);
    let t0 = fake.tick;
    p.isSneaking = true; use(p); p.isSneaking = false;
    fake.advance(20);                                      // cues at 0, 8, 15 have played
    const before = overworld().played.length;
    p.holding = "minecraft:stick";                         // swap away mid-reload
    fake.advance(gun.reloadTicks + 5);
    check("swapping away mid-reload silences the rest of the sequence", overworld().played.length === before && before === 3, `(${before} -> ${overworld().played.length})`);

    p = armed(gun, "disconnect");
    emptyMagazine(p, gun);
    t0 = fake.tick;
    p.isSneaking = true; use(p); p.isSneaking = false;
    fake.advance(10);
    const beforeDisconnect = overworld().played.length;
    p.isValid = false;                                     // the player disconnects mid-reload
    let threw = null;
    try { fake.advance(gun.reloadTicks + 5); } catch (e) { threw = e; }
    check("disconnecting mid-reload throws nothing and plays nothing further", threw === null && overworld().played.length === beforeDisconnect, threw ? String(threw) : "");

    p = armed(gun, "blocked");
    for (let i = 0; i < gun.magazineSize - 1; i++) { use(p); fake.advance(gun.fireRateTicks); }
    fake.advance(80);
    p.isSneaking = true; use(p); p.isSneaking = false;
    const midReload = overworld().played.length;
    use(p);                                                // try to shoot while reloading
    check("firing during a reload does nothing", overworld().played.length === midReload);
    fake.advance(gun.reloadTicks + 5);
    done();
});

test("a broken cue can never break firing, and is reported once", () => {
    const { check, done } = checks();
    const gun = GUNS.revolver;
    const p = armed(gun, "badcue");
    const original = gun.sounds.fire[0].pitch;
    gun.sounds.fire[0].pitch = 0;                          // below the engine's 0.01 floor
    let threw = null;
    try {
        use(p); fake.advance(gun.fireRateTicks);
        use(p); fake.advance(gun.fireRateTicks);
    } catch (e) { threw = e; }
    gun.sounds.fire[0].pitch = original;

    check("a bad cue doesn't throw out of the shot", threw === null, threw ? String(threw) : "");
    check("the bad cue is reported exactly once, not on every shot", fake.chat.filter((m) => m.includes("[GUN SOUND ERROR]") && m.includes("firework.blast")).length === 1, JSON.stringify(fake.chat));
    check("the other layers of that shot still played both times", overworld().played.filter((x) => x.id === "random.explode").length === 2);
    done();
});
