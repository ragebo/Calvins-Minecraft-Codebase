# Task list: telemetry for robberies and NPC shops, and a way to read it

Design, evidence and risks: `tasks/plan.md`. Commands run from `C:\rae\rae`. Every task also meets the project's definition of
done (CLAUDE.md): `npm run check` clean, `npm test` green, `npm run check:legacy` not raised, diff inside the listed files.
Nothing is deployed or pushed unless the owner asks.

## Phase 1: walking skeleton (rounds, end to end)

- [x] **Task 1: Event contract (pure)** (S) - done
  Define the one-line format in `logic/telemetry.ts`: the event types for every kind in the plan, `toLine(event, limits)`
  (compact JSON, stamp first; strings cut at 80 characters, lists at 8, a line over 600 loses its biggest fields and says
  `cut:1`; the numbers are passed in and Task 2 puts them in config), the log source `telemetry`, and a pure rate limiter
  `limitStep(state, tick, max, windowTicks)` (state in, state out, as `pickStep` does, because `logic/` keeps no state).
  Changed from the first draft: no `parseLine` here. The game never reads its own lines and the tool has its own parser
  (Task 4), so a parser in the pack would be dead code; its "garbage never throws" check moved to Task 4.
  - Acceptance:
    - [x] every kind survives `toLine` then `JSON.parse` unchanged and unflagged
    - [x] a 5,000-character string field gives a line of at most 600 characters that is still valid JSON
    - [x] the limiter lets `max` through per window, counts the rest, and reports the count once when the window rolls over
    - [x] (added) the exact wire format is pinned; the stamp is never cut or dropped; an undefined field never trips the cap
  - Verification: `npm run check`; `npm test` (new `telemetry-events.test.mjs`; `layers.test.mjs` proves `logic/` has no game imports)
  - Result: 10 new tests; 12 deliberate breaks of the module, each caught by a test.
  - Dependencies: none
  - Files: `rae/src/logic/telemetry.ts`, `rae/test/telemetry-events.test.mjs`

- [x] **Task 2: The emitter** (S-M) - done
  `core/telemetryevents.ts`: `emit(kind, fields)` stamps `v`, `w` (world id, made on first use and kept in the world property
  `rae:telemetry:world`), `b` (random boot id made at load), `n` (counter), `t` (`system.currentTick`), `bv` (`BUILD_VERSION`)
  and writes `[telemetry] <line>` through `core/log.ts` `info`. Emits `boot` on the first tick after a load. New
  `TELEMETRY.events` in `config/balance.ts`: `enabled`, `maxLinesPerWindow`, `windowTicks` and the three size caps. Dropped
  lines are reported by one `telemetry.dropped` line. Never throws into gameplay. A failure to write is reported once per boot
  as `[telemetry-problem] ...` (a source of its own, so a reader that expects JSON after `[telemetry]` never meets a sentence).
  Not loaded by the game yet: nothing imports it until Task 3.
  - Acceptance:
    - [x] one stamped line per `emit`, `n` rising by 1
    - [x] the world id is made once, is the same after a simulated reload, and `rae:persist_reset` leaves it alone
    - [x] `enabled: false` writes nothing (and uses no line number)
    - [x] over the limit, lines are dropped and one `telemetry.dropped` carries the count after the window
    - [x] a console that throws does not throw out of `emit` (also when it throws on the complaint too, and for a field JSON cannot hold)
    - [x] a `boot` line appears on the first tick of a fresh load
  - Verification: check, test, check:legacy; deliberate break: remove the limiter and see a test fail
  - Result: 11 new tests; 16 deliberate breaks of the module, each caught by a test. Also fixed on the way (own commit): two
    event fields were named `n` like the stamp's line number; they are now `players` and `lines`, and the compiler rejects a clash.
  - Dependencies: Task 1
  - Files: `rae/src/core/telemetryevents.ts`, `rae/src/config/balance.ts`, `rae/test/telemetry-emit.test.mjs`

