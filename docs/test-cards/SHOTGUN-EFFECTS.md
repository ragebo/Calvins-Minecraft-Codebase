# SHOTGUN-EFFECTS test card: you can see a shotgun fire

Not an ARCH task: added on request. The shotguns are hitscan: there is no bullet, so nothing showed when one went off except the sound. A shot is now drawn with particles:

- **At the muzzle:** a flash (two flame particles) and a puff of smoke, just in front of the barrel and a little below the eyes.
- **Along every pellet's path:** a small spark every 2 blocks, so the spread pattern of the pellets can be seen.
- **Where a pellet ends on a block or a target:** a puff of smoke. A pellet that simply runs out of range leaves no puff.

Only the shotguns (pump and double-barrel) do this; the revolver, pistol and rifles are unchanged. Behavior pack **0.1.14**; nothing in the resource pack changed. The particles are vanilla ones, so no new art is involved.

Everything is in `rae/src/config/guns.ts` under each shotgun's `effects`: the particle ids, `muzzleDistance` (how far in front of the eyes) and `trailSpacing` (blocks between sparks; smaller is denser and costs more, and anything under 0.25 is treated as 0.25). A wrong particle id is reported once in the content log as `[gun effects] <id> failed: ...` and the shot still fires and hurts.

`npm test` checks where the particles are spawned, how many, that they stop at what a pellet hit, that the other guns draw nothing, and that a wrong id or a silly config value cannot break a shot. It cannot say what they **look** like: that is what this card is for. The particle ids come from Microsoft's published Bedrock samples and the file names the game itself ships (`basic_flame`, `basic_smoke`, `basic_crit`), and have not been seen in your game yet.

## Steps

`/give @s bountysys:pump_shotgun`, `/give @s bountysys:double_barrel_shotgun`, `/give @s bountysys:shotgun_ammo 64`.

| # | Do | Expect |
|---|---|---|
| 1 | Fire the pump shotgun at the sky. | A flash and smoke at the barrel, and sparks flying out ahead in a fan of about 8 lines. |
| 2 | Fire it at a wall a few blocks away. | The sparks stop at the wall, with a puff of smoke where the pellets hit. |
| 3 | Fire it at a mob. | Puffs where the pellets land on it, and it takes the damage as before. |
| 4 | Fire the double-barrel. | The same, with its wider spread. |
| 5 | Fire a revolver and a rifle. | No particles at all: unchanged. |
| 6 | Aim (tap right-click) and fire again. | The same effects, seen along the zoomed view. |
| 7 | Do the same on a horse. | The same. |

## What to tell me

1. Can you clearly see each shot: is the flash big enough, the fan of sparks readable? Too much, too little?
2. Do the sparks look right (they are the small "crit" stars) or would smoke, flame or end-rod sparkles read better?
3. Any lag when firing (many shots in a row, or several players)?

## Content log

Must not appear: `[gun effects] ... failed` (a particle id the game did not accept) or `[Scripting][error]`.

## Not checked

- The game was not run with this change: how the particles look is unseen. If one is invisible or wrong, its id in `config/guns.ts` is the thing to change (I can look up others).
- Particles are only drawn to players near the shooter (the game's usual particle range).
- The effect cost is about 60 to 70 particles a shot; if that ever lags, raise `trailSpacing`.
