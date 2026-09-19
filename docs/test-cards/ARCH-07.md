# ARCH-07 test card: one writer for the title, action bar and chat (`core/ui`)

The new module `rae/src/core/ui.ts` decides who gets the single action-bar line: every line is posted under a source name and a priority (ambient 10, tool 50, alert 90), and only the winner reaches the screen. The law compass is its only caller so far: `systems/compass.ts` now posts its readout as source `compass` at the default `tool` priority instead of writing to the screen itself. Nothing else moved. In particular `roles.ts` still writes its two titles directly.

**What the player sees must not change at all.** Same readout, same look, same refresh rate, same fade-out. The compass posts every 4 ticks, and it must still send the line every time even when the text is identical: the client fades an action bar about two seconds after the LAST packet it gets, so a readout that is only sent when it changes would vanish while you stand still.

**What this card cannot show:** the arbitration itself (a lower-priority line failing to overwrite the compass). Nothing else posts to the action bar yet, so it only becomes visible once the heads-up display exists. Until then it is covered only by the fake-API tests in `rae/test/ui.test.mjs`.

## Automated (from `rae/`)

- `npm run check` prints only the `tsc --noEmit` line and exits 0.
- `npm test` ends with `ℹ fail 0`. The new tests are in `rae/test/ui.test.mjs`; the last one drives the real compass through `core/ui`. `compass.test.mjs` is unchanged and still green.
- `npm run check:legacy` shows `ui-direct` at 2, down from 3, and every other pattern `ok`.

## Setup

- Two players are best, and a third for step B: A and B both law, C outlaw. One player is enough for steps A1 to A5 if you tag them `law` and leave nobody tagged `outlaw` (the readout then says `No outlaws to track`), but the strip and the distance are only checked with an outlaw around.
- Creative world with the RAE pack, cheats on, Content Log GUI on (Settings > Creator > Enable Content Log GUI).
- `cd rae && npm run build`. `your_pack_name_BP/scripts/core/ui.js` must now exist. If the world keeps running the old scripts, bump the behavior pack version (README, "Building and testing").
- The `coins` and `bounty` scoreboards exist (`/scriptevent rae:debug` reports a missing one).

## 1. The module loaded

1. Load the world and wait a second.
   Expected: green `RAE loaded.` in chat. That line only appears if `main.js` and everything it imports loaded, including the new `core/ui.js`.
2. Run `/scriptevent rae:debug`.
   Expected: the `Systems:` line now includes `ui` (next to `compass`, `roles`, `jail` and the rest).

## A. The compass looks and behaves as before

A runs `/tag @s add law` and `/give @s bountysys:law_compass`. C (or B) runs `/tag @s add outlaw` and stands at least 10 blocks away, out of jail.

1. A holds the compass in the main hand.
   Expected within about a second: the action bar reads `NEAREST`, then a strip between `«` and `»` with a `*` marker on it, then the outlaw's name and a distance such as `14m`. `NEAREST` is blue, the name white, the distance gray. It looks exactly as it did before this change.
2. A stands perfectly still, camera not moving, for 10 seconds.
   Expected: the readout stays on the screen the whole time. **If it disappears about two seconds after you stop moving, the unchanged line is no longer being re-sent: fail.** This is the case the never-skip-a-repeat rule exists for.
3. A turns the camera slowly left and right.
   Expected: the `*` slides smoothly along the strip, refreshing about 5 times a second. It turns green within about 10 degrees of dead ahead. A marker that jumps once a second, blanks, or flickers is a fail.
4. A sneaks and uses the compass, then does it again after a second.
   Expected: the label switches `NEAREST` to `TOP BOUNTY` with a click and a chat line, then back. Nothing else about the readout changes.
5. A puts the compass away (another hotbar slot, or an empty hand), and starts a stopwatch.
   Expected: the last readout stays for about two seconds and then fades out by itself, as before. Nothing takes its place and nothing flickers. Note the time the readout stays visible; the module assumes about 2 s (40 ticks), so report it if it is clearly more than 3 s or less than 1 s.
6. A holds the compass again.
   Expected: the readout is back within a second.

## B. Two holders do not affect each other

A and B are both law and both hold a compass, with C outlaw somewhere.

1. Look at both screens, or have B report.
   Expected: each sees their own distance to C, and each readout keeps refreshing.
2. B puts the compass away while A keeps holding theirs.
   Expected: B's line fades after about two seconds. A's readout never blinks or stops. (Lines are kept per player id, so one holder can never blank another's.)

## C. A round reset

1. A holds the compass with a readout showing. Run `/scriptevent rae:reset`.
   Expected: chat `All systems reset.` and **no** `[RESET ERROR] ui` line. The reset also clears the `law` tag (the `roles` system owns it), so A's readout stops and fades. That is the existing behavior, not part of this task.
2. A runs `/tag @s add law` again, still holding the compass.
   Expected: the readout returns within a second. (The reset left nothing behind in `core/ui` that blocks the compass.)

## Pass and fail

- Pass: everything above as expected and nothing new in the content log.
- Fail: `ui` missing from the `Systems:` line, `RAE loaded.` missing, an empty action bar while A holds the compass, the readout vanishing while A stands still (A2), or any red `[COMPASS ERROR]`, `[TICK ERROR] compass` or `[RESET ERROR] ui` line in chat. If `ui` is missing, check that `your_pack_name_BP/scripts/core/ui.js` exists and rebuild if it does not.

## Content log

There is no log line to look for. The pass condition is the absence of new errors: no `[Scripting][error]` line, nothing mentioning `ui.js` or `setActionBar`, and none of `[COMPASS ERROR]`, `[TICK ERROR]` or `[RESET ERROR]` in chat. `core/ui` reports nothing to chat itself: if an engine call fails, the error goes back to the caller, and for the compass that is the same throttled `[COMPASS ERROR]` message as before.

## Not checked

The game was not run for this task; every expectation above comes from the code and the fake-API tests.

- The action bar's fade time after the last packet (about 2 s), which the 40-tick lifetime of a line is based on. A5 is the only measurement of it.
- `showTitle` and `clearTitle` are not called by anything yet (`roles.ts` migrates later), so there is nothing to see in game. The real title options need all three timings, so `showTitle` fills in any a caller leaves out with 10, 70 and 20 ticks, assumed to be the vanilla `/title` defaults and not checked against this build. Clearing a title by setting an empty one is what the typings document; whether that also removes a subtitle was not checked.
- `format`, `tell` and `announce` are not called by anything yet.
