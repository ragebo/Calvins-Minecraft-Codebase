# Implementation Plan: telemetry for robberies and NPC shops, and a way to read it

Status of each task: `tasks/todo.md` (the source of truth). Nothing here is built, deployed or pushed.

## Overview

Today `core/telemetry.ts` records one thing, round summaries (a 20-round ring buffer saved in the world), and nothing can
read it: no in-game screen, no export. This plan does three things.

1. Records robbery runs and NPC shop activity as well (an NPC here means the shopkeepers; a teller hold-up is a robbery element).
2. Writes every record as one JSON line into the game's content log, the one way a Bedrock script has to get data out of a
   running world. This machine already keeps that log (see below).
3. Adds a small Node tool in the repo, no dependencies, that reads the content logs, keeps its own archive, and writes an HTML
   report plus CSV files. Double-click `tools/telemetry.cmd`.

The game side only emits events. All counting happens in the tool, so there is no new saved state in the world.

## What exists today (checked on 2026-10-11, not assumed)

- Telemetry: `core/telemetry.ts`, rounds only, saved as `rae:persist:telemetry`, imported by `main.ts` for its side effects. A
  read-only scan of the five worlds earlier today found no saved rounds.
- Content log: `%APPDATA%\Minecraft Bedrock\logs\ContentLog<date>_<time>_1.txt`, one file per game launch. "Enable Content Log
  File" is on here: 100 files since 2026-08-08, today's is being written now. 100 is a round number, so the game may prune at 100
  (unverified).
- Line shape: `18:36:51[Scripting][warning]-[tag] message`. Time of day only (the date is in the file name) and no world name.
- `core/log.ts` `info()` is `console.warn`, so it lands at the `[warning]` level. The project never uses `console.log`.
- Long lines survive: the 2026-10-06 log holds an intact 18,467-character script line. Volume is tiny: 3,423 script lines in
  100 files, so a few lines per robbery or purchase will not crowd it.
- A Node script can read the log of the running game (46 KB in 4 ms), but while the game runs the file ends mid-line, so the
  last line may be cut.
- No other way out: a script has no file API, and `@minecraft/server-net` is not installed in this project (Microsoft
  documents it as dedicated-server-only; not verified here). Wall-clock time inside the game is unmeasured (`Date.now` is
  used nowhere in `src`), so events carry the game tick and the tool derives the date from the log.
- Hook points (read directly; Graphify confirmed the callers): `endRun()` is the one place every run ending passes through (five
  callers: the end effect, the time limit, an empty area, stop, reset); `begin()` starts a run; `complete()` finishes an element
  (callers: activate, a lock, a cascade, finishLocks); `deliverReward()` pays out and has one caller; `pickLoop` jam/unlock;
  `openShop()` is the only caller of `carryOutTrade()`.

## How the data gets out: options considered

| Option | Verdict |
|---|---|
| One JSON line per event in the content log, read by a Node tool | **Chosen.** Already enabled, full history, no new saved state, no game-side file or network needs. |
| Saved counters in the world plus an in-game screen | Not in v1. Needs the game running to look, and a saved key over 10,000 characters is skipped silently by `core/persist.ts`. Easy to add later on top of the same events. |
| Read the world save offline (my LevelDB scan script) | Brittle: game must be closed, one world at a time, a custom reader to maintain. |
| HTTP from the script | Not available in a local world. |
| Drag-and-drop HTML viewer | Cannot find the logs folder on its own; a double-clicked page cannot load ES modules. |
| Hosted Artifact dashboard | Cannot read local logs; would mean uploading player data. |

## Architecture decisions

- **AD1 Events, not counters.** Anything countable is derived from lines, so a new question never needs a game change.
- **AD2 The format.** `[telemetry] {"v":1,"k":"robbery.end","w":"<world>","b":"<boot>","n":<seq>,"t":<tick>,"bv":"0.2.5",...}`.
  Every line is self-contained (world id, boot id, sequence, build), so a log that lost its first lines still parses. Dedupe
  key is world + boot + seq, so reading the same log twice, or a copied log, adds nothing. A line stays under 600 characters:
  strings are cut at 80, lists at 8.
- **AD3 World id.** A random six-character id in the world property `rae:telemetry:world`, outside the `rae:persist:` prefix so
  `rae:persist_reset` does not rename a world. Without it the five worlds (and test worlds) would mix in one report.
- **AD4 Safety.** A live off switch (`/rae:config set telemetry.events false`), a rate limit with a `telemetry.dropped` line,
  the size guard above, and no player names (the raw player id only; names are an open question).
