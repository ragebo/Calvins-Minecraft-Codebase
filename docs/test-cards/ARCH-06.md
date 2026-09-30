# ARCH-06 test card: one log/error module (`core/log`)

The new module `rae/src/core/log.ts` is the one place a failure or a diagnostic goes now. It
replaces two idioms V1 left scattered everywhere: `world.sendMessage("§c[TAG ERROR] ...")`, which
put every failure in every player's chat whether they could act on it or not (38 sites across the
codebase), and ad hoc `console.warn`/`console.error` calls with a hand-rolled `[tag]` prefix that
only someone watching the content log ever saw (about a dozen more). Every one of those sites now
calls `debug()`, `info()`, `warn()` or `error()` from `core/log.ts` instead.

**What must change:** a genuine failure (e.g. a missing scoreboard, a bad structure name, a raid
that can't spawn a mob) no longer appears as a red line in every player's chat. It always goes to
the content log (`console.warn` for `debug`/`info`/`warn`, `console.error` for `error`), and
`error()` additionally messages an **operator** (or a specific player, if the caller names one) —
never a broadcast to everyone. One exception, called out below, is intentionally not migrated yet.

**What must not change:** every other chat line (round announcements, "you were captured", coin
totals, etc.) is untouched — only the red `§c[TAG ERROR]`-style lines and the ad hoc
`console.warn`/`console.error` calls moved. No game number or timing changed.

**New:** `/scriptevent rae:log_debug on|off` toggles a debug-logging gate (`debug()` is silent
until this is on). It is a dev/ops toggle, not round state, so a round reset does not affect it.

## Automated (from `rae/`)

- `npm run check` prints only the `tsc --noEmit` line and exits 0.
- `npm test` ends with `ℹ fail 0` (462 tests). New tests are in `rae/test/log.test.mjs`. Every test
  that used to assert on the exact `§c[TAG ERROR]` chat text (`compass.test.mjs`, `tick.test.mjs`,
  `dead-entity.test.mjs`, `player-id-keys.test.mjs`, `load-smoke.test.mjs`, `aimprobe.test.mjs`,
  plus `train-cadence.test.mjs` and `event-exclusion.test.mjs`, found during this task) now asserts
  on `console.error` output instead, and that nothing new lands in `fake.chat`.
- `npm run check:legacy`: `error-to-chat` drops from 36 to 1 (the one intentionally unmigrated
  site below); every other pattern is `ok` except `player-filter`, which rises by exactly 1 — the
  one `world.getAllPlayers()` call inside `error()` itself, needed because `core/log.ts` cannot
  import `core/players.ts` (see the file's own comment). That is a known, accepted consequence of
  this module's design, not a new bug.

## Setup

- Creative world with the RAE pack, cheats on, Content Log GUI on (Settings > Creator > Enable
  Content Log GUI).
- Be the world owner/host, or otherwise an **operator** — `error()`'s player-facing message only
  reaches operators (or whoever `options.to` names), so a non-operator will see nothing in chat for
  any step below even though the console line still appears.
- `cd rae && npm run build`. Bump the behavior pack version if the world keeps running old scripts
  (README, "Building and testing").

## 1. The module loaded, and the new event is not in the public list

1. Load the world and wait a second. Expected: green `RAE loaded.` in chat, as before.
2. Run `/scriptevent rae:debug`. Expected: the `Systems:` line is unchanged (`core/log` registers
   no system — the debug flag is not round state). The `Events:` line is also unchanged: it does
   **not** list `rae:log_debug`, because that event is registered directly on the engine signal,
   not through `core/events.ts`'s shared registry (see `core/log.ts`'s comment on why). This is
   expected, not a bug — `rae:log_debug` still works, per step 3 below.
3. Run `/scriptevent rae:log_debug on`. Expected: a gray chat line, `Debug logging is now on.`
4. Run `/scriptevent rae:log_debug off`. Expected: `Debug logging is now off.`
5. Run `/scriptevent rae:log_debug maybe`. Expected: a yellow usage line
   (`Usage: /scriptevent rae:log_debug on|off`), and the flag is unchanged.

## A. An error no longer goes to everyone's chat

A second player, B, is nearby and **not** an operator (if only one player is available, skip the
"B sees nothing" checks and rely on the content log instead).

1. As the operator, remove a scoreboard the game needs: `/scoreboard objectives remove coins`.
2. Run `/scriptevent rae:debug`.
   Expected: **you** (the operator) see a red line naming the missing objective (something like
   `[economy] Missing scoreboard objectives: coins`). **B sees nothing at all.** Before this task,
   this line went to every player, in red, with a `[ECONOMY]` tag.
3. Check the content log. Expected: a `console.error` line with the same text, `[economy] Missing
   scoreboard objectives: coins`.
4. Restore the scoreboard: `/scoreboard objectives add coins dummy`.

## B. A routine content-log line is unaffected

1. With debug logging off (`/scriptevent rae:log_debug off`), run
   `/scriptevent rae:aim_spike log on`, then swing, right-click and drop the `bountysys:aim_probe_plain`
   item a few times.
   Expected: unchanged from before — `[aim-spike] ...` lines appear in the content log for every
   action, and nothing appears in chat except the spike's own "Logging on" confirmation. This
   exercises `warn()` (always on), not the new `debug()` gate.
2. Run `/scriptevent rae:aim_spike log off`.

## Pass and fail

- Pass: step 1 shows `RAE loaded.` and an unchanged `Systems:`/`Events:` line; step A shows the
  missing-scoreboard line reaching only the operator and the content log, never a second,
  non-operator player; step B is unchanged from before this task.
- Fail: the missing-scoreboard line (or any other migrated error) appears in a non-operator's chat;
  `rae:log_debug on|off` does not reply, or does not actually gate `debug()`-based content-log
  lines (there is no in-game feature that calls `debug()` yet, so this is really only checkable via
  `npm test`'s `log.test.mjs`); anything in chat still uses the old `§c[TAG ERROR]` look.

## Content log

Look for lines of the shape `[source] message` — e.g. `[economy] Missing scoreboard objectives:
coins`, `[compass] <player>: <error>` (throttled to at most once every 200 ticks per the existing
compass logic, unchanged), `[jailbreak] ...`, `[train] ...`. A failure now uses `console.error`
(shows as `[Scripting][error]` in the log, not `[Scripting][warn]`) — that's the intended, new way
to tell a genuine failure apart from routine tracing at a glance.

## Not checked

The game was not run for this task; every expectation above comes from the code and the fake-API
tests (`rae/test/log.test.mjs` and the fixed tests listed under Automated).

- The exact visual look of `console.error` vs `console.warn` in the real Content Log GUI (both are
  assumed to render distinctly, per the engine's own log-level convention, but this was not opened
  in game to confirm).
- Every one of the ~50 migrated sites individually — `npm test` characterizes the ones that had
  existing tests; the rest (e.g. `[HORSE ERROR]`, `[GOLD ERROR]`, most of `[TRAIN ERROR]`) only had
  a chat-text check removed by this task if one existed, per file, and were otherwise not previously
  covered by an automated test either.
- `systems/guns.ts`'s `[GUN SOUND ERROR]` line (inside `playCue()`) is **deliberately** still the
  old `world.sendMessage` idiom — that whole function is being deleted by separate, parallel work
  on `core/sound.ts`, per this task's brief. It is the one line `check:legacy`'s `error-to-chat`
  still counts.
