import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { checks, load } from "./helpers.mjs";

// The resource pack (BountySys_RP) and the behavior pack (your_pack_name_BP) are separate folders that
// have to agree with each other, and the game says nothing when they don't: a texture path that does not
// resolve, an attachable left behind for an item that is now flat, or a wrong-sized PNG all show up in
// game as a missing or wrong texture with no error. These checks read the files, not the compiled code.

const root = path.resolve(import.meta.dirname, "..", "..");
const RP = path.join(root, "BountySys_RP");
const BP = path.join(root, "your_pack_name_BP");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name)) : []);
const rel = (file) => path.relative(root, file).replaceAll("\\", "/");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALPHA_COLOR_TYPES = new Set([4, 6]);               // grayscale + alpha, RGBA

/** Width, height and colour type of a PNG, or null when the file is not one. */
function pngInfo(file) {
    const bytes = readFileSync(file);
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

const items = jsonFiles(path.join(BP, "items")).map((file) => {
    const item = readJson(file)["minecraft:item"];
    return { file, id: item.description.identifier, icon: item.components?.["minecraft:icon"] };
});

const textureMap = readJson(path.join(RP, "textures", "item_texture.json")).texture_data;
const textureFiles = (entry) => [entry.textures].flat().map((texture) => path.join(RP, `${texture}.png`));

const attachables = jsonFiles(path.join(RP, "attachables")).map((file) => ({ file, body: readJson(file)["minecraft:attachable"] }));
const geometryIds = jsonFiles(path.join(RP, "models", "entity"))
    .flatMap((file) => (readJson(file)["minecraft:geometry"] ?? []).map((g) => g.description.identifier));

test("every texture the item map names exists as a PNG, and every key in it is used by an item", () => {
    const { check, done } = checks();
    const used = new Set(items.map((item) => item.icon));

    for (const [key, entry] of Object.entries(textureMap)) {
        for (const file of textureFiles(entry)) check(`${key}: ${rel(file)} exists`, existsSync(file));
        check(`${key}: some item uses it as its icon`, used.has(key), `icons in use: ${[...used].join(", ")}`);
    }
    done();
});

test("item icons are 16x16 PNGs with transparency, so they don't show as a solid box in the inventory", () => {
    const { check, done } = checks();

    for (const [key, entry] of Object.entries(textureMap)) {
        for (const file of textureFiles(entry)) {
            if (!existsSync(file)) continue;                // the test above reports it
            const info = pngInfo(file);
            check(`${rel(file)} is a PNG`, info !== null);
            if (info === null) continue;
            check(`${key}: 16x16`, info.width === 16 && info.height === 16, `${info.width}x${info.height}`);
            check(`${key}: has an alpha channel`, ALPHA_COLOR_TYPES.has(info.colorType), `colour type ${info.colorType}`);
        }
    }
    done();
});

test("an attachable points at an item, a geometry and textures that exist", () => {
    const { check, done } = checks();
    const itemIds = new Set(items.map((item) => item.id));

    for (const { file, body } of attachables) {
        const where = rel(file);

        for (const id of Object.keys(body.description.item ?? {})) check(`${where}: item ${id} exists`, itemIds.has(id));

        for (const geometry of Object.values(body.description.geometry ?? {})) {
            check(`${where}: ${geometry} is defined in models/entity`, geometryIds.includes(geometry), `defined: ${geometryIds.join(", ")}`);
        }

        // Only textures in this pack are checked; textures/misc/... belongs to the game.
        for (const texture of Object.values(body.description.textures ?? {}).filter((t) => t.startsWith("textures/items/"))) {
            check(`${where}: ${texture}.png exists`, existsSync(path.join(RP, `${texture}.png`)));
        }
    }
    done();
});

test("the revolver is a flat item: its icon is the 16x16 sprite, and nothing overrides how it is held", () => {
    const { check, done } = checks();
    const revolver = items.find((item) => item.id === "bountysys:revolver");

    check("the item exists", revolver !== undefined);
    check("its icon is the revolver texture", revolver?.icon === "revolver", String(revolver?.icon));
    check("the item map points that icon at textures/items/revolver", textureMap.revolver?.textures === "textures/items/revolver", JSON.stringify(textureMap.revolver));

    const sprite = path.join(RP, "textures", "items", "revolver.png");
    const info = existsSync(sprite) ? pngInfo(sprite) : null;
    check("the sprite is a 16x16 PNG", info?.width === 16 && info?.height === 16, JSON.stringify(info));

    check("no attachable overrides the revolver's held look", !attachables.some((a) => "bountysys:revolver" in (a.body.description.item ?? {})), attachables.map((a) => rel(a.file)).join(", "));
    check("no revolver geometry is left over", !geometryIds.some((id) => id.includes("revolver")), geometryIds.join(", "));
    check("no 3D revolver texture is left over", !existsSync(path.join(RP, "textures", "items", "revolver_3d.png")));
    done();
});

test("every gun and every kind of ammo has its own sprite: an icon that is mapped to a texture in this pack, not a vanilla item's", () => {
    const { check, done } = checks();

    for (const icon of ["revolver", "pistol", "bolt_rifle", "semi_rifle", "pump_shotgun", "double_barrel_shotgun", "handgun_ammo", "rifle_ammo", "shotgun_ammo", "game_menu"]) {
        const id = `bountysys:${icon}`;
        const item = items.find((candidate) => candidate.id === id);
        check(`${id}: the item exists`, item !== undefined);
        check(`${id}: its icon is "${icon}"`, item?.icon === icon, String(item?.icon));
        check(`${id}: the item map points "${icon}" at textures/items/${icon}`, textureMap[icon]?.textures === `textures/items/${icon}`, JSON.stringify(textureMap[icon]));
        check(`${id}: the sprite exists`, existsSync(path.join(RP, "textures", "items", `${icon}.png`)));
    }
    done();
});

test("the resource pack declares the pbr capability, or Vibrant Visuals cannot be used while it is active", () => {
    const { check, done } = checks();
    const manifest = readJson(path.join(RP, "manifest.json"));
    const [major, minor, patch] = manifest.header.min_engine_version;

    // The game says Vibrant Visuals "requires a PBR-enabled resource pack", and the vanilla pack marks itself
    // with this capability. One active pack without it is enough to block the mode, so every world's only
    // resource pack (this one) must carry it. Microsoft's documented minimum engine version for it is 1.21.120.
    check("capabilities include \"pbr\"", Array.isArray(manifest.capabilities) && manifest.capabilities.includes("pbr"), JSON.stringify(manifest.capabilities));
    check("min_engine_version is at least 1.21.120", major > 1 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 120))), JSON.stringify(manifest.header.min_engine_version));
    check("the capability is not one that limits the pack to ray tracing hardware", !(manifest.capabilities ?? []).includes("raytraced"), JSON.stringify(manifest.capabilities));
    done();
});

