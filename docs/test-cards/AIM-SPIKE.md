# AIM-SPIKE test card: what the game reports for clicks, holds, swaps, zoom and a scope overlay

Not an ARCH task: added on request. The plan for the guns is to **fire with left-click**, **aim with a held right-click** (a bow-like zoom, and a scope for the bolt rifle) and **reload by swapping to the off-hand**, because sneak-and-use cannot be done on a horse (sneaking dismounts). What a script can see of the player's input is thin, so this slice builds nothing on a guess: it records what the game actually reports, and shows the two visual pieces (the zoom and the scope overlay) so you can judge them. **No gun changes.**

What is new:

- `/scriptevent rae:aim_spike log on|off` writes every swing, item use (start, stop, release, complete), hit, drop, inventory change and off-hand change to the content log, as `[aim-spike]` lines.
- `/scriptevent rae:aim_spike fov <number>` zooms the camera (smaller is closer; the normal view is about 70), and `fov reset` puts it back.
- `/scriptevent rae:aim_spike scope on|off` shows or hides a scope overlay: a black screen with a clear round lens and a crosshair.
- Three test items: `bountysys:aim_probe_plain`, `_bow` and `_spyglass`. All are hold-to-use items that slow you a little; they differ only in their use animation, so the log and your eyes show whether the bow or spyglass animation zooms by itself.

Packs: behavior pack **0.1.10** (the items; 0.1.11 fixes `scope off`; 0.1.12 gives every gun its own sprite) and resource pack **1.0.17** (the HUD overlay: `ui/` and `textures/ui/rae_scope.png`). Deploy the resource pack with Minecraft **closed** and launch fresh.

`npm test` checks that the spike records what it is given, stays silent unless asked, and cleans up; that the overlay's files agree with each other and with the script; and that the image is what its generator makes. It cannot say what the game reports, or whether the HUD accepts the overlay. This card does.

## Steps

Give yourself the items and switch logging on:

```
/give @s bountysys:revolver
/give @s bountysys:aim_probe_plain
/give @s bountysys:aim_probe_bow
/give @s bountysys:aim_probe_spyglass
/scriptevent rae:aim_spike log on
```

| # | Do | Expect |
|---|---|---|
| 1 | Hold the revolver. Left-click at the sky, then at a block, then at a mob (a cow is fine). | Nothing is fired (the guns are unchanged). Each click writes a `swing` line: I need the `source=` of each. |
| 2 | Hold `aim_probe_plain`. Press and **hold** right-click for two seconds, then release. | You move slower while holding. The log gets `itemStartUse`, then `itemStopUse` or `itemReleaseUse` when you let go. Note if the arm animation looks odd and if the view zooms. |
| 3 | Repeat with `aim_probe_bow`, then `aim_probe_spyglass`. | Same log lines. **Tell me if either zooms the view or draws anything on screen by itself.** A spyglass overlay would be a surprise, and useful. |
| 4 | `/scriptevent rae:aim_spike fov 40`, then `fov 20`, then `fov 10`, then `fov reset`. | The view zooms in smoothly each time (0.2 seconds) and `reset` returns it to exactly how it was. If the game refuses, the chat says so. |
| 5 | `/scriptevent rae:aim_spike scope on`, then `scope off`. | A black screen with a clear round lens and thin crosshair, **and no text on the screen**. `scope off` removes it. |
| 6 | Hold the revolver and press the **swap hand** key (F on a keyboard). Press it again to swap back. | The revolver goes to the off-hand and back. The log gets an `offhand` line each time: I need to see both. |
| 7 | Hold the revolver and press **Q** (drop), then pick it up again. | The revolver drops. The log gets `itemDrop` and, when you pick it up, `inventory` lines. |
| 8 | Get on a horse. Repeat steps 1, 2, 6 and 7 while riding. | The same lines, with `riding=true`. Sneak dismounts you, so do not test it. Tell me if any of these did something to the horse or the ride. |
| 9 | `/scriptevent rae:aim_spike log off` when you are done. | Logging stops. |

## Results so far (2026-09-20, BP 0.1.10, resource pack 1.0.17)

From the owner's run and the content log (the log flushes late, so the off-hand, drop and horse lines were not on disk yet):

