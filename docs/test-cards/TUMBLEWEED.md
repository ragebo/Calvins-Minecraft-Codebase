# TUMBLEWEED test card: ambient tumbleweeds blown by a wind system

Not an ARCH task: added on request, inspired by an old Bedrock mod ([mcpedl.com/tumbleweed](https://mcpedl.com/tumbleweed/); nothing from it was downloaded or copied — its page gives almost no detail and its file carries no stated license, so this is a new entity built from scratch to fit this codebase). Purely ambience: it cannot hurt or be hurt by anything.

- `bountysys:tumbleweed`s spawn near online players (up to `TUMBLEWEED.maxActive` at once, `config/balance.ts`) **only when the candidate spot is in a desert biome** (`TUMBLEWEED.biomes`), get nudged along by a steady "world wind" with a little jitter and the occasional gust, roll and bounce as they go, and despawn once too old (quickly) or too far from everyone.
- Spawning starts **off** by default (v5+, 2026-09-24). The menu's last button, and `/scriptevent rae:tumbleweed` (no player needed), toggle it. Turning it off only stops new ones from appearing — it does not remove the ones already rolling. **You need to turn it on first with either of those** before any of the steps below will do anything.
- **History:** v1 (2026-09-21) had `minecraft:physics` fully off, floated and clipped through terrain. v2 fixed the floating with a script-driven ground raycast, and reworked the look to crossed alpha-cutout planes (the vanilla dead-bush/fern technique). v3 replaced the ground-snap with **real physics** (`has_gravity`/`has_collision` both on) — the trade-off, still true today, is that a hitscan gun's ray excludes the type outright so a shotgun always passes through, but a **projectile gun's bullet has its own real collision and can physically stop on one**. v4 made it faster and added a scripted bounce (no native restitution setting exists to turn on). **v5 (this one, 2026-09-23)** is four more owner requests together:
  - **Only spawns in the desert now** (`Dimension.getBiome`) — if nobody online is near one, nothing spawns. That's correct, not a bug.
  - **Despawns much quicker**: `maxAgeTicks` 6000 → 400 (20 seconds), `despawnDistance` 80 → 50.
  - **No hop or spin while stuck** against a block: judged by how far it actually moved since the last check, not by velocity, so a wedged one doesn't jitter in place.
  - **Rolls instead of spinning in place**: yaw now faces the direction it's actually travelling and pitch tumbles it forward, instead of a vertical-axis spin. **This is the one genuinely uncertain part** — the engine's own docs call pitch a head-tilt "for most mobs", and this model has no head bone, so whether pitch does anything visible at all on it is unconfirmed. **This is the main thing to check below.**

Packs: behavior pack **0.1.25**. No resource-pack change — the look is unchanged, only the physics, the spawn gate, the despawn timing, and now the on/off default.

`npm test` drives the wind system through the fake tick loop: spawns only when the (faked) biome is desert, nudges and bounces as before, suppresses the hop and the rotation when it hasn't actually moved since the last check, despawns by the new shorter age/distance, the toggle works, and a hitscan gun's ray excludes the type. The fake does not simulate real gravity, real block collision, or rendering at all, so it cannot say whether the roll is visible, whether the bounce still feels right at the new despawn pace, or whether desert-only spawning feels too sparse. Those are this card.

## Steps

You need to actually be in or very near a desert this time — nothing spawns anywhere else now. You do not need op rights to just watch; you need them for the summon/scriptevent steps.

| # | Do | Expect |
|---|---|---|
| 0 | **New:** open the game menu (the item or `/scriptevent rae:menu`) and press the last button, or `/scriptevent rae:tumbleweed`. | It's off by default now, so this reads "Turn tumbleweeds on" — press it. Without this, nothing in steps 1+ will spawn anything. |
| 1 | Stand in a desert and just wait, watching the area around you. | Within a few seconds, a tumbleweed or two rolls into view. |
| 2 | Stand somewhere clearly **not** desert (plains, forest, wherever) and wait a while. | **None spawn.** This is the new desert-only gate working, not a bug — if you wanted a broader area (mesa/badlands, say), tell me and it's a one-line config add (`TUMBLEWEED.biomes`). |
| 3 | Watch one closely as it rolls. | **Does it look like it's actually rolling forward** — tumbling end-over-end in the direction it's moving — or does it still look like it's spinning in place / sliding while spinning on the wrong axis? This is the uncertain part; say exactly what you see. |
| 4 | Watch one cross a fence, a corner, or anywhere it might get wedged. | It should sit still — no hopping in place, no spinning in place — while stuck, and only resume rolling/bouncing once it's actually moving again (a jitter or gust may eventually free it, or it may just sit until it despawns). |
| 5 | Just keep watching one. | It should disappear noticeably sooner than before — around 20 seconds now, not minutes. |
| 6 | `/summon bountysys:tumbleweed` right in front of you (works regardless of biome — summon isn't gated). | One appears immediately and starts rolling with the others. |
| 7 | Open the game menu (the item or `/scriptevent rae:menu`) and press the last button. | It reads "Turn tumbleweeds off" while they're on, or "Turn tumbleweeds on" while off, and flips it. You're told which. |
| 8 | `/scriptevent rae:tumbleweed` (no player needed). | Toggles the same switch; chat says which way it went. Turn them back on when done. |
| 9 | Shoot a gun so the bullet's path crosses a tumbleweed on the way to a target behind it. Try both a hitscan gun (shotgun) and a projectile gun (pistol/rifle). | Shotgun passes through cleanly. Pistol/rifle can still physically stop on it (the known, accepted trade-off from v3). |

## What to tell me

1. **Does it actually roll now, or does the pitch attempt do nothing visible?** This decides whether the next step is "done" or "build the real animation-based fix."
2. Does the desert-only gate feel right, or too restrictive (should mesa/badlands count too, like the original mod)?
3. Does the new, much shorter lifespan feel right, or too short/too long now?
4. Does the "no hop/spin while stuck" fix actually look right when one gets wedged?
5. Anything odd: one stuck forever without despawning, a texture or model glitch, one launched absurdly high.

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. Must not appear: `[Scripting][error]` lines, an item or entity error naming `tumbleweed`, or a `[TICK ERROR] tumbleweed` line (core/tick.ts reports a handler that throws there without stopping the rest of the game) — in particular, any error from the new `Dimension.getBiome` call.
