# ARCH-13 test card: versioned config schema and migration path

**This task has no in-game behavior.** It adds one constant to each of `rae/src/config/world.ts`, `balance.ts` and `guns.ts` (`WORLD_SCHEMA_VERSION`, `BALANCE_SCHEMA_VERSION`, `GUNS_SCHEMA_VERSION`, all `1`) and a new pure module, `rae/src/config/schema.ts` (a config fingerprint plus a migration finder). Nothing imports the new module yet, so it never runs in the game. No number, coordinate, event id or rule changed.

The only thing to confirm in game is that the addon still loads exactly as before, with no new errors.

## Automated (from `rae/`)

- `npm run check` prints only the `tsc --noEmit` line and exits 0.
- `npm test` ends with `ℹ fail 0`. The new tests are in `rae/test/schema.test.mjs`.
- `npm run check:legacy` shows every pattern as `ok` or `down`, none as `RISES`.

## In game

1. From `rae/`, run `npm run build`.
   Expected: no errors. `your_pack_name_BP/scripts/config/` now holds `schema.js` next to `world.js`, `balance.js` and `guns.js`. It is compiled but nothing imports it.
2. Open a world that has the behavior pack applied, with the content log visible (Settings > Creator > Content Log GUI; Ctrl+H toggles it).
3. Wait a second after the world loads.
   Expected: green `RAE loaded.` in chat. That line only appears if `main.js` and everything it imports loaded, including the three config files that changed. If the world has no `coins` or `bounty` scoreboard objectives you will also see the existing `[ECONOMY] Missing scoreboard objectives: ...` line. It is unrelated to this task.
4. Run `/scriptevent rae:debug`.
   Expected: `=== RAE DEBUG ===`, a `Systems:` line that still includes `roles`, `jail`, `jailbreak`, `raids`, `train`, `boat`, `guns`, `compass` and `endgame`, and an `Events:` line that still includes all ten public ids: `bounty:start_round`, `bounty:teleport`, `bounty:fort`, `bounty:ranch`, `bounty:train`, `bounty:escape`, `bounty:lockpick`, `bounty:test_capture`, `rae:debug`, `rae:reset`.
5. Read the content log.
   Expected: **no new lines** compared with loading the world before this change. There is no line to look for; the pass condition is the absence of new errors. In particular no script error and nothing mentioning `schema`, `SCHEMA_VERSION`, `world.js`, `balance.js` or `guns.js`.

## Pass and fail

- Pass: steps 1 to 4 as expected and nothing new in the content log.
- Fail: `RAE loaded.` is missing, a red `[...]` chat line other than the scoreboard note in step 3 appears, or the content log shows a script error. Then check that `world.js`, `balance.js` and `guns.js` under `your_pack_name_BP/scripts/config/` each contain one `export const ..._SCHEMA_VERSION = 1;` line.

## Not checked

The game was not run for this task. The Content Log menu path and shortcut in step 2 are from memory of the Bedrock UI and were not checked against the installed build.
