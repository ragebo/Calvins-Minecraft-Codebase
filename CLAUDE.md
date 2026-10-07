# RAE: instructions for agents

RAE is a bounty-hunter-vs-outlaws Minecraft Bedrock addon. TypeScript source in `rae/src` compiles into the behavior pack. You are working on the ARCH (Foundations) epic: a behavior-preserving refactor that adds shared core modules. **Do not change game behavior or any number unless your brief says so.**

## Layout

```
rae/src/config/    numbers and coordinates only          rae/test/       tests (run the COMPILED code under a fake game API)
rae/src/logic/     pure rules, no game imports           rae/scripts/    test runner and legacy ratchet
rae/src/core/      shared engines and contracts          your_pack_name_BP/   behavior pack (scripts/ is BUILD OUTPUT, gitignored)
rae/src/systems/   one file per gameplay system          BountySys_RP/   resource pack
rae/src/main.ts    imports + debug commands              docs/test-cards/   one manual test card per task
```

`rae/test/layers.test.mjs` enforces the layer rules below from the source, so a bad import fails `npm test`.

## Commands (run from `rae/`; run `npm ci` once in a fresh worktree)

| Command | What it does |
|---|---|
| `npm run check` | type-check (`tsc --noEmit`) |
| `npm test` | compile to `.test-build/`, install the fake API, run `node --test` |
| `npm run check:legacy` | fails if a legacy-pattern count is higher than on `main` |

## The seven rules