- **Left-click at the sky reports a swing with `source=Attack`.** So left-click can fire a gun with no target. On a **block** it reports `source=Mine` instead, and on a mob a `hit` line plus `source=Attack`. To fire at a block too, both `Attack` and `Mine` have to count.
- **Holding right-click gives events, in this order:** `itemUse` (at the moment of the press), then `itemStartUse` (`useDuration` is in ticks: 24000 is the 1200 seconds set on the item), and on release `itemReleaseUse` and `itemStopUse` in the same tick. `itemCompleteUse` never fired. So a held aim can start on `itemStartUse` and end on `itemStopUse`, and a gun must **ignore** `itemUse`, or every aim would also fire a shot.
- **None of the three probe items zooms or draws anything by itself** (the plain one, the bow animation and the spyglass animation). The zoom has to be scripted.
- **`fov` and `scope on` work.** The zoom is smooth and the overlay shows.
- **`scope off` did not switch the overlay off.** Cause: the overlay shows while the HUD's title text equals the switch text, and the HUD keeps the last text it was given even after the title is cleared. Fixed in BP 0.1.11: `scope off` first overwrites the text with an invisible different one, then clears the title 5 ticks later. **To re-check: `scope on`, then `scope off`.**
  If the overlay is stuck on right now, `/title @s title .` replaces the switch text (a dot shows briefly) and should turn it off, which also tests the diagnosis. Leaving the world does too.
- **There is no swap-to-off-hand key on Bedrock (the owner confirmed it), so an off-hand swap cannot be the reload.** The first run saw no off-hand change; I suspected `minecraft:allow_off_hand` and added it in BP 0.1.11, and the second run saw none either. The component was removed again in 0.1.12 (it only let players park a gun in the off-hand).
- **Q (drop) works and a script can see it.** One press logs, in the same tick: `itemDrop [bountysys:revolver]`, `inventory slot=0 bountysys:revolver -> none` and `swing source=DropItem held=bountysys:revolver`. Picking the item up again logs `inventory slot=0 none -> bountysys:revolver`. So Q is a candidate reload key: react to it by taking the dropped item back and starting a reload. It has not been tried on a horse yet.
- **Left-click works on a horse.** While riding: `swing source=Attack held=bountysys:revolver riding=true` (twice, at mobs or the air) and `source=Mine`; getting on logs `source=Interact held=none`. Nothing was blocked.
- **Not tested yet:** Q on a horse, and a held right-click on a horse. `fov 30 ok` and `fov reset ok` were logged; `scope off` was tried in the first run (the bug above) and not yet re-checked with 0.1.11.

## What to tell me

1. Step 1: does a left-click at the sky produce a swing line at all? (It decides if left-click can fire.)
2. Step 3: did the bow or the spyglass animation zoom on its own, or slow you differently?
3. Step 4: how does the zoom feel (too fast, too slow)? Does `reset` return to your normal view?
4. Step 5: does the scope show? Is it round? Is any text visible? If it does not show, I read the content log for `[UI]` errors.
5. Step 6 and 8: does swapping to the off-hand work on a horse?

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt`. The lines are:

- `swing source=... held=... riding=... sneaking=...`: what a click reports.
- `itemStartUse`, `itemStopUse`, `itemReleaseUse`, `itemCompleteUse`, each with the item and `useDuration`.
- `offhand none -> bountysys:revolver (main hand none)`: an off-hand swap.
- `itemDrop [...]`, `inventory slot=... a -> b`, `hit ... by ...`.
- `fov 30 ok` or `fov 30 FAILED: ...`, and `scope on|off`.

Must not appear: `[Scripting][error]` lines, or an item, texture or `[UI]` error naming `aim_probe`, `rae_scope` or `hud_screen`.

## If something is off

- **The screen has a strange element, or the normal HUD misbehaves:** the overlay files are in `BountySys_RP/ui/`; deleting that folder and the `ui` texture removes it (roll back to resource pack 1.0.16).
- **The scope shows but text is visible in the middle of the screen:** the title's formatting codes are being drawn. Tell me what it shows.
- **`fov` does nothing:** the camera call may need a camera preset in this build; the chat and the log give the engine's message.
- **An aim probe item is missing or an error is logged for it:** the use animation value may not be accepted (the bow and spyglass ones); the content log names the item and the value.

## Not checked

- Answered by the run (see Results): a left-click in the air is a swing, `setFov` works on the normal view, and the HUD accepts the overlay.
- Still unmeasured: Q and a held right-click on a horse, and whether `scope off` now works (fixed in 0.1.11, not yet re-checked).
- Controller and touch controls were not considered; the off-hand swap and drop are keyboard keys here.
