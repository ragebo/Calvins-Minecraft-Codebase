# ARCH-12 test card: finish migrating call sites onto `core/players.ts`

`core/players.ts` already had `players`, `lawPlayers`, `outlaws`, `aliveOutlaws`, `freeOutlaws`, `spectators`
and `prisoners`. This task adds one more cached query, `alivePlayers()` (not eliminated, any role), and a
raid-specific pairing of that cache with an area check, `alivePlayersIn()` in `core/raid.ts`. Four call sites
that used to ask the engine directly (`world.getAllPlayers()` / `world.getPlayers()`) now go through those
instead, so they share the once-per-tick cache every other query already gets:

- `systems/compass.ts` — the law-players loop (`onTick("compass", ...)`) now calls `lawPlayers()`.
- `systems/jailbreak.ts` — `getLawNear()`'s player-listing now calls `lawPlayers()`; its own distance filter is
  untouched.
- `systems/raids.ts` — `getRaidersInRanch()` is gone; its three call sites now call
  `alivePlayersIn({ area: RANCH_AREA, outlawsOnly: true })` directly. `insideRanch()` is untouched (the heal
  loop still calls it on its own).
- `core/raid.ts` — `participantsOf()` now calls `alivePlayersIn()`. `reportWhyNoOneIsInside()` still needs the
  *full* roster (including eliminated players, to explain them), so its internal `everyone()` helper now calls
  `core/players.ts`'s `players()` instead of `world.getAllPlayers()` directly — same centralization, unchanged
  behavior.

**One real behavior change, directed by this task's brief:** the ranch raid's raider count used to be "any
non-eliminated player standing in the ranch, law included" (this was documented as intentional in ARCH-09's
test card: *"Anyone standing inside counts as a raider, tagged or not"*). With `outlawsOnly: true` it is now
outlaws only, matching what the ranch's own heal loop already assumed. **Everything else is behavior-preserving.**

`core/registry.ts` and `core/state.ts` each keep their own direct `world.getAllPlayers()` call — routing either
through `core/players.ts` would create an import cycle (`core/players.ts` already imports `core/state.ts`).
Left alone on purpose; nothing to check for that in game.

## Automated (from `rae/`)

- `npm run check` — clean, no errors.
- `npm test` — ends `ℹ fail 0` (513 tests). New cases: `alivePlayers()`/`alivePlayersIn()` in
  `core-contracts.test.mjs`.
- `npm run check:legacy` — every pattern `ok` or `down`. `player-filter` (the count this task targets) drops
  from 9 to 6 against this branch's fork point; it does not reach 0 because of the two intentional exceptions
  above plus `core/log.ts`'s own already-accepted one.

## In game

Two players: A (law) and B (outlaw). A stopwatch for the ranch section.

1. A runs `/tag @s add law`, holds `bountysys:law_compass`. B runs `/tag @s add outlaw` and stands within
   range.
   Expected: A's action bar reads `NEAREST` and points at B, exactly as before (ARCH-11's card). This exercises
   `lawPlayers()` inside compass's own tick loop.
2. Get B captured and jailed (see `ROUND-LIFECYCLE.md` / `STATE-ADOPT.md` for a capture flow, or
   `/scriptevent bounty:test_capture` run as B). With B in jail, have A stand within `JAILBREAK.lawBlockRadius`
   of the jail and have a third, free outlaw C run `/scriptevent bounty:lockpick` and attempt the pick.
   Expected: C is told "Law is nearby — you can't work on the lock right now!" and the pick does not count,
   exactly as before (`JAIL-FLOW`-style behavior; `getLawNear` unchanged in effect).
3. **(The one changed behavior.)** Stand at the ranch (`-286 69 -53`, area x -295..-277, y 68..83, z -66..-41)
   tagged `law` only (no `outlaw` tag), alone. Run `/scriptevent bounty:ranch`.
   Expected now: "Ranch raid started!" then "No outlaws are inside the ranch." plus one explanation line for
   yourself. **Before this task**, a lone law player here started the raid ("Raid Started! 1 outlaw(s).",
   per ARCH-09's card) — that no longer happens.
4. Now add the `outlaw` tag (remove `law`) and repeat step 3.
   Expected: "Raid Started! 1 outlaw(s)." and mobs spawn, same as always.
5. Stand at the fort (`-17 70 -52`, area x -30..-4, y 69..79, z -65..-39) with no tags, alone, and run
   `/scriptevent bounty:fort`.
   Expected: "Raid started! 1 player(s)." — fort has no `outlawsOnly`, so this is unaffected by the change.

## Content log

No new log lines. Pass condition is the absence of anything new: no `[COMPASS ERROR]`, `[jailbreak]`,
`[raids]` or `[tick]` line in the content log or chat for any of the steps above.

## Pass and fail

- Pass: steps 1, 2, 4 and 5 unchanged from before this task; step 3 now refuses instead of starting.
- Fail: the compass stops tracking, the law-nearby lockpick block stops working, a lone law player still
  starts the ranch raid in step 3, or a lone outlaw in step 4 no longer does.

## Not checked

The game was not run for this task; every expectation above comes from the code and the fake-API tests
(`compass.test.mjs`, `jail-flow.test.mjs`, `raid-explain.test.mjs`, `ranch-cadence.test.mjs`,
`event-exclusion.test.mjs`, `core-contracts.test.mjs`). Step 2's exact capture flow is abbreviated; see
`STATE-ADOPT.md` or `ROUND-LIFECYCLE.md` for the full sequence if `bounty:test_capture` is unavailable.