1. Layers point down: `config <- logic <- core <- systems`. `src/logic/` has no game imports.
2. Systems never import each other, only `core/` contracts and events.
3. Numbers and coordinates live only in `config/`. (One deliberate exception: a robbery a builder authors in game is world data, saved in the world like the recorded train route. `config/balance.ts`'s `ROBBERY` block holds only its caps, defaults and tuning.)
4. Mutable game state lives in `core/state`, not in module variables or tags. Tags are output for command targeting.
5. One writer per channel: `core/ui` (title/action bar/chat), `core/sound`, `core/log`, `core/director` (events).
6. A system self-registers with `registerSystem`; adding one edits no shared file.
7. Every change ships a machine-checkable test.

## How you work

- You are in your own git worktree on branch `task/<ID>`. Commit there. **Never push, tag, or touch other branches.**
- Edit only the paths in your brief ("allowed paths"). **Never edit:** manifests (`*/manifest.json`), `README.md`, `ARCHITECTURE.md`, `MIGRATION.md`, `rae/package.json`, `rae/package-lock.json`, `rae/test/fake/*`, `rae/scripts/*`, `.github/`, `CLAUDE.md`, unless your brief names the file. If you need one changed, say so in your report.
- **Public script-event ids are an API** (command blocks in the world call them): `bounty:start_round`, `bounty:teleport`, `bounty:fort`, `bounty:ranch`, `bounty:train`, `bounty:escape`, `bounty:lockpick`, `bounty:test_capture`, `rae:adopt`, `rae:aim_spike`, `rae:debug`, `rae:log_debug`, `rae:menu`, `rae:probe_damage`, `rae:reset`, `rae:robbery_probe`, `rae:tumbleweed`, and the train recorder `rae:train_mark`, `rae:train_station`, `rae:train_undo`, `rae:train_clear`, `rae:train_loop`, `rae:train_info`, `rae:train_show`, `rae:train_spike`. Never rename or remove one. (`rae:log_debug` is registered directly on the raw engine signal by `core/log.ts`, not through `core/events.ts`'s `onScriptEvent`/`listScriptEvents` registry — log.ts cannot import `core/events.ts` — so it is real but does not show up in `rae:debug`'s event list.)
- **Public custom-command ids are an API too, a separate mechanism from script events**: `systems/liveconfig.ts` registers `rae:config_list`, `rae:config_get`, `rae:config_set_number`, `rae:config_set_bool`, `rae:config_set_coordinate`, `rae:config_reset` via `@minecraft/server`'s `CustomCommandRegistry` (`system.beforeEvents.startup`), not `core/events.ts`. Real slash commands (`/rae:config_set_number ...`, no `/scriptevent` prefix), each operator-only via `CommandPermissionLevel.GameDirectors`, each with a `field` parameter the game's own command bar tab-completes from an enum built off `core/configoverrides.ts`'s registry. Never rename or remove one. `systems/robberyprobe.ts` registers one more, `rae:robbery_probe_ctx` (Phase 0 of the in-game robbery framework, a measurement). The framework's builder wand is the item `bountysys:robbery_wand`, and `systems/robberybuilder.ts` registers fifteen operator-only commands: `rae:robbery_list`, `rae:robbery_info`, `rae:robbery_new`, `rae:robbery_select`, `rae:robbery_delete`, `rae:robbery_start`, `rae:robbery_stop`, `rae:robbery_reset`, `rae:robbery_activate`, `rae:robbery_wand`, `rae:robbery_edit`, `rae:robbery_view`, `rae:robbery_undo`, `rae:robbery_area`, `rae:robbery_set` (and the enum `rae:robbery_setting`). `start`, `stop`, `reset` and `activate` take a robbery id and work from a command block or an NPC button, which is how an old command-block build hands part of itself to the framework. Every id the framework adds is `rae:robbery_*` / `bountysys:robbery_*`, the same never-rename rule. `test/load-smoke.test.mjs` registers every public command together under the validating registry, so a bare name or two systems claiming one name fails a test instead of silently in the game. Engine facts for it: a `world.beforeEvents.*` callback is read-only (anything that changes the world must be deferred with `system.run`), and a registered enum or command name needs a namespace even where the typings do not say so.
- Write **characterization tests before refactoring** anything whose behavior you touch (tick cadences, death-handler order, round flow, jail rotation, compass output), watch them pass on the old code, then refactor.
- **Definition of done:** `npm run check` clean, `npm test` green, `npm run check:legacy` not raised, diff inside allowed paths, and a manual test card at `docs/test-cards/<ID>.md`: numbered in-game steps, expected result, and the content-log line to look for. For risky logic, break it on purpose (a mutation) and confirm a test fails.
- **Report (<= 200 words):** what changed, files touched, test/check results, anything you could not verify, anything the orchestrator must decide. Do not claim it works in-game; you can't run the game.

## Testing with the fake API

Tests import the compiled game code plus a fake `@minecraft/server`. See `rae/test/helpers.mjs` and any existing test. The essentials: `fake.makePlayer(name, { tags, location, holding, facing })`, `fake.advance(ticks)` (time only moves when you move it), `world.afterEvents.<name>.emit(payload)` and `system.afterEvents.scriptEventReceive.emit({ id })` to deliver events, `fake.dimension("overworld").played` for sounds, `fake.calls` for query counts, `checks()` to collect failures. A feature branch should not edit `test/fake/*`: extend behaviour inside your test file, or say what is missing. On the main line additive, opt-in extensions to the fake are fine when a feature needs them, and the existing ones are worth using: a block store (`fake.placeBlock`, `dim.getBlock` with real permutations and containers, `fake.setUnloaded`, `fake.pairChests`), `fake.strictBefore = true` (every `world.beforeEvents.*` handler and custom-command callback then runs in RESTRICTED execution, so a forbidden call throws as it does in the game), `fake.startUp()` (a custom-command registry that enforces namespaced names, enums registered before their commands, startup-only registration, typed arguments and the permission level, with `run(name, origin, ...args)` to act out typing a command), `useBlock(player, [x, y, z], { held })` in `helpers.mjs` (a right-click as the before event reports it), and `test/fake/minecraft-server-ui.mjs`'s function responses (a queued response may be a function of the form shown, so a test presses "the button called Locks"; `test/robbery-ui.mjs` is a stand-in player built on it). `test/fake-harness.test.mjs` pins them.

## Engine facts: verify, never guess

This targets a very recent Bedrock build (`1.26.x`); schemas and APIs drift, and guessing has cost whole sessions. Check `rae/node_modules/@minecraft/server/index.d.ts` for any API you use, and the game's own data at `C:\XboxGames\Minecraft for Windows\Content\data\resource_packs\` (for example `vanilla\sounds.json`, `vanilla\font\`). If something can't be verified, write a spike/finding instead of assuming.

Known gotchas (details in `README.md`):
- In an `entityDie` handler the dead entity can already be invalid: `hasTag()` throws `InvalidEntityError`. `typeId`, `id` and `scoreboardIdentity` still work. Guard with `isValid`.
- Item dynamic properties are refused on stackable items, but a custom item with `"minecraft:max_stack_size": 1` accepts them (measured 2026-10-06 on `bountysys:robbery_wand`); the guns still keep per-item state in Maps.
- Block interaction (measured 2026-10-06, `docs/test-cards/ROBBERY-SPIKE.md`): `world.beforeEvents.playerInteractWithBlock` fires for every right-click on any block and `cancel = true` stops containers, levers, buttons and doors; it repeats while the button is held, so gate on `isFirstEvent`. The after event only fires when the interaction does something. A before-event or custom-command callback is restricted: `spawnEntity`, `runCommand`, `setPermutation`, `spawnParticle` and `addTag` throw there, so defer world changes with `system.run` (`sendMessage`, dynamic properties, `getLootTable` and `getBlock` are fine).
- The typings tag every method that cannot run in a before-event or custom-command callback with `@privilege no-restricted-execution`, and the list is long: besides world changes it covers `Player.playSound`, `Dimension.playSound`, `ScreenDisplay.setActionBar` and `setTitle`, `Entity.addEffect`, `kill`, `teleport`, `applyDamage`, `Container.addItem`, `setItem` and `clearAll`, and structure calls. Reads, `sendMessage`, `world`/`Entity` dynamic properties and `LootTableManager` are exempt. So such a callback decides and cancels, then hands everything else to `system.run`; `fake.strictBefore` enforces this in tests.
- `BlockPermutation.getState` does exist (`index.d.ts`); setting a door's `open_bit` on both halves holds. A robbery element's blocks are bound by position, so an unloaded chunk means "not now": `core/robberyworld.ts` answers undefined or false and the janitor retries when the chunk loads.
- `Dimension.playSound` throws for pitch < 0.01 or volume < 0.
- The game's font has no arrow or geometric-shape glyphs; use ASCII plus `« »`.
- Player-list queries (`getAllPlayers`, `getPlayers`) cost real time per call; prefer one shared snapshot per tick.
- `system.runTimeout` callbacks must re-check `player.isValid` for anything that outlives the tick.

## Commit format

Short imperative summary line, a blank line, a few lines on why, then `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