test("each pack's manifest has one version, on the header and on every module", () => {
    const { check, done } = checks();

    for (const [name, file] of [["resource pack", path.join(RP, "manifest.json")], ["behavior pack", path.join(BP, "manifest.json")]]) {
        const manifest = readJson(file);
        const header = manifest.header.version;

        check(`${name}: the version is three whole numbers`, Array.isArray(header) && header.length === 3 && header.every(Number.isInteger), JSON.stringify(header));
        for (const module of manifest.modules) {
            check(`${name}: the ${module.type} module has the header's version`, JSON.stringify(module.version) === JSON.stringify(header), `${JSON.stringify(module.version)} vs ${JSON.stringify(header)}`);
        }
    }
    done();
});

// ---------------------------------------------------------------------------------------------------------
// Entities: the behavior pack's definition, the resource pack's client entity, the model and its texture
// ---------------------------------------------------------------------------------------------------------

const behaviorEntities = jsonFiles(path.join(BP, "entities")).map((file) => ({ file, body: readJson(file)["minecraft:entity"] }));
const clientEntities = jsonFiles(path.join(RP, "entity")).map((file) => ({ file, body: readJson(file)["minecraft:client_entity"] }));
const geometries = jsonFiles(path.join(RP, "models", "entity"))
    .flatMap((file) => (readJson(file)["minecraft:geometry"] ?? []).map((geometry) => ({ file, geometry })));

