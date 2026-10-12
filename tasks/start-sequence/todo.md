# Todo: the start sequence

Status source of truth for `plan.md` in this folder. Every task: RED first (a failing test), then the code, then `check`, `test`
(`node scripts/test.mjs`) and `check:legacy` as one chain, then one commit. Deliberate-break (mutation) runs on the new rules, as before.

## Phase 1: Foundation

- [x] **Task 1: Shots, the command list and the START config** (M) - done
  `logic/start.ts` (pure, no game imports): a `Shot` is a name and two marks (position and the way the camera faces); its saved text
  and the parse back (malformed input never throws); `pickShots(pool, count, previousFirstId, random)`; `secondsPerShot(total, count)`;
  the start-command list: `cleanCommand` (trim, one leading `/` dropped, empty or over-long or multi-line refused), `addCommand`,
  `editCommand`, `removeCommand` (immutable, capped, index checked). `config/balance.ts` gets a `START` block: `introEnabled`,
  `introSeconds` 10, `shotsPerStart` 2, `pickSeconds` 20, `flyDownSeconds` 3, `flyDownHeight` 30, caps (`maxShots` 12, `maxCommands`
  20, `maxCommandChars` 200, `maxSavedChars`), and `defaultCommands` (the plan's list).
  - Acceptance:
    - [x] a shot survives save and parse exactly; text that is damaged, has a NaN, a pitch outside -90..90 or a height outside the world gives a reason and no shot
    - [x] `pickShots` returns distinct shots, never more than the pool, never the same first shot as last time when the pool has another, and is exact with a fixed random
    - [x] `secondsPerShot(10, 2)` is 5; a count of 0 or a total of 0 cannot divide by zero
    - [x] a command is cleaned the same way every time; a line over the cap, an empty line and a line with a newline are refused with a reason; add/edit/remove never change their input and respect the cap
  - Verification: check, test; deliberate breaks on every rule above
  - Result: 16 new tests (shots, picking, seconds, ids, the command list and its edits, the START defaults). 46 deliberate breaks on logic/start.ts, all caught (one is guarded by the type checker itself); running them found 6 gaps in my own tests (the end mark's rounding, a yaw range, the z edge, an id that only ends like one, a space after the slash, a saved list at exactly the cap, the shuffle's range) and each got a check. START is in config/balance.ts; nothing reads it yet.
  - Dependencies: None
  - Files: `rae/src/logic/start.ts`, `rae/src/config/balance.ts`, `rae/test/start-logic.test.mjs`

- [ ] **Task 2: Saving shots and start commands in the world** (S)
  `core/startstore.ts` on `core/recordstore.ts` (the store shops and robberies use): shots one world property each, the command list
  one more. A list never saved means the defaults; a list saved empty means "run nothing" (the two are different on purpose).
  - Acceptance:
    - [ ] save, read, list, delete and undo of a shot; a save over the cap is refused with a reason and changes nothing
    - [ ] the default commands come back when nothing was saved, and an empty saved list stays empty
    - [ ] after a script reload (forget loaded) everything reads back the same
    - [ ] an unreadable record is listed and never overwritten
  - Verification: check, test
  - Dependencies: Task 1
  - Files: `rae/src/core/startstore.ts`, `rae/test/start-store.test.mjs`

- [ ] **Task 3: The camera and lock wrapper, and the fake that lets tests see them** (S-M)
  `core/cinematic.ts` is the only file that calls `player.camera` and `player.inputPermissions`: `lock`/`unlock` (movement),
  `playShot(player, shot, seconds)` (the camera appears at the start mark at once, then eases to the end mark over `seconds`),
  `flyDown(player, spawn, seconds)` (starts `flyDownHeight` above the spawn looking down, eases to eye level), `clearCamera`,
  `unlockEveryone`. Each call is wrapped: an engine error is logged once per kind and never thrown. `rae/test/fake/minecraft-server.mjs`
  gets additive support (named here because that file is otherwise off limits): `player.camera.setCamera/clear/fade` recorded in a call
  list (and `fake.cameraError` covers them), `player.inputPermissions` with its state, and the `InputPermissionCategory` and
  `EasingType` enums.
  - Acceptance:
    - [ ] `playShot` makes exactly two `setCamera` calls: the start with no ease, then the end with `easeTime` equal to the seconds given
    - [ ] `flyDown` starts above the spawn looking straight down and ends at eye height, with the ease time given
    - [ ] lock then unlock restores movement; `unlockEveryone` unlocks every online player and clears their cameras
    - [ ] an engine error from any call is swallowed and logged once; a player who left (invalid) is skipped
    - [ ] the whole existing suite still passes with the fake's additions (run before and after)
  - Verification: check, test; deliberate breaks
  - Dependencies: Task 1
  - Files: `rae/src/core/cinematic.ts`, `rae/test/fake/minecraft-server.mjs`, `rae/test/cinematic.test.mjs`

### Checkpoint: Foundation
- [ ] all green; nothing visible in game yet

## Phase 2: The sequence

- [ ] **Task 4: Start commands run when a game starts** (M)
  `core/startsequence.ts` (first part): `runStartCommands(by?)` runs the saved list in order as the server (overworld dimension), and
  `begin()` in `core/game.ts` calls it after the roles are assigned and before anything else. A command that throws is reported to
  `by` (the operator who pressed Start, when there is one) and to the log, and the rest still run. `startRandomRound` and
  `startChosenRound` take an optional `by`; the menu passes the player.
  - Acceptance:
    - [ ] with the defaults, a Start sends the seven default commands to the dimension in order, after roles exist (so `@a[tag=law]` would match)
    - [ ] a command is sent without its leading `/`
    - [ ] one that throws is reported by name to `by`, and the commands after it still run and the round still starts
    - [ ] an empty saved list runs nothing; sitting-out players are not affected by the code (the commands' own selectors decide)
    - [ ] a Start from the script event (no `by`) logs a failure instead of telling nobody
  - Verification: check, test; deliberate breaks
  - Dependencies: Tasks 2, 3
  - Files: `rae/src/core/startsequence.ts`, `rae/src/core/game.ts`, `rae/src/systems/menu.ts`, `rae/test/start-commands.test.mjs`

- [ ] **Task 5: The camera intro before the reveal** (M)
  Staged with a generation token (`core/startsequence.ts`, second part): when the intro is on and at least one shot is saved, lock the
  playing players, pick `shotsPerStart` shots, play each for `secondsPerShot` on a timer chain for everybody at once, then continue
  into what happens today (spawn, reveal, play). No shots, or the intro switched off: nothing changes. A reset or another Start cancels
  the stage that is waiting, unlocks everyone and clears their cameras.
  - Acceptance:
    - [ ] playing players are locked and in a camera during the intro; sitting-out players are not
    - [ ] shots play in order, each cut at the right tick (checked with fake time), 10 s in total with the defaults
    - [ ] the same pool never repeats the previous Start's first shot
    - [ ] a round reset mid-intro: everyone unlocked, cameras cleared, no later step runs; a second Start mid-intro takes over cleanly
    - [ ] no shots saved: no camera call, no lock, and the existing timing is unchanged
    - [ ] a player who leaves mid-intro does not stop the others
  - Verification: check, test; deliberate breaks
  - Dependencies: Task 4
  - Files: `rae/src/core/startsequence.ts`, `rae/src/core/game.ts`, `rae/test/start-intro.test.mjs`

- [ ] **Task 6: Reveal, outlaw fly-down, law picks a spawn, then play** (L, the biggest)
  Replaces the end of `begin()`. After the intro (or straight after the commands when there is none): titles LAWMAN/OUTLAW and
  "Roles Assigned!" show; outlaws are teleported to a random outlaw spawn and fly down to it; law players get a screen of the law
  spawns with a `pickSeconds` countdown; a law player placed by choice or at random; play (`beginActive`) starts when every law player
  has chosen or the countdown ends, whichever is first, everyone unlocked and cameras cleared in the same tick. "Rolling..." is gone.
  - Acceptance:
    - [ ] roles are revealed at the start of this stage, not at the end
    - [ ] an outlaw lands at one of the outlaw spawns, with a fly-down that ends at their eyes; they stay locked until play begins
    - [ ] every law player gets the spawn screen with one button per law spawn; choosing teleports them there, and two players may choose the same one
    - [ ] play starts at once when the last law player chooses, and after `pickSeconds` otherwise, with the unpicked placed at a random law spawn
    - [ ] a pick that arrives after the countdown is ignored (no teleport, no second `beginActive`)
    - [ ] no law players: no screen, play starts after the fly-down; nobody to fly down: play starts at once
    - [ ] a reset or a second Start mid-stage cancels the countdown, the screens' effects and the locks; a law player leaving does not hang the round
    - [ ] `beginActive` is called exactly once per Start in every path
    - [ ] the existing start tests are updated for the new timing and the new titles, each for a stated reason (`round-flow`, `ui`, `menu`, `load-smoke`)
  - Verification: check, test, check:legacy; deliberate breaks on every branch
  - Dependencies: Task 5
  - Files: `rae/src/core/startsequence.ts`, `rae/src/core/game.ts`, `rae/test/start-reveal.test.mjs`, `rae/test/round-flow.test.mjs`, `rae/test/ui.test.mjs`, `rae/test/menu.test.mjs`, `rae/test/load-smoke.test.mjs`

### Checkpoint: the sequence
- [ ] all green; a whole Start under fake time reaches ACTIVE every way it can end

## Phase 3: Customizing it

- [ ] **Task 7: The start-commands screen** (M)
  `core/startforms.ts` (the operator's screens, on `core/screens.ts`), opened from a new "Start sequence" button in the RAE menu that
  only operators see: the numbered list, Add (a text box), Edit one (the box prefilled; an empty box deletes it), Reset to defaults, Back.
  Refusals show on the next screen.
  - Acceptance:
    - [ ] add, edit, delete and reset change what the next Start runs
    - [ ] a refused line (too long, empty on add, over the cap) says why on the same screen and changes nothing
    - [ ] a non-operator never sees the button and cannot open the screens by any route
    - [ ] closing a screen with Esc leaves the list as it was
  - Verification: check, test; deliberate breaks
  - Dependencies: Tasks 2, 4
  - Files: `rae/src/core/startforms.ts`, `rae/src/systems/menu.ts`, `rae/test/start-forms.test.mjs`

- [ ] **Task 8: The camera-shots screen** (M)
  In `core/startforms.ts`: the shot list, "Mark the start of a new shot here" (position and the way you are facing, kept on the operator
  until the end is marked), "Mark the end here" (saves the shot, asks for an optional name), Cancel marking, Preview (plays that one
  shot for the operator alone, then clears their camera), Delete.
  - Acceptance:
    - [ ] marking start then end saves a shot whose marks are the operator's position and facing at each moment
    - [ ] a pending start survives the screen closing and shows up when reopened; Cancel clears it
    - [ ] Preview moves only the operator's camera, does not change the round phase, and ends with their camera cleared and movement restored
    - [ ] a save over `maxShots` is refused with the reason; delete asks for nothing more than the button
  - Verification: check, test; deliberate breaks
  - Dependencies: Tasks 3, 7
  - Files: `rae/src/core/startforms.ts`, `rae/test/start-shots-forms.test.mjs`

- [ ] **Task 9: Live numbers, docs and the test card** (M)
  `core/configoverrides.ts` registers the START numbers (`start.introEnabled`, `start.introSeconds`, `start.shotsPerStart`,
  `start.pickSeconds`, `start.flyDownSeconds`, `start.flyDownHeight`) so the config editor and `/rae:config` change them live.
  `docs/test-cards/START-SEQUENCE.md` (numbered in-game steps: marking a shot, previewing it, a Start with law and outlaw, a late
  pick, a mid-sequence reset, one failing command, the bag-clearing default; and what only the real game can answer).
  README and ARCHITECTURE.md rows (named here because the rules normally forbid editing them).
  - Acceptance:
    - [ ] each number is a registered setting with a range, changes the next Start, and resets to its default
    - [ ] the card has every step the owner needs, and says what is unmeasured
    - [ ] README and ARCHITECTURE.md say where the sequence lives; `git status` is clean after the commit
  - Verification: check, test, check:legacy
  - Dependencies: Tasks 6, 8
  - Files: `rae/src/core/configoverrides.ts`, `rae/test/start-config.test.mjs`, `docs/test-cards/START-SEQUENCE.md`, `README.md`, `ARCHITECTURE.md`

### Checkpoint: complete
- [ ] every acceptance box above is ticked
- [ ] the owner has run `docs/test-cards/START-SEQUENCE.md` in the real game

- [ ] **Task 10: Release** (S; only when the owner asks)
  Bump the BP to 0.2.7 in four places (manifest header and two modules, `config/build.ts`), gate, clean build, `deploy.ps1` dry run
  then real, byte-verify, read the four world pins as JSON, tell the owner to fully quit and relaunch if the game is running. No push
  unless asked.
  - Dependencies: all of the above. Not started.
