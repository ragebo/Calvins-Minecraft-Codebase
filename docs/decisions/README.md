# Decision records

Short records of decisions that shaped this codebase and would be expensive to reverse, written so the reasoning survives the people and sessions that made them. Code shows *what* was built; these say *why*, and what was rejected.

| # | Decision | Status |
|---|---|---|
| [0001](0001-authored-data-is-world-data.md) | Data an operator builds in game is world data, not config | Accepted |
| [0002](0002-telemetry-through-the-content-log.md) | Telemetry leaves the game as content-log lines, read by an outside tool | Accepted |
| [0003](0003-endings-are-records-with-one-engine.md) | Endings are stored records run by one engine; an escape is a flag on the player | Accepted |
| [0004](0004-shops-are-data-and-a-screen.md) | A shop is data and a script-driven screen, not a chain of commands in an NPC's buttons | Accepted |
| [0005](0005-jails-are-records-with-buttons.md) | Jails are stored records, and a bound block starts the lockpick | Accepted |

Rules for adding one: number it next in sequence, never delete or rewrite an accepted one (write a new record that supersedes it and change the old one's status line), and record the alternatives that were rejected with the reason.
Statuses: Proposed, Accepted, Superseded by NNNN, Deprecated. The layer rules and the seven rules are in `CLAUDE.md`; the file-by-file map is in `ARCHITECTURE.md`; the working plans behind these decisions are in `tasks/`.
