# START-SEQUENCE test card: a clean start, a camera intro, and law choosing a spawn

What pressing Start does now, in order: **your start commands run** (the last game's list by default: effects cleared, health and food full,
bags emptied for anyone not in creative, everyone in survival, coins and bounty to zero), then a **camera intro** of 2 shots picked at random
from the ones you marked (10 seconds in all, everyone locked in place), then the **roles are revealed**, **outlaws fly down** to a random outlaw
spawn while **law choose their spawn** from a screen, and **play begins** when every law player has chosen and the outlaws' fly-down is over
(or after 20 seconds, with a random spawn for anyone who did not choose). Everything that does not depend on the real game is covered by the
tests (`test/start-*.test.mjs` and `test/cinematic.test.mjs`: about 130 tests, and about 250 deliberate breaks of the rules, each caught). What they cannot say is
how the camera moves, whether a screen opens after a camera, and what a player sees: that is this card.

- Not deployed yet: it ships in the next behavior pack after 0.2.6 (0.2.7). RP unchanged. Operators only for the editing; every player sees the result.
- **Two players are best** (one law, one outlaw: a second account, or a friend). Alone you can run steps 1 to 8 and 20 to 22.
- You edit it all from the RAE menu (`/give @s bountysys:game_menu`, right-click, **Start sequence**, which only operators see) and from the
  config editor (`/rae:config`, the group **Start sequence**). There is no new command.
- **Heads up:** the default start commands empty the bag of everyone **not in creative** at every Start, including the RAE menu item and the
  builder wand of an operator in survival. That is what the last game did. Edit the list (step 3) if you would rather not.
- A problem in the sequence goes to the content log as `[start]` (a failed start command, also to whoever pressed Start) or `[cinematic]` (a camera
  or lock the game refused: it says which, once).