test("every entity has a client entity in the resource pack and the reverse, and each client entity's geometry and texture exist", () => {
    const { check, done } = checks();
    const behaviorIds = behaviorEntities.map((e) => e.body.description.identifier);
    const clientIds = clientEntities.map((e) => e.body.description.identifier);

    for (const id of behaviorIds) check(`${id}: the resource pack has a client entity for it`, clientIds.includes(id), `client entities: ${clientIds.join(", ")}`);
    for (const id of clientIds) check(`${id}: the behavior pack defines it`, behaviorIds.includes(id), `entities: ${behaviorIds.join(", ")}`);

    for (const { file, body } of clientEntities) {
        const where = rel(file);
        for (const [name, geometry] of Object.entries(body.description.geometry ?? {})) {
            check(`${where}: geometry "${name}" (${geometry}) is defined in models/entity`, geometryIds.includes(geometry), `defined: ${geometryIds.join(", ")}`);
        }
        for (const [name, texture] of Object.entries(body.description.textures ?? {})) {
            if (texture.startsWith("textures/misc/")) continue;         // the game's own
            check(`${where}: texture "${name}" (${texture}.png) exists`, existsSync(path.join(RP, `${texture}.png`)));
        }
    }
    done();
});

test("geometry identifiers are unique, and every face of every box points inside its texture", () => {
    const { check, done } = checks();
    const ids = geometries.map(({ geometry }) => geometry.description.identifier);
    check("no geometry identifier is defined twice", new Set(ids).size === ids.length, ids.join(", "));

    for (const { file, geometry } of geometries) {
        const { texture_width: width, texture_height: height } = geometry.description;
        const where = `${rel(file)} ${geometry.description.identifier}`;
        for (const bone of geometry.bones) {
            // A bone may be a pure parent/pivot with no cubes of its own (the tumbleweed's "root").
            for (const [index, cube] of (bone.cubes ?? []).entries()) {
                if (Array.isArray(cube.uv)) {
                    check(`${where}: ${bone.name} cube ${index} starts inside the texture`, cube.uv[0] >= 0 && cube.uv[1] >= 0 && cube.uv[0] < width && cube.uv[1] < height, JSON.stringify(cube.uv));
                    continue;
                }
                for (const [face, uv] of Object.entries(cube.uv ?? {})) {
                    const [u, v] = uv.uv, [w, h] = uv.uv_size ?? [0, 0];
                    check(`${where}: ${bone.name} cube ${index} ${face} inside the texture`, u >= 0 && v >= 0 && u + w <= width && v + h <= height, JSON.stringify(uv));
                }
            }
        }
    }
    done();
});

test("no custom entity uses minecraft:pushable: the schema rejects it and the entity fails to load", () => {
    const { check, done } = checks();

    // Found the hard way on the train car (copied from the vanilla boat, which does have it): the game
    // rejects this component for a custom entity ("found in the input, but is not present in the Schema"),
    // and the whole entity then fails to load. Checked for every entity, not just the train, so the next
    // one that reaches for it (a rolling tumbleweed is exactly the kind of entity that looks like it wants
    // a "pushable" component) is caught before it ever reaches the game.
    for (const { file, body } of behaviorEntities) {
        check(`${rel(file)}: no minecraft:pushable`, !("minecraft:pushable" in body.components), Object.keys(body.components).join(", "));
    }
    done();
});

