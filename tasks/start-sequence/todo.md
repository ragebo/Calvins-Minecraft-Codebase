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

- [x] **Task 2: Saving shots and start commands in the world** (S) - done
  `core/startstore.ts` on `core/recordstore.ts` (the store shops and robberies use): shots one world property each, the command list
  one more. A list never saved means the defaults; a list saved empty means "run nothing" (the two are different on purpose).
  - Acceptance:
    - [x] save, read, list, delete and undo of a shot; a save over the cap is refused with a reason and changes nothing
    - [x] the default commands come back when nothing was saved, and an empty saved list stays empty
    - [x] after a script reload (forget loaded) everything reads back the same
    - [x] an unreadable record is listed and never overwritten
  - Verification: check, test
  - Result: 14 new tests (shots saved, read back after a reload, ordered s2 before s10, deleted and undone, capped at 12 with an existing one still editable, a damaged one listed and never overwritten; the command list: defaults when never saved, saved empty means run nothing, an unreadable list runs nothing and says why, reset, over-size refused). 19 deliberate breaks on core/startstore.ts, all caught (one needed a second test check, a readable list reporting a problem). Found while testing: a name of 40 control characters (written as 6 characters each) could push a valid shot past the 400-character cap, so `maxShotChars` is now 600 and a test holds the longest valid shot to it.
  - Dependencies: Task 1
  - Files: `rae/src/core/startstore.ts`, `rae/test/start-store.test.mjs`