## The editor (alone)

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:game_menu`, right-click. | The menu has a **sixth button, Start sequence**. (An account that is not an operator sees only five.) |
| 2 | Press **Start sequence**. | A screen: "Start commands: the defaults", "Camera shots: 0", and the buttons **Start commands (7)**, **Camera shots (0)**, Back. |
| 3 | **Start commands.** | The seven defaults, numbered 1 to 7, then **Add a command** and Back. Add `say Start commands work` (no slash needed): it is listed as 8, the next screen says "Added", and **Put the defaults back** now appears. Press 8 and change it; press 8 again and empty the box: "deleted". Try a line of over 200 characters, or an empty one: the box comes back with "Not saved: ..." in its title and what you typed still in it. Escape leaves everything as it was. **Put the defaults back** asks first. |
| 4 | **Camera shots.** | "No shots yet, so a start has no intro until you make one." One button: **Mark the start of a new shot here**. |
| 5 | Stand (or fly, in creative) where a shot should **start** and look the way the camera should look. Press **Mark the start of a new shot here**. Go where it should **end**, look that way, press **Mark the end here**. Name it `Town one` (or leave the name empty). | "Start marked at x, y, z" after the first press; after the second a name box ("Name (optional)"), then "Saved s1 (Town one)" and it is listed as **1. Town one**. Make three or four shots that look good: high over the town, along the bridge, the fort, the ranch. |
| 6 | Mark a start, then **close the menu** and open it again (Start sequence, Camera shots). | It still says the start is marked and offers **Mark the end here** and **Cancel marking**. Cancel it. |
| 7 | **1. Town one**, then **Preview**. | The menu closes, you cannot move, and the camera **pans from the start mark to the end mark over 5 seconds**, then hands your view back. (See "What only the real game can answer".) |
| 8 | Open a shot and press **Delete**; make another. | One button, nothing to confirm. The next shot you make gets the next number: a deleted shot's number is not reused at once. |

## A whole Start (two players)

Before step 9, give yourself something the default commands will visibly change: be in **survival**, then `/scoreboard players set @s coins 50`,
hold some item, and `/effect @s speed 60`. Have at least 3 shots saved.

| # | Do | Expect |
|---|---|---|
| 9 | Menu: **Start game**, **Choose roles** (you **Law**, your friend **Outlaw**), start it. Watch from the first second. | **1.** Your bag is empty, the effect is gone and coins are 0 (the commands ran; a player in creative keeps their bag). **2.** Everyone is **locked in place** and a camera intro plays: two of your shots, 5 seconds each, a hard cut between them, nothing else on the screen. **3.** At 10 seconds the roles are revealed: **LAWMAN** / **OUTLAW** titles and "Roles Assigned!". **4.** The law player gets a screen **Choose your spawn** with **Law spawn 1** and **Law spawn 2**. The outlaw is moved to a random outlaw spawn and the camera **flies down** from above it to their eyes over about 3 seconds; they stay locked. **5.** When law has chosen and the fly-down is over, everyone can move and play begins. |
| 10 | Law: press **Law spawn 2**. | You arrive there. Play begins at the end of the outlaw's fly-down (about 3 seconds after the reveal), not before. |
| 11 | Start again. This time law presses **Escape** on the spawn screen. | A random law spawn at once; play begins when the fly-down is over. |
| 12 | Start again. Law does **nothing** for 20 seconds. | At 20 seconds law is moved to a random spawn and play begins. **Tell me what you see on the law player's screen**: is the spawn screen still open? If you press a button on it then, nothing should happen (you are already placed). |
| 13 | With a **second law player** (three accounts), both press **Law spawn 1**. | Both are at spawn 1. Fine. |
| 14 | Start four or five times in a row. | The shots are not the same each time, and with 3 or more saved the intro never **opens** with the shot it opened with last time. |
| 15 | Delete every shot, then Start. | No intro: the commands, then straight to the reveal. A start is never blocked by missing shots. Make some again. |
| 16 | Start, and **reset the game** from the menu during the intro. | Everyone can move at once and has their own view back, and nothing else happens (no teleport, no play). |
| 17 | Start, and press **Start game** again during the intro. | The second start takes over: one intro at a time, play begins once. |
| 18 | Add the line `bogus command here` to the start commands and Start. | **You** (who pressed Start) get a red line "Start command N (bogus command here) did not run: ..." and the rest of the commands still run and the game still starts. Delete the line. (A start from the old button tells every operator online instead.) |
| 19 | Add a line that runs one of this add-on's own commands, for example `rae:robbery reset test_vault` (if you have one), and Start. | **Tell me whether it ran** (a vault door shutting, for example). This is the one thing in the list the tests cannot answer: whether the game lets a script run a `/rae:` command. If it did not, the red line says why. |

## The numbers and the safety net

| # | Do | Expect |
|---|---|---|
| 20 | `/rae:config`, **Start sequence**: six settings. Set **start.introSeconds** to 4 and Start. | The intro is 4 seconds, split between its shots. `start.introSeconds 0` skips it; so does `start.introEnabled off` (shots or not). |
| 21 | Set **start.pickSeconds** to 5, **start.flyDownSeconds** to 1, **start.flyDownHeight** to 50, **start.shotsPerStart** to 1; Start. | Law has 5 seconds; the outlaw's camera comes down from 50 blocks in 1 second; one shot plays for the whole intro. Put each back with "Put it back to the default". |
| 22 | In the middle of an intro, **quit to the main menu** and rejoin the world. | When the world loads nobody is left locked or stuck in a camera. (A reload cannot remember a sequence, so the next load lets everyone go.) |

## What only the real game can answer (tell me what you SEE)

1. **Does a pan look like a pan?** The camera should appear at the start mark and drift smoothly to the end mark. Watch for: it jumps straight
   to the end, it starts from your own view, or it stutters. Each pan is two camera calls made in the same tick, which no test can judge.
2. **Is the camera where you expected?** It sits at the marked **eye** position and facing; the shot should look as it did when you marked it.
3. **Several players at once:** does everyone see their own camera at the same moment, with no flicker?
4. **Locked players:** they cannot move, jump or sneak but can they still look around? Can a mob hurt them during the 10 seconds?
5. **The spawn screen after a camera:** does it open straight after the intro, after a moment, or not at all? (Opening a form straight after a
   camera is cleared is unmeasured.)
6. **A screen still open when the countdown ends** (step 12): what do you see, and does pressing a button then do anything?
7. **The default commands:** does `clear @a[m=!creative]` leave a creative player's bag alone and empty everyone else's? Does `gamemode survival @a`
   change you? Does `effect @a instant_health 1 10 true` heal to full, and do the two scoreboards go to 0?
8. **The fly-down:** does it end at the outlaw's eyes, so that when the camera is released nothing seems to jump?
9. **Anyone left locked or in a camera** after any of the above, however you got there. That is the worst thing this can do.
10. **How it feels:** is 10 seconds right, 20 seconds to choose, 3 for the fly-down? The six numbers are in `/rae:config`.

## Must not appear

A `[cinematic]` line in the content log (copy it to me: it says which camera or lock call the game refused), a `[start]` line that is not a command
you broke on purpose, any `[Scripting][error]` line, or a player who cannot move after play has begun.

## Notes

- A player who is not playing (a role of "Sit out") gets none of it: no commands are aimed at them by the code (their selectors decide), no camera,
  no lock, no title.
- The start commands run as the server in the overworld: `@a` and `@a[tag=law]` work (the roles are assigned before they run), `@s` does not.
- Law players see the spawn names the menu's Teleport list uses ("Law spawn 1", "Law spawn 2"). The numbers of spawns are `LAW_SPAWNS` in `config/world.ts`.
- Endings and their cameras are not part of this: they are not built yet. The same `core/cinematic.ts` is what they would use.
