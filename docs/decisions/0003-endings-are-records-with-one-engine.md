# 0003: Endings are stored records run by one engine; an escape is a flag on the player

## Status
Accepted. Decided 2026-10-15 with the owner (interview, then `tasks/endings/plan.md`); built and deployed the same week (BP 0.2.9).

## Context
The game had two endings and both were code. The law's win fired when every outlaw was jailed or eliminated. The outlaws' win was the boat: the whole gang within a radius of a fixed NPC, together holding a set price per member, run by the `bounty:escape` script event. The place, the price,
the radius, the words and the win spot were config constants, and there was no way to add a second ending. The new game needs about three, built in game the way the start sequence and the robberies are. The owner wanted two kinds: a **group** ending that ends the round for everyone, and a **solo** ending where one
outlaw leaves alone and the round goes on for the others.

## Decision
- An ending is a record (kind, place, radius, price, optional item, win spot, four messages, optional cinematic), saved with `core/recordstore.ts` (see 0001) and edited on operator-only screens. One engine, `core/endings.ts`, runs both kinds; `bounty:escape` stays and tries the boat.
- The boat becomes the first record, built from the old constants for a world that has never saved an ending. Its existing flow tests were left unchanged and had to keep passing.
- A solo escape is a **flag** (`escaped`) on the player's record in `core/state.ts`, not a new role and not the jailed or eliminated status. The owner said an escaper is "not jailed, not eliminated", and the `flags` map already existed for small per-player booleans, so no schema change. `core/players.ts` honors the flag in every "who is in play" query, once, so every system that asks
  stops seeing an escaped outlaw.
- The round ends when a group ending fires or when no outlaw is left in play. All escaped is an outlaw win; the rest jailed or eliminated (whoever escaped earlier) is the law's win. There is no new end reason.
- A cinematic is a camera pan played **after** the announcement, through the start sequence's own safety (its held-player list and generation counter), so a reset or a player leaving never leaves anyone locked and the round's end never waits for it.

## Alternatives considered
- **Leave the constants and add another.** Each ending would be another code path with its own copy of the gather and pay rules. Rejected.
- **Fully custom endings built from arbitrary pieces.** The owner scoped this out: pick a type, fill in the details.
- **An escaped outlaw as a role or as eliminated.** Would make every system that filters on role or elimination treat an escape as a defeat (and the law's win would then count it against the outlaws). A flag honored in one place avoids touching them.
- **Rewards and a Dead-by-Daylight-style scoring for the law.** Parked by the owner.

## Consequences
- Operators add, edit, turn off and delete endings in game; a refused value keeps what was typed and says why.
- Preflight checks every ending's place and win spot against the world's height limits and reports one that cannot be read. It does **not** check whether an ending's area is loaded: preflight never asks that of any point, because a legitimately far place is simply not loaded at startup.
- Telemetry names the group ending that ended a round and writes one line per solo escape (see 0002).
- **Unmeasured in the real game when this was built:** spectator mode for an escaper still counted as alive, the pan for several players at once, and an NPC button running `rae:ending`. `docs/test-cards/ENDINGS.md` is the run sheet, with the file a fix would go in for each.
