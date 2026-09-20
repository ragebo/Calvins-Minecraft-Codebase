import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { checks } from "./helpers.mjs";

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