test("the train car: its texture is the size its geometry says, and its seats and hit box agree", () => {
    const { check, done } = checks();
    const car = behaviorEntities.find((e) => e.body.description.identifier === "bountysys:train_car")?.body;
    const client = clientEntities.find((e) => e.body.description.identifier === "bountysys:train_car")?.body;
    check("the behavior entity exists", car !== undefined);
    check("the client entity exists", client !== undefined);
    if (!car || !client) return done();

    const geometry = geometries.find(({ geometry: g }) => g.description.identifier === client.description.geometry.default)?.geometry;
    const texture = path.join(RP, `${client.description.textures.default}.png`);
    const info = existsSync(texture) ? pngInfo(texture) : null;
    check("the texture is a PNG", info !== null);
    check("its size is what the geometry says it is", info?.width === geometry?.description.texture_width && info?.height === geometry?.description.texture_height, `${JSON.stringify(info)} vs ${geometry?.description.texture_width}x${geometry?.description.texture_height}`);

    const components = car.components;
    const rideable = components["minecraft:rideable"];
    const box = components["minecraft:collision_box"];
    check("it can be ridden, and has as many seats as it says", Array.isArray(rideable?.seats) && rideable.seats.length === rideable.seat_count, `${rideable?.seat_count} vs ${rideable?.seats?.length}`);
    check("every seat is over the car's floor (inside its hit box, above the ground)", rideable?.seats.every((s) => Math.abs(s.position[0]) <= box.width / 2 && Math.abs(s.position[2]) <= box.width / 2 && s.position[1] >= 0 && s.position[1] < box.height), JSON.stringify(rideable?.seats.map((s) => s.position)));
    check("no two seats are in the same place", new Set(rideable?.seats.map((s) => s.position.join(","))).size === rideable?.seats.length);
    check("it does not fall or collide (a script drives it)", components["minecraft:physics"]?.has_gravity === false && components["minecraft:physics"]?.has_collision === false, JSON.stringify(components["minecraft:physics"]));
    check("nothing can hurt it", components["minecraft:damage_sensor"]?.triggers?.cause === "all" && components["minecraft:damage_sensor"]?.triggers?.deals_damage === "no", JSON.stringify(components["minecraft:damage_sensor"]));
    check("only a script or a command spawns it", car.description.is_spawnable === false && car.description.is_summonable === true);
    done();
});

/** The RGBA pixels of a PNG made by our generator (8 bits, RGBA, filter 0, no interlace), or null for any other kind. */
function pngPixels(file) {
    const bytes = readFileSync(file);
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    const idat = [];
    let offset = 8, header = null;
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") header = data;
        if (type === "IDAT") idat.push(data);
        offset += length + 12;
    }
    if (!header || header[8] !== 8 || header[9] !== 6 || header[12] !== 0) return null;
    const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
    const raw = inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        if (raw[y * (width * 4 + 1)] !== 0) return null;
        raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
    }
    return pixels;
}

test("the train model and texture in the pack are exactly what scripts/gen-train-model.mjs makes", async () => {
    const { check, done } = checks();
    const generator = await import(pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "gen-train-model.mjs")).href);

    const geometryFile = path.join(RP, "models", "entity", "train.geo.json");
    const textureFile = path.join(RP, "textures", "entity", "train.png");
    check("the geometry file exists", existsSync(geometryFile));
    check("the texture file exists", existsSync(textureFile));
    if (!existsSync(geometryFile) || !existsSync(textureFile)) return done();

    check("the geometry file is what the generator writes (run: node scripts/gen-train-model.mjs)", readFileSync(geometryFile, "utf8").replace(/\r\n/g, "\n") === generator.renderGeometry());
    const pixels = pngPixels(textureFile);
    check("the texture is a plain RGBA PNG", pixels !== null);
    check("and its pixels are the generator's palette (the compressed bytes may differ between Node versions, the pixels may not)", pixels !== null && pixels.equals(generator.buildPixels()));

    const palette = Object.values(generator.PALETTE).map((c) => c.join(","));
    check("every palette colour is different", new Set(palette).size === palette.length);
    check("the palette fits in one row of the texture", palette.length <= generator.TEXTURE_SIZE, String(palette.length));
    done();
});

