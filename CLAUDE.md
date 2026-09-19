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
3. Numbers and coordinates live only in `config/`.
4. Mutable game state lives in `core/state` (once it exists), not in module variables or tags. Tags are output for command targeting.
5. One writer per channel: `core/ui` (title/action bar/chat), `core/sound`, `core/log`, `core/director` (events).
6. A system self-registers with `registerSystem`; adding one edits no shared file.
7. Every change ships a machine-checkable test.

## How you work

- You are in your own git worktree on branch `task/<ID>`. Commit there. **Never push, tag, or touch other branches.**
- Edit only the paths in your brief ("allowed paths"). **Never edit:** manifests (`*/manifest.json`), `README.md`, `MIGRATION.md`, `rae/package.json`, `rae/package-lock.json`, `rae/test/fake/*`, `rae/scripts/*`, `.github/`, `CLAUDE.md`, unless your brief names the file. If you need one changed, say so in your report.
- **Public script-event ids are an API** (command blocks in the world call them): `bounty:start_round`, `bounty:teleport`, `bounty:fort`, `bounty:ranch`, `bounty:train`, `bounty:escape`, `bounty:lockpick`, `bounty:test_capture`, `rae:debug`, `rae:reset`. Never rename or remove one.
- Write **characterization tests before refactoring** anything whose behavior you touch (tick cadences, death-handler order, round flow, jail rotation, compass output), watch them pass on the old code, then refactor.
- **Definition of done:** `npm run check` clean, `npm test` green, `npm run check:legacy` not raised, diff inside allowed paths, and a manual test card at `docs/test-cards/<ID>.md`: numbered in-game steps, expected result, and the content-log line to look for. For risky logic, break it on purpose (a mutation) and confirm a test fails.
- **Report (<= 200 words):** what changed, files touched, test/check results, anything you could not verify, anything the orchestrator must decide. Do not claim it works in-game; you can't run the game.

## Testing with the fake API

Tests import the compiled game code plus a fake `@minecraft/server`. See `rae/test/helpers.mjs` and any existing test. The essentials: `fake.makePlayer(name, { tags, location, holding, facing })`, `fake.advance(ticks)` (time only moves when you move it), `world.afterEvents.<name>.emit(payload)` and `system.afterEvents.scriptEventReceive.emit({ id })` to deliver events, `fake.dimension("overworld").played` for sounds, `fake.calls` for query counts, `checks()` to collect failures. Don't edit `test/fake/*`; extend behaviour inside your test file, or say what is missing.

## Engine facts: verify, never guess

This targets a very recent Bedrock build (`1.26.x`); schemas and APIs drift, and guessing has cost whole sessions. Check `rae/node_modules/@minecraft/server/index.d.ts` for any API you use, and the game's own data at `C:\XboxGames\Minecraft for Windows\Content\data\resource_packs\` (for example `vanilla\sounds.json`, `vanilla\font\`). If something can't be verified, write a spike/finding instead of assuming.

Known gotchas (details in `README.md`):
- In an `entityDie` handler the dead entity can already be invalid: `hasTag()` throws `InvalidEntityError`. `typeId`, `id` and `scoreboardIdentity` still work. Guard with `isValid`.
- Item dynamic properties are refused on stackable items (every custom item counts), so per-item state lives in Maps for now.
- `Dimension.playSound` throws for pitch < 0.01 or volume < 0.
- The game's font has no arrow or geometric-shape glyphs; use ASCII plus `« »`.
- Player-list queries (`getAllPlayers`, `getPlayers`) cost real time per call; prefer one shared snapshot per tick.
- `system.runTimeout` callbacks must re-check `player.isValid` for anything that outlives the tick.

## Commit format

Short imperative summary line, a blank line, a few lines on why, then `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
