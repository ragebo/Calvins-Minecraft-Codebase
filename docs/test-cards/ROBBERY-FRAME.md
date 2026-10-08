# ROBBERY-FRAME test card: steal what an item frame shows

For the jewelry store. A robbery can now have **item frames** as elements: you bind a frame with the wand like a chest or a
door, give it loot, and whoever takes from it gets the loot while the frame is emptied; when the site is put back the frame
shows its item again. Everything that does not depend on the game's own behavior is covered by the tests. What the tests
cannot say, because the game's scripts have no item-frame support at all and nobody has measured it yet, is what this card is for.

- Behavior pack **0.2.1**, resource pack unchanged (1.0.27). BP only. The 0.2.1 deploy also carries the NPC shop changes (typed
  teleports, `/rae:shop_move`): those are `NPC-SHOP.md` steps 29 to 36, a separate run. Fully quit and relaunch Minecraft
  after the deploy so you are sure the new scripts are what is running.
- Operators only. Run it in your test world, away from a finished build, or on the real jewelry store: the steps work on any
  frames.
- RAE2's load line says a scoreboard objective may be missing. The loot needs none, but the bounty reward in step 5 does:
  `/scoreboard objectives add bounty dummy` (and `coins`) if they are missing.
- **How a frame works.** The game cannot tell a script what is inside a frame, so **the loot is set on the element** (a loot
  table, fixed items, or both), and what the frame shows is only the display. Binding a frame also saves what it shows, so it
  can be shown again after a theft. If you change the display later, press **Save what the frame shows now** in its screen.
- `npm test` covers (1139 tests in all, 74 of them new for frames, and 75 deliberate breaks of the frame rules each caught by at least one): the data and
  its validation, the saved form, binding and re-binding, the world layer (save, empty, restore, remove what popped out), the
  whole theft (locks, requirements, outlaws only, overflow, a table), the reset by timer, stop, reload, unloaded chunk and a
  missing copy, the right-click cancel, every order the game might report a punch in, the builder's screens, and the wand's
  ray looking through a frame. None of that says what the REAL game does with a frame: that is this card.

## The short run (steps 1 to 11): bind, rob, put back

| # | Do | Expect |
|---|---|---|
| 1 | On a wall, put up three item frames: a plain one holding a **diamond**, a **glow** item frame holding an **emerald**, and a third plain one holding a **gold ingot** that you will NOT bind. Put a stone button beside them. | Just a display. |
| 2 | `/rae:robbery_new jewels "Jewelry Store"`, then `/rae:robbery_wand`, hold the wand and **right-click the diamond frame**. (Or use your own robbery: select it with `/rae:robbery_select`.) | The item in the frame **does not turn**. A form "Jewelry Store: bind a block" opens with **An item frame: what it shows can be stolen** already chosen, and no question about a neighbouring chest. **If nothing opens, or the item turns, stop and tell me: it would mean the game does not report a click on a frame like it does on other blocks.** |
| 3 | Name it `Necklace` and submit. | Chat says it is bound and the Necklace screen opens. Its text says **Saved copy of the frame: yes**. (If it says NO, chat also told you "could not be saved" and why: tell me the words.) |
| 4 | Press **Loot**; under "Items to add on top" type `minecraft:diamond 2`; submit. | Chat says this is what the thief is given, and to press "Save what the frame shows now" if you change the display. |
| 5 | **When it is done** then **Add: pay out** (coins 0, bounty 100, to **The player who did it**), submit, then **Back** until the screens are gone. | Reopening the Necklace (wand, right-click) shows "Loot: minecraft:diamond 2" and one effect. |
| 6 | Right-click the **glow frame** with the wand: name it `Ring`, submit. **Loot**: `minecraft:emerald 3`. **Waits for**: turn on `Waits for Necklace`, submit. **When it is done** then **Add: end the robbery** (The robbery is won, wait 3 seconds). | The Ring screen also says **Saved copy of the frame: yes**. |
| 7 | Stand in the middle of the shop. Menu (left-click the air): **Area**, **A box around where I stand**, radius about 10. Then `/rae:robbery_set outlawsOnly off` and `/rae:robbery_info jewels`. | "Ready to run." The Ring "waits for Necklace". (A frame with no loot and nothing to do when done is listed as unfinished: that is by design.) |
| 8 | Put the wand away (an empty hand). **Right-click the Ring first.** | Nothing is given. You are told it will not budge (nothing is running yet, and the Ring waits for the Necklace so it cannot start the robbery). **The emerald stays in the frame and does not turn.** |
| 9 | Right-click the **Necklace**. | The diamond is **gone from the frame**, the frame stays on the wall, you are given **2 diamonds**, chat says you took them, a sound plays, your bounty goes up 100. **Look at the floor: nothing should have dropped.** |
| 10 | Right-click the **Ring**. | The emerald is gone, you are given 3 emeralds, and about 3 seconds later the robbery is won. Right-click the Necklace again: nothing more is given. |
| 11 | Right-click the **third (unbound) frame**, and punch it. | Plain game behavior: the item turns, or pops out. The framework does not touch it. Put it back. |

## Putting it back

| # | Do | Expect |
|---|---|---|
| 12 | `/rae:robbery_reset jewels` (or wait about a minute after the win). | **Both frames show their item again**: the diamond in the plain frame, the emerald in the glow frame. Tell me if an item is missing, is a different item, is turned a different way, or the glow frame is no longer glowing. Look at the floor: nothing extra. |
| 13 | Take the necklace again (right-click, empty hand), then **quit to the main menu and relaunch** (or close the world) before the reset time. Rejoin and wait a few seconds. | The diamond is back in the frame by itself once the area has loaded. |

## Punching (what the game really does: please look carefully)