test("the Gatling gun model and texture in the pack are exactly what scripts/gen-gatling-model.mjs makes", async () => {
    const { check, done } = checks();
    const generator = await import(pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "gen-gatling-model.mjs")).href);

    const geometryFile = path.join(RP, "models", "entity", "gatling_gun.geo.json");
    const textureFile = path.join(RP, "textures", "entity", "gatling_gun.png");
    check("the geometry file exists", existsSync(geometryFile));
    check("the texture file exists", existsSync(textureFile));
    if (!existsSync(geometryFile) || !existsSync(textureFile)) return done();

    check("the geometry file is what the generator writes (run: node scripts/gen-gatling-model.mjs)", readFileSync(geometryFile, "utf8").replace(/\r\n/g, "\n") === generator.renderGeometry());
    const pixels = pngPixels(textureFile);
    check("the texture is a plain RGBA PNG", pixels !== null);
    check("and its pixels are the generator's palette (the compressed bytes may differ between Node versions, the pixels may not)", pixels !== null && pixels.equals(generator.buildPixels()));

    const palette = Object.values(generator.PALETTE).map((c) => c.join(","));
    check("every palette colour is different", new Set(palette).size === palette.length);
    check("the palette fits in one row of the texture", palette.length <= generator.TEXTURE_SIZE, String(palette.length));
    done();
});

test("the tumbleweed model and texture in the pack are exactly what scripts/gen-tumbleweed-model.mjs makes", async () => {
    const { check, done } = checks();
    const generator = await import(pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "gen-tumbleweed-model.mjs")).href);

    const geometryFile = path.join(RP, "models", "entity", "tumbleweed.geo.json");
    const textureFile = path.join(RP, "textures", "entity", "tumbleweed.png");
    check("the geometry file exists", existsSync(geometryFile));
    check("the texture file exists", existsSync(textureFile));
    if (!existsSync(geometryFile) || !existsSync(textureFile)) return done();

    check("the geometry file is what the generator writes (run: node scripts/gen-tumbleweed-model.mjs)", readFileSync(geometryFile, "utf8").replace(/\r\n/g, "\n") === generator.renderGeometry());
    const pixels = pngPixels(textureFile);
    check("the texture is a plain RGBA PNG", pixels !== null);
    check("and its pixels are the generator's drawn branches", pixels !== null && pixels.equals(generator.buildPixels()));

    if (pixels) {
        const alphas = [];
        for (let i = 3; i < pixels.length; i += 4) alphas.push(pixels[i]);
        const drawn = alphas.filter((a) => a > 0).length / alphas.length;
        check("mostly transparent, like a real bush's gaps, but not empty", drawn > 0.02 && drawn < 0.5, `${(drawn * 100).toFixed(1)}% opaque`);
    }

    // The geometry: a root, several "unit" crosses hanging off it, and two planes 90 degrees apart per unit
    // (the standard cross-plant technique), all sharing the root's pivot so every rotation is around the
    // same centre.
    const geometry = generator.buildGeometry()["minecraft:geometry"][0];
    const [root, ...rest] = geometry.bones;
    const units = rest.filter((b) => b.parent === "root");
    const planes = rest.filter((b) => b.parent !== "root");

    check("at least a few units, or it reads as one flat cross, not a tangle", units.length >= 4, String(units.length));
    check("every unit and plane pivots at the same point as the root", rest.every((b) => b.pivot.join(",") === root.pivot.join(",")));
    check("more than one unit rotation is used", new Set(units.map((b) => b.rotation.join(","))).size > 1);
    check("exactly two planes per unit", planes.length === units.length * 2, `${planes.length} planes for ${units.length} units`);

    for (const unit of units) {
        const ownPlanes = planes.filter((p) => p.parent === unit.name);
        check(`${unit.name}: its two planes are 90 degrees apart`, ownPlanes.length === 2 && Math.abs(Math.abs(ownPlanes[0].rotation[1] - ownPlanes[1].rotation[1]) - 90) < 1e-9, JSON.stringify(ownPlanes.map((p) => p.rotation)));
        check(`${unit.name}: each plane is a zero-depth quad (the flat-cross technique), not a solid box`, ownPlanes.every((p) => p.cubes[0].size.filter((s) => s === 0).length === 1), JSON.stringify(ownPlanes.map((p) => p.cubes[0].size)));
    }

    const palette = generator.PALETTE.map((c) => c.join(","));
    check("every palette colour is different", new Set(palette).size === palette.length);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The scope overlay: a HUD image (ui/), the texture it shows, and the title text that switches it on
