# 0002: Telemetry leaves the game as content-log lines, read by an outside tool

## Status
Accepted. Decided 2026-10-11 (`tasks/plan.md`), built 2026-10-12. Extended by the endings on 2026-10-15 (`round.end` names the ending; a new `ending.escape` kind).

## Context
Before this, the only record of how rounds went was a ring buffer of 20 round summaries saved in the world, with no way to read it: no screen, no export. The owner wanted to see how robberies, shops and rounds actually play. A Bedrock script has no file or network access, and
`@minecraft/server-net` is not installed here (Microsoft documents it as dedicated-server-only; not verified in this project). The game's content log is the one place a running world's output survives, and it was already switched on and archiving on the owner's machine.

## Decision
The game only **emits events**: one line of JSON per event, written through `core/log.ts` to the content log as `[telemetry] {...}`. Every line carries a stamp (format version, a random world id kept in a world property, a boot id, a line number, the game tick, the build), so a log that lost its first lines
still parses and a line read twice is dropped by world + boot + number. A Node tool in `tools/telemetry/` (no dependencies) reads the logs into its own archive and writes an HTML report and CSV files. All counting happens in the tool; the game keeps no new saved state for it.
A line stays under 600 characters (text cut at 80, lists at 8), there is a rate limit and a live off switch, and no player names are written (the engine's id only).

## Alternatives considered
- **Saved counters in the world plus an in-game screen.** Needs the game running to look, and a counter saved as one key over 10,000 characters is silently skipped by `core/persist.ts`. Not in v1; easy to add on top of the same events.
- **Reading the world save offline.** Brittle: the game must be closed, one world at a time, and it needs a custom database reader to maintain.
- **HTTP from the script.** Not available in a local world.
- **A drag-and-drop HTML viewer.** Cannot find the logs folder by itself, and a double-clicked page cannot load ES modules.
- **A hosted dashboard.** Cannot read local logs and would mean uploading player data.

## Consequences
- A new question about the data never needs a game change, only a tool change, as long as the event carries the fields.
- The format is a contract between the game and the tool: `logic/telemetry.ts` defines it, versioned (`v`), and contract tests feed the tool lines from the real emitter so the two cannot drift. A field that changes meaning means a version bump; the reader skips versions it does not know.
- Whether the log is flushed promptly, how long a line it keeps and whether old logs are pruned were unmeasured when this was built; `docs/test-cards/TELEMETRY.md` is the run sheet that measures them.
- While the game runs, the log's last line may be cut; the tool treats that line as unfinished rather than damaged.