- [x] **Task 3: Rounds emit `round.end`** (XS) - done
  `core/telemetry.ts` `pushRecord` also calls `emit("round.end", ...)` with the fields it stores. Importing the emitter here is
  what loads it in the game. Stored behavior does not change.
  - Acceptance:
    - [x] `telemetry.test.mjs` passes untouched (run it first, before editing): 12 of 12 before, the same 12 after
    - [x] a normal round gives one `round.end` line equal to the stored record (and to the real numbers: the test is lopsided on purpose so a swapped field cannot hide)
    - [x] an ACTIVE round reset gives reason `aborted`; a SETUP to IDLE cancel gives no line; an ENDED to IDLE reset gives no second line
    - [x] (added) rounds the saved history has already dropped (past `maxStoredRounds`) still go out as lines
    - [x] (added) the whole game, loaded as a world loads it (`main.js`), writes the boot line on its first tick and a `round.end` line when a round ends: the claim "importing the emitter here is what loads it in the game" is now tested, and cutting `main.ts`'s import of `core/telemetry.js` fails it
  - Verification: check, test
  - Result: 6 new tests (4 in `telemetry.test.mjs`, 2 in the new `telemetry-wiring.test.mjs`); 11 deliberate breaks, each caught by a test.
  - Dependencies: Task 2
  - Files: `rae/src/core/telemetry.ts`, `rae/test/telemetry.test.mjs`, `rae/test/telemetry-wiring.test.mjs`