// ---------------------------------------------------------------------------------------------------------

const UI = path.join(RP, "ui");
const SCOPE_TEXTURE = "textures/ui/rae_scope";

test("the scope overlay's HUD files hang together: defs list an existing file, the hook names a real element, its texture exists", () => {
    const { check, done } = checks();
    const defs = readJson(path.join(UI, "_ui_defs.json"));
    check("_ui_defs.json lists the scope file", defs.ui_defs?.includes("ui/rae_scope.json"), JSON.stringify(defs));
    for (const file of defs.ui_defs ?? []) check(`${file} exists`, existsSync(path.join(RP, file)));

    const scope = readJson(path.join(UI, "rae_scope.json"));
    const namespace = scope.namespace;
    check("the scope file has a namespace", typeof namespace === "string" && namespace.length > 0);
    check("it defines scope_root", scope.scope_root !== undefined);
    check("the element shows the scope texture", scope.scope_root?.texture === SCOPE_TEXTURE, String(scope.scope_root?.texture));
    check("and is hidden until a binding shows it", scope.scope_root?.visible === false);
    check("the texture file exists", existsSync(path.join(RP, `${SCOPE_TEXTURE}.png`)));

    const hud = readJson(path.join(UI, "hud_screen.json"));
    const modification = hud.root_panel?.modifications?.[0];
    check("hud_screen.json adds a control to the root panel", modification?.array_name === "controls" && Array.isArray(modification?.value), JSON.stringify(hud));
    const added = Object.keys(modification?.value?.[0] ?? {})[0] ?? "";
    check("the control points at namespace.scope_root", added.endsWith(`@${namespace}.scope_root`), added);
    done();
});

test("the title text in the overlay's binding is the one the script sends", async () => {
    const { check, done } = checks();
    const { AIM } = await load("config/balance.js");
    const scope = readJson(path.join(UI, "rae_scope.json"));

    const binding = (scope.scope_root?.bindings ?? []).find((b) => b.target_property_name === "#visible");
    check("a binding sets #visible", binding !== undefined, JSON.stringify(scope.scope_root?.bindings));
    check("it compares the title text with the configured switch", binding?.source_property_name === `(#hud_title_text_string = '${AIM.scopeTitle}')`, `${binding?.source_property_name} vs ${AIM.scopeTitle}`);
    check("the switch draws nothing by itself (formatting codes only)", AIM.scopeTitle.replace(/§./g, "") === "", JSON.stringify(AIM.scopeTitle));
    done();
});

test("the scope overlay image in the pack is exactly what scripts/gen-scope-overlay.mjs makes", async () => {
    const { check, done } = checks();
    const generator = await import(pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "gen-scope-overlay.mjs")).href);
    const file = path.join(RP, `${SCOPE_TEXTURE}.png`);
    check("the file exists", existsSync(file));
    if (!existsSync(file)) return done();

    const info = pngInfo(file);
    check("it is a PNG of the generator's size, with an alpha channel", info?.width === generator.WIDTH && info?.height === generator.HEIGHT && ALPHA_COLOR_TYPES.has(info?.colorType), JSON.stringify(info));
    const pixels = pngPixels(file);
    check("its pixels are the generator's (run: node scripts/gen-scope-overlay.mjs)", pixels !== null && pixels.equals(generator.buildScopePixels()));

    const at = (x, y) => pixels?.[(y * generator.WIDTH + x) * 4 + 3];
    check("the middle of the lens is clear except for the crosshair gap", at(Math.floor(generator.WIDTH / 2) + 5, Math.floor(generator.HEIGHT / 2) + 5) === 0);
    check("a corner is solid black", at(2, 2) === 255 && at(generator.WIDTH - 3, generator.HEIGHT - 3) === 255);
    done();
});

