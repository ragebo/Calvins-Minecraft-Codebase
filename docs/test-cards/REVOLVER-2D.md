# REVOLVER-2D test card: the revolver is a flat sprite

Not an ARCH task: added on request. The revolver was a 3D model (an attachable with geometry and a 32x32 texture) whose held look was never finished, and its inventory icon was a scaled-down picture on a solid white background. It is now a flat 16x16 sprite, taken from a crossbow texture pack the user supplied (`revolver.mcpack`, made with createtextures.com, which replaced `crossbow_pulling_0.png`).

What changed, all in the resource pack: `textures/items/revolver.png` is the new sprite (byte for byte the mcpack's PNG, with a transparent background); `attachables/revolver.json`, `models/entity/revolver.geo.json` and `textures/items/revolver_3d.png` are gone; the pack is 1.0.12. The behavior pack and the scripts are untouched, so the gun fires, reloads and sounds exactly as before.

`npm test` checks the files (`assets.test.mjs`: the texture path resolves, the sprite is a 16x16 PNG with alpha, no attachable or geometry is left over for the revolver, each pack's versions agree). It cannot show how the sprite looks in the game. This card does.

## Steps

Deploy the resource pack (its own version and its own world pins, separate from the behavior pack), then restart the world.

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:revolver`. Look at it in the hotbar and in the inventory. | The dark grey revolver sprite on a transparent background: no white box around it. Not a missing-texture (purple and black) square. |
| 2 | Hold it, first person. | A flat sprite held like a tool, barrel pointing up-left or left and **not down**. It is not the old 3D model. |
| 3 | Hold it, third person (F5), and look at another player holding one. | The same flat sprite. |
| 4 | Fire it, reload it (sneak + use), and shoot a mob. | Unchanged: same sounds, ammo count and damage as before. |

## Orientation (resource pack 1.0.13)

A flat item held like a tool has its icon turned roughly 45 to 90 degrees counterclockwise on screen. The sprite as supplied has the barrel pointing left, and in the hand that pointed **down**. It is now turned 90 degrees clockwise (checked pixel for pixel: turning it back gives the supplied sprite exactly), so the barrel points **up** in the icon and should point up and to the left, toward the crosshair, when held. The inventory icon therefore shows the gun standing upright.

What to check: in first person the barrel points up-left or left, not down. If it is still wrong, tell me where it points (up, left, toward you) and I can turn it to match. The other options, in order of effort:

- The mirrored sprite (barrel right): one file, but it would point up and away rather than into the screen.
- Set `minecraft:hand_equipped` to `false` in `your_pack_name_BP/items/revolver.json`: held flat and upright instead of like a tool (a behavior pack change and version bump).
- An attachable with a pose animation: the supported way to set an exact hand rotation while keeping the inventory icon horizontal. The item component that used to do it, `minecraft:render_offsets`, is documented as deprecated and no longer in use.

## Content log

- Must not appear: `[Textures]` errors, or a line naming `revolver`.
- The resource pack version in the log should read 1.0.13.

## Not checked

- The game was not run for this change. How the sprite looks in the hand, in first and third person, is exactly what step 2 and 3 are for.
- The sprite's license. The pack states none (its description is only "revolver - createtextures.com"). It is credited in the README with the terms marked unconfirmed.
