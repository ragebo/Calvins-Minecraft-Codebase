# ARCH-10 test card: a real preflight system (`core/preflight.ts`)

Before this task, the only startup check was `core/economy.ts`'s `verifyScoreboards()`: two
scoreboard objectives, reported with a plain `world.sendMessage`. The new module
`rae/src/core/preflight.ts` widens this into a real preflight, run once at load
(`rae/src/main.ts`'s `system.run`), that checks:

- the two scoreboard objectives (unchanged, via the new `missingScoreboards()`)
- the train structure (`config/world.ts`'s `TRAIN_STRUCTURE`, `"mystructure:train"` — relocated
  there from a local const in `systems/train.ts`)
- every item id in `config/guns.ts`'s `AMMO` and `GUNS` records (3 ammo + 7 guns today), via
  `ItemTypes.get(id) !== undefined`
- every hardcoded coordinate in `config/world.ts`, for finiteness and the Overworld's
  build-limit Y bounds (`OVERWORLD_Y_BOUNDS`, new in `config/world.ts`), via the pure,
  separately-exported `checkCoordinateBounds()`

Every problem found is reported through **one combined** `core/log.ts` `error()` call, not one
call per problem.

**What must change:** the load-time message changes from a silent `verifyScoreboards()` call to
`runPreflightChecks()`. When something is wrong, one `[preflight] N problem(s) found before
load: ...` line appears (content log always; an operator's chat too, same as any other
`error()` call since ARCH-06) instead of nothing, or instead of the old, narrower
`[economy] Missing scoreboard objectives: ...` line.

**What must not change:** `rae:debug`'s own `verifyScoreboards()` call (a lighter, on-demand
check, separate from the load-time gate) is untouched — it still checks only the two scoreboards,
still via `world.sendMessage`'s successor `error()`, exactly as ARCH-06 left it. No gun/ammo
number, coordinate, or existing script-event id changed.

**Deliberately out of scope** (see `core/preflight.ts`'s file comment): `compass.ts`'s and
`menu.ts`'s item ids are not checked — only `config/guns.ts`'s `AMMO`/`GUNS` are, per this task's
brief, since those two files were not centralized in `config/` the same way. `isChunkLoaded()` is
never used as a preflight check (that would false-positive on legitimately far, simply
not-yet-loaded terrain — `systems/transit.ts` already calls it, right before it actually needs a
chunk resident). `systems/train.ts`'s backup-structure names (`BACKUP_PREFIX`, `BRIDGE_BACKUP`)
are not checked either — the addon's own `/structure save` calls create those at runtime, so
checking for them at startup would fail every fresh world.

## Automated (from `rae/`)

- `npm run check`: clean, `tsc --noEmit` only.
- `npm test`: `514` tests, `0` failures (503 before this task + 11 new in
  `rae/test/preflight.test.mjs`). `rae/test/load-smoke.test.mjs`'s "reports no errors" test was
  updated to seed `fake.itemTypes` (every `config/guns.ts` id) and `fake.structures`
  (`TRAIN_STRUCTURE`) — the new checks this task adds — alongside the two scoreboards it already
  seeded; its other tests are unaffected.
- `npm run check:legacy`: fails against `main` (`player-filter` 8 -> 9), but that is inherited
  from `v2` itself, not this task — `LEGACY_BASE_REF=v2 npm run check:legacy` (comparing against
  the actual commit this branch forked from) shows every pattern unchanged (`player-filter` 9 ->
  9, all others equal). ARCH-06's own test card already flagged this exact `player-filter` count
  as "a known, accepted consequence" of `core/log.ts`'s design (its one direct
  `world.getAllPlayers()` call), predating this task.

## Setup

- Creative world with the RAE pack, cheats on, Content Log GUI on (Settings > Creator > Enable
  Content Log GUI). Be an operator, or `error()`'s chat line will not reach you (console still
  gets it either way).