A punch on a frame makes the game pop the item out. A script can see that but cannot stop it, so the framework takes the popped
item away a tenth of a second later, puts the frame back as it was, and counts the punch as trying to take the item. Nobody has
seen this in the real game yet, so this part is the most useful for me.

| # | Do | Expect |
|---|---|---|
| 14 | `/scriptevent rae:log_debug on`. `/rae:robbery_reset jewels`. In **survival**, with an empty hand, **punch the diamond frame once**. | Whatever the game does first, the item may pop out for an instant, then it is gone. You end with **exactly 2 diamonds**, nothing on the floor, the frame empty. **Tell me exactly what you saw**: did the item pop, where to, for how long, and did you get 2 diamonds, 3, or 1? |
| 15 | `/rae:robbery_reset jewels`, then **punch the Ring first** (it still waits for the Necklace). | The emerald may pop and then goes back into the frame, shown as before, and you are told it will not budge. If the emerald stays on the floor, tell me. |
| 16 | Take the Necklace (right-click), then **punch it again** now that it is empty. | Nothing more is given. (You are an operator, and a bound block is protected from everyone else only, so a punch on an empty frame may knock it off the wall: if it does, put a frame back in the same place, it is still bound. Step 21 is the same punch from a non-operator.) |
| 17 | `/scriptevent rae:log_debug off`, then send me the `[robbery]` lines from the content log that start with **right-click on frame**, **punch on frame** or **a dropped item appeared**. | They say which events the game really sent for the punch and what was done. If steps 14 to 16 all behaved, I only need to know that they did. |
| 18 | `/rae:config_set_bool robbery.guardFramePunches false`, `/rae:robbery_reset jewels`, and punch the necklace. Then `/rae:config_reset robbery.guardFramePunches` and `/rae:robbery_reset jewels` again. | With the undo off the game's own pop is left alone: the diamond lies on the floor and nothing is counted. The second reset shows the frame again. This switch is the way out if the undo ever misbehaves; it needs no redeploy. |

## The builder

| # | Do | Expect |
|---|---|---|
| 19 | `/rae:robbery_reset jewels` (so nothing is waiting to be put back). Then sneak (operator) and right-click the Necklace frame with another item in hand, or just to turn it. Then right-click it with the wand and press **Save what the frame shows now**. | While sneaking, the game does what it always does (no theft, no cancel). The screen says "Saved. The frame will be put back looking like this." After a reset the NEW item is what the frame shows. (Pressing that button while a robbery's frames are waiting to be put back is refused, with the reason: that is by design.) |
| 20 | Hold the wand and punch a bound frame. | Nothing is taken and nothing is undone: the wand is for editing. If the game popped the item out, it lies there for you to put back. Tell me whether it did. |
| 21 | With a **non-operator account** (or `/deop` yourself), after the Necklace has been taken: **punch the empty frame twice**. | The frame stays on the wall: a bound block is protected from everyone but operators. Tell me if it comes off. |
| 22 | (Optional, a thief's trick.) Break the wall block behind a bound frame, then reset. | The frame falls off the wall: that is NOT protected. Tell me whether the reset puts the frame back on the wall or leaves it empty or floating. |
| 23 | Look at the frame with the wand while the builder view is on (`/rae:robbery_view`), then look at an unbound frame. | The action bar names the Necklace (frame, with its state) and the robbery; the unbound frame says to right-click it with the wand to bind it. **No menu opens on top of a frame's screen, whenever you click.** |

## What only the real game can answer (tell me what you SEE)

1. **Binding:** does a right-click with the wand on a frame open the bind form (step 2), and never also turn the item or open
   the main menu on top? (The wand's ray might look straight through a frame like it does through a flower; I added a second
   check for that, but only the game can say.)
2. **Putting it back:** does the saved frame bring back the same item, the same way up, glowing if it was a glow frame (step 12)?
3. **Punch:** which events the game sends, whether the popped item is announced as a new item, and whether the undo leaves exactly
   the loot and nothing else (steps 14 to 17). If the game pops the item **without** announcing it, the thief keeps the popped
   item AND is given the loot (two diamonds instead of one); the tests pin that as a known limit. If you see it, `guardFramePunches
   false` stops the undo and I will find another way.
4. **Emptying:** after a theft is the frame really empty, or does the item drop to the floor (step 9)? Emptying works by swapping
   the frame block for air and back; the game might drop the item when the block goes.
5. **The wall:** step 22.
6. Anything in the content log marked `[robbery]`, `[forms]` or `[Scripting][error]`.

## Known limits (by design, for this version)

- Every frame of a robbery is shown again from its saved copy at the end of every run, taken from or not, and by
  `/rae:robbery_reset`: a script cannot read a frame, so it cannot tell if one was emptied behind its back. If a frame ever looks
  wrong, `/rae:robbery_reset jewels` is the fix. (So a display you changed without pressing "Save what the frame shows now" goes
  back to the saved one.)
- "Save what the frame shows now" is refused while a frame is waiting to be put back after a robbery (it might be empty and the
  empty copy would be what comes back). Save it once the site has been put back, or reset it first.
- If the game never tells scripts about a punch, nothing can undo it: the item pops, the thief can pick it up with no loot and no
  lock, and the frame is shown again at the end of the next run or reset. Steps 14 to 17 are what find out.
- Breaking the block a frame hangs on drops the frame, and that is not protected (step 22 shows what the reset then does).
- A frame has exactly one block: no "also bind the neighbour", and it waits to be touched even when everything it waits for is done.
- The loot is what the element says, never read from the frame: a frame showing a necklace with loot `diamond 2` gives diamonds.
- A frame that has no saved copy (the step 3 warning) stays empty after a theft; this is reported in the log and does not hold up
  the next run. Press **Save what the frame shows now** to fix it.
- Nothing is pushed or deployed until you say so.
