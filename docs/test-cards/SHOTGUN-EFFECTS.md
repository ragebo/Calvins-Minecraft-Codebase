# GUN-EFFECTS test card (SHOTGUN-EFFECTS.md): you can see every gun fire

Not an ARCH task: added on request. Guns now show their shot with vanilla particles.

**Every gun** shows **muzzle smoke** just in front of the barrel and a little below the eyes: 2 puffs from the pistol, 3 from the revolver and the semi-auto rifle, 4 from the bolt-action. The shotguns also have a muzzle flash (two flame particles).

**The shotguns** are hitscan, so there is no bullet to watch. They also draw:

- **A trail along every pellet's path:** a small ember every 2 blocks, so the fan of the pellets can be seen.
- **A puff of smoke where a pellet ends** on a block or a target. A pellet that just runs out of range leaves no puff.

Behavior pack **0.1.16**. The particles are vanilla ones, so no new art is involved.

Everything is in `rae/src/config/guns.ts` under each gun's `effects`: the particle ids, `muzzleDistance` (how far in front of the eyes) and, for the shotguns, `trail`, `trailSpacing` (blocks between embers; smaller is denser and costs more; anything under 0.25 counts as 0.25) and `impact`. A wrong particle id is reported once in the content log as `[gun effects] <id> failed: ...` and the shot still fires and hurts.

## What the first playtest showed (2026-09-20, BP 0.1.15)

The whole session's content log had **no script errors or warnings**, but it was full of one thing: `particles/basic_crit.json | variable.direction.x ... unable to find member variable` (16,836 lines for 2,806 spawns). The trail particle I had picked, `basic_crit_particle`, needs a `direction` value that whatever spawns it must supply, and a script cannot. It probably drew wrongly. **The trail is now `basic_flame_particle`**, and `basic_flame_particle` and `basic_smoke_particle` logged no error at all in the same session. A test now fails if any gun is given a particle known to need variables. A particle you try must work when spawned bare: check the content log for `[Molang]` errors after trying a new one.

`npm test` checks where the particles are spawned, how many, that they stop at what a pellet hit, that every gun has muzzle smoke and only the shotguns draw trails, and that a wrong id or a silly config value cannot break a shot. It cannot say what they **look** like: that is what this card is for.

## Steps

`/give @s bountysys:pump_shotgun`, `/give @s bountysys:double_barrel_shotgun`, `/give @s bountysys:shotgun_ammo 64`, and the same for the other guns and their ammo.

| # | Do | Expect |
|---|---|---|
| 1 | Fire the pump shotgun at the sky. | A flash and smoke at the barrel, and a fan of small orange embers flying out ahead in about 8 lines. |
| 2 | Fire it at a wall a few blocks away. | The embers stop at the wall, with a puff of smoke where the pellets hit. |
| 3 | Fire it at a mob. | Puffs where the pellets land on it, and it takes the damage as before. |
| 4 | Fire the double-barrel. | The same, with its wider spread. |
| 5 | Fire the revolver, the pistol, the semi-auto and the bolt-action. | A puff of smoke at the barrel each time (the bolt-action the biggest), no flash, no trail. |
| 6 | Fire from a horse, and while aimed (tap right-click). | The same effects. |

## What to tell me

1. Is the smoke on each gun visible enough, or too much? Does the bolt-action's bigger puff read as a rifle?
2. Do the orange embers read as pellets, or would something else (smoke, end-rod sparkles) look better?
3. Any lag when firing many shots in a row?
4. After a session: I read the content log for `[Molang]` and `[gun effects]` lines.

## Content log

Must not appear: `[gun effects] ... failed` (a particle id the game did not accept), `[Molang][error]` naming a `particles/` file (a particle that needs variables), or `[Scripting][error]`.

## Not checked

- Whether the embers and smoke look right is unseen until you fire.
- Particles are only drawn to players near the shooter (the game's usual particle range).
- The effect cost of a shotgun shot is about 60 particles; if that ever lags, raise `trailSpacing`.