- `cd rae && npm run build`. Bump the behavior pack version if the world keeps running old scripts.

## 1. The happy path is silent, same as before

1. Load a world where `coins`, `bounty` and `mystructure:train` all already exist (any world this
   addon has run in before). Expected: the usual green `RAE loaded.` and nothing else — no red
   preflight line, in chat or the content log.

## 2. A missing scoreboard is reported through the new combined message

1. `/scoreboard objectives remove bounty`, then fully reload the world (preflight only runs at
   load).
2. Expected: one line, `[preflight] 1 problem(s) found before load: Missing scoreboard
   objectives: bounty`, to you (the operator) and the content log — not the old, narrower
   `[economy] ...` line.
3. `/scoreboard objectives add bounty dummy` to restore it.

## 3. A missing structure is reported, with the same fix hint the train robbery itself gives

1. If `mystructure:train` was ever saved in this world, there is no in-game way to un-save a
   structure to test this directly — treat this step as covered by `npm test` instead
   (`rae/test/preflight.test.mjs`'s "a missing structure is the only problem reported").
2. On a brand-new world that has never run `/structure save mystructure:train`: reload it and
   expect `[preflight] ...: Missing structure "mystructure:train" (save it with /structure save
   mystructure:train)` among the reported problems (likely alongside the scoreboard problem too,
   on a truly fresh world — see step 4).

## 4. Several problems at once still produce exactly one line

1. On a fresh world (missing scoreboards, missing structure, item ids never an issue in a real
   world since the behavior pack always defines them): reload and expect exactly **one**
   `[preflight] ...` line listing every problem found, separated by ` | ` — not one line per
   problem.

## Pass and fail

- Pass: a fully set-up world loads silently; each broken piece above is named correctly in one
  combined `[preflight] ...` line, to the operator and the content log only; `rae:debug` still
  reports scoreboards the old way, unaffected.
- Fail: any problem is silent; more than one `[preflight]`-tagged line appears for one load; a
  non-operator sees the chat line; `rae:debug`'s behavior changed.

## Content log

Look for `[preflight] N problem(s) found before load: ...` (via `console.error`, so it shows as
`[Scripting][error]`), or nothing at all when everything checks out.

## Not checked

The game was not run for this task; everything above comes from the code and
`rae/test/preflight.test.mjs` under the fake API.

- **The Overworld Y-bound value itself.** `OVERWORLD_Y_BOUNDS` (`config/world.ts`) is `{ min:
  -64, max: 320 }`. Checked against this project's own installed engine rather than assumed
  outright: neither `Dimension.heightRange`'s type in
  `rae/node_modules/@minecraft/server/index.d.ts` (a runtime `NumberRange`, `min`/`max` fields,
  no literal default documented) nor the installed vanilla behavior/resource packs
  (`vanilla_1.26.52` in the game's own data folder — manifest/contents.json only, no readable
  dimension definition; vanilla data ships in opaque archives) state this number in the clear.
  `-64..320` is the standard, unchanged Bedrock Overworld build limit since the 1.18 height
  expansion, and nothing found contradicts it, but it was not read verbatim from either source.
  **Decide:** if this addon's world ever uses a non-default height, `OVERWORLD_Y_BOUNDS` needs a
  manual update — nothing here would catch that automatically.
- Whether `ItemTypes.get()` recognizes this behavior pack's own custom item ids (e.g.
  `bountysys:revolver`) in the real, running game exactly the way it recognizes vanilla ones. The
  typings document it as "registered within Minecraft" generally (no vanilla-only carve-out), and
  the fake API's own pre-existing `ItemTypes`/`fake.itemTypes` design (untouched by this task,
  already present for tests to extend) mirrors that — but this was not confirmed against a real
  world.
- The compass.ts/menu.ts item-id gap noted above: not a bug, but a real, intentional scope cut
  worth a follow-up task if it matters.