- [x] **Task 3: The camera and lock wrapper, and the fake that lets tests see them** (S-M) - done
  `core/cinematic.ts` is the only file that calls `player.camera` and `player.inputPermissions`: `lock`/`unlock` (movement),
  `playShot(player, shot, seconds)` (the camera appears at the start mark at once, then eases to the end mark over `seconds`),
  `flyDown(player, spawn, seconds)` (starts `flyDownHeight` above the spawn looking down, eases to eye level), `clearCamera`,
  `unlockEveryone`. Each call is wrapped: an engine error is logged once per kind and never thrown. `rae/test/fake/minecraft-server.mjs`
  gets additive support (named here because that file is otherwise off limits): `player.camera.setCamera/clear/fade` recorded in a call
  list (and `fake.cameraError` covers them), `player.inputPermissions` with its state, and the `InputPermissionCategory` and
  `EasingType` enums.
  - Acceptance:
    - [x] `playShot` makes exactly two `setCamera` calls: the start with no ease, then the end with `easeTime` equal to the seconds given
    - [x] `flyDown` starts above the spawn looking straight down and ends at eye height, with the ease time given
    - [x] lock then unlock restores movement; `unlockEveryone` unlocks every online player and clears their cameras
    - [x] an engine error from any call is swallowed and logged once; a player who left (invalid) is skipped
    - [x] the whole existing suite still passes with the fake's additions (run before and after)
  - Verification: check, test; deliberate breaks
  - Result: 10 new tests (a pan is two camera calls, a fly-down, a negative length is a cut, lock and unlock, clear, unlockEveryone with one who left, a camera that throws is reported once per kind, a lock that throws, one player's failure does not stop the rest). The fake gained camera.setCamera/clear/fade (recorded in camera.calls), inputPermissions, fake.inputPermissionError and the InputPermissionCategory and EasingType enums; the whole existing suite was run before and after the fake's additions: 1457 of 1457 both times. 27 deliberate breaks on core/cinematic.ts, all caught (two needed a compiling variant). The two calls of a pan are made in the same tick: unmeasured in the real game whether the ease starts from the first mark; the card checks it.
  - Dependencies: Task 1
  - Files: `rae/src/core/cinematic.ts`, `rae/test/fake/minecraft-server.mjs`, `rae/test/cinematic.test.mjs`

### Checkpoint: Foundation
- [x] all green; nothing visible in game yet (1467 tests after Task 3)

## Phase 2: The sequence

- [x] **Task 4: Start commands run when a game starts** (M) - done
  `core/startsequence.ts` (first part): `runStartCommands(by?)` runs the saved list in order as the server (overworld dimension), and
  `begin()` in `core/game.ts` calls it after the roles are assigned and before anything else. A command that throws is reported to
  `by` (the operator who pressed Start, when there is one) and to the log, and the rest still run. `startRandomRound` and
  `startChosenRound` take an optional `by`; the menu passes the player.
  - Acceptance:
    - [x] with the defaults, a Start sends the seven default commands to the dimension in order, after roles exist (so `@a[tag=law]` would match)
    - [x] a command is sent without its leading `/`
    - [x] one that throws is reported by name to `by`, and the commands after it still run and the round still starts
    - [x] an empty saved list runs nothing; sitting-out players are not affected by the code (the commands' own selectors decide)
    - [x] a Start from the script event (no `by`) logs a failure instead of telling nobody
  - Verification: check, test; deliberate breaks
  - Result: 10 new tests: the seven default commands run in order in the overworld, after the roles exist and before anyone is moved (checked against where players really stood), without a leading slash, a failing one is told to only whoever pressed Start (checked with a second operator online) and the rest still run, the old button tells every operator, a list saved empty or unreadable runs nothing, a refused start runs none (a bag is not emptied for a game that never began), a chosen round too. 20 deliberate breaks across core/startsequence.ts and the wiring in core/game.ts, all caught; running them found two flaws in my own tests (a second 'operator' who was really a member, and no check that a long reason is cut). game.ts, menu.ts: startRandomRound and startChosenRound take an optional who-pressed-it. A command that runs but matches no one counts as run; only a throw is a failure. Unmeasured in the real game: that Dimension.runCommand throws on a command the game refuses, and that selectors like @a[m=!creative] behave as in a command block.
  - Dependencies: Tasks 2, 3
  - Files: `rae/src/core/startsequence.ts`, `rae/src/core/game.ts`, `rae/src/systems/menu.ts`, `rae/test/start-commands.test.mjs`

- [x] **Task 5: The camera intro before the reveal** (M) - done
  Staged with a generation token (`core/startsequence.ts`, second part): when the intro is on and at least one shot is saved, lock the
  playing players, pick `shotsPerStart` shots, play each for `secondsPerShot` on a timer chain for everybody at once, then continue
  into what happens today (spawn, reveal, play). No shots, or the intro switched off: nothing changes. A reset or another Start cancels
  the stage that is waiting, unlocks everyone and clears their cameras.
  - Acceptance:
    - [x] playing players are locked and in a camera during the intro; sitting-out players are not
    - [x] shots play in order, each cut at the right tick (checked with fake time), 10 s in total with the defaults
    - [x] the same pool never repeats the previous Start's first shot
    - [x] a round reset mid-intro: everyone unlocked, cameras cleared, no later step runs; a second Start mid-intro takes over cleanly
    - [x] no shots saved: no camera call, no lock, and the existing timing is unchanged
    - [x] a player who leaves mid-intro does not stop the others
  - Verification: check, test; deliberate breaks
  - Result: 13 new tests, exact to the tick: 2 shots of 5 s each (a cut at tick 100, the end at 200, play 60 ticks later), one shot for the whole 10 s, even shares for 3 shots, never opening with last time's shot, a round reset or a second Start in the middle (old timers do nothing), no shots / intro off / 0 seconds / nobody to show it to (nothing changes), a player leaving mid-intro, and the safety net (everyone let go at the next load, a joining player let go unless the intro holds them; the reload test comes last because a second module copy would unlock everyone). 25 deliberate breaks across core/startsequence.ts and core/game.ts, all caught (6 needed a compiling variant). It found a REAL hang: a player leaving during the 10 s intro made showTitle throw in the continuation before beginActive was scheduled, which would have left the round stuck in SETUP; the continuation now skips a player who left. startIntro(playing, then) is the new stage in begin(); with nothing to play it calls then() at once, so the old timing is untouched. Unmeasured in the real game: the two camera calls of a pan in one tick, free cameras for several players at once, and whether movement lock plus a free camera lets players be hurt.
  - Dependencies: Task 4
  - Files: `rae/src/core/startsequence.ts`, `rae/src/core/game.ts`, `rae/test/start-intro.test.mjs`

- [x] **Task 6: Reveal, outlaw fly-down, law picks a spawn, then play** (L, the biggest) - done
  Replaces the end of `begin()`. After the intro (or straight after the commands when there is none): titles LAWMAN/OUTLAW and
  "Roles Assigned!" show; outlaws are teleported to a random outlaw spawn and fly down to it; law players get a screen of the law
  spawns with a `pickSeconds` countdown; a law player placed by choice or at random; play (`beginActive`) starts when every law player
  has chosen or the countdown ends, whichever is first, everyone unlocked and cameras cleared in the same tick. "Rolling..." is gone.
  - Acceptance:
    - [x] roles are revealed at the start of this stage, not at the end
    - [x] an outlaw lands at one of the outlaw spawns, with a fly-down that ends at their eyes; they stay locked until play begins
    - [x] every law player gets the spawn screen with one button per law spawn; choosing teleports them there, and two players may choose the same one
    - [x] play starts at once when the last law player chooses, and after `pickSeconds` otherwise, with the unpicked placed at a random law spawn
    - [x] a pick that arrives after the countdown is ignored (no teleport, no second `beginActive`)
    - [x] no law players: no screen, play starts after the fly-down; nobody to fly down: play starts at once
    - [x] a reset or a second Start mid-stage cancels the countdown, the screens' effects and the locks; a law player leaving does not hang the round
    - [x] `beginActive` is called exactly once per Start in every path
    - [x] the existing start tests are updated for the new timing and the new titles, each for a stated reason (`round-flow`, `ui`, `menu`, `load-smoke`)
  - Verification: check, test, check:legacy; deliberate breaks on every branch
  - Result: 17 new tests in start-reveal.test.mjs: roles revealed at once (no Rolling...), the outlaw fly-down and lock, the law screen (one button per law spawn, how long there is), two law choosing the same spawn, a random spawn that really follows the dice (a closed screen, a countdown that ran out), play waits for the last law player AND the outlaws' fly-down, a late answer is ignored, a reset or a second Start cancels it all, a law player or an outlaw who leaves does not hold it up, no fly-down time, a countdown shorter than the fly-down, and a whole start end to end (commands, 10 s intro, reveal, pick, fly-down, play at 13 s). 29 deliberate breaks across core/startsequence.ts and core/game.ts, all caught (the first run found a real gap: a fly-down time of 0). Existing tests updated, each for a stated reason: round-flow.test.mjs (2 tests rewritten: roles are revealed at once and play begins when the fly-down is over; law are placed when their screen is answered), menu.test.mjs (3 places: the start now ends with the law player's spawn screen), and my own start-intro (rewritten for the re-lock at the reveal and the settle) and start-commands (1 place). ui.test.mjs and load-smoke.test.mjs needed no change, unlike the plan guessed. No test was deleted. Design notes: the pick screen has no ticking countdown (the body says how many seconds, the game ends it); Esc on the screen means a random spawn at once; the old REVEAL_DELAY_TICKS constant and the Rolling... title are gone; core/startsequence.ts is now the only caller of beginActive. Unmeasured in the real game: that a form opens normally right after a camera is cleared, and what a player who still has the screen open sees when the countdown ends.
  - Dependencies: Task 5
  - Files: `rae/src/core/startsequence.ts`, `rae/src/core/game.ts`, `rae/test/start-reveal.test.mjs`, `rae/test/round-flow.test.mjs`, `rae/test/ui.test.mjs`, `rae/test/menu.test.mjs`, `rae/test/load-smoke.test.mjs`

### Checkpoint: the sequence
- [x] all green; a whole Start under fake time reaches ACTIVE every way it can end (all picked, the countdown, a closed screen, no law, no outlaws, a reset, a second Start, a player leaving; 1507 tests after Task 6)

## Phase 3: Customizing it

- [x] **Task 7: The start-commands screen** (M) - done
  `core/startforms.ts` (the operator's screens, on `core/screens.ts`), opened from a new "Start sequence" button in the RAE menu that
  only operators see: the numbered list, Add (a text box), Edit one (the box prefilled; an empty box deletes it), Reset to defaults, Back.
  Refusals show on the next screen.
  - Acceptance:
    - [x] add, edit, delete and reset change what the next Start runs
    - [x] a refused line (too long, empty on add, over the cap) says why on the same screen and changes nothing
    - [x] a non-operator never sees the button and cannot open the screens by any route
    - [x] closing a screen with Esc leaves the list as it was
  - Verification: check, test; deliberate breaks
  - Result: 19 new tests (start-forms.test.mjs) with a stand-in operator: the first screen and its summary in all four states (defaults, your own, none, unreadable), a member refused by the entry and not offered the button (the RAE menu shows Start sequence only to an operator; pressing it opens the editor), the numbered list, add (cleaned, last, announced), edit (the box starts with the command), an empty box deletes, a refused line comes straight back with the reason in the box title and what was typed kept (too long, empty, full list, and a save the store refuses for size), Escape changes nothing, Put the defaults back only on a yes, a saved-empty list, an unreadable list offering only the reset, and a long command cut short on its button. 31 deliberate breaks across core/startforms.ts and the menu button, all caught (8 needed a compiling variant). No reordering (delete and add instead), as planned. Written in the style of the live config editor: an isOperator gate at the entry, one createScreens set, refusals in the modal title. Unmeasured in the real game: how the screens look, and that a text box opens right after another form closes.
  - Dependencies: Tasks 2, 4
  - Files: `rae/src/core/startforms.ts`, `rae/src/systems/menu.ts`, `rae/test/start-forms.test.mjs`

- [x] **Task 8: The camera-shots screen** (M) - done
  In `core/startforms.ts`: the shot list, "Mark the start of a new shot here" (position and the way you are facing, kept on the operator
  until the end is marked), "Mark the end here" (saves the shot, asks for an optional name), Cancel marking, Preview (plays that one
  shot for the operator alone, then clears their camera), Delete.
  - Acceptance:
    - [x] marking start then end saves a shot whose marks are the operator's position and facing at each moment
    - [x] a pending start survives the screen closing and shows up when reopened; Cancel clears it
    - [x] Preview moves only the operator's camera, does not change the round phase, and ends with their camera cleared and movement restored
    - [x] a save over `maxShots` is refused with the reason; delete asks for nothing more than the button
  - Verification: check, test; deliberate breaks
  - Result: 20 new tests (start-shots-forms.test.mjs): the main screen's Camera shots button and summary, an empty list, marking the start (kept on the operator, eyes and facing not feet), marking the end saves a named shot with the marks of the two moments, the end is taken at the press and not after the name box, an unnamed shot is listed by its id, a name that is too long comes back in the box with the reason and what was typed kept, closing the name box saves nothing and keeps the start, a pending start survives the screen closing and Cancel marking clears it, a damaged pending mark (five kinds, including 1e999) is ignored, a full list refuses a new start at once, a shot's screen with Preview and Delete, Preview (the operator alone, locked, camera given back at the end, menus closed so the screen does not come back over the camera), refused while a start is under way and for an intro of no seconds, a Start in the middle of a preview lets the operator go, a second preview is not cut short by the first, Delete is one button, a damaged shot is listed and deletable, and a new shot never takes a damaged shot's id. About 34 deliberate breaks across the shots half of core/startforms.ts and previewShot in core/startsequence.ts, all caught; running them found a real weakness (a pending mark of 1e999 reads as Infinity) and a redundant notice (Start marked said twice), both fixed. core/startstore.ts listStoredShots is now in the order made (s2 before s10). previewShot lives in startsequence.ts so it shares the hold-and-release rules: a reset or a Start releases an operator mid-preview. Unmeasured in the real game: how a preview looks, that getHeadLocation is where the free camera should sit, and the screens' feel.
  - Dependencies: Tasks 3, 7
  - Files: `rae/src/core/startforms.ts`, `rae/test/start-shots-forms.test.mjs`

- [x] **Task 9: Live numbers, docs and the test card** (M) - done
  `core/configoverrides.ts` registers the START numbers (`start.introEnabled`, `start.introSeconds`, `start.shotsPerStart`,
  `start.pickSeconds`, `start.flyDownSeconds`, `start.flyDownHeight`) so the config editor and `/rae:config` change them live.
  `docs/test-cards/START-SEQUENCE.md` (numbered in-game steps: marking a shot, previewing it, a Start with law and outlaw, a late
  pick, a mid-sequence reset, one failing command, the bag-clearing default; and what only the real game can answer).
  README and ARCHITECTURE.md rows (named here because the rules normally forbid editing them).
  - Acceptance:
    - [x] each number is a registered setting with a range, changes the next Start, and resets to its default
    - [x] the card has every step the owner needs, and says what is unmeasured
    - [x] README and ARCHITECTURE.md say where the sequence lives; `git status` is clean after the commit
  - Verification: check, test, check:legacy
  - Result: 9 new tests (start-config.test.mjs): the six settings (start.introEnabled, introSeconds, shotsPerStart, pickSeconds, flyDownSeconds, flyDownHeight) are registered in a group of their own, Start sequence, with kinds, ranges and labels that say what they do; each refuses what it cannot take and says the range (a negative or fractional intro, more shots than can be saved, no time to choose, a number for a switch, a member); each goes back to its default; typed as /rae:config set it works; and each changes the NEXT Start, checked by running one (the intro off, 4 seconds eased and over at tick 80, one shot of three, 5 seconds to choose, a 1 second fly-down from 50 blocks). 14 deliberate breaks, all caught. docs/test-cards/START-SEQUENCE.md: 22 numbered in-game steps in three parts (the editor alone, a whole Start with two players, the numbers and the safety net), ten things only the real game can answer, what must not appear. README: a Start sequence section, the layout lines, the game menu bullet, the round-lifecycle paragraph corrected (no more Rolling...). ARCHITECTURE.md: rows for cinematic, startforms, startsequence, startstore and logic/start (All nine became All ten), game.ts updated, and a The start sequence's shape section. CLAUDE.md is not touched. The card also notes that the default commands empty an operator's bag, menu item and wand in survival.
  - Dependencies: Tasks 6, 8
  - Files: `rae/src/core/configoverrides.ts`, `rae/test/start-config.test.mjs`, `docs/test-cards/START-SEQUENCE.md`, `README.md`, `ARCHITECTURE.md`

### Checkpoint: complete
- [x] every acceptance box above is ticked (Tasks 1 to 9)
- [ ] the owner has run `docs/test-cards/START-SEQUENCE.md` in the real game

- [ ] **Task 10: Release** (S; only when the owner asks)
  Bump the BP to 0.2.7 in four places (manifest header and two modules, `config/build.ts`), gate, clean build, `deploy.ps1` dry run
  then real, byte-verify, read the four world pins as JSON, tell the owner to fully quit and relaunch if the game is running. No push
  unless asked.
  - Dependencies: all of the above. Not started.
