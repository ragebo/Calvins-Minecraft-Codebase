# ARCH-09 test card: one director for the fort raid, ranch raid and train robbery

`core/eventLock.ts` (a one-flag lock each event wired by hand) is gone. `core/director.ts` now owns the three big scripted events: the shared slot, the `bounty:fort`, `bounty:ranch` and `bounty:train` script events (ids unchanged), the "already in progress" line, and freeing the slot. **Nothing a player sees may change, with one exception: the ranch bug below is fixed.**

The director can also queue, apply cooldowns, announce and pick an event by weight. **None of that is switched on:** no event has a cooldown, an announcement or a queue request, and nothing calls the random pick. Those parts are covered by `npm test` only (`director.test.mjs`); there is nothing to try in game.

`npm test` pins everything below against a fake game (`event-exclusion.test.mjs`, `director.test.mjs`, plus the existing `train-cadence` and `ranch-cadence`). This card checks the real game.

## Setup

- Creative world with the RAE pack, cheats on, Content Log GUI on (Settings > Creator > Enable Content Log GUI).
- Scoreboards `coins` and `bounty` exist (`/scriptevent rae:debug` lists what is missing).
- A stopwatch.
- Places (run `/tp @s <x> <y> <z>`):
  - **fort**: `-17 70 -52` (area x -30..-4, y 69..79, z -65..-39)
  - **ranch**: `-286 69 -53` (area x -295..-277, y 68..83, z -66..-41). Anyone standing inside counts as a raider, tagged or not.
  - **outside**: anywhere well clear of both areas, for example your world spawn.
- Between sections run `/scriptevent rae:reset` (expect "All systems reset.") so the next one starts from a free slot.

The red refusal line is always `Can't start a <fort raid | ranch raid | train robbery> — <event that is running> is already in progress.` (an em dash, and the running event is named `fort`, `ranch` or `train`).

Wherever a step says "no errors": no chat line starting `[EVENT ERROR]`, `[TICK ERROR]`, `[RAID ERROR]` or `[TRAIN ERROR]`, and no `[Scripting][error]` line in the content log.

## A. The director is loaded and the three ids still work

| # | Do | Expect |
|---|---|---|
| A1 | Load the world. Run `/scriptevent rae:debug`. | The `Systems:` line lists `director` and no longer lists `event-lock`. The `Events:` line still lists `bounty:fort`, `bounty:ranch` and `bounty:train` (and the other public ids). |
| A2 | At **fort**, run `/scriptevent bounty:fort`. | "Raid started! 1 player(s)." and the first wave spawns (2 pillagers, 1 vindicator for one player). |
| A3 | Walk out to **outside**. | Within a second: "[DEBUG] Fort raid ended" (red) and the mobs vanish. |
| A4 | At **ranch**, run `/scriptevent bounty:ranch`. | "Ranch raid started!", then "Raid Started! 1 outlaw(s).", and 2 pillagers spawn. |
| A5 | Walk out to **outside**. | Within a second: "Raid ended early." and the defenders vanish. |
| A6 | Run `/scriptevent bounty:train`. | "The train is moving out!", "The bridge has been destroyed!", and the train hops along the track. |

Log: no errors. Run `/scriptevent rae:reset` before the next section.

## B. One at a time: every pair is refused with the same line, and nothing starts

Start the first event, then immediately request the second. Expect exactly one red line in chat and nothing spawning or moving. Reset between rows.

| # | First (running) | Then request | Expect |
|---|---|---|---|
| B1 | fort (at **fort**) | `bounty:ranch` | "Can't start a ranch raid — fort is already in progress." No ranch mobs. |
| B2 | fort | `bounty:train` | "Can't start a train robbery — fort is already in progress." No train, no explosion. |
| B3 | fort | `bounty:fort` | "Can't start a fort raid — fort is already in progress." No additional mobs spawn. |
| B4 | ranch (at **ranch**) | `bounty:fort` | "Can't start a fort raid — ranch is already in progress." |
| B5 | ranch | `bounty:train` | "Can't start a train robbery — ranch is already in progress." |
| B6 | ranch | `bounty:ranch` | "Can't start a ranch raid — ranch is already in progress." No "Ranch raid started!" line, no extra pillagers. |
| B7 | train | `bounty:fort` (at **fort**) | "Can't start a fort raid — train is already in progress." |
| B8 | train | `bounty:ranch` (at **ranch**) | "Can't start a ranch raid — train is already in progress." |
| B9 | train, still moving (within 5 s) | `bounty:train` | "A train robbery is already in progress." This is the train's own line, not the shared one. The train does not speed up. |

Log: no errors.

## C. A robbery holds the slot until its cleanup

Stay at **fort** for this whole section. The robbery starts wherever you stand, and you need to be inside the fort for C4.

