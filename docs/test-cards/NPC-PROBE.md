# NPC-PROBE test card: how does the real game treat a vanilla NPC?

A measurement, not a feature. The NPC shops (`/rae:shop_*`, see `NPC-SHOP.md`) hang on how the real game treats a vanilla
`minecraft:npc`, and nobody has measured it: the scripting API has no dialogue calls, and a click on an NPC is handled by the game
before any script sees it. This card records the facts first. Two live switches, `shop.interceptClicks` and
`shop.useDialogueScene`, are then set from the answers with no redeploy. About ten minutes.

- Behavior pack **0.1.43**, resource pack unchanged (1.0.27). BP only: no world needs to be open to deploy it, but a fresh launch
  is the safest way to be sure the new scripts and the new `dialogue/` folder are what you are running.
- Operators only. Run it in your test world (RAE2) as an operator. For step 9 you also want a second account that is NOT an operator.
- Everything is written to the content log as lines starting `[npc-probe]`; the findings are the `RESULT` lines. Turn the game off (or
  trigger more output) before reading the log: it is written in bursts and the tail can be missing until then.
- A line in the log is also an answer to "did it throw?": a step that failed says `THREW` and the engine's own error text.

## Steps

| # | Do | Expect, and what to tell me |
|---|---|---|
| 1 | `/scriptevent rae:npc_probe clear`, then `/scriptevent rae:npc_probe log on`. | Chat says "Forgotten." and "Click logging is on." |
| 2 | `/scriptevent rae:npc_probe spawn`. | A vanilla NPC appears in front of you, facing you. **Tell me: is the name "Probe 1" shown above its head? What does it look like?** The log gets `RESULT spawn`, `tag`, `dynamic property`, `nameTag set`, `nameTag read back`, `face the builder`, `dialogue change right after spawning` and `NPC component`, and 10 ticks later `dialogue change 10 ticks after spawning`. |
| 3 | Right-click the NPC (empty hand, standing, not sneaking). | **Tell me which screen opens:** (a) a box that says "NPC probe. Press a button, then read the report." with two buttons, (b) the game's ordinary NPC box, or (c) nothing. Close it. The log gets a `click BEFORE` and a `click AFTER` line. |
| 4 | Click it again and press **Probe button A**. Click again and press **Probe button B (two commands)**. | The log gets `RESULT button A = fromNpc=true entity=minecraft:npc initiator=minecraft:player <you> operator=true`, and the same for B. **Tell me whether it says `fromNpc=true` and your name.** Button B also tags you: `/tag @s list` shows `rae_npc_probe_pressed`. |
| 5 | `/scriptevent rae:npc_probe cancel on`, then right-click the NPC. | **This is the question the shop turns on: does the game's own NPC box still open?** Tell me yes or no. Then `/scriptevent rae:npc_probe cancel off` (it switches itself off after two minutes anyway). |
| 6 | `/scriptevent rae:npc_probe name Old Pete`. Look at the NPC and click it. | **Tell me: did the name above its head change? Does the box's title show the name?** |
| 7 | `/scriptevent rae:npc_probe scene`, then click it. Then `/scriptevent rae:npc_probe open` without clicking. | Does `scene` point it at the probe box again (3a)? **Does `open` pop the box open by itself?** |
| 8 | `/scriptevent rae:npc_probe report`. | `RESULT clicks on NPCs seen: before / after / cancelled`, the buttons pressed, the probe NPCs with their property and name. |
| 9 | With a second account that is not an operator: click the NPC and press **Probe button A**. | The log says `fromNpc=true`, that account's name and `operator=false`. **Tell me if it says anything else.** |
| 10 | Quit to the main menu and open the world again (a full relaunch is better), then `/scriptevent rae:npc_probe report` and click the NPC. | **Tell me: is the NPC still there with its name and property? Does it still show the probe box (3a) or the ordinary one (3b)?** |
| 11 | `/scriptevent rae:npc_probe log off`. Close the game and keep the newest `ContentLog*.txt` for me. | |

Tidy up afterwards: `/kill @e[tag=rae_npc_probe]`.

## What the answers decide

| What you see | What it means for the shop |
|---|---|
| Step 5: with `cancel on` the game's box does NOT open (and the report shows 0 "after" events for the cancelled clicks) | Interception works: leave `shop.interceptClicks` on (the default). One screen. |
| Step 5: the game's box STILL opens | Interception cannot replace it: `/rae:config_set_bool shop.interceptClicks false`. The shop then opens from the box's one button (two screens). |
| Step 3 is (b) or (c), or `dialogue change` threw | The button route does not work as built: interception is the only way in. If cancel also fails, the NPC needs another approach (a different entity). |
| Step 10: the box went back to ordinary after the reload | The scene assignment does not survive a reload: the shop code re-points its NPCs when they load (a small change, I will make it). |
| Step 9: `fromNpc=false`, or no name | The button route cannot tell the customer: interception only. |
| Step 6: the name does not show | The shop's own screen carries the name; nothing else changes. |
| Step 2: `NPC component = THREW` or undefined | Expected: the NPC component is a Beta API. It means a script cannot set a skin; set it in the game's own NPC screen (operator, sneak and click). |

## Known limits

- Nothing here is a shop yet: it only measures. The shop card is `NPC-SHOP.md`, and it assumes this one has been run.
- The probe only ever touches NPCs it made (tag `rae_npc_probe`) and counts clicks on every NPC; it never changes one you placed.
- `cancel on` cancels EVERY click on an NPC while it is on (at most two minutes), so do not leave a shop's NPC to someone else during it.
