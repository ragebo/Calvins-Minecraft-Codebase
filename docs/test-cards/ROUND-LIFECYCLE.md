# ROUND-LIFECYCLE test card: wiring core/round.ts in (ARCH-04)

Not a playtest-reported bug: this wires an already-built, already-tested state machine (`core/round.ts`) into starting, ending and resetting a round, closing a gap where nothing could answer "is a round running?" and the law win and the boat win each guarded against double-announcing independently. `test/round-flow.test.mjs` and `test/core-contracts.test.mjs` cover this thoroughly against the fake game API. This card is only for what those can't check: that it actually feels the same in the real game, since none of your everyday flows should look any different.

## What changed under the hood (nothing here should be visibly different)

- Starting a round (the button, `bounty:start_round`, or the menu) now moves the round through `IDLE -> SETUP -> ACTIVE` as it goes: `SETUP` during "Rolling...", `ACTIVE` once roles are revealed.
- A law win or a boat win now goes through the same shared gate (`endRound`), so they can never both announce a win for the same round.
- **New:** attempting the boat escape (`/scriptevent bounty:escape`) with no round running says "No round is running." instead of whatever it did before (nothing, or a confusing partial message on the closed edge case described in the README's new "The round lifecycle" section).

## Steps

Two players (one law, one outlaw) covers everything except the boat escape, which needs the full outlaw gang.

| # | Do | Expect |
|---|---|---|
| 1 | Start a round the normal way. | Looks exactly as before: "Rolling..." then role titles then "Roles Assigned!", same timing. |
| 2 | `/scriptevent bounty:escape` **before** starting any round (or right after a reset). | "No round is running." Nothing else happens — no coins touched, nobody teleported, no escape message. |
| 3 | Play a round to a law win (jail or eliminate every outlaw). | "THE LAW HAS WON!" exactly as before, once. |
| 4 | Reset (`/scriptevent rae:reset` or the menu), start a fresh round, play it to a boat escape this time. | "THE OUTLAWS HAVE ESCAPED!" exactly as before, with the right coin total, and the winners teleported. |
| 5 | Right after a law win (before resetting), try `/scriptevent bounty:escape` as the eliminated/jailed outlaw. | "No round is running." — not a second, empty "escaped" announcement. |
| 6 | Start a round, and while it's running (mid-fight, before anyone's won), start a **second** round from the menu or the button. | Works exactly as before: it resets and starts fresh, same as always. |

## Content log

Must not appear: `[Scripting][error]` lines, or anything naming `round.ts`, `endgame.ts` or `boat.ts`.

## Not checked

Every other system (raids, the train, jailbreak) is deliberately **not** gated on the round being active in this change — they still work exactly as before, whether or not a round is technically running. That's a separate, bigger change for later, not this one.
