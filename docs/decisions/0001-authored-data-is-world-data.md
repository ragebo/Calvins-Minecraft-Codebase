# 0001: Data an operator builds in game is world data, not config

## Status
Accepted. First applied 2026-09-20 (the recorded train route); the rule for everything built in game since 2026-10-06.

## Context
Rule 3 of `CLAUDE.md` says every number and coordinate lives in `config/`. That suits tuning values and the fixed map. It does not suit things an operator **makes while playing**: the robberies, shops, camera shots, start commands and endings. These are many, specific to one world, and change often.
Putting them in config would mean editing TypeScript, rebuilding and redeploying for every new vault door or shop, and a deploy needs the game closed (`docs/DEPLOY.md`). The first piece of authored data, the train route recorded by walking it (`systems/transit.ts`), was already saved in a world property.

## Decision
Anything authored in game is saved in the world, one world dynamic property per record, through the generic `core/recordstore.ts`: written at once, capped in size, a record that cannot be read is listed and never overwritten, and one level of undo is kept.
`config/balance.ts` holds only the caps, defaults and tuning for each kind (`ROBBERY`, `SHOP`, `START`, `ENDINGS`). Where a feature replaces something that used to be config, a world that has never saved anything gets the old values as its default (the shipped boat ending is built from the old boat constants).

## Alternatives considered
- **Config files, edited and redeployed.** Keeps rule 3 literal, but every change needs a build and a deploy, and nobody can build a robbery while playing. Rejected.
- **Command blocks and NPC dialogue in the world.** What the owner had before: the logic is spread across the world where the code cannot see it, and resets were inconsistent (the fort chest never emptied, a reload mid-train left the bridge destroyed). Rejected for robberies and shops (see 0004).
- **One saved blob for everything.** `core/persist.ts` caps a key at 10,000 characters and silently skips a save over the cap, so a large robbery would be lost without a word. One property per record, with an explicit size check that refuses the edit, avoids it.

## Consequences
- Authored data lives in one world's save. It is **per world**; there is no export or import between worlds yet (the robbery plan lists it as a later phase). A world's data is only as safe as the world's save, which is why a robbery's `info` action with `raw` can dump a record to the log as a backup.
- A record has a version; a record from a different version is refused with a reason rather than guessed at.
- Each store's tests check the same rules (round trip, malformed input never throws, over-cap refused, unreadable never overwritten, undo).
- Rule 3 carries this one stated exception in `CLAUDE.md` and `ARCHITECTURE.md`.
