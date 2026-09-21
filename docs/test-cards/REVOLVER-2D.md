# REVOLVER-2D test card: the revolver is a flat sprite

Not an ARCH task: added on request. The revolver was a 3D model (an attachable with geometry and a 32x32 texture) whose held look was never finished, and its inventory icon was a scaled-down picture on a solid white background. It is now a flat 16x16 sprite, taken from a crossbow texture pack the user supplied (`revolver.mcpack`, made with createtextures.com, which replaced `crossbow_pulling_0.png`).

**Update 2026-09-20:** the project owner replaced the sprite in the game folder with the original, un-turned one (barrel pointing left) and added their own sprites for the pistol (`pistol.png`) and the bolt rifle (`bolt_rifle.png`); the repo now holds exactly those (behavior pack 0.1.9 points the two items at them). The 45-degree turn described below is therefore history (commit 43d5963): step 2 and the orientation section are what to re-check with the horizontal sprite, and the pistol and bolt rifle need the same look in hand.

What changed, all in the resource pack: `textures/items/revolver.png` is the mcpack's sprite turned to aim forward when held (see Orientation), on a transparent background; `attachables/revolver.json`, `models/entity/revolver.geo.json` and `textures/items/revolver_3d.png` are gone; the pack is 1.0.14. The behavior pack and the scripts are untouched, so the gun fires, reloads and sounds exactly as before.

`npm test` checks the files (`assets.test.mjs`: the texture path resolves, the sprite is a 16x16 PNG with alpha, no attachable or geometry is left over for the revolver, each pack's versions agree). It cannot show how the sprite looks in the game. This card does.

## Steps

Deploy the resource pack (its own version and its own world pins, separate from the behavior pack) with Minecraft **closed**, then launch it fresh. The game reads a resource pack when it launches, so a pack changed while it is running is not picked up, and the next world load writes the old version back into the world's pin.

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:revolver`. Look at it in the hotbar and in the inventory. | The dark grey revolver sprite on a transparent background: no white box around it. Not a missing-texture (purple and black) square. |
| 2 | Hold it, first person. | A flat sprite held like a tool, barrel pointing up-left or left and **not down**. It is not the old 3D model. |
| 3 | Hold it, third person (F5), and look at another player holding one. | The same flat sprite. |
| 4 | Fire it (left-click), reload it (Q; see GUN-CONTROLS.md, which replaced sneak + right-click), and shoot a mob. | The same sounds, ammo count and damage as before the sprite change. |

## Orientation (resource pack 1.0.14)

How it got here, from what the user saw in the game:

1. The sprite as supplied (barrel pointing left) was reported as pointing down. The game had not yet reloaded the resource pack, so this was most likely the old 3D model.
2. Turned 90 degrees clockwise (barrel straight up, checked pixel for pixel), the user reported it looked like the gun was **pointing up**.
3. Now turned **45 degrees clockwise**: the barrel points up and to the left in the icon. Held, that should aim toward the crosshair. The blur the earlier 45 degree try had came from averaging colours; this one uses a pixel-art rotation (scale up with edge smoothing, rotate, take the most common colour per block), which keeps every colour of the sprite (0 new colours) and 84 of its 92 opaque pixels.

What to check: in first person the barrel points up-left, toward the crosshair, rather than straight up or down. If it is off, say which way (a bit more up, a bit more left) and I can turn it a step. The other options:

- 135 degrees (barrel up-right) is already made, in case the aim is the wrong way round.
- Set `minecraft:hand_equipped` to `false` in `your_pack_name_BP/items/revolver.json`: held flat and upright instead of like a tool (a behavior pack change and version bump).
- An attachable with a pose animation: the supported way to set an exact hand rotation while keeping the inventory icon horizontal. The item component that used to do it, `minecraft:render_offsets`, is documented as deprecated and no longer in use.

## Content log

- Must not appear: `[Textures]` errors, or a line naming `revolver`.
- The resource pack version in the world's pin (`world_resource_packs.json`) should still read 1.0.14 after the world has loaded. If the game wrote an older one back, it was running when the pack was deployed.

## Not checked

- The game was not run for this change. How the sprite looks in the hand, in first and third person, is exactly what step 2 and 3 are for.
- The sprite's license. The pack states none (its description is only "revolver - createtextures.com"). It is credited in the README with the terms marked unconfirmed.
