# Task list: configurable endings

Plan: `tasks/endings/plan.md`. Every task is red, then green, then the full gate (`npm run check`, `node scripts/test.mjs`, `npm run check:legacy`), then its own commit, then ticked here.
Deliberate-break (mutation) runs on every new rule. Nothing is deployed or pushed unless the owner asks.

## Phase 1: The engine, with the boat as the first ending

- [x] **Task 1: The ending record and its rules, pure** (M) - done
  `logic/endings.ts`: the record `{version, id, name, kind: "group" | "solo", enabled, place, radius, pricePerMember (group) / price (solo), item?, consumeItem, winSpot?, message, announce,
  cinematic?}` with `parse` (never throws, refuses what it cannot read with a reason), `serialize`, `validate` (a reason an operator can read), and immutable edit operations. The
  verdicts as plain functions on plain snapshots: the group verdict (who is missing, what is owed, how the cost is split across the gathered members in order), the solo verdict (distance,
  coins, item), the round tally (escaped, captured, still in play), and "is the round over". `config/balance.ts` gets `ENDINGS` (the caps and the shipped boat defaults, copied from the
  old boat constants).
  - Acceptance:
    - [x] a record round-trips through serialize and parse; garbage, a missing field, a wrong type, a newer version and an oversized text are refused with a reason and never throw
    - [x] validate refuses: no place, a radius of 0 or less, a negative price, a solo ending with neither coins nor item, an empty id, an id with characters the store cannot keep
    - [x] the group verdict: everyone present and enough pooled coins passes; one absent member names them; a short purse says how many coins are missing; zero members passes nothing
    - [x] the cost split takes from the gathered members in the order given and never takes more than the total owed (a test with uneven purses)
    - [x] the solo verdict: at the radius edge in, a hair outside out; coins only, item only, both; a short purse and a missing item each give their own reason
    - [x] the tally and "is the round over" for: none escaped, some escaped and some captured, all escaped, nobody assigned (not over)
  - Verification: check, test, check:legacy; deliberate breaks on every comparison and the split
  - Result: logic/endings.ts: the ending record (group or solo; place, radius, price, item, win spot, four texts) with parse/serialize that never throw, validate with readable reasons, new/edit/id-from-name, the group verdict (gather before money, cost taken in order), the solo verdict (place, coins, item), the tally and the round verdict (all escaped = outlaw win, law judged on those left in play). ENDINGS in config/balance.ts. 1704 tests (+13), 109-break mutation run all caught.
  - Dependencies: None
  - Files: `rae/src/logic/endings.ts`, `rae/src/config/balance.ts`, `rae/test/endings-logic.test.mjs`

- [x] **Task 2: Where endings live, with the boat seeded** (S-M) - done
  `core/endingstore.ts` on `core/recordstore.ts` (`rae:ending:<id>`, a cap of `ENDINGS.maxEndings`, one undo). Never saved means the boat ending, built from today's `BOAT_NPC`,
  `BOAT_WIN_TELEPORT`, `ECONOMY.boatEscapePerOutlaw`, `BOAT.escapeRadius` and the boat's messages as they read now; saved empty means no endings; a damaged record is listed and never
  quietly replaced by the default.
  - Acceptance:
    - [x] a fresh world has exactly one ending, `boat`, whose place, radius, price, win spot and texts equal the old config and chat lines
    - [x] after any save, the default is no longer offered (the operator can delete the boat ending and it stays deleted)
    - [x] a saved empty list means no endings; an unreadable record means no ending from it, and the reason is available to a screen and never overwritten
    - [x] the cap is enforced with a reason; an id is made from the name the way shops and shots are, and not reused at once
    - [x] one undo restores the last version
  - Verification: check, test, check:legacy; deliberate breaks of the seed values and the "never saved" rule
  - Result: core/endingstore.ts on the record store (rae:ending:<id>, cap 12, one undo): a world that never saved has the boat, built live from BOAT_NPC/BOAT_WIN_TELEPORT/BOAT.escapeRadius/ECONOMY.boatEscapePerOutlaw and ENDINGS.texts.boat, written nothing; the first save or delete makes it a real record (marker rae:endings-seeded, so deleting all stays deleted and an edit of the boat can be undone to the default); a damaged save is listed and never replaced by the default or overwritten. 1717 tests (+13), 32-break mutation run all caught.
  - Dependencies: Task 1
  - Files: `rae/src/core/endingstore.ts`, `rae/test/endings-store.test.mjs`

