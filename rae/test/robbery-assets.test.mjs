import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { checks, load } from "./helpers.mjs";

// The builder wand is a behavior-pack item the script recognises by its identifier, so the two have to agree
// byte for byte, and the icon it borrows has to exist: the game says nothing when they don't, it just shows no
// wand (or a missing texture). These read the files, not the compiled code.

const root = path.resolve(import.meta.dirname, "..", "..");
const BP = path.join(root, "your_pack_name_BP");
const RP = path.join(root, "BountySys_RP");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));

const { ROBBERY } = await load("config/balance.js");

test("the robbery wand item matches the id the scripts look for, borrows an icon that exists, and is one at a time", () => {
    const { check, done } = checks();
    const file = path.join(BP, "items", "robbery_wand.json");

    check("the item file exists", existsSync(file));
    if (!existsSync(file)) { done(); return; }

    const item = readJson(file)["minecraft:item"];
    const components = item.components ?? {};
    const icons = readJson(path.join(RP, "textures", "item_texture.json")).texture_data;

    check("its identifier equals ROBBERY.wandItemId", item.description.identifier === ROBBERY.wandItemId, `${item.description.identifier} vs ${ROBBERY.wandItemId}`);
    check("its icon key is in the item texture map (so no resource-pack change is needed)", components["minecraft:icon"] in icons, String(components["minecraft:icon"]));
    check("one at a time, so per-item state could be kept on it", components["minecraft:max_stack_size"] === 1);
    check("it has a name", typeof components["minecraft:display_name"]?.value === "string" && components["minecraft:display_name"].value.length > 0);
    check("it is not a hold-to-use item (that would swallow left-clicks)", components["minecraft:use_modifiers"] === undefined && components["minecraft:use_animation"] === undefined);
    done();
});
