# NPC-PROBE test card: how does the real game treat a vanilla NPC?

A measurement, not a feature. The NPC shops (`/rae:shop_*`, see `NPC-SHOP.md`) hang on how the real game treats a vanilla
`minecraft:npc`, and nobody has measured it: the scripting API has no dialogue calls, and a click on an NPC is handled by the game
before any script sees it. This card records the facts first. Two live switches, `shop.interceptClicks` and
`shop.useDialogueScene`, are then set from the answers with no redeploy. About ten minutes.

- Behavior pack **0.2.0**, resource pack unchanged (1.0.27). BP only: no world needs to be open to deploy it, but a fresh launch
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

## Result of the first run (2026-10-07, BP 0.2.0, RAE2, as an operator)

Read from the content log's `[npc-probe]` lines plus what the owner saw. Steps 9 (needs a second, non-operator account) and the
"which box after a reload" half of step 10 were not run; they only matter for the dialogue-button fallback.

| Step | What happened | What it means |
|---|---|---|
| 2 | Spawn, tag, dynamic property, name tag (set and read back), facing the builder, and `dialogue change` right after spawning and 10 ticks later all ran without error. `getComponent("minecraft:npc")` answered `undefined` with no error. | A script cannot set an NPC's skin: shop NPCs have the default look. The scene needs no delayed second try. |
| 3 | An uncancelled click gave one `click BEFORE` and one `click AFTER`. The owner saw an edit-style screen first and, after clicking in it, the scene's box. | That is the game's own flow, and it only appears when the click is not cancelled. |
| 4 | Both buttons logged `fromNpc=true entity=minecraft:npc initiator=<the player> operator=true`, and button B's second command (the tag) ran. | The dialogue button can name the customer: the fallback route works. |
| 5 | With `cancel on`, 5 clicks gave 5 `click BEFORE ... cancel=true` and no `click AFTER`. The owner: "the cancel does work". | **Interception works: `shop.interceptClicks` stays on and a shop opens in one screen.** |
| 6 | The name tag was set and read back ("Old Pete"). Whether the name changed above its head was not reported. | Nothing depends on it. |
| 7 | `dialogue change` ran; `dialogue open` opened the box with no click ("does force open"). | A script can open a scene by itself. |
| 8 | `clicks on NPCs seen: before / after / cancelled = 11 / 6 / 5`, buttons A and B, one probe NPC with its property and name. | Consistent with the above. |
| 10 | After leaving the world and entering it again, the NPC, its property and its name were all still there. Which box a click then showed was not reported. | NPC data survives; whether the scene assignment does is open (the fallback route only). |

The part of the content log written so far held no error from the new code, only the usual RAE2 line about the missing
`mystructure:train` structure.

## Known limits

- Nothing here is a shop yet: it only measures. The shop card is `NPC-SHOP.md`, and it assumes this one has been run.
- The probe only ever touches NPCs it made (tag `rae_npc_probe`) and counts clicks on every NPC; it never changes one you placed.
- `cancel on` cancels EVERY click on an NPC while it is on (at most two minutes), so do not leave a shop's NPC to someone else during it.
