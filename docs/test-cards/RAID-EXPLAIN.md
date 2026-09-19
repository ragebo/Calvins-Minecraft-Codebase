# RAID-EXPLAIN test card: a raid that refuses to start says why

Not an ARCH task: added after a playtest where the fort answered `No one is inside the area.` to a player who had checked the coordinates. The old line could not tell a player one block too low from a player who is **eliminated**. An eliminated player is skipped by the fort and the ranch wherever they stand, and the `eliminated` tag stays on a player after jail testing until a reset.

Now the refusal keeps its first line and adds one grey line per player saying why they don't count. Nothing about who counts, or about starting a raid that does have someone inside, has changed.

`npm test` pins this against a fake game (`raid-explain.test.mjs`, 11 tests, each line of the new logic broken on purpose at least once). This card checks the real game.

## What counts as "inside" (unchanged)

A player counts only if **both** are true: their feet are inside the box, and they do **not** carry the `eliminated` tag. Roles do not matter for the fort or the ranch. The edges are inclusive.

| Area | x | y (feet) | z |
|---|---|---|---|
| Fort | -30 to -4 | 69 to 79 | -65 to -39 |
| Ranch | -295 to -277 | 68 to 83 | -66 to -41 |

The train ignores where anyone is standing.

## Steps

Cheats on, chat visible. `/tag @s list` shows your tags; F3 shows your feet position.

| # | Do | Expect |
|---|---|---|
| 1 | Stand inside the fort, well within the box. `/scriptevent bounty:fort`. | `Raid started! 1 player(s).` and mobs. No grey lines. |
| 2 | End it (`/scriptevent rae:reset`). `/tag @s add eliminated`. Stand inside the fort. `/scriptevent bounty:fort`. | `No one is inside the area.` then a grey line `  <you>: eliminated, so they don't count wherever they stand`. No raid. |
| 3 | `/tag @s remove eliminated`. (On 0.1.5 and later the record follows the tag within about a second; the raid reads the tag itself and needs no wait.) `/scriptevent bounty:fort`. | The raid starts. |
| 4 | `/scriptevent rae:reset`. Stand at the fort's x and z but one block below its floor of y 69 (or on its roof above y 79). `/scriptevent bounty:fort`. | `No one is inside the area.` then `  <you>: y 68.0 is outside 69 to 79` (your own y). |
| 5 | Stand beside the fort, off in x and z. `/scriptevent bounty:fort`. | One grey line naming both, for example `  <you>: x 5.0 is outside -30 to -4; z -20.0 is outside -65 to -39`. |
| 6 | With a second player who is far away and not eliminated, and you inside the fort. `/scriptevent bounty:fort`. | The raid starts and **nothing** is explained: someone counted. |
| 7 | Ranch: `/tag @s add eliminated`, stand inside the ranch, `/scriptevent bounty:ranch`. | `Ranch raid started!`, `No outlaws are inside the ranch.` (both as before), then `  <you>: eliminated, so they don't count wherever they stand`. |
| 8 | Right after step 2 or 7, `/scriptevent bounty:train`. | `The train is moving out!`. A refused raid does not block the others. |

## Content log

- Must not appear: `[TICK ERROR]`, `[EVENT ERROR]`, `InvalidEntityError`.
- The refusal lines are chat only.

## Not checked

- The game was not run for this change. The lines and the tag and position checks come from the fake-API tests and from reading the code.
- How `player.location` behaves at a block edge in the real engine (the tests use exact values; the code compares numbers, inclusive at both ends, and shows one decimal).