- [x] **Task 4: Tool, ingest and archive** (S-M) - done
  `tools/telemetry/ingest.mjs`: finds the content logs (default `%APPDATA%\Minecraft Bedrock\logs`, `--logs <dir>` overrides:
  the flag itself is Task 5's CLI, `defaultLogsDir()` is here), reads each `.txt` in the folder read-only (so a copy of someone's
  log under any name is read too), keeps the `[telemetry]` lines, gives each a wall-clock time (date from the file name, time of
  day from the line, plus a day each time the clock jumps back by more than 12 hours, judged by every line's clock), drops an
  unfinished last line, and appends new events to the archive (dedupe on world + boot + number). Exports `ingest`, `parseLog`,
  `readArchive`, `launchTime`, `defaultLogsDir`. Returns counts: files, found, added, duplicates, skipped (other `v`), damaged,
  unfinished (the cut last line of a live log), unreadable. No archive is made when there is nothing to add.
  - Acceptance:
    - [x] a fixture log with noise lines, a cut last line and a midnight roll-over gives the right events with the right times
    - [x] ingesting the same log twice adds nothing; a copy under another name adds nothing
    - [x] a line with another `v`, a damaged JSON line, an empty one and garbage after the tag are counted and skipped, never fatal
    - [x] never writes into the logs folder (an archive placed inside it is refused); reads a file another process holds open (the test holds a handle)
    - [x] on the real folder it finished with no errors and 0 events (none are emitted yet): 100 logs, 121.3 MB, including the one the running game holds open, in 0.37 s; closed logs untouched, no archive made
    - [x] (added) the game's real entry separator is `\r\n\r\r\n`, not a newline: the fixtures use it, and a reader that split on plain newlines would match nothing (breaking that fails 10 tests)
  - Verification: `telemetry-tool-ingest.test.mjs`; one manual run on the real folder
  - Result: 15 new tests; 19 deliberate breaks of the reader, each caught by a test.
  - Dependencies: Task 1 (the format only; the tool has its own parser)
  - Files: `tools/telemetry/ingest.mjs`, `rae/test/telemetry-tool-ingest.test.mjs`

- [ ] **Task 5: Tool, rounds report, CLI and launcher** (M; built as two commits, 5a and 5b, because it came to six files)
  `aggregate.mjs` (pure: events to figures, one section per area), `report.mjs` (figures to one self-contained HTML file: tables
  with inline bars, no external requests), `cli.mjs` (ingest then report; `--out`, `--logs`, `--world`, `--open`; prints a short
  summary), one CSV per kind next to the report, and `tools/telemetry.cmd` (double-click: runs from its own folder and opens the
  report). Sections: Rounds (count, law and outlaw wins, average and median length, kills, deaths, coins at end) and a data panel
  (files read, events, worlds, builds, skipped lines, lines the game's rate limit dropped). Changed from the first draft:
  `--world <id>` is new (the world id is in every line so that worlds are not mixed; this is how a report picks one), and
  `--include-tests` waits for Task 8, where the first thing it affects (robbery test runs) arrives.
  - 5a, done: `aggregate.mjs`, `report.mjs`, `telemetry-tool-report.test.mjs`. Colours follow the dataviz method: law is palette
    hue 1 and outlaw hue 2 all through (checked with the palette validator in light and dark: colour-blind separation 24.7 and 26.8,
    contrast at least 3:1), aborted is neutral gray, every bar's number is also in text. 14 tests; 58 deliberate breaks, each caught.
  - 5b, next: `cli.mjs`, `telemetry.cmd`, a CLI test, and the contract test below.
  - Acceptance:
    - [x] fixture events give exact figures
    - [x] the HTML makes no external request, and an empty archive says "no data yet" instead of failing
    - [x] one CSV per kind, a header row and one row per event (`toCsv`; the CLI writes the files in 5b)
    - [ ] `telemetry.cmd` works when started from any folder
    - [ ] the report looks right in a browser (checked by eye)
    - [ ] (moved here from Checkpoint 1) contract test: a round played under the fake game is written as a real line, read by the tool and shown in the report
  - Verification: `telemetry-tool-report.test.mjs`; open the generated report in the built-in browser
  - Dependencies: Task 4
  - Files: `tools/telemetry/aggregate.mjs`, `tools/telemetry/report.mjs`, `tools/telemetry/cli.mjs`, `tools/telemetry.cmd`, `rae/test/telemetry-tool-report.test.mjs`, plus in 5b `rae/test/telemetry-tool-cli.test.mjs` and `rae/test/telemetry-contract.test.mjs`

### Checkpoint 1: walking skeleton
- [ ] check, test and check:legacy green
- [ ] contract test: a round played under the fake game produces a line the tool ingests, and the report shows that round
- [ ] (on the owner's request) deploy, load a world: the newest content log has a `[telemetry]` boot line; end one round; run `telemetry.cmd`; the round is in the report
- [ ] review with the owner before Phase 2

## Phase 2: robberies

- [ ] **Task 6: Run start, element and end events** (M; the biggest file in `core/`, edit surgically)
  In `core/robberyrun.ts`: `Run` gets `number` (a per-boot counter) and `actors` (distinct player ids). `begin()` emits
  `robbery.start`; `complete()` emits `robbery.element` (kind, locks, ticks since start, who); `endRun()` emits `robbery.end`
  (result, duration, elements done of total, distinct people). `endRun` is the one place all five endings pass through and its
  first-ending-wins rule stays.
  - Acceptance:
    - [ ] a full flow (reuse an existing run test's setup) emits start, one element line per element completed in order, and one `win` end with duration, done/of and people
    - [ ] each ending (end effect win and fail, time limit, empty area, stop, round reset) emits exactly one end with the right result; a second ending emits nothing
    - [ ] a test run carries `test:true`; a command-block start has no `p`
    - [ ] a teller hold-up shows as an element of kind `teller`
    - [ ] every existing robbery test passes untouched
    - [ ] deliberate breaks, each caught by a test: skip the emit in `endRun`; emit twice in `complete`
  - Verification: check, test, check:legacy
  - Dependencies: Task 2
  - Files: `rae/src/core/robberyrun.ts`, `rae/test/robbery-telemetry.test.mjs`

- [ ] **Task 7: Pick and payout events** (S)
  `pickLoop` emits `robbery.pick` when a lock jams or unlocks (hits, misses). `deliverReward` emits `robbery.payout` (coins and
  bounty actually given, summed over the recipients, the audience, the number of recipients): one line per reward effect, so a
  delayed effect is counted too. `applyEffect` passes the run to it.
  - Acceptance:
    - [ ] a jam gives `result: jammed` with misses equal to the lock's strikes; an unlock gives `unlocked`
    - [ ] a 100-coin reward to 3 players gives one payout with coins 300 and players 3; nobody to pay gives no line
    - [ ] a reward delayed past the end of the run still carries the run's number
    - [ ] existing tests untouched and green; one deliberate break caught (a wrong total)
  - Verification: check, test
  - Dependencies: Task 6
  - Files: `rae/src/core/robberyrun.ts`, `rae/test/robbery-telemetry.test.mjs`

- [ ] **Task 8: Robberies report section** (S-M)
  Per robbery (test runs left out unless `--include-tests`): runs; win, fail, stopped and round counts; average and median
  duration; average elements done of total; coins and bounty paid (total and per run); a per-element table (reached, completed
  percent, median time since start, jams, average pick misses); the latest runs.
  - Acceptance:
    - [ ] fixture events give exact figures; an element nobody completed shows 0%
    - [ ] test runs are excluded by default and included with the flag
    - [ ] a payout attaches to the right run by boot and run number
    - [ ] contract test: a bank robbery played under the fake game appears in the report with the right figures
  - Verification: tests; look at the report in the browser
  - Dependencies: Tasks 5, 6, 7
  - Files: `tools/telemetry/aggregate.mjs`, `tools/telemetry/report.mjs`, `rae/test/telemetry-tool-report.test.mjs`

### Checkpoint 2: robberies
- [ ] all green; the contract test covers a full robbery
- [ ] (on request) deploy; the owner plays a test run and a real one; the report matches what happened (result, time, elements, payout)
- [ ] review with the owner

## Phase 3: NPC shops

- [ ] **Task 9: Shop open, trade and refuse events** (S-M)
  In `core/shopforms.ts` `openShop`: `shop.open` once per screen opening; after `carryOutTrade`, `shop.trade` for a success
  (coins paid, coins received, items given and taken, service kinds) or `shop.refuse` with the reason text cut to 80 characters.
  The facts of a deal come from a small pure helper `tradeFacts(trade)` in `logic/telemetry.ts`. `shoptrade.ts` is not touched.
  - Acceptance:
    - [ ] buying one item gives open then trade, spent equal to the price, the item in give
    - [ ] a sell deal gives got; a deal with a service lists its kinds; a refusal for lack of coins gives refuse with the reason and no trade line
    - [ ] a deal that failed part-way and was undone gives refuse, not trade
    - [ ] "that deal has just changed" and the Close button emit nothing beyond the open; a second open while one is up emits nothing
    - [ ] existing shop tests untouched and green; one deliberate break caught
  - Verification: check, test
  - Dependencies: Task 2
  - Files: `rae/src/core/shopforms.ts`, `rae/src/logic/telemetry.ts`, `rae/test/shop-telemetry.test.mjs`

- [ ] **Task 10: Shops report section and coin flow** (S-M)
  Per shop: opens, trades, trades per open, coins spent by customers, coins paid to customers, top deals, services used, top
  refusal reasons (numbers replaced by `#`, so "you need 50 coins (you have 12)" groups). A coin-flow panel: coins in (robbery
  payouts plus sell deals) against coins out (purchases), and the last round-end coin total.
  - Acceptance:
    - [ ] fixture exact; refusal reasons group after the numbers are normalized
    - [ ] the coin-flow totals equal the sums of the section figures
    - [ ] contract test: a purchase under the fake game shows in the report
  - Verification: tests; look at the report in the browser
  - Dependencies: Tasks 5, 8, 9
  - Files: `tools/telemetry/aggregate.mjs`, `tools/telemetry/report.mjs`, `rae/test/telemetry-tool-report.test.mjs`

### Checkpoint 3: shops
- [ ] all green
- [ ] (on request) deploy; the owner buys, sells and is refused once; the report matches
- [ ] review with the owner

## Phase 4: handover

- [ ] **Task 11: Live switch, docs, test card** (M)
  `telemetry.events` boolean in `core/configoverrides.ts` (the live off switch); `docs/test-cards/TELEMETRY.md` (numbered
  in-game steps, the expected report figures, the log line to look for, how to turn the content log on); README and
  ARCHITECTURE.md rows (named here because the rules normally forbid editing them); `.gitignore` entry for `telemetry-data/`.
  - Acceptance:
    - [ ] `/rae:config get` and `set` of `telemetry.events` work under the fake and turn the lines off and on
    - [ ] the card has every step the owner needs, including "close the game or wait before running the tool: the live log is written in bursts"
    - [ ] `git status` after a tool run shows no data files
  - Verification: check, test, check:legacy
  - Dependencies: Tasks 2, 10
  - Files: `rae/src/core/configoverrides.ts`, `docs/test-cards/TELEMETRY.md`, `README.md`, `ARCHITECTURE.md`, `.gitignore`

- [ ] **Task 12: Release** (S; only when the owner asks)
  Bump the BP to 0.2.6 in four places (manifest header and two modules, `config/build.ts`), run the gate, clean build,
  `deploy.ps1` dry run then real, byte-verify, read the four world pins as JSON, tell the owner to fully quit and relaunch if the
  game is running. No push unless asked.
  - Acceptance: all four pins read 0.2.6; the repo build equals the game folder byte for byte; the rollback copy holds 0.2.5.
  - Dependencies: all of the above. Not started.

### Checkpoint: complete
- [ ] every acceptance box above is ticked
- [ ] the owner has run `docs/test-cards/TELEMETRY.md` in the real game and the report matches
- [ ] unmeasured items from the plan recorded in CLAUDE.md's engine facts (first real line, line length, boot timing, log pruning)
