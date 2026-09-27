# ARCH-14 test card: `core/telemetry` — round history (kills, deaths, duration, outcome)

New module `rae/src/core/telemetry.ts`: `recentRounds()` (newest first, capped at
`TELEMETRY.maxStoredRounds` = 20), `totalKills()`, `totalDeaths()`. It rides `core/persist`'s
engine as its own `"telemetry"` key (no separate dynamic property) and, unlike every
`registerSystem`-based module, has **no round-reset hook on purpose** — a round reset must never
erase the history of the round that just finished, the same reason `core/economy.ts`'s coin
balances survive one.

**Important — please read before testing:** `core/round.ts`'s phase machine (`startRound`,
`beginActive`, `endRound`, `resetRound`) is not yet called by anything in actual play.
`systems/endgame.ts` and `systems/boat.ts` each decide and announce a win with their own local
`roundEnded` flag, entirely independent of `core/round.ts` — that wiring is a separate, later task
(this worktree sits before it landed). This task's own automated tests drive `core/round.ts`
directly, exactly as `core-contracts.test.mjs`'s existing round tests already do, and that is
fully verified. **But it means that in the game as it stands right now, `onPhase("ACTIVE"/"ENDED"/
"IDLE", ...)` never fires from real play, so `recentRounds()` will stay empty and `totalKills()`/
`totalDeaths()` will stay 0 no matter how many rounds are actually played**, until whatever task
wires `core/round.ts` into `roles.ts`/`endgame.ts`/`boat.ts` lands. Nothing else in this task can
be shown in game beyond that one honest fact, and step 2 below is how to confirm it.

## Automated (from `rae/`)

- `npm run check` clean.
- `npm test` green. New tests in `rae/test/telemetry.test.mjs`: a normal round
  (ACTIVE→ENDING→ENDED), an abort (ACTIVE→IDLE directly), a SETUP→IDLE cancellation producing no
  record, an ENDED→IDLE reset not double-recording, the ring buffer capping at
  `TELEMETRY.maxStoredRounds`, kill/death attribution (law vs. outlaw, no killer, a mob death not
  counted), and a save/restore round-trip through `core/persist`'s real engine.
- `npm run check:legacy`: no pattern rises.

## Setup

1. From `rae/`: `npm run build`. `your_pack_name_BP/scripts/core/telemetry.js` should now exist,
   and `main.js` should import it. If the world keeps running old scripts, bump the behavior pack
   version (README, "Building and testing").
2. Content Log GUI on, chat visible.

## 1. The module loaded and is wired in

1. Load the world, wait a second.
   Expected: `RAE loaded.` in chat, no new errors. Telemetry adds no system (by design) and no
   script event, so `/scriptevent rae:debug`'s `Systems:`/`Events:` lines are unchanged from
   before this task — that absence is itself the expected result, not a sign it failed to load.

## 2. What can actually be confirmed right now

1. Two players, L (law) and A (outlaw). Do **not** run `bounty:start_round` — role assignment
   there is independent of `core/round.ts` too, so it wouldn't demonstrate anything more than
   hand-tagging would. Just get a real player kill: L kills A with a weapon.
   Expected: play proceeds completely normally (capture/elimination messages as in
   `ARCH-03.md` section B) — telemetry's own `onDeath` handler (order 300, after every existing
   one) only reads state and counts internally; it sends no chat, changes no tag, grants no coin.
   **No `[TELEMETRY` or `[persist]` line should appear anywhere.**
2. There is currently no in-game command that prints `recentRounds()`/`totalKills()`/
   `totalDeaths()` (this task adds none — see the brief). The only way to observe the numbers
   right now is through `npm test`. This is expected, not a gap to chase down in this pass.

## Content log

- **Must not appear:** `InvalidEntityError`, any `[Scripting][error]` line, and no `[persist]
  "telemetry" ...` line (telemetry's `save()`/`restore()` are plain data and should never fail;
  one failing is worth pasting in full).
- **Lines to look for:** none — this task adds no chat output of its own.

## Not checked

- The game was not run for this task; everything above is from the fake-API tests and the code.
- Everything that would make telemetry's numbers actually move in a real game (`core/round.ts`
  wired into `roles.ts`/`endgame.ts`/`boat.ts`) is out of this task's scope; see the note at the
  top. Once that lands, no further change to `core/telemetry.ts` should be needed — it is already
  written against `core/round.ts`'s real contract and tested directly against it.