- [ ] **Task 3: The group engine; the boat becomes an ending** (L)
  `core/endings.ts` with `attempt(player, id)` for a group ending, `systems/endings.ts` for the glue (`rae:ending <id>`, and `bounty:escape` as an alias of `boat`), and `systems/boat.ts`
  removed. The behavior must be identical for the boat: same checks in the same order, same messages, same coin taking, same winner tags and teleport. `core/round.ts` is untouched
  except that `endRound` may carry the ending's id for telemetry (an optional second argument).
  - Acceptance:
    - [ ] every existing "boat win" test in `test/round-flow.test.mjs` passes UNCHANGED (this is the characterization; edit the code, not those tests)
    - [ ] a second group ending with a different place, radius, price and message works the same way, and the two do not interfere
    - [ ] a disabled ending, a deleted ending and an unknown id each say so to the player and do nothing
    - [ ] the price is per member and follows the number of outlaws in play at the moment of the attempt
    - [ ] only an outlaw, only in an ACTIVE round, may attempt one; the messages for the others are the boat's
    - [ ] two endings fired in the same tick: the first wins, the second is refused without taking coins
    - [ ] a round reset leaves nothing behind in the engine
  - Verification: check, test, check:legacy; deliberate breaks of each check and of the coin taking
  - Dependencies: Task 2
  - Files: `rae/src/core/endings.ts`, `rae/src/systems/endings.ts`, `rae/src/systems/boat.ts` (deleted), `rae/src/main.ts`, `rae/src/core/round.ts`, `rae/test/endings-group.test.mjs`

### Checkpoint 1: the boat is data
- [ ] all green; the boat tests unchanged; an operator could already change the boat's numbers by saving a new record (the screens come in Task 7)

## Phase 2: Solo escapes and the round rule

