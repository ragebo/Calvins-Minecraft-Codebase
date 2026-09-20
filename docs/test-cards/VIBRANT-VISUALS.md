# VIBRANT-VISUALS test card: the resource pack works with Vibrant Visuals

Not an ARCH task: added on request. With the resource pack active, Vibrant Visuals (Settings > Video > Graphics Mode) could not be used. The game says the mode "requires a PBR-enabled resource pack", and a resource pack says it is one with a line in its manifest. Ours had none. Every world uses only this one resource pack (checked in all four worlds' `world_resource_packs.json`), so it was the only thing in the way.

What changed: `BountySys_RP/manifest.json` gains `"capabilities": ["pbr"]` (the vanilla pack declares the same; its `min_engine_version` must be at least 1.21.120 and ours is 1.26.50), and the pack is 1.0.16. Nothing else: no textures, models or scripts changed. `npm test` checks the capability (and that the ray-tracing-only one is not used instead); it cannot check what the mode does with the pack. This card does.

Deploy the resource pack with Minecraft **closed** and launch fresh (the game reads it at launch).

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Launch, open Settings > Video, open the Graphics Mode list. | **Vibrant Visuals** can be picked (before: greyed out or missing, with a note about compatible content). It needs a supported graphics card. |
| 2 | Pick Vibrant Visuals and load a RAE world. | The world loads with the new lighting and no message about the pack being incompatible. |
| 3 | `/give @s bountysys:revolver`, then the pistol and `bolt_rifle`. Look at them in the hotbar and hold them. | The three sprites look as they did before: not black, not glowing, not missing. |
| 4 | Fire a gun. | Bullets appear and fly as before. |
| 5 | Record and ride the train (see TRAIN-RIDE.md) or at least `/scriptevent rae:train_spike momentum`. | The carriage is lit like the rest of the scene. Its colours are the same as under the normal mode. |
| 6 | Switch back to the normal graphics mode. | Everything looks as it did before this change. |

## What to tell me

1. Can you pick Vibrant Visuals now, and does the world load with it?
2. Do the guns and the carriage look right? Anything too dark, too shiny or washed out?
3. Should the carriage's lamps glow? Under this mode a surface can be made emissive with a texture set; today nothing is, so the lamps are just yellow and red.

## If something is off

- **Still cannot pick it:** the game did not read the new pack. Check `world_resource_packs.json` says 1.0.16 and that the content log lists the resource pack at 1.0.16; if some other resource pack is switched on in that world (a global pack from Settings > Storage or Global Resources), it blocks the mode as well: turn it off.
- **Something looks wrong under the mode:** that item or entity needs a texture set (its own surface values). It is a small file per texture; tell me which one.

## Not checked

- The game was not run for this change, and the machine's graphics card was not checked for Vibrant Visuals support.
- What the mode does to our textures without texture sets is from Microsoft's documentation (defaults are used when a pack supplies nothing), not from a look.
