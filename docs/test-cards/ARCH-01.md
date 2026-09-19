# ARCH-01 test card: one tick scheduler, per-handler cadence

Every repeating job now runs from one loop (`core/tick.ts`) and each has its own cadence. The ranch raid clock and the train mover moved onto it. **Nothing about pacing may change.** If a time below is off by a factor of two, a cadence is wrong.

`npm test` pins all of this against a fake game (`tick.test.mjs`, `train-cadence.test.mjs`, `ranch-cadence.test.mjs`). This card checks the real game.

**Compass status:** the compass loop is migrated last, after ARCH-02. Section D applies once that commit is in; until then the compass is simply unchanged and section D is a plain regression check.

## Setup

- Creative world with the RAE pack, cheats on, Content Log GUI on (Settings > Creator > Enable Content Log GUI).
- Scoreboards `coins` and `bounty` exist (`/scriptevent rae:debug` lists what is missing).
- A stopwatch. Times below are seconds after the first chat line unless said otherwise.

Wherever a step says "no errors": no chat line starting `[TICK ERROR]`, `[TRAIN ERROR]` or `[RAID ERROR]`, and no `[Scripting][error]` line in the content log.

## A. Train pace (10 ticks per hop, counted from the start)

| # | Do | Expect |
|---|---|---|
| A1 | Stand near the track start (-284, 94, -269). Run `/scriptevent bounty:train`. | Chat: "The train is moving out!" and "The bridge has been destroyed!". The train appears at the start of the track. |
| A2 | Start the stopwatch at "The train is moving out!". Watch the train. | It hops along the track twice a second (9 hops over 43 blocks, about 4.5 s). Chat "The vault car is open! Get to the chest before someone else does." and "The vault chest is full of gold!" arrive **5 s** after departure, and 3 pillager guards spawn at the end of the track. **10 s means the train runs at half speed: fail.** |
| A3 | While the train is still hopping (during A2), run `/scriptevent bounty:train` again. | "A train robbery is already in progress." The train does not speed up or hop twice. |
| A4 | After it has stopped, run `/scriptevent bounty:train` once more, then wait. | The start is refused: "Can't start a train robbery — train is already in progress." (the event lock is held until cleanup). "The train has been cleaned up." and the guards vanish 60 s after the vault opened; "The bridge has been rebuilt." 80 s after departure. |
| A5 | Once it has cleaned up, start a second robbery. | Same pace as A2. |
| A6 | Start another robbery and run `/scriptevent rae:reset` about 2 s in. | "All systems reset." The train stops where it is and never moves again. |

Log: no errors. A broken loop shows up as `[TICK ERROR] train:move` or `[TRAIN ERROR]` in chat.

## B. Ranch raid (clock counts whole seconds from the raid start)

Ranch area: x -295..-277, y 68..83, z -66..-41. Stand inside at about (-286, 69, -53) and give yourself the tag: `/tag @s add outlaw`. Anyone inside the area counts as a raider, tagged or not.

| # | Do | Expect |
|---|---|---|
| B1 | Alone inside, run `/scriptevent bounty:ranch`. | Chat "Ranch raid started!" and "Raid Started! 1 outlaw(s).". 2 pillagers spawn immediately. |
| B2 | Stopwatch from B1. | Wave 2 (2 more pillagers) at **17 s**, wave 3 (2 more) at **34 s**. At **50 s**: "Safe unlocked!", a redstone block at (-284, 76, -55), and every defender disappears. **Double those times means a half-speed clock: fail.** |
| B3 | During B2, watch your effects (you carry the `outlaw` tag). | Regeneration stays applied, particles hidden, refreshed every second while the raid runs. It is no longer refreshed after the safe unlocks. |
| B4 | With two players inside, start a raid. | Timer 60 s: wave 2 at 21 s, wave 3 at 41 s, unlock at 60 s. |
| B5 | Start a raid, then everyone leaves the ranch. | Within a second: "Raid ended early." The defenders vanish. No more waves, and the safe never unlocks. |
| B6 | Stand outside and run `/scriptevent bounty:ranch`. | "No outlaws are inside the ranch." Nothing spawns. Known V1 quirk, kept on purpose: the heal flag stays on, so an outlaw who then walks in gets regeneration each second, but no waves ever come. Run `/scriptevent rae:reset` afterwards to free the event lock. |
| B7 | Start a raid, then run `/scriptevent rae:reset` mid-raid. | "All systems reset." Defenders vanish. No further waves, no unlock, no regeneration. |
| B8 | During a raid, run `/scriptevent bounty:train`. | "Can't start a train robbery — ranch is already in progress." |

Log: no errors. A throwing raid loop is now reported in chat as `[TICK ERROR] ranch:raid: ...` (it used to be an uncaught error in the content log); the raid keeps ticking either way.

## C. The 20-tick jobs that share the loop (cadence unchanged, player list now fetched lazily)

| # | Do | Expect |
|---|---|---|
| C1 | Stand in water. | Poison (no particles) is applied within a second and kept up while you stay in the water. It wears off about 2 s after you leave. (`main:water-poison`) |
| C2 | Stand inside the fort (x -30..-4, y 69..79, z -65..-39) and run `/scriptevent bounty:fort`. | Waves advance as each is cleared, participants keep regeneration, the reward chest opens at the end. (`raid:fort`) |

Log: no `[TICK ERROR]` for `main:water-poison`, `raid:fort`, `ranch:heal` or `jailbreak:escort`.

## D. Compass follows the camera (4 ticks per refresh)

| # | Do | Expect |
|---|---|---|
| D1 | As a player with the `law` tag (`/tag @s add law`), `/give @s bountysys:law_compass` and hold it. Have an `outlaw` (not eliminated, not jailed) elsewhere. | A bearing bar on the action bar, naming the outlaw. |
| D2 | Turn the camera slowly left and right. | The marker slides smoothly, refreshing about 5 times a second. **A marker that jumps once a second means the compass fell onto the 20-tick cadence: fail.** |
| D3 | Sneak and use the compass. | Switches NEAREST <-> TOP BOUNTY with a click and a chat line. Nothing else changes. |

Log: no `[COMPASS ERROR]`, no `[TICK ERROR] compass`.
