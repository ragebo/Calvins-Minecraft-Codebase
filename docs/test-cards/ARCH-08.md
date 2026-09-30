# ARCH-08 test card: one sound module (`core/sound`)

The new module `rae/src/core/sound.ts` is the one place `Player.playSound`/`Dimension.playSound`
gets called now (CLAUDE.md rule 5's "one writer per channel", the sibling of ARCH-06's `core/log`).
It replaces 5 scattered direct calls: `systems/guns.ts`'s shared `playCue`/`playCues` (positional,
used by every gun's fire/reload/prime cues, including the Gatling gun's) and its `playDryClick`
helper (private), `systems/compass.ts`'s mode-switch click (private), and
`systems/jailbreak.ts`'s lockpick ping/success chimes (private, and their surrounding try/catch —
now redundant since `core/sound.ts` itself never lets a bad cue throw — is gone).

Two functions, not one, because the distinction is real: `playFor` (`Player.playSound`) is private —
only that one player hears it — and `playAt` (`Dimension.playSound`) is positional — everyone near
the location hears it. `playSequence` generalizes the old `playCue`/`playCues`: a list of cues, some
delayed by `delayTicks`, each delayed one re-checking the player is still valid and — if the caller
passed one — that a `shouldPlay()` closure still holds (guns.ts passes `() => stillUsing(player,
gun)`, exactly its old check). `core/sound.ts` itself knows nothing about a "gun": it takes a plain
closure instead.

**What must change:** a bad cue id (or an out-of-range pitch/volume) is now reported once via
`core/log.ts`'s `error("sound", ...)` — console + the online operators' chat — instead of guns.ts's
old `world.sendMessage(\`§c[GUN SOUND ERROR] ...\`)` broadcast to every player. jailbreak.ts's two
`try { player.playSound(...) } catch { error("jailbreak", ...) }` blocks are gone; `playFor` already
guarantees it never throws.

**What must not change:** every gun's fire/reload/prime cue still plays positionally, at the same
volume/pitch/delay it always did; dry-fire clicks, the compass mode-switch click, and the jailbreak
ping/success chimes are still private (only the acting player hears them); a reload's remaining cues
are still silenced by swapping away, dismounting, or disconnecting mid-sequence. No game number,
timing, or sound id changed.

## Automated (from `rae/`)

- `npm run check` prints only the `tsc --noEmit` line and exits 0.
- `npm test` ends with `ℹ fail 0` (512 tests). New tests are in `rae/test/sound.test.mjs`, testing
  `playFor`/`playAt`/`playSequence` directly (private vs positional, default location, the
  `shouldPlay`/`positional` options, a delayed cue skipped for an invalid player, one bad cue not
  stopping the rest of a sequence, and the once-per-id dedup — moved and rewritten from
  `guns-sounds.test.mjs`, which now only keeps the gun-integration half of that old test: a bad cue
  in a real gun's config can't break the shot or its other cues). `compass.test.mjs`,
  `jail-flow.test.mjs` and the rest of `guns-sounds.test.mjs`/`guns-controls.test.mjs` needed no
  changes — they already asserted on `fake.dimension("overworld").played` /
  `player.privateSounds`, which is unchanged.
- `npm run check:legacy` (vs `main`): `sound-direct` drops from 5 to 0, as required. One other
  pattern, `player-filter`, shows `RISES` (8 to 9) — verified **pre-existing on `v2`'s tip, before
  any ARCH-08 change** (`git grep` of `world.getAllPlayers|getPlayers` on `v2`'s HEAD alone already
  totals 9; this task's diff touches no such call). Run with `LEGACY_BASE_REF=v2` (this branch's
  real fork point) instead: everything is `ok` or `down` — `sound-direct` 5 to 0 and, as a bonus,
  `error-to-chat` 1 to 0 (the one `§c[GUN SOUND ERROR]` line ARCH-06's own test card named as the
  line it deliberately left behind for this task). Nothing rises against `v2`.

