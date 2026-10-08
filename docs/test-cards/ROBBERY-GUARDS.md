# ROBBERY-GUARDS test card: mobs that appear when you trigger something

An effect can now **spawn mobs**: pillagers that appear the moment a vault door opens, a lock jams, or the robbery starts, wins or
fails, to be an obstacle on the way through the bank. Everything that does not depend on the game is covered by the tests. What
they cannot say is what the REAL game does with a spawned pillager, and that is what this card is for.

- Not deployed yet: it ships in the next behavior pack after 0.2.2 (the deploy will say which). Operators only. Run it in your
  test world, with the wand (`/rae:robbery_wand`).
- `spawn` is one more thing under "Add:" on every effects screen: an element's **When it is done** and **When its lock jams**, and
  the robbery's **Start, win and fail effects**.
- Limits (by design, so a robbery cannot flood a server): at most **10** mobs in one effect and **30** in a whole robbery, counted
  over all its effects (each fires once a run, so 30 is the most that can ever stand at once).
- The mobs are tagged `rbg` and `rbg:<robbery id>`; that is how the site finds them to take them away.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Anywhere flat, away from your finished builds: place two stone buttons a few blocks apart (call them the alarm and the safe). `/rae:robbery_new guards "Guard Test"`, hold the wand and **right-click the alarm button**, name it `Alarm`, submit. Do the same for the other button: `Safe`. | Both bound as switches. |
| 2 | Open `Safe`: **When it is done**, **Add: end the robbery** (won, wait 0). Then the menu (left-click the air): **Area**, **A box around where I stand**, radius 15. `/rae:robbery_set outlawsOnly off`. `/rae:robbery_info guards`. | "Ready to run." |
| 3 | Walk to **where the pillagers should appear** (the floor of a room, a few blocks from the alarm) and stand still. Open `Alarm`: **When it is done**, **Add: spawn mobs**. | The form is **The mob** `minecraft:pillager`, **How many** 3, **Where: X / Y / Z** already filled with the block you stand on, and a wait. |
| 4 | Type `pillager` (no `minecraft:`), 4 pillagers, leave the rest, submit. Look at the effect's line. | "Added." The line reads **Spawn 4 pillager at X, Y, Z**. |
| 5 | Stand clear of the spot, empty hand, press the **alarm** button. | The robbery starts and **four pillagers appear one after another** (about a third of a second apart) at the spot. **Tell me: do they stand in the middle of the block, not in a wall? Do they carry crossbows? Do they come for you? Do they come for a law-side player standing near?** |
| 6 | Kill one. | Nothing special happens (no coins yet): the rest stay. |
| 7 | Press the **safe** button. | The robbery is won. **The pillagers are still there** (the site is put back a minute later by default). |
| 8 | Wait about a minute (the "seconds after it ends until the site is put back" setting). | **Every pillager is gone**, including ones that wandered off, as long as they are in a loaded area. |
| 9 | Start it again (alarm) and, once the four have appeared, `/rae:robbery_reset guards`. | **They vanish at once.** |
| 10 | Change the spawn effect to **10** pillagers, start it, and the moment the first appears `/rae:robbery_stop guards`. | **No more appear** after the stop, and the first is taken away within a second or two. |
| 11 | Start it, let them appear, then **quit to the main menu and rejoin the world** (do not stop it first). | A reload ends the robbery, so **within a few seconds of the chunk loading the pillagers are gone** (a guard that loads belongs to a robbery that is not running). |
| 12 | Try to add a spawn effect with the mob `minecraft:dragonn`. | "The game has no mob called minecraft:dragonn. Try minecraft:pillager, ..." and nothing is saved. |
| 13 | Add spawn effects until the robbery would spawn more than 30 mobs in all (three of 10, then one more). | The fourth is refused: "a robbery can spawn at most 30 mobs in all (this one would spawn 31)". |
| 14 | Open the menu: **Start, win and fail effects**, **When it starts**, **Add: spawn mobs**: 2 `vindicator` where you stand. Start the robbery. | Two vindicators appear the moment it starts, besides whatever the alarm adds. |

## What only the real game can answer (tell me what you SEE)

1. **Where and how they stand:** a pillager spawned at a block's middle, feet at the block's Y: inside a wall, a half-block up, or
   fine? (If the spot is in a wall it is the builder's block to move.)
2. **What they are:** do spawned pillagers have crossbows (a mob made by the game's own spawn rules does; one made by a script may
   not)? Do they go for law players too (they go for any player)? Do they wander far enough to leave a loaded area?
3. **The clean-up:** are all of them really gone at step 8 and step 9, and after the rejoin in step 11?
4. **Timing:** does the stagger look right (a third of a second apart), or do they bunch up?
5. Anything in the content log marked `[robbery]` ("could not spawn ...", "could not remove a guard") or `[Scripting][error]`.

## Known limits (by design, for this version)

- Killing a guard gives nothing (the ranch and train raids pay coins for kills; it would be one more setting).
- The mobs are the game's own, with its own AI: they hunt any player, law side or outlaw, and a pillager out of reach just stands.
- A guard in a chunk nobody has loaded cannot be removed until the chunk loads (then it goes at once).
- Nothing is pushed or deployed until you say so.
