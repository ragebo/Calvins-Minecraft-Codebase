# TUMBLEWEED test card: ambient tumbleweeds blown by a wind system

Not an ARCH task: added on request, inspired by an old Bedrock mod ([mcpedl.com/tumbleweed](https://mcpedl.com/tumbleweed/); nothing from it was downloaded or copied — its page gives almost no detail and its file carries no stated license, so this is a new entity built from scratch to fit this codebase). Purely ambience: it cannot hurt or be hurt by anything, and it cannot even be hit by a gun.

- `bountysys:tumbleweed`s spawn near online players (up to `TUMBLEWEED.maxActive` at once, `config/balance.ts`), get blown along by a steady "world wind" with a little jitter and the occasional gust, spin as they roll, and despawn once too old or too far from everyone.
- **`minecraft:physics` is fully off** (no gravity, no collision — the same trick as the train car), so a tumbleweed can never physically stop on, or be stopped by, a wall, a player, or a bullet's hitbox. Guns additionally exclude the type from their hitscan ray. Both together mean **a tumbleweed can never shield anyone from a shot, on any gun.**
- Spawning is **on by default**. The menu's last button, and `/scriptevent rae:tumbleweed` (no player needed), toggle it. Turning it off only stops new ones from appearing — it does not remove the ones already rolling.
- **Fixed since the first playtest (2026-09-21):** it visibly floated, and looked like solid metal fins rather than brush. It has no block collision to rest it on the ground, so it now casts a ray straight down every handler run and snaps onto whatever the ray finds (the same technique `guns.ts` uses to find where a shot stops). The look is now several crossed, alpha-cutout planes scattered around a ball — the same technique vanilla uses for dead bush, ferns and saplings — not solid boxes.

Packs: behavior pack **0.1.19** and resource pack **1.0.22** (the model, the texture, and the ground-following fix).

`npm test` drives the wind system through the fake tick loop: it tops up to the cap and stops there, moves in the configured wind direction, spins, despawns by age and by distance, the toggle works, and a gun's ray excludes the type. It cannot say whether it looks like a tumbleweed, whether it clips through terrain, or how it feels watching it roll past. Those are this card.

## Steps

One player is enough. You do not need op rights to just watch; you need them for the summon/scriptevent steps.

| # | Do | Expect |
|---|---|---|
| 1 | Stand in open ground and just wait, watching the area around you. | Within a few seconds, a tumbleweed or two rolls into view and drifts across the ground in a fairly consistent direction. |
| 2 | Watch one for a while as it crosses uneven ground (a slope, a small ledge, a hole). | It should hug the terrain, not float or sink in. **Note any spot where it still looks wrong** — the ground snap runs once per handler cadence (`TUMBLEWEED.tickInterval`), so a sharp cliff edge crossed mid-cycle is the one case that might still look a little off. |
| 3 | Walk away from the area, then look back a minute or two later. | Old ones are gone; new ones keep appearing near you as you move around. |
| 4 | `/summon bountysys:tumbleweed` right in front of you. | One appears immediately and starts rolling with the others. |
| 5 | Open the game menu (the item or `/scriptevent rae:menu`) and press the last button. | It reads "Turn tumbleweeds off" while they're on, or "Turn tumbleweeds on" while off, and flips it. You're told which. |
| 6 | With them off, wait a minute. | No new ones appear, but any already rolling keep going until they age out or roll out of range. |
| 7 | `/scriptevent rae:tumbleweed` (no player needed — try it from a command block if you have one set up). | Toggles the same switch; chat says which way it went. Turn them back on when done. |
| 8 | Shoot a gun so the bullet's path crosses a tumbleweed on the way to a target (a mob, or another player) behind it. Try with both a hitscan gun (a shotgun) and a projectile gun (a pistol or rifle). | The tumbleweed is unaffected (no hit, no particle, nothing), and the target behind it still takes damage as if the tumbleweed weren't there. |
| 9 | Look at one up close, from a few different angles. | A scraggly, see-through tangle of brown twig-like planes with real gaps in them (like a dead bush), not a solid shape and not a flat sprite that vanishes edge-on. |

## What to tell me

1. Does it look and move like a tumbleweed — a rolling, spinning tangle of brush — or does something look off (too flat from some angles, too sparse, too dense, spinning oddly, moving in a straight line with no life to it)?
2. Where, if anywhere, does one still float or sink into the terrain?
3. Does the density feel right — too many at once, too few, appearing too close to you or too far to ever notice?
4. Did guns really pass through cleanly in both the hitscan and projectile tests?
5. Anything odd: one stuck in place, one that never despawns, a texture or model glitch.

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. Must not appear: `[Scripting][error]` lines, an item or entity error naming `tumbleweed`, or a `[TICK ERROR] tumbleweed` line (core/tick.ts reports a handler that throws there without stopping the rest of the game).