// ---------------------------------------------------------------------------------------------------------
// The hit-marker overlay (GUN-07 spike): the same HUD-image-switched-by-title-text technique as the scope,
// on its own title string so core/aim.ts can coordinate the two instead of them fighting over one channel.
// ---------------------------------------------------------------------------------------------------------

const HIT_MARKER_TEXTURE = "textures/ui/rae_hit_marker";

test("the hit-marker overlay's HUD files hang together: defs list an existing file, the hook names a real element, its texture exists", () => {
    const { check, done } = checks();
    const defs = readJson(path.join(UI, "_ui_defs.json"));
    check("_ui_defs.json lists the hit-marker file", defs.ui_defs?.includes("ui/rae_hit_marker.json"), JSON.stringify(defs));

    const marker = readJson(path.join(UI, "rae_hit_marker.json"));
    const namespace = marker.namespace;
    check("the hit-marker file has a namespace", typeof namespace === "string" && namespace.length > 0);
    check("it defines hit_marker_root", marker.hit_marker_root !== undefined);
    check("the element shows the hit-marker texture", marker.hit_marker_root?.texture === HIT_MARKER_TEXTURE, String(marker.hit_marker_root?.texture));
    check("and is hidden until a binding shows it", marker.hit_marker_root?.visible === false);
    check("it's centered, not full-screen like the scope", marker.hit_marker_root?.anchor_from === "center" && marker.hit_marker_root?.anchor_to === "center", JSON.stringify(marker.hit_marker_root));
    check("the texture file exists", existsSync(path.join(RP, `${HIT_MARKER_TEXTURE}.png`)));

    const hud = readJson(path.join(UI, "hud_screen.json"));
    const added = (hud.root_panel?.modifications?.[0]?.value ?? []).map((v) => Object.keys(v)[0]);
    check("hud_screen.json adds a control pointing at namespace.hit_marker_root", added.some((name) => name.endsWith(`@${namespace}.hit_marker_root`)), JSON.stringify(added));
    done();
});

test("the title text in the hit-marker's binding is the one the script sends, and differs from the scope's own switch", async () => {
    const { check, done } = checks();
    const { AIM } = await load("config/balance.js");
    const marker = readJson(path.join(UI, "rae_hit_marker.json"));

    const binding = (marker.hit_marker_root?.bindings ?? []).find((b) => b.target_property_name === "#visible");
    check("a binding sets #visible", binding !== undefined, JSON.stringify(marker.hit_marker_root?.bindings));
    check("it compares the title text with the configured switch", binding?.source_property_name === `(#hud_title_text_string = '${AIM.hitMarkerTitle}')`, `${binding?.source_property_name} vs ${AIM.hitMarkerTitle}`);
    check("the switch draws nothing by itself (formatting codes only)", AIM.hitMarkerTitle.replace(/§./g, "") === "", JSON.stringify(AIM.hitMarkerTitle));
    check("it's a different switch from the scope's own, so core/aim.ts can tell them apart", AIM.hitMarkerTitle !== AIM.scopeTitle && AIM.hitMarkerTitle !== AIM.scopeOffTitle, `${AIM.hitMarkerTitle} vs ${AIM.scopeTitle} / ${AIM.scopeOffTitle}`);
    done();
});

test("the hit-marker image in the pack is exactly what scripts/gen-hit-marker.mjs makes", async () => {
    const { check, done } = checks();
    const generator = await import(pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "gen-hit-marker.mjs")).href);
    const file = path.join(RP, `${HIT_MARKER_TEXTURE}.png`);
    check("the file exists", existsSync(file));
    if (!existsSync(file)) return done();

    const info = pngInfo(file);
    check("it is a PNG of the generator's size, with an alpha channel", info?.width === generator.WIDTH && info?.height === generator.HEIGHT && ALPHA_COLOR_TYPES.has(info?.colorType), JSON.stringify(info));
    const pixels = pngPixels(file);
    check("its pixels are the generator's (run: node scripts/gen-hit-marker.mjs)", pixels !== null && pixels.equals(generator.buildHitMarkerPixels()));

    const at = (x, y) => pixels?.[(y * generator.WIDTH + x) * 4 + 3];
    const center = Math.floor(generator.WIDTH / 2);
    check("the very centre is clear (the dashes leave a gap for the crosshair)", at(center, center) === 0);
    check("a corner is clear too (it's a small mark, not a full-screen image)", at(2, 2) === 0 && at(generator.WIDTH - 3, generator.HEIGHT - 3) === 0);
    check("at least one dash is actually opaque somewhere", pixels.some((_, i) => i % 4 === 3 && pixels[i] === 255));
    done();
});