## Setup

- Creative world with the RAE pack, cheats on, Content Log GUI on (Settings > Creator > Enable
  Content Log GUI).
- A second player, B, nearby but not holding/riding anything of the first player's — to check the
  positional/private split by ear.
- Be (or have) an operator online, to see step C's chat line.
- `cd rae && npm run build`. Bump the behavior pack version if the world keeps running old scripts
  (README, "Building and testing").

## A. Positional cues: a bystander hears gunfire

1. Player A equips any gun (e.g. the revolver) with ammo loaded; player B stands within earshot but
   isn't holding a gun.
2. A fires. Expected: unchanged from before — **both** A and B hear the fire cue(s), at the gun's
   configured volume/pitch, coming from A's position.
3. A empties the magazine and reloads (or presses Q). Expected: both A and B hear the reload
   sequence on the same schedule as before.
4. A swaps away to an empty hand mid-reload. Expected: unchanged — the rest of the reload sequence
   goes silent for both A and B (the old `stillUsing` check, now `playSequence`'s `shouldPlay`).

## B. Private cues: only the acting player hears them

1. A dry-fires an empty gun (or the Gatling gun's own dry click while mounted). Expected: only A
   hears the click; B hears nothing.
2. A holds the law compass, sneaks, and uses it to switch modes. Expected: only A hears the click.
3. An outlaw attempts the jailbreak lockpick minigame (`bounty:lockpick`) near a second player who
   is not attempting it. Expected: only the picking player hears the ping (pitch varying with how
   close the guess was) and the success chime; the bystander hears nothing. This is unchanged from
   before this task — it was already `Player.playSound` — this step just confirms the refactor kept
   it private.

## C. A bad cue is reported once, to the operator only

1. As an operator, temporarily give a gun's fire cue a bad id (this needs a source edit + rebuild —
   e.g. change `revolver`'s first fire cue id in `config/guns.ts` to something misspelled — or skip
   to the content-log check in `npm test` if you'd rather not touch source for this step).
2. Fire that gun twice. Expected: it still fires (damage/effects unaffected), a non-operator
   bystander sees and hears nothing, and **you** (the operator) see one red chat line shaped
   `[sound] <bad id>: <error>` — not two, even though you fired twice.
3. Check the content log: one matching `console.error` line, `[sound] <bad id>: ...`.
4. Revert the id and rebuild.

## Pass and fail

- Pass: section A's cues still carry to a bystander on the same schedule as before; section B's
  cues stay private; section C shows exactly one operator-only report for a repeated bad id, and
  firing/reloading is otherwise unaffected.
- Fail: a bystander hears a dry click, a compass click, or a lockpick ping/success chime; gunfire or
  a reload goes silent for a bystander; a bad cue throws, breaks firing, reaches a non-operator's
  chat, or is reported more than once for the same id.

## Content log

Look for `[sound] <id>: <error text>` — a bad cue, reported once per id, `console.error` level.
Everything else (`[gun effects] ...`, `[aim] ...`, `[jailbreak] ...` for non-sound failures) is
unchanged from before this task.

## Not checked

The game was not run for this task; every expectation above comes from the code and the fake-API
tests (`rae/test/sound.test.mjs` plus the existing `guns-sounds.test.mjs`, `guns-controls.test.mjs`,
`compass.test.mjs` and the jailbreak tests in `jail-flow.test.mjs`, none of which needed changes
beyond the one moved assertion called out above).

- The exact in-game feel of a positional cue's falloff with distance (unchanged engine behavior,
  not something this task touches).
- Section C's real-game chat/content-log formatting was not opened in game to confirm — it follows
  directly from `core/log.ts`'s own `error()`, already characterized by ARCH-06's test card.
- Whether `player-filter`'s pre-existing rise against `main` (see Automated) needs its own cleanup
  task — flagged for the orchestrator, not fixed here (outside this task's allowed paths).