- **AD5 One hook per event** (table below), each placed where all paths pass through.
- **AD6 The tool.** Node, no dependencies, in `tools/telemetry/`. Steps: ingest logs into the archive `telemetry-data/events.jsonl`,
  then build the report from the archive (so a pruned log loses nothing). The tool has its own tiny parser, not the game's
  TypeScript; a contract test feeds it lines from the real emitter so the two cannot drift.
- **AD7 Test runs** (`/rae:robbery start <id> test`) are tagged `test:true` and left out of reports unless asked.
- **AD8 Layers.** `logic/telemetry.ts` is pure; `core/telemetryevents.ts` is a client of `core/log.ts` (the single writer,
  rule 5) and imports no system. No new `/rae:` command or script event, so the public-id rules are untouched.

## Event list (v1)

| Kind | Emitted from | Fields (besides the stamp) |
|---|---|---|
| `boot` | first tick after a world loads | none (the stamp has world and build): the check that the pipe works |
| `round.end` | `core/telemetry.ts` `pushRecord` | reason, dur, kills, deaths, lawKills, outlawKills, coins |
| `robbery.start` | `begin()` | id, r (run number), test, p, role, inside |
| `robbery.element` | `complete()` | id, r, el, kind, locks, after (ticks since start), p |
| `robbery.pick` | `pickLoop` on jam or unlock | id, r, el, result, hits, misses, p |
| `robbery.payout` | `deliverReward()` | id, r, coins, bounty, to, players |
| `robbery.end` | `endRun()` | id, r, result, test, dur, done, of, people |
| `shop.open` | `openShop()` | id, p, role |
| `shop.trade` | `openShop()` after a deal succeeds | id, deal, face, spent, got, give, take, svc, p, role |
| `shop.refuse` | `openShop()` after a deal is refused | id, deal, why, p |
| `telemetry.dropped` | the emitter | lines |

## Task list (ordered; details and status in `tasks/todo.md`)

### Phase 1: walking skeleton (rounds, end to end)
- Task 1: event contract (pure)
- Task 2: the emitter
- Task 3: rounds emit `round.end`
- Task 4: tool, ingest and archive
- Task 5: tool, rounds report, CLI and launcher
- Checkpoint 1: first real line in the real log

### Phase 2: robberies
- Task 6: run start, element and end events
- Task 7: pick and payout events
- Task 8: robberies report section
- Checkpoint 2

### Phase 3: NPC shops
- Task 9: shop open, trade and refuse events
- Task 10: shops report section and coin flow
- Checkpoint 3

### Phase 4: handover
- Task 11: live switch, docs, test card
- Task 12: release (only when asked)

Two lanes can run in parallel after Task 1: the game lane (2, 3, 6, 7, 9) and the tool lane (4, 5, 8, 10). They meet in each
phase's contract test.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Real-game behavior of the channel is unmeasured (first real line, line length, boot timing) | High | Walking skeleton first: Checkpoint 1 is the earliest possible real-game proof, with only a `boot` line and `round.end` at stake. |
| Content log is off on another machine | Med | Documented in the test card; nothing is lost on this machine (it is on). No in-world fallback is built, by choice. |
| The log is pruned (the 100-file count) or cut mid-line while the game runs | Med | Archive keeps events after the first ingest; the tool ignores an unfinished last line and reports it. |
| Lines carry no date and no world | Med | Date from the file name with a +1 day roll-over; world id in every line. |
| Hooks regress the 1,378-line `robberyrun.ts` | Med | Characterization first: existing tests stay green untouched; one deliberate break per hook must fail a test (project policy). |
| Telemetry floods or slows the game | Low | Rate limit, size guard, kill switch, `info()` is one console write. |
| `rae:persist_reset` or a deleted world property changes a world id | Low | Id lives outside the persist prefix; the report shows a split world twice and the tool can label ids. |

## Open questions (a default is used unless you say otherwise)

1. Player names in the lines? **Default: no, only the raw player id and the law/outlaw role.**
2. "NPC" means the shopkeepers (tellers count through their robbery). Quests do not exist yet. **Default: as stated.**
3. In-game stats screen? **Default: not in v1** (it needs saved counters; see the options table).
4. Tool at `C:\rae\tools\telemetry\` and its data at `C:\rae\telemetry-data\` (gitignored)? **Default: yes.**

## Not in this plan

Guard kills and spawn counts, refused robbery starts, a live-updating dashboard, per-player leaderboards, import of other
people's logs, a network upload. Each is a small addition to the same event stream later.