| # | Do | Expect |
|---|---|---|
| C1 | Run `/scriptevent bounty:train`. Start the stopwatch. About **5 s** later the vault car opens (chat "The vault car is open!") and 3 pillager guards spawn. The train has stopped. | As in ARCH-01 A2. |
| C2 | Now run `/scriptevent bounty:train`. | "Can't start a train robbery — train is already in progress." (the shared line: the train is no longer moving, but it still holds the slot). |
| C3 | Now run `/scriptevent bounty:fort` and `/scriptevent bounty:ranch`. | Both refused: "Can't start a fort raid — train is already in progress." and "Can't start a ranch raid — train is already in progress." |
| C4 | Wait for "The train has been cleaned up." (60 s after the vault opened; the guards vanish). Immediately run `/scriptevent bounty:fort`. | The fort raid starts: "Raid started! 1 player(s).", no refusal. The slot is free on the very tick of the cleanup. |
| C5 | Wait for "The bridge has been rebuilt." (80 s after departure). | Unchanged from before: the bridge comes back. |

Log: no errors.

## D. An event that never really started must not keep the slot (the bug fix)

| # | Do | Expect |
|---|---|---|
| D1 | Stand **outside**. Run `/scriptevent bounty:fort`. | "No one is inside the area." Nothing spawns. |
| D2 | Right away, at **outside**, run `/scriptevent bounty:train`. | The train starts ("The train is moving out!"). No "Can't start" line. (The slot was never kept.) Run `/scriptevent rae:reset`. |
| D3 | Stand **outside** the ranch. Run `/scriptevent bounty:ranch`. | Two lines, in this order: "Ranch raid started!" then "No outlaws are inside the ranch." Nothing spawns. (The first line is printed before the raiders are counted, as it always was.) |
| D4 | **Without resetting**, `/tp` to **fort** and run `/scriptevent bounty:fort`. | The fort raid starts: "Raid started! 1 player(s).". **Before this change** this was refused with "Can't start a fort raid — ranch is already in progress." until a round reset. |
| D5 | Run `/scriptevent rae:reset`. Repeat D3, then run `/scriptevent bounty:train` instead of D4. | The train starts. |
| D6 | (Kept V1 quirk, unchanged.) After D3, an outlaw (`/tag @s add outlaw`) who walks into the ranch gets regeneration refreshed every second, but no waves ever come and the safe never unlocks. | As described. Run `/scriptevent rae:reset` afterwards to turn the heal off. |

Log: no errors, and no `[director]` line: a start that says "no" is not an error.

## E. A round reset frees the slot

For each of fort (at **fort**), ranch (at **ranch**) and train:

| # | Do | Expect |
|---|---|---|
| E1 | Start the event. Confirm a second request is refused (section B). | The refusal line. |
| E2 | Run `/scriptevent rae:reset`. | "All systems reset." The event stops: mobs vanish, the train stops where it is and never moves again, no further waves, no "Safe unlocked!". |
| E3 | Immediately request any of the three events (for example `bounty:train`, or `bounty:fort` at **fort**). | It starts. No refusal line. |

Log: no errors.

## F. Events that run to their end also free the slot

| # | Do | Expect |
|---|---|---|
| F1 | At **ranch**, alone, run `/scriptevent bounty:ranch` and wait. | Wave 2 at about 17 s, wave 3 at about 34 s, "Safe unlocked!" at about 50 s and the defenders vanish (timings as in ARCH-01 B2). |
| F2 | Right after "Safe unlocked!", run `/scriptevent bounty:fort` (at **fort**). | The fort raid starts. No refusal. |
| F3 | (Optional, slow) Clear all three fort waves. | "The fort has been cleared! The reward chest is open." Then any event can start at once. |

Log: no errors.

## Log lines to look for

- **Nothing** is the pass condition for every section: no `[EVENT ERROR]`, `[TICK ERROR]` or `[Scripting][error]` line, and no line starting `[director]`.
- The director writes one line to the content log only when an event's `start()` throws: `[director] <id> threw while starting: <error>`. It also frees the slot when that happens. If you see it, note the event id and the error text.

## Pass and fail

- Pass: every step as expected and nothing in the log.
- Fail: a refusal line has different wording or names the wrong event, a second event starts while one runs, an event stays refused after it ended, after a failed start (D4) or after a reset (E3), or a pace or message from ARCH-01 changed.

## Not checked

The game was not run for this task; every expectation above comes from the code and the fake-API tests. The coordinates and the Content Log menu path are taken from the ARCH-01 and ARCH-13 cards. ARCH-01's B6 ends with "Run `/scriptevent rae:reset` afterwards to free the event lock": that is no longer needed (D3 and D4 above).
