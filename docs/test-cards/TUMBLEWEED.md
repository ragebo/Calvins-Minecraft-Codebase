# TUMBLEWEED test card: ambient tumbleweeds blown by a wind system

Not an ARCH task: added on request, inspired by an old Bedrock mod ([mcpedl.com/tumbleweed](https://mcpedl.com/tumbleweed/); nothing from it was downloaded or copied — its page gives almost no detail and its file carries no stated license, so this is a new entity built from scratch to fit this codebase). Purely ambience: it cannot hurt or be hurt by anything.

- `bountysys:tumbleweed`s spawn near online players (up to `TUMBLEWEED.maxActive` at once, `config/balance.ts`) **only when the candidate spot is in a desert biome** (`TUMBLEWEED.biomes`), get nudged along by a steady "world wind" with a little jitter and the occasional gust, roll and bounce as they go, and despawn once too old (quickly) or too far from everyone.
- Spawning starts **off** by default (v5+, 2026-09-24). The menu's last button, and `/scriptevent rae:tumbleweed` (no player needed), toggle it. Turning it off only stops new ones from appearing — it does not remove the ones already rolling. **You need to turn it on first with either of those** before any of the steps below will do anything.
- **History:** v1 (2026-09-21) had `minecraft:physics` fully off, floated and clipped through terrain. v2 fixed the floating with a script-driven ground raycast, and reworked the look to crossed alpha-cutout planes (the vanilla dead-bush/fern technique). v3 replaced the ground-snap with **real physics** (`has_gravity`/`has_collision` both on) — the trade-off, still true today, is that a hitscan gun's ray excludes the type outright so a shotgun always passes through, but a **projectile gun's bullet has its own real collision and can physically stop on one**. v4 made it faster and added a scripted bounce (no native restitution setting exists to turn on). v5 (2026-09-23) made it desert-only, despawn much quicker, stop hopping while stuck, and start off by default — and tried making it roll by driving pitch (`setRotation`'s `x`) from script. **A real playtest confirmed that did nothing visible**: the engine's own docs call pitch a head-tilt "for most mobs", and this model has no head bone for it to apply to. **v6 (this one, 2026-09-24)** replaces that with the real mechanism: a custom entity property (`bountysys:roll`) updated from script every tick, read by a new resource-pack animation (`BountySys_RP/animations/tumbleweed.animation.json`) that turns the model's root bone via molang. The rate is physical, not fixed — angle turned = distance actually moved / `TUMBLEWEED.radius`, scaled by `TUMBLEWEED.rollScale` for by-eye tuning — so it naturally stalls while stuck, same as before.

**Hotfix (2026-09-29):** rolling silently broke — not from anything touched here. A Gatling gun playtest on
2026-09-29 turned up a content-log error that also named this entity: `Error loading property 'bountysys:roll':
'default' value does not match the specified type 'float'`, taking the whole properties block down with it, so
`bountysys:roll` had nothing to write to and rolling stopped entirely (silently — the tumbleweed still moved and
bounced, it just stopped visibly turning). The property's own JSON hadn't changed since it was confirmed working
on 2026-09-27; the likely cause is a Minecraft engine update between then and now that stopped accepting a bare
integer (`0`) as a `"default"` for a `"type": "float"` property. Fixed by writing `bountysys:roll`'s `default`
and `range` as explicit decimals (`0.0`, `[0.0, 360.0]`) in `tumbleweed.json` — same numeric values, just a
stricter literal form; no script or animation change. If tumbleweed rolling ever silently stops working again,
check the content log for this exact "does not match the specified type" wording before assuming the script or
animation regressed.

Packs: behavior pack **0.1.26**, resource pack **1.0.23** — the first resource-pack change since the icon/sprite swap; everything from v1 through v5 only ever touched the behavior pack.

`npm test` drives the wind system through the fake tick loop: spawns only when the (faked) biome is desert, nudges and bounces as before, suppresses the hop and the roll property when it hasn't actually moved since the last check, advances the roll property in proportion to real distance moved and keeps it wrapped to [0, 360), despawns by age/distance, the toggle works, and a hitscan gun's ray excludes the type. The fake does not simulate real gravity, real block collision, or rendering at all — and has no concept of animations or molang whatsoever — so it cannot say whether the roll is actually visible in game, only that the script's own math driving it is correct. That's this card.

## Steps

You need to actually be in or very near a desert. You do not need op rights to just watch; you need them for the summon/scriptevent steps.

| # | Do | Expect |
|---|---|---|
| 0 | Open the game menu (the item or `/scriptevent rae:menu`) and press the last button, or `/scriptevent rae:tumbleweed`. | It's off by default, so this reads "Turn tumbleweeds on" — press it. Without this, nothing in steps 1+ will spawn anything. |
| 1 | Stand in a desert and just wait, watching the area around you. | Within a few seconds, a tumbleweed or two rolls into view. |
| 2 | Watch one closely as it rolls. | **Does it now actually tumble forward** — rotating end-over-end in the direction it's moving — rather than sliding along or spinning on the wrong axis? This is the main thing v5 couldn't confirm; it's what v6 is for. |
| 3 | Watch it roll for a while at different speeds (right after spawning vs. after a gust vs. cruising normally). | The roll rate should look proportional to how fast it's actually moving — not slower/faster than the ground it's covering suggests. If it looks off (too fast/slow relative to its actual speed), that's `TUMBLEWEED.rollScale` to tune, not a bug. |
| 4 | Watch one cross a fence, a corner, or anywhere it might get wedged. | It should sit still — no hopping, no rolling — while stuck, and only resume once it's actually moving again. |
| 5 | Just keep watching one. | It should disappear after roughly 20 seconds. |
| 6 | `/summon bountysys:tumbleweed` right in front of you (works regardless of biome — summon isn't gated). | One appears immediately, rolling like the others. |
| 7 | Open the game menu and press the last button, then separately try `/scriptevent rae:tumbleweed`. | Both toggle the same switch; chat says which way it went each time. Turn them back on when done. |
| 8 | Shoot a gun so the bullet's path crosses a tumbleweed on the way to a target behind it. Try both a hitscan gun (shotgun) and a projectile gun (pistol/rifle). | Shotgun passes through cleanly. Pistol/rifle can still physically stop on it (the known, accepted trade-off from v3). |

## What to tell me

1. **Does it actually roll now?** (End-over-end in the direction of travel, not a slide or a spin on the wrong axis.)
2. Does the roll rate look right, or does `rollScale` need tuning (too fast/slow for how fast it's actually moving)?
3. Does the "no hop/roll while stuck" behavior still look right when one gets wedged?
4. Anything odd: one stuck forever without despawning, a texture/model glitch, a visible seam or snap where the animation and the entity's own yaw disagree.

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. Must not appear: `[Scripting][error]` lines, an item or entity error naming `tumbleweed`, a `[TICK ERROR] tumbleweed` line (core/tick.ts reports a handler that throws there without stopping the rest of the game), or — new this round — any resource-pack load error naming `tumbleweed.animation.json` or the `bountysys:roll` property (the animation's molang syntax is written from documentation, not copied from a working example in this game's own data, so a typo here would show up as a content-log error rather than a script one).
