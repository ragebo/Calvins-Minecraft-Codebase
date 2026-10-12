# Implementation Plan: the start sequence (clean start, camera intro, law picks a spawn)

(Lives in `tasks/start-sequence/` because `tasks/plan.md` still has the telemetry plan's unchecked owner checkpoints; nothing there is touched.)

## Spec: what the owner confirmed (interview, 2026-10-12)

Pressing Start must force every player into a known state, show a short cinematic, let law choose where they spawn, and then begin
play. All of it is changeable in game by an operator, easily, with no code edit.

1. **Start commands run first.** An operator-edited, ordered list of vanilla commands, run before anything else. The owner's own list from
   the last game: effects cleared, health full, bag cleared, game mode set, scoreboards back to zero, robberies and other command-block
   things reset. (Selectors like `@a[tag=law]` work: role tags are written when roles are assigned.)
2. **A ~10 second cutscene for everybody**: two or three panning shots over the map, picked at random each Start so it stays fresh.
   A shot is two marked points, a start and an end, made by standing there and pressing "mark start" / "mark end"; the camera pans
   from one to the other. The camera moves are the same ones the vanilla `/camera` command does (the script API has the equivalent).
3. **Then roles are revealed.** Law players get a screen to **choose which spawn** they want (two players may choose the same one);
   a law player who does not choose gets a random one, whatever is lightest on the code. Outlaw spawns stay random: outlaws get a short
   fly-down camera to their spawn while law choose.
4. **Then play begins.**
5. Customizing "mostly means starting commands"; the camera shots are marked in game, and the numbers (lengths, countdown) are
   editable in the existing config editor. Operators only.
6. **Not in this version:** endings and ending cameras (not built or planned yet).

## Decisions I made that you did not state (change any of them; the defaults hold unless you say so)

- "Class" in the interview was a slip for **spawn**: there is no class or loadout choice. (Confirmed implicitly: "you're correct on your assumptions".)
- Movement is **locked** from the start commands until play begins, so nobody wanders or gets hurt during the cutscene. I use the script
  API's `player.inputPermissions` (the same switch as the vanilla `/inputpermission`). It is always undone: on play start, on a round reset,
  at world load and when a player joins.
- Cutscene: **10 s total, 2 shots**, split evenly, a hard cut between shots (no fade), never the same first shot twice in a row. With
  **no shots recorded the cutscene is skipped** (a start is never blocked by missing setup).
- Start commands run **as the server, in order**. A failing command is reported to whoever pressed Start (and the log) and **never stops
  the start**. They run in the overworld; the first command to fail does not skip the rest.
- **Defaults** (editable, resettable): `effect @a clear`, `effect @a instant_health 1 10 true`, `effect @a saturation 1 10 true`,
  `clear @a[m=!creative]`, `gamemode survival @a`, `scoreboard players set @a coins 0`, `scoreboard players set @a bounty 0`. Note this
  empties the bags of everyone not in creative on **every** Start (an operator testing in survival loses the menu item and wand), exactly
  as the last game's did. Say if you would rather ship with the list empty.
- The "Rolling..." title goes away: the cutscene is the wait. "LAWMAN" / "OUTLAW" and "Roles Assigned!" show when roles are revealed.
- The spawn screen names the choices with the existing names ("Law spawn 1", "Law spawn 2"). **20 second** countdown; the round begins
  as soon as every law player has chosen, or when the countdown ends. A script **cannot close** a form: a player who still has the
  screen open when time runs out has already been placed, and pressing a button late does nothing.
- Outlaws are teleported to a random outlaw spawn, then the camera starts 30 blocks above it looking down and eases to eye level over 3 s.
  They stay locked until play begins, with everyone else (no head start).
- A player with no role (sitting out) gets none of it. A round reset, or pressing Start again, **cancels** whatever is under way.
- Operators edit it from the **RAE menu** (a new "Start sequence" button, hidden from non-operators): start commands (add, edit,
  delete, reset to defaults; no reordering) and camera shots (mark start, mark end, name, preview, delete). No new `/rae:` command
  (the project keeps exactly three).

## Architecture

```
config/balance.ts   START { intro on/off, seconds, shots per start, pick seconds, fly-down seconds/height, caps, default commands }
logic/start.ts      pure: a shot (two marks) and its saved text, picking shots at random, the seconds each gets, the command list and its edits
core/startstore.ts  shots (one world property each) and the command list (one), refused up front when over a cap
core/cinematic.ts   the ONLY place that touches the camera and input locks: lock, unlock, play a shot, fly down, clear; never throws
core/startsequence.ts  the staged sequence (commands -> cutscene -> reveal -> placement and law pick -> ACTIVE) with a generation
                    token so a reset or a second Start cancels the stage that is waiting; called from core/game.ts begin()
core/startforms.ts  the operator's screens, opened from a button in systems/menu.ts
```

Layers stay `config <- logic <- core <- systems`; no system imports a system. `begin()` in `core/game.ts` is the one place a round
starts (the menu and `bounty:start_round` both call it), so the sequence plugs in there.

## Task List

### Phase 1: Foundation
- [ ] Task 1: Shots, the command list and the START config (pure logic)
- [ ] Task 2: Saving shots and start commands in the world
- [ ] Task 3: The camera and lock wrapper, and the fake that lets tests see them

### Checkpoint: Foundation
- [ ] all green; nothing visible in game yet

### Phase 2: The sequence
- [ ] Task 4: Start commands run when a game starts (the first thing you can feel: the clean slate)
- [ ] Task 5: The camera intro before the reveal
- [ ] Task 6: Reveal, outlaw fly-down, law picks a spawn, then play

### Checkpoint: the sequence
- [ ] all green; a whole Start under fake time reaches ACTIVE every way it can end (all picked, timeout, reset, a player leaving)

### Phase 3: Customizing it
- [ ] Task 7: The start-commands screen
- [ ] Task 8: The camera-shots screen (mark start, mark end, preview)
- [ ] Task 9: Live numbers, docs and the test card

### Checkpoint: complete
- [ ] every acceptance box ticked; check, test, check:legacy green
- [ ] (owner) `docs/test-cards/START-SEQUENCE.md` run in the real game

- Task 10: release (only when asked)

## Existing tests this will change (named so it is not a surprise)

`round-flow.test.mjs` (15 places), `ui.test.mjs` (6), `menu.test.mjs` (3), `load-smoke.test.mjs` (1) read the old timing (play begins
exactly 60 ticks after Start, a "Rolling..." title). They are updated in Task 6, each change for a stated reason; no test is deleted
to get to green.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A start hangs (a step never finishes) and the round never goes active | High | One generation token; every stage has its own timeout path to ACTIVE; tests for every way a stage can fail to finish |
| A player is left locked or stuck in a camera | High | Unlock and clear on ACTIVE, on reset, at world load, on join; a reload mid-sequence is a test |
| Free camera, eased moves and the pick screen are unmeasured in the real game (several players at once; does a form open mid-camera) | High | Camera clear before the pick screen; the card says exactly what to watch; every call is wrapped and never throws |
| `clear @a[m=!creative]` empties the operator's bag on every Start | Med | Decision above, editable in game, flagged for you |
| A script cannot close the pick screen | Med | A late pick is ignored; documented; the card asks what you see |
| `runCommand` of a `/rae:` command (e.g. a robbery reset) from the server context is unmeasured | Low | A failing command is reported, never fatal; the card tests one |
| Existing start tests depend on the old timing | Med | Named above; changed only where the timing changed |

## Not in this plan

Endings and ending cameras; reordering start commands; a fade between shots; per-role command lists (selectors do it); custom names
for law spawns; re-picking a spawn after the round starts; a skip-the-intro key; camera presets as JSON files.

## Open questions (a default is used unless you say otherwise)

1. Ship with the default start commands above, or with the list empty? **Default: the owner's list above.**
2. Plan folder `tasks/start-sequence/` rather than `tasks/`? **Default: yes (the telemetry plan is not finished).**
