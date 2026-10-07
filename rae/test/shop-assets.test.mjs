import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { checks, load } from "./helpers.mjs";

// The NPC dialogue scenes are behavior-pack files the scripts name by `scene_tag`, and their buttons run `/scriptevent` ids the
// scripts listen for. The game says nothing when a name or an id does not line up: the NPC just shows the wrong dialogue, or a
// button does nothing. So these read the files, not the compiled code, and hold the two sides to each other.

const root = path.resolve(import.meta.dirname, "..", "..");
const DIALOGUE = path.join(root, "your_pack_name_BP", "dialogue");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));

const { SHOP } = await load("config/balance.js");
await load("main.js");
const { listScriptEvents } = await load("core/events.js");

const scenes = [];
const files = existsSync(DIALOGUE) ? readdirSync(DIALOGUE).filter((name) => name.endsWith(".json")) : [];
for (const name of files) {
    const json = readJson(path.join(DIALOGUE, name));
    for (const scene of json["minecraft:npc_dialogue"]?.scenes ?? []) scenes.push({ file: name, scene, json });
}

test("the dialogue folder holds the shop scene and the probe scene, in the format the game reads", () => {
    const { check, done } = checks();

    check("the folder exists", existsSync(DIALOGUE));
    check("there is a scene file", files.length > 0, files.join());

    for (const { file, json } of scenes.filter((s, i, all) => all.findIndex((o) => o.file === s.file) === i)) {
        check(`${file}: format_version is 1.17, the version the docs show`, json.format_version === "1.17", String(json.format_version));
        check(`${file}: it has a scenes list`, Array.isArray(json["minecraft:npc_dialogue"]?.scenes));
    }

    const tags = scenes.map((s) => s.scene.scene_tag);
    check("every scene has a tag", tags.every((t) => typeof t === "string" && t.length > 0));
    check("scene tags are unique across the pack", new Set(tags).size === tags.length, tags.join());
    check("the shop scene is the one the scripts point NPCs at (SHOP.dialogueScene)", tags.includes(SHOP.dialogueScene), `${SHOP.dialogueScene} not in ${tags.join()}`);
    check("the probe scene is the one the probe points at (SHOP.probeScene)", tags.includes(SHOP.probeScene), `${SHOP.probeScene} not in ${tags.join()}`);
    done();
});

test("every button has a label and commands the game can run", () => {
    const { check, done } = checks();

    for (const { scene } of scenes) {
        const buttons = scene.buttons ?? [];
        check(`${scene.scene_tag}: has at least one button`, buttons.length > 0);
        for (const button of buttons) {
            check(`${scene.scene_tag}: a button has a name`, typeof button.name === "string" && button.name.length > 0);
            check(`${scene.scene_tag} / ${button.name}: has commands (a button without them does not show)`, Array.isArray(button.commands) && button.commands.length > 0);
            check(`${scene.scene_tag} / ${button.name}: every command starts with a slash`, (button.commands ?? []).every((c) => typeof c === "string" && c.startsWith("/")), JSON.stringify(button.commands));
        }
    }

    done();
});

test("the shop scene keeps the NPC's own name, and its one button runs the script event the scripts listen for", () => {
    const { check, done } = checks();
    const shopScene = scenes.find((s) => s.scene.scene_tag === SHOP.dialogueScene)?.scene;

    check("the shop scene exists", shopScene !== undefined);
    check("it sets no npc_name, so each shop NPC shows its own name", shopScene?.npc_name === undefined);
    check("it has exactly one button", shopScene?.buttons?.length === 1);
    check("that button runs `/scriptevent rae:npc shop`", shopScene?.buttons?.[0]?.commands?.join() === "/scriptevent rae:npc shop", String(shopScene?.buttons?.[0]?.commands));
    done();
});

test("every script event a dialogue button runs is one the scripts register", () => {
    const registered = listScriptEvents();
    const used = new Set();

    for (const { scene } of scenes) {
        for (const button of scene.buttons ?? []) {
            for (const command of button.commands ?? []) {
                const match = /^\/scriptevent\s+(\S+)/.exec(command);
                if (match) used.add(match[1]);
            }
        }
    }

    assert.ok(used.size > 0, "the scenes run at least one script event");
    const missing = [...used].filter((id) => !registered.includes(id));
    assert.deepEqual(missing, [], `buttons run script events nothing listens for: ${missing.join(", ")}`);
});

test("the probe scene's second button also tags the player, to test @initiator", () => {
    const probe = scenes.find((s) => s.scene.scene_tag === SHOP.probeScene)?.scene;
    assert.ok(probe?.buttons?.some((b) => b.commands.some((c) => /^\/tag @initiator add rae_npc_probe_pressed$/.test(c))));
});
