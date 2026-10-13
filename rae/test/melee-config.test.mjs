import { test } from "node:test";
import { checks, fakeApi, load, world } from "./helpers.mjs";
import { MELEE, fake, fresh, hit, armed, resetMelee } from "./melee-fixtures.mjs";

// The melee numbers in the live config editor (core/configoverrides.ts), group "Melee": the five damages, the bleed's stack cap, the baton's chance
// and length, the axe's reach and cooldown, the sledgehammer's cooldown. Each is a registered setting with a range, changes the NEXT hit, swing or
// stun, and resets to its default. The point is not only that they register but that the weapons read them: a setting nothing reads is worse than none.

const { PlayerPermissionLevel, CustomCommandStatus } = fakeApi;
const O = await load("core/configoverrides.js");
const { stunnedNow } = await load("core/melee.js");
await load("systems/liveconfig.js");

const GROUP = "Melee";
const DAMAGES = ["knife", "machete", "baton", "axe", "sledgehammer"].map((key) => `melee.${key}Damage`);
const OTHERS = ["melee.bleedMaxStacks", "melee.stunChance", "melee.stunTicks", "melee.axeReach", "melee.axeCooldownTicks", "melee.hammerCooldownTicks"];
const IDS = [...DAMAGES, ...OTHERS];

const operator = () => fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });
const mob = (x = 0, z = 2) => {
    const entity = fake.makeEntity({ typeId: "minecraft:pillager", location: { x, y: 64, z } });
    entity.getComponent = (id) => id === "minecraft:health" ? { currentValue: 20, effectiveMax: 20 } : undefined;
    return entity;
};
const wielder = (weapon, name = "Wielder") => {
    const player = armed(name, weapon);
    player.location = { x: 0, y: 64, z: 0 };
    player.facing = { x: 0, y: 0, z: 1 };
    return player;
};

/** Sets a setting the way the editor does, runs `body`, and puts it back whatever happens. */
function withSetting(op, id, value, body) {
    const set = O.setOverride(op, id, value);
    if (!set.ok) throw new Error(set.reason);
    try { body(); } finally { O.resetOverride(op, id); }
}

test("the eleven settings are registered, in a group of their own, with a kind, a range and a label that says what they do", () => {
    const { check, done } = checks();
    check("all eleven exist", IDS.length === 11 && IDS.every((id) => O.getField(id) !== undefined), IDS.filter((id) => !O.getField(id)).join());
    check("in the group Melee, which the editor lists", O.listCategories().includes(GROUP) && IDS.every((id) => O.getField(id)?.category === GROUP));
    check("the group holds exactly these", O.listFields(GROUP).length === IDS.length, String(O.listFields(GROUP).length));
    check("damages and the chance, reach are decimals", [...DAMAGES, "melee.stunChance", "melee.axeReach"].every((id) => O.getField(id).kind === "float"));
    check("the rest are whole numbers", ["melee.bleedMaxStacks", "melee.stunTicks", "melee.axeCooldownTicks", "melee.hammerCooldownTicks"].every((id) => O.getField(id).kind === "integer"));
    check("each label starts with Melee: and says more than a name", IDS.every((id) => /^Melee: /.test(O.getField(id).label) && O.getField(id).label.length > 30), IDS.map((id) => O.getField(id).label).join(" | "));
    check("each says its unit where it has one", /health points/.test(O.getField("melee.knifeDamage").label) && /ticks/.test(O.getField("melee.stunTicks").label) && /blocks/.test(O.getField("melee.axeReach").label));
    done();
});

test("they start at the config's numbers", () => {
    const { check, done } = checks();
    check("the five damages", DAMAGES.map((id) => O.getField(id).get()).join() === "2,4,3,6,8", DAMAGES.map((id) => O.getField(id).get()).join());
    check("the bleed's stack cap", O.getField("melee.bleedMaxStacks").get() === 10);
    check("the stun", O.getField("melee.stunChance").get() === 0.25 && O.getField("melee.stunTicks").get() === 10);
    check("the axe", O.getField("melee.axeReach").get() === 3 && O.getField("melee.axeCooldownTicks").get() === 20);
    check("the sledgehammer", O.getField("melee.hammerCooldownTicks").get() === 30);
    done();
});

