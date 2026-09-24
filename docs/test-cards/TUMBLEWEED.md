# TUMBLEWEED test card: ambient tumbleweeds blown by a wind system

Not an ARCH task: added on request, inspired by an old Bedrock mod ([mcpedl.com/tumbleweed](https://mcpedl.com/tumbleweed/); nothing from it was downloaded or copied — its page gives almost no detail and its file carries no stated license, so this is a new entity built from scratch to fit this codebase). Purely ambience: it cannot hurt or be hurt by anything.

- `bountysys:tumbleweed`s spawn near online players (up to `TUMBLEWEED.maxActive` at once, `config/balance.ts`), get nudged along by a steady "world wind" with a little jitter and the occasional gust, spin as they roll, and despawn once too old or too far from everyone.
- Spawning is **on by default**. The menu's last button, and `/scriptevent rae:tumbleweed` (no player needed), toggle it. Turning it off only stops new ones from appearing — it does not remove the ones already rolling.
- **History:** v1 (2026-09-21) had `minecraft:physics` fully off so it could never be a physical obstacle, but with no collision to rest it on the ground it visibly floated, clipped through terrain, and moved "weirdly". v2 fixed the floating with a script-driven ground raycast but kept collision off, and reworked the look from solid 3D "twig" boxes to crossed alpha-cutout planes (the vanilla dead-bush/fern technique). v3 replaced the script-driven ground-snap with **real physics**: `has_gravity` and `has_collision` are both on, so the engine settles and stops it the normal way. The trade-off: a hitscan gun's ray still excludes the type outright (`systems/guns.ts`), so a shotgun always passes through, but a **projectile gun's bullet has its own real collision and can physically stop on a tumbleweed**, the same as it would on a mob — there is no "collide with terrain but not with a bullet" option in `minecraft:physics`. **v4 (this one, 2026-09-23):** still moved too slowly and didn't bounce, so `TUMBLEWEED.windStrength` is raised sharply (0.03 → 0.18, first guess — there's no measured real-game number for how much `has_collision`'s ground friction eats into it, so this may need another round), and it now gets an occasional upward kick (`hopChance` / `hopStrength`) since `minecraft:physics` has no bounciness/restitution setting to turn on — the kick is scripted, added on top of whatever vertical velocity it already has, and only while it isn't already rising, so a lucky streak of rolls can't stack into one giant launch.

Packs: behavior pack **0.1.23**. No resource-pack change — the look is unchanged, only the physics tuning and the bounce script.

`npm test` drives the wind system through the fake tick loop: it tops up to the cap and stops there, nudges sideways without fighting whatever vertical velocity it already has, bounces by adding to (not replacing) existing vertical velocity only while not already rising, despawns by age and by distance, the toggle works, and a hitscan gun's ray excludes the type. The fake does not simulate real gravity or block collision at all, so it cannot say whether the new speed or the bounce actually look right, or how a real bounce interacts with real ground friction. Those are this card.

## Steps

One player is enough. You do not need op rights to just watch; you need them for the summon/scriptevent steps.

| # | Do | Expect |
|---|---|---|
| 1 | Stand in open ground and just wait, watching the area around you. | Within a few seconds, a tumbleweed or two rolls into view, now noticeably faster than before, and visibly hops/bounces along rather than sliding smoothly. **Tell me if it's now too fast, still too slow, or about right**, and whether the bounce looks natural or too floaty/too sharp. |
| 2 | Watch one for a while as it crosses uneven ground (a slope, a small ledge, a hole, a fence or wall in its path). | It should move like a real physical object: resting on the ground, stopping or tumbling over an obstacle instead of clipping through it, with the occasional hop. **Note anything that still looks wrong** — especially a hop that launches it absurdly high, or one that never bounces at all. |
| 3 | Walk away from the area, then look back a minute or two later. | Old ones are gone; new ones keep appearing near you as you move around. |
| 4 | `/summon bountysys:tumbleweed` right in front of you. | One appears immediately and starts rolling with the others. |
| 5 | Open the game menu (the item or `/scriptevent rae:menu`) and press the last button. | It reads "Turn tumbleweeds off" while they're on, or "Turn tumbleweeds on" while off, and flips it. You're told which. |
| 6 | With them off, wait a minute. | No new ones appear, but any already rolling keep going until they age out or roll out of range. |
| 7 | `/scriptevent rae:tumbleweed` (no player needed — try it from a command block if you have one set up). | Toggles the same switch; chat says which way it went. Turn them back on when done. |
| 8 | Shoot a gun so the bullet's path crosses a tumbleweed on the way to a target (a mob, or another player) behind it. Try with both a hitscan gun (a shotgun) and a projectile gun (a pistol or rifle). | **Shotgun (hitscan): passes through cleanly**, same as before — the tumbleweed is unaffected and the target still takes damage. **Pistol/rifle (projectile): now expected to be able to physically stop on the tumbleweed** instead of reaching the target — this is the accepted trade-off for real physics. Tell me if this is a problem in practice (e.g., it happens constantly and ruins gunfights) or is fine (tumbleweeds are sparse enough that it rarely matters). |
| 9 | Look at one up close, from a few different angles. | A scraggly, see-through tangle of brown twig-like planes with real gaps in them (like a dead bush), not a solid shape and not a flat sprite that vanishes edge-on. |

## What to tell me

1. Is the speed right now, or does `windStrength` need another pass (up or down)?
2. Does the bounce look like a real tumbleweed hopping along, or wrong in some way (too high, too frequent, too rare, too floaty, too sudden)?
3. Does it move naturally otherwise — settling on the ground, interacting with obstacles — or does something still look off (jittery, stuck, still floating anywhere, spinning oddly)?
4. Does the crossed-plane look still read as a tangle of brush from a few angles at the new speed?
5. Does the density feel right — too many at once, too few, appearing too close to you or too far to ever notice?
6. The shotgun passed through cleanly; did a projectile gun (pistol/rifle) actually get blocked by one? How often does that come up, and does it bother you?
7. Anything odd: one stuck in place, one that never despawns, a texture or model glitch, one launched absurdly high.

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. Must not appear: `[Scripting][error]` lines, an item or entity error naming `tumbleweed`, or a `[TICK ERROR] tumbleweed` line (core/tick.ts reports a handler that throws there without stopping the rest of the game).
