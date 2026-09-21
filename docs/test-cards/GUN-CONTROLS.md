# GUN-CONTROLS test card: fire with left-click, aim with right-click, reload with Q

Not an ARCH task: added on request. A lot of the game is spent on horseback, and a horse takes sneak (it dismounts you and reports nothing to a script), so "sneak + right-click to reload" could not work there. The controls are now:

| Action | How |
|---|---|
| Fire | **Left-click**: at the air, a mob or a block. Riding or not |
| Aim | **Right-click toggles it** (tap to aim, tap again to stop). A bow-like zoom (62 to 52 degrees depending on the gun; the normal view is about 70). The **bolt rifle** zooms furthest (30, the smallest the game allows) and shows a **scope overlay** (black screen, clear round lens, crosshair). You walk slower while aimed (the bolt rifle most), and you **can fire while aimed** |
| Reload | **Q**. The game drops the gun, and a script takes it back into its slot and starts the reload. You see the reload messages and hear its sounds as before |
| Reload (automatic) | **Clicking an empty gun** clicks and starts the reload by itself |

Sneaking does nothing to a gun any more. Right-click never fires: it only aims.

**Why aim is a toggle and not a hold.** The first version made it a hold. The game sends no attack input while an item is in use (the same rule that stops you hitting things while drawing a bow), so you could not left-click to fire while holding right-click. A tap has no "in use" state, so it does not block the click. The guns are therefore plain items again (no hold-to-use, no cooldown).

Two other things the first real-game run of the controls showed, both fixed here: the game only accepts a field of view from 30 to 110 (the bolt rifle asked for 24, so its zoom silently did nothing while the scope overlay showed), and one drop event carried an item list that could not be iterated (a logged script error), which is now read defensively.

Every one of these was measured in the game first (`AIM-SPIKE.md`): a left-click at the air is a swing with source Attack, at a block Mine, on a horse too; a held right-click sends a start and, when let go, a stop; Q sends a drop, the slot emptying and a DropItem swing in the same tick; Bedrock has no swap-to-off-hand key.

Packs: behavior pack **0.1.13** (the controls, plain gun items) and resource pack **1.0.18** (the six gun sprites, unchanged since the last deploy).

`npm test` checks each rule with the same event sequences the game sent (fire on Attack and Mine, nothing on the other swings, no shot from right-click, the zoom and its reset, the scope only for the bolt rifle, Q keeping the gun and starting the reload, a drop that is not Q left alone, two players at once). It cannot say how it feels or whether the game accepts every piece together. This card does.

## Steps

`/give @s bountysys:revolver`, `bountysys:handgun_ammo 64`, and the same for the bolt rifle (`bolt_rifle` and `rifle_ammo`) and a shotgun (`pump_shotgun` and `shotgun_ammo`).

| # | Do | Expect |
|---|---|---|
| 1 | Hold the revolver. Left-click at the sky, then at a mob, then at a block. | A shot each time: the bang, and a bullet flying. Nothing is mined. |
| 2 | Tap right-click once, look around, walk, then tap it again. | The first tap zooms in a little and it **stays** zoomed; you walk slower. The second tap puts the view back to normal. No shot from either tap. |
| 3 | Hold the bolt rifle and tap right-click. Fire a shot **through the scope** (left-click), then tap right-click again. | The view zooms a lot **and** the black scope overlay appears. The shot fires while the scope stays up. The second tap removes both the zoom and the overlay. |
| 4 | Fire until the revolver clicks empty. Click once more. | A dry click, then "Reloading Revolver..." with the reload sounds, and it is full again after a couple of seconds. No key needed. |
| 5 | Fire a few rounds and press **Q**. | The gun does not stay on the ground: it stays in your hand or hotbar slot, the reload starts, and the magazine is full afterwards. If it is already full you are told so. |
| 6 | Get on a horse and repeat 1 to 5. | The same. Left-click, aim and Q all work while riding. **Q on a horse is the one thing not seen in the game yet.** |
| 7 | Aim, then switch to another hotbar slot. | The zoom (and the scope) end by themselves within a fraction of a second. |
| 8 | Drag a gun out of the inventory screen onto the ground. | It drops for real and stays dropped (only the Q key is a reload). |

## What to tell me

1. Does left-click feel right for firing, or does mining or hitting something get in the way (a block you break, a mob you also punch)?
2. Zoom: enough, too much? Is the scope overlay right (round, no text, gone on release)?
3. Q: does the gun come back every time, and does the item flicker on the ground? Does it work on a horse?
4. Anything that stays stuck: a zoom that does not reset, a scope that stays up, a gun that vanished.

## Content log

Must not appear: `[Scripting][error]` lines, or an item error naming a gun. A `[aim] zoom failed` or `[aim] zoom reset failed` warning means the camera refused a call (each is reported once).

## Not checked

- The game was not run with this exact build: the controls are assembled from measured pieces (each one seen in the game), but not yet used together.
- Q while riding: the drop event was only measured on foot.
- Left-click also hits and can break blocks like any item; whether that matters depends on your game mode (adventure mode avoids mining).
- Controller and touch play: the click, the hold and the drop button were only measured with mouse and keyboard.
- There is no accuracy bonus for aiming: it only zooms (and slows you). It is a small change if you want one.