test("each setting refuses what it cannot take, and says the range", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const refused = (label, id, value, mentions) => {
        const before = O.getField(id).get();
        const result = O.setOverride(op, id, value);
        check(label, result.ok === false && result.reason.includes(mentions) && O.getField(id).get() === before, JSON.stringify(result));
    };

    refused("a damage below nothing", "melee.knifeDamage", -1, "0");
    refused("a damage above a hundred", "melee.sledgehammerDamage", 101, "100");
    refused("a chance above one", "melee.stunChance", 1.5, "1");
    refused("a chance below nothing", "melee.stunChance", -0.1, "0");
    refused("a stun of no length", "melee.stunTicks", 0, "1");
    refused("a stun of ten seconds and more", "melee.stunTicks", 201, "200");
    refused("a stun of half a tick", "melee.stunTicks", 2.5, "whole");
    refused("a bleed that cannot stack", "melee.bleedMaxStacks", 0, "1");
    refused("a bleed that stacks past fifty", "melee.bleedMaxStacks", 51, "50");
    refused("an axe that reaches nothing", "melee.axeReach", 0, "0.5");
    refused("an axe that reaches across the map", "melee.axeReach", 9, "8");
    refused("an axe cooldown below nothing", "melee.axeCooldownTicks", -1, "0");
    refused("an axe cooldown of half a minute and more", "melee.axeCooldownTicks", 601, "600");
    refused("a hammer cooldown below nothing", "melee.hammerCooldownTicks", -1, "0");
    refused("a hammer cooldown of half a minute and more", "melee.hammerCooldownTicks", 601, "600");

    check("a decimal damage is fine (half a heart)", O.setOverride(op, "melee.knifeDamage", 1.5).ok === true && MELEE.weapons.knife.damage === 1.5);
    O.resetOverride(op, "melee.knifeDamage");
    check("a member cannot change them", O.setOverride(fake.makePlayer("Mem", { permission: PlayerPermissionLevel.Member }), "melee.knifeDamage", 9).ok === false && MELEE.weapons.knife.damage === 2);
    done();
});

test("every setting goes back to its default", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const changes = [["melee.knifeDamage", 3], ["melee.macheteDamage", 0], ["melee.batonDamage", 9], ["melee.axeDamage", 1], ["melee.sledgehammerDamage", 20],
        ["melee.bleedMaxStacks", 3], ["melee.stunChance", 1], ["melee.stunTicks", 40], ["melee.axeReach", 5], ["melee.axeCooldownTicks", 0], ["melee.hammerCooldownTicks", 90]];
    const defaults = changes.map(([id]) => O.getField(id).get());

    changes.forEach(([id, value]) => O.setOverride(op, id, value));
    check("all eleven changed", changes.every(([id, value]) => O.getField(id).get() === value), changes.map(([id]) => O.getField(id).get()).join());

    changes.forEach(([id]) => O.resetOverride(op, id));
    check("all eleven are back", changes.every(([id], i) => O.getField(id).get() === defaults[i]), changes.map(([id]) => O.getField(id).get()).join());
    done();
});

test("typed as /rae:config set, a melee number changes", () => {
    const { check, done } = checks();
    const registry = (fake.reset(), fake.startUp());
    const op = fake.makePlayer("Op", { permission: PlayerPermissionLevel.Operator });

    const set = registry.run("rae:config", { sourceEntity: op }, "set", "melee.knifeDamage", "5");
    check("it worked and said from what to what", set.status === CustomCommandStatus.Success && /melee\.knifeDamage: 2 -> 5/.test(set.message), JSON.stringify(set));
    check("the config now says 5", MELEE.weapons.knife.damage === 5);

    O.resetOverride(op, "melee.knifeDamage");
    check("and back", MELEE.weapons.knife.damage === 2);
    done();
});

test("a damage changes the next hit of that weapon, and no other", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const target = mob();

    for (const key of ["knife", "machete", "baton", "axe", "sledgehammer"]) {
        const attacker = wielder(key, `W-${key}`);
        const before = hit({ attacker, target, damage: 1 }).damage;
        withSetting(op, `melee.${key}Damage`, 7, () => {
            resetMelee();
            check(`${key}: the next hit is 7`, hit({ attacker, target, damage: 1 }).damage === 7);
            const other = wielder(key === "knife" ? "baton" : "knife", `Other-${key}`);
            check(`${key}: another weapon is unmoved`, hit({ attacker: other, target, damage: 1 }).damage === MELEE.weapons[key === "knife" ? "baton" : "knife"].damage);
        });
        resetMelee();
        check(`${key}: and back after a reset`, hit({ attacker, target, damage: 1 }).damage === before, String(before));
    }
    done();
});