test("every gun is a plain item: not hold-to-use (a used item blocks left-click) and with no cooldown", async () => {
    const { check, done } = checks();
    const { GUNS } = await load("config/guns.js");

    for (const gun of Object.values(GUNS)) {
        const item = items.find((candidate) => candidate.id === gun.itemId);
        check(`${gun.id}: the item exists`, item !== undefined);
        if (!item) continue;
        const components = readJson(item.file)["minecraft:item"].components;

        // While an item is in use (a held right-click on an item with a use duration) the game sends no attack input, so a
        // hold-to-use gun could never fire while aimed: the owner hit exactly this with the bolt rifle. Aim is a toggle.
        check(`${gun.id}: no minecraft:use_modifiers (it would make right-click a hold and block the left-click)`, components["minecraft:use_modifiers"] === undefined, JSON.stringify(components["minecraft:use_modifiers"]));
        check(`${gun.id}: no minecraft:cooldown (fire rate is the script's)`, components["minecraft:cooldown"] === undefined);
        check(`${gun.id}: held like a tool`, components["minecraft:hand_equipped"] === true);
        check(`${gun.id}: no allow_off_hand (Bedrock has no swap key, so it would only let a gun be parked there)`, components["minecraft:allow_off_hand"] === undefined);
        check(`${gun.id}: has a zoom in its config`, gun.aim?.fov > 0);
        check(`${gun.id}: the inventory tooltip name matches what the script says in chat`, components["minecraft:display_name"]?.value === gun.displayName, `item says "${components["minecraft:display_name"]?.value}", config says "${gun.displayName}"`);
    }
    done();
});

test("the aim probe items are hold-to-use items that differ only in their use animation", () => {
    const { check, done } = checks();
    const probes = items.filter((item) => item.id.startsWith("bountysys:aim_probe_"));
    check("three of them", probes.length === 3, probes.map((p) => p.id).join(", "));

    const animations = {};
    for (const probe of probes) {
        const components = readJson(probe.file)["minecraft:item"].components;
        animations[probe.id] = components["minecraft:use_animation"] ?? "none";
        check(`${probe.id}: hold to use (a use duration and a movement modifier)`, components["minecraft:use_modifiers"]?.use_duration > 0 && components["minecraft:use_modifiers"]?.movement_modifier <= 1, JSON.stringify(components["minecraft:use_modifiers"]));
        check(`${probe.id}: one at a time, held like a tool`, components["minecraft:max_stack_size"] === 1 && components["minecraft:hand_equipped"] === true);
    }
    check("plain, bow and spyglass", animations["bountysys:aim_probe_plain"] === "none" && animations["bountysys:aim_probe_bow"] === "bow" && animations["bountysys:aim_probe_spyglass"] === "spyglass", JSON.stringify(animations));
    done();
});

test("the menu item's icon in the pack is a proper 16x16 sprite", () => {
    const { check, done } = checks();

    // scripts/gen-menu-icon.mjs made the original gold-star icon; the owner replaced it with their own
    // art (2026-09-21), so this no longer checks the file against that generator's output, only that
    // whatever image is here is a well-formed sprite like every other item icon.
    const file = path.join(RP, "textures", "items", "game_menu.png");
    check("the file exists", existsSync(file));
    if (!existsSync(file)) return done();

    const info = pngInfo(file);
    check("it is a 16x16 PNG with an alpha channel, like the other item sprites", info?.width === 16 && info?.height === 16 && ALPHA_COLOR_TYPES.has(info?.colorType), JSON.stringify(info));
    done();
});
