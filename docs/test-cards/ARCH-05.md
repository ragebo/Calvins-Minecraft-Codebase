# ARCH-05 test card: `core/persist` — save/restore engine, wired into state and round

`rae/src/core/persist.ts` already had the `Persistable` contract (`registerPersistable`,
`listPersistables`); this task adds the engine (`saveAll`, `restoreAll`), a new script event
(`rae:persist_reset`), and registers `core/state.ts` (records + jail site) and `core/round.ts`
(only `lastEndReason`, never `phase`) as the first two Persistables.

**Nothing about play changes.** No round, jail, gun, or economy behavior is touched. The only
visible new things are: the addon now remembers who was law/outlaw/eliminated/jailed and each
player's ammo/flags across a world reload (previously everything reset to nothing at load, papered
over by the tag-adoption poll re-reading the tags that *did* survive), and the new
`rae:persist_reset` command.

`npm test` pins the engine itself (`persist.test.mjs`, fake dynamic properties, no real world
needed). This card checks the one thing the fake can't: a real script reload.

## Automated (from `rae/`)

- `npm run check` clean.
- `npm test` green, `test/persist.test.mjs` new.
- `npm run check:legacy`: no pattern rises. In particular `error-to-chat` does not move — this
  file reports failures with `console.error`, not a chat broadcast, on purpose (see the code
  comment; matches `core/round.ts`'s own subscriber-isolation error handling).

## Setup

1. From `rae/`: `npm run build`. `your_pack_name_BP/scripts/core/persist.js` should be newer than
   before, and `state.js`/`round.js` should have grown slightly. If the world keeps running old
   scripts, bump the behavior pack version (README, "Building and testing").
2. Content Log GUI on (Settings > Creator > Enable Content Log GUI), chat visible.
3. `/scriptevent rae:debug` — sanity check nothing else broke: `Systems:` and `Events:` lines look
   the same as before this task (persist adds no `registerSystem`, and `rae:persist_reset` is a
   script event, not a system).

## A. State survives a reload

1. Two players: L (law), A (outlaw). `/scriptevent bounty:start_round` or hand-tag + `rae:adopt`
   as in `ARCH-03.md`. Get A jailed once (any capture works — see `ARCH-03.md` section B), so A
   carries `jailed`, and give A some ammo (fire a gun a couple of times, or `/scriptevent
   rae:debug` won't show ammo directly — firing a shot is the visible proxy for "ammo state
   exists").
2. Close the world (or the client entirely) **without** resetting, then reopen it and rejoin.
   Expected: within about a second, `RAE loaded.` in chat as usual, and `/tag @s list` for both
   players shows the same tags they had before closing (the tags themselves are vanilla player
   data and would survive anyway — this step is the control). Now confirm the *script's own*
   memory came back, not just the tags: `/scriptevent rae:adopt` should NOT report any surprising
   change (if persist did nothing, the record would already recover from tags alone via
   `state:adopt-at-load`, so this step alone can't distinguish them — B does).
3. Have L capture A a **second** time (elimination). Watch chat for the elimination line, exactly
   as `ARCH-03.md` section D describes.
   Expected: works exactly as before. `captures` (used to decide first-jail vs. eliminate) came
   back from the saved record, not just re-derived from the `jailed` tag (both give the same
   answer here — this is a smoke test that nothing broke, not a proof of the save path; B4 below
   is the real proof).

## B. The part tags alone cannot prove: ammo/flags survive a reload

Tags never carried ammo. If ammo comes back after a reload, it came from `core/persist`, not from
tag adoption.

1. A holds a revolver (or any gun with limited ammo/reload behavior) and fires once or twice, so
   its chambered-rounds count is below full.
2. Close and reopen the world (same as A2). Let the addon finish loading (`RAE loaded.`).
3. A fires again immediately.
   Expected: the gun continues from where it left off (no full-magazine reset). If ammo tracking
   resets to full on every reload, this task's `state` restore did not run — check the content log
   for a `[persist]` line (see below).

## C. `rae:persist_reset`

1. With some round state active (from A), run `/scriptevent rae:persist_reset`.
   Expected: chat `§7Persisted data cleared (N keys). Takes effect on the next load.` N is at
   least 2 (`state`, `round`). **Nothing else happens**: tags, ammo, the active round, all of it is
   completely unaffected right now — `/scriptevent rae:adopt` and `/tag @s list` immediately after
   look identical to before the command.
2. Close and reopen the world.
   Expected: the round state machine starts at its usual defaults (no round in progress —
   unsurprising, nothing wires round *phase* back regardless). More telling: A's ammo from part B
   is back to a fresh gun's default, because there was no saved `state` blob left to restore from.
   Tags-derived state (role, jailed, etc., since those are real player data) still comes back as
   usual — `rae:persist_reset` only removes what `core/persist` itself was holding.
3. `/scriptevent bounty:start_round` afterwards.
   Expected: works normally. The reset did not corrupt anything registration-related.

## Content log

- **Must not appear:** `InvalidEntityError`, any `[Scripting][error]` line, and no `[PERSIST` chat
  line (persist reports its own failures to the content log via `console.error`, prefixed
  `[persist]`, never to chat — a `[persist] "state" failed to ...` or `[persist] "round" failed to
  ...` line anywhere is a fail and worth pasting in full).
- **Lines to look for:** `§7Persisted data cleared (N keys). Takes effect on the next load.` after
  step C1, and nothing else new — this task adds no other chat output.

## Not checked

- The game was not run for this task; everything above is from the fake-API tests and the code.
- Whether a real world reload actually re-runs `system.runInterval`/module top-level code the same
  way a fresh script load does (assumed, per the project's existing `state:adopt-at-load` comment,
  which relies on the same assumption for tag adoption).
- The real per-property and total dynamic-property byte limits enforced by the engine itself
  (`PERSIST.maxSavedCharsPerKey` = 10000 chars is a self-imposed guard well under whatever those
  are, chosen without a real-game measurement of the actual ceiling).