test("the bleed's stack cap changes how many stacks the next hits make", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const knifer = wielder("knife");
    const target = mob();

    withSetting(op, "melee.bleedMaxStacks", 2, () => {
        for (let i = 0; i < 5; i++) hit({ attacker: knifer, target, damage: 1 });
        fake.advance(20);
    });
    check("five hits, a cap of two: two a second", target.damage.map((d) => d.amount).join() === "2", target.damage.map((d) => d.amount).join());
    done();
});

test("the baton's chance and length change the next stun", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const batonist = wielder("baton");
    const dice = (roll, body) => { const real = Math.random; Math.random = () => roll; try { return body(); } finally { Math.random = real; } };
    const stuns = (entity) => entity.effects.filter((e) => e.id === "slowness");

    withSetting(op, "melee.stunChance", 1, () => {
        const a = mob();
        dice(0.99, () => hit({ attacker: batonist, target: a, damage: 1 }));
        check("a chance of 1 stuns on the worst roll", stuns(a).length === 1);
    });
    withSetting(op, "melee.stunChance", 0, () => {
        const b = mob();
        dice(0, () => hit({ attacker: batonist, target: b, damage: 1 }));
        check("a chance of 0 never stuns, even on a roll of 0", stuns(b).length === 0);
    });
    resetMelee();
    withSetting(op, "melee.stunTicks", 40, () => {
        const c = mob();
        dice(0, () => hit({ attacker: batonist, target: c, damage: 1 }));
        check("a stun of 40 ticks", stuns(c)[0]?.duration === 40, JSON.stringify(stuns(c)));
        fake.advance(39);
        check("still stunned a tick before the end", stunnedNow() === 1);
        fake.advance(1);
        check("and over at 40", stunnedNow() === 0);
    });
    done();
});

test("the axe's reach and cooldown change the next attack", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const swing = (player) => { world.afterEvents.playerSwingStart.emit({ swingSource: "Attack", heldItemStack: { typeId: player.holding }, player }); fake.advance(1); };

    withSetting(op, "melee.axeReach", 1, () => {
        const player = wielder("axe", "ShortArm");
        const near = mob(0, 2);
        swing(player);
        check("a reach of 1: something 2 away is not hit", near.damage.length === 0);
    });
    resetMelee();
    withSetting(op, "melee.axeReach", 5, () => {
        const player = wielder("axe", "LongArm");
        const far = mob(0, 4.5);
        swing(player);
        check("a reach of 5: something 4.5 away is", far.damage.length === 1);
    });
    resetMelee();
    withSetting(op, "melee.axeCooldownTicks", 40, () => {
        const player = wielder("axe", "Slow");
        const target = mob(0, 2);
        swing(player);
        fake.advance(30);
        swing(player);
        check("a cooldown of 40: 31 ticks on, still cooling", target.damage.length === 1);
        fake.advance(10);
        swing(player);
        check("and 41 on, it works", target.damage.length === 2);
    });
    done();
});

test("the sledgehammer's cooldown changes the next break", () => {
    const { check, done } = checks();
    fresh();
    const op = operator();
    const player = armed("Smith", "sledgehammer");
    player.location = { x: 0, y: 64, z: 0 };
    const swing = () => world.afterEvents.playerSwingStart.emit({ swingSource: "Mine", heldItemStack: { typeId: player.holding }, player });
    const broken = () => fake.dimension("overworld").commands.filter((c) => /air destroy$/.test(c)).length;
    fake.dimension("overworld").commands.length = 0;

    withSetting(op, "melee.hammerCooldownTicks", 0, () => {
        fake.placeBlock("overworld", { x: 0, y: 64, z: 3 }, "minecraft:oak_planks");
        player.aimAt = { x: 0, y: 64, z: 3 };
        swing();
        fake.placeBlock("overworld", { x: 1, y: 64, z: 3 }, "minecraft:oak_planks");
        player.aimAt = { x: 1, y: 64, z: 3 };
        swing();
        check("no wait: two breaks in the same tick", broken() === 2, String(broken()));
    });
    done();
});