- [ ] **Task 4: An escaped outlaw is not an outlaw any more** (M)
  A per-player flag `escaped` (in the record's `flags`) and `core/players.ts` excluding it from `outlaws()`, `aliveOutlaws()`, `freeOutlaws()` and `alivePlayers()`; `core/spectate.ts` lifted
  out of `systems/jail.ts` (jail uses it, no change in behavior). The law win ignores escaped outlaws.
  - Acceptance:
    - [ ] an escaped player appears in none of the four queries; a non-escaped player is unchanged
    - [ ] the law win with one outlaw escaped and the rest jailed or eliminated fires; with one still free it does not
    - [ ] a raid and a robbery do not count or target an escaped outlaw; the harming level counts one fewer
    - [ ] jail and elimination behave exactly as before (the jail tests unchanged) and an escaped player's spectator mode is given back by a reset
    - [ ] the flag survives a script reload and is cleared by a round reset
  - Verification: check, test, check:legacy; deliberate breaks of each query
  - Dependencies: Task 3
  - Files: `rae/src/core/players.ts`, `rae/src/core/spectate.ts`, `rae/src/systems/jail.ts`, `rae/src/systems/endgame.ts`, `rae/test/endings-escaped.test.mjs`

- [ ] **Task 5: The solo ending and the round-over rule** (L)
  `attempt(player, id)` for a solo ending: the checks, the money or item taken, the player marked escaped and announced, taken to the win spot if there is one, put in spectator, and the
  round-over rule run afterwards: all outlaws escaped ends the round as `outlaw_win`; the law win check runs on those left in play. The round does not end for a solo escape otherwise.
  - Acceptance:
    - [ ] a solo escape with the coins taken, with the item taken (consumed or kept as the ending says), and with both, each ends with the player escaped, announced and a spectator
    - [ ] the round continues, other outlaws can still use a group ending, and they are no longer asked to include the escaper
    - [ ] the last free outlaw escaping ends the round `outlaw_win`; escaping while the rest are jailed or eliminated ends it `law_win`; escaping while another is free does not end it
    - [ ] a jailed or eliminated outlaw, a law player and a player already escaped cannot use it; each is told why
    - [ ] a short purse or a missing item says which, and takes nothing
    - [ ] two outlaws attempting the same solo ending in the same tick: both may win if each qualifies (a solo ending is not used up), and the order never decides the round
  - Verification: check, test, check:legacy; deliberate breaks of every check, the item consumption and the round-over rule
  - Dependencies: Task 4
  - Files: `rae/src/core/endings.ts`, `rae/src/systems/endgame.ts`, `rae/test/endings-solo.test.mjs`

- [ ] **Task 6: The tally and the telemetry** (S)
  The round-end announcement says how many escaped and how many were captured. `round.end` telemetry carries the ending's id (when a group ending ended the round), and a solo escape writes its
  own event.
  - Acceptance:
    - [ ] a round ending with escapes and captures announces "N escaped, M captured" with the right numbers; a round with none says nothing extra
    - [ ] the telemetry line for a round ended by an ending names it; a solo escape writes one line with the ending id and the coins or item given
    - [ ] the telemetry format stays versioned and the reader tool still accepts old lines
  - Verification: check, test, check:legacy
  - Dependencies: Task 5
  - Files: `rae/src/core/telemetry.ts`, `rae/src/logic/telemetry.ts`, `rae/src/core/endings.ts`, `rae/test/endings-telemetry.test.mjs`

### Checkpoint 2: both kinds of ending work by script event
- [ ] all green; an operator can save a solo and a group ending as records and see them play out, one round to the end

## Phase 3: Making it yours

- [ ] **Task 7: The operator's screens** (L)
  `core/endingforms.ts` and an operator-only **Endings** button in the RAE menu: the list (name, type, on or off), add (pick the type), and an edit screen for every field: name, on/off, the place
  (taken by standing there), the radius, the price (per member or for the one), the item (hold it, then take it), whether it is consumed, the win spot (by standing), the messages, delete, undo. A
  refused value brings the form back with what was typed and the reason, as the other editors do.
  - Acceptance:
    - [ ] a non-operator never sees the button and cannot open the screens by any path
    - [ ] an ending can be added, every field edited, turned off and deleted; the change is what the next attempt reads
    - [ ] the place and win spot are taken from where the operator stands (rounded to the block); the item is taken from the hand and a bare hand says so
    - [ ] a refused value (a negative price, a radius of 0, no place) shows the reason and keeps what was typed; nothing is saved
    - [ ] closing a screen mid-edit saves nothing half-done; a player who leaves mid-edit leaves no state behind
    - [ ] the list says when an ending cannot be read and why, and offers nothing that would overwrite it
  - Verification: check, test, check:legacy; deliberate breaks of the operator check and each field
  - Dependencies: Task 6
  - Files: `rae/src/core/endingforms.ts`, `rae/src/systems/menu.ts`, `rae/test/endings-forms.test.mjs`

- [ ] **Task 8: The cinematic** (L)
  An ending's optional pan: a start mark and an end mark taken by standing (look the way the camera should), and seconds. Played after the announcement for `all` players or the `winners`, locking
  them while it plays and handing the camera back; the group ending's winners are taken to the win spot after it. A preview button on the edit screen. Rides the start sequence's safety:
  a generation a reset moves on, one function that releases everyone, and a held player is never released by anything else.
  - Acceptance:
    - [ ] a group ending with a pan locks and moves every player's camera, hands it back after the seconds, and only then teleports the winners
    - [ ] a solo ending with the audience `winners` moves only the escaper's camera; `all` moves everyone's
    - [ ] no cinematic set means no camera, no lock and no delay
    - [ ] a round reset in the middle, a player leaving, or a failing camera call leaves nobody locked or stuck in a camera (the start sequence's safety net is reused, not copied)
    - [ ] the preview plays for the operator alone and is refused while a game is starting
    - [ ] the ending is announced and recorded as ended at once; the cinematic never delays the round's end state
  - Verification: check, test, check:legacy; deliberate breaks of the audience, the lock release and the delay
  - Dependencies: Task 7
  - Files: `rae/src/logic/endings.ts`, `rae/src/core/endings.ts`, `rae/src/core/endingforms.ts`, `rae/test/endings-cinematic.test.mjs`

- [ ] **Task 9: Retire the boat config, document it, write the test card** (M)
  Remove the boat's four live-config fields and have preflight check the endings' places instead; a config group **Endings** is not needed (every number is per ending, in the screens).
  `docs/test-cards/ENDINGS.md` (what only the real game can answer first, then numbered steps for a group ending, a solo ending, the mixed round, the cinematic), README and ARCHITECTURE.md
  rows (named here because the rules normally forbid editing them).
  - Acceptance:
    - [ ] `world.boatNpc`, `world.boatWinTeleport`, `economy.boatEscapePerOutlaw` and `boat.escapeRadius` are gone from the editor and nothing else reads them; the config constants stay as the seed only
    - [ ] preflight warns about an ending whose place is outside the world or in an unloaded area, naming the ending
    - [ ] the card has every step the owner needs and says what is unmeasured and where each fix would go
    - [ ] README and ARCHITECTURE.md say where endings live
  - Verification: check, test, check:legacy
  - Dependencies: Tasks 3 to 8
  - Files: `rae/src/core/configoverrides.ts`, `rae/src/core/preflight.ts`, `docs/test-cards/ENDINGS.md`, `README.md`, `ARCHITECTURE.md`, `rae/test/endings-config.test.mjs`

### Checkpoint: complete
- [ ] every acceptance box above is ticked
- [ ] the owner has run `docs/test-cards/ENDINGS.md` in the real game; what it shows is fixed in a follow-up round

- [ ] **Task 10: Release** (S; only when the owner asks)
  The behavior pack only (no sprite or texture changes): bump the BP in four places (manifest header and both modules, `BUILD_VERSION`), gate, clean build, `deploy.ps1` with no world open,
  byte-verify, read the four worlds' pins as JSON, tell the owner to launch fresh. No push unless asked.
  - Dependencies: all of the above.
