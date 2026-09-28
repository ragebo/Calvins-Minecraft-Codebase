# GATLING-GUN test card: a placed, manned gun instead of a carried one

Not an ARCH task: added on request, "for some fun" — the seventh gun, and the first one that is placed and
ridden rather than carried and fired directly.

**v1 (2026-09-27) shipped, then failed all three real-game checks it needed to pass** — the owner's own
report after playing it:
1. It only fired on a click, never felt like it was ramping up.
2. It didn't turn to follow the rider's look direction at all.
3. Placing it didn't work.

**v2 (this one)** fixes all three, and the root cause of the first two turned out to be the same kind of
gap: v1 guessed at engine behavior instead of building around what a real playtest actually showed.

- **Firing is now a toggle, not click-sustained.** v1 tried to approximate "hold to fire" by having every
  swing "rev" a fire-rate gate, hoping either that holding the mouse button would repeat the swing event on
  its own, or that clicking fast enough would feel like ramping. Neither held up: the owner's playtest
  confirmed holding does nothing extra, and even rapid clicking never felt like it was speeding up, because
  the gate's own "cold" rate (6 ticks, 0.3s) was barely slower than a human can click anyway — there was
  nothing for the ramp to do that a finger wasn't already doing. v2 throws that model out: **one swing now
  starts a self-sustaining fire loop** (`systems/guns.ts`'s `fireAutomaticStep`, rescheduling itself with
  `system.runTimeout`) that fires and accelerates entirely on its own timer, needing no further clicks at
  all, from a genuinely slow start (`fireRateTicksStart`, 8 ticks) to a rate no human could click
  (`fireRateTicksSpunUp`, 1 tick) over `spinUpShots` (12) shots. A second swing stops it. This is the same
  toggle-not-hold fix already used for aiming, now applied here for the same underlying reason (no held-
  button signal for a swing in this engine).
- **It now turns to follow whoever is riding it, every tick.** Yaw is the whole entity's own rotation (set to
  the rider's own yaw); pitch is isolated to the model's "turret" bone alone (so the tripod stays level) via
  a new client-synced entity property (`bountysys:aim_pitch`) a new resource-pack animation reads through
  molang — the same technique the tumbleweed's own roll already uses. The model itself changed shape to
  support this: two bones now (`base`, fixed; `turret` — the receiver, barrels and crank — pivoting for
  pitch), not one.
- **Placement now uses a different, already-proven event.** v1 placed it via `playerInteractWithBlock`, a
  first for this codebase — untested against the real engine, and it turned out not to fire for a plain item
  with no block-interaction behavior of its own (this is the confirmed root cause of "placing it doesn't
  work"). v2 places it on `itemUse` instead — the exact same event the aim toggle has used reliably for
  months — and finds where to place it with a raycast from the player's own view
  (`Dimension.getBlockFromRay`), the same technique `fireHitscan` already uses to find a shotgun pellet's
  target, rather than trusting a block-interaction event's own fields.

Everything else from v1 is unchanged: `bountysys:gatling_gun` is a normal carryable gun until placed (one
identifier, item and entity both — separate registries, no clash), 90 rounds of `rifle_ammo`, auto-reload on
empty, 3 damage per bullet, and it's still never held to fire or aimed with a zoom.

Packs: behavior pack **0.1.30**, resource pack **1.0.25** — the model gained a second bone and the entity
gained the aim-pitch property and its own new animation file.

`npm test` drives the whole thing through the fake tick loop: placing it now via a mocked raycast (and the
"nothing in range" case), that holding it still does nothing, that one click starts a loop that keeps firing
and accelerating with **no further clicks at all** (verified both by shot count over time and by the fire
cue's own pitch climbing, not just "many shots happened"), that a second click genuinely stops it (nothing
plays afterward, not just "fires less"), that running dry stops the loop and reloads on its own, that
dismounting mid-burst or mid-reload stops it, that a round reset really kills a running loop rather than
leaving it scheduled, and that the mount's yaw and its aim-pitch property both track the rider every tick.
None of this can say whether the resource-pack animation actually reads that property the way it's meant to,
or whether the ramp's *feel* is right now that a human's own clicking speed is no longer the bottleneck —
that's what this card is for.

## Steps

`/give @s bountysys:gatling_gun`, `/give @s bountysys:rifle_ammo 96`.

| # | Do | Expect |
|---|---|---|
| 1 | Hold it and left-click at the sky a few times. | Nothing happens — no shot, no sound. |
| 2 | Look at a wall or the ground and right-click. | It plants where you were looking, facing the direction you were facing, and vanishes from your hand. |
| 3 | **New:** if you're not looking at anything in range (over a ledge into open air, say), right-click. | You're told there's nothing in range to place it on, and it stays in your hand. |
| 4 | Right-click the placed gun to sit in it. | You mount it. |
| 5 | **New:** look around — up, down, left, right — without clicking anything. | Does the gun visibly turn to follow where you're looking? Does the barrel cluster tilt up/down without the tripod itself tipping over, or does the whole thing lurch, or does nothing move at all? |
| 6 | **The main fix.** Left-click once, then let go and don't click again. | Does it keep firing on its own, getting faster over roughly the first couple of seconds, without you touching anything else? This is the one thing v1 completely failed. |
| 7 | While it's firing on its own, click once more. | It should stop immediately — no more shots. |
| 8 | Click again to restart it, then look around while it's firing. | Does it keep tracking your aim while it's actively shooting, or does it lock in place until you stop? |
| 9 | Let it run all the way through the magazine on its own. | It reloads by itself once empty — no key needed. Does 5 seconds (100 ticks) feel like the right length for a reload this size? |
| 10 | Start it firing, then dismount. | It should stop firing the moment (or within a fraction of a second of) you get off. |
| 11 | Shoot something with it for a while. | Judge the damage now that it can genuinely sustain fire without your finger being the limit: still 3 per hit — does the volume of fire at full speed feel like it makes up for that, or is it too weak/strong now? |

## What to tell me

1. **Does it actually feel like it's ramping up now**, with no clicking required after the first one?
2. **Does the aim-tracking look right** — does the barrel cluster follow your look direction smoothly, does the tripod stay planted, and is up/down the right way round (not inverted)?
3. Does placement land where you'd expect, and does "nothing in range" ever trigger somewhere it shouldn't (or fail to trigger somewhere it should)?
4. Does the model read as a Gatling gun, especially now that part of it moves?
5. Now that sustained fire is real, is the damage/magazine/reload balance still right, or does it need retuning?
6. Anything broken: firing that doesn't stop when it should, tracking that snaps or glitches, a reload that never finishes, or getting stuck unable to dismount.

## Content log

Must not appear: `[Scripting][error]` lines, an item or entity error naming `gatling`, or a `[TICK ERROR] guns` line. Specifically watch for anything about `bountysys:aim_pitch` (a new property) or `gatling_gun.animation.json` (a new animation file, its molang syntax written from documentation, not copied from a working example in this game's own data) — either would show up as a resource-pack load error or a `[Molang]` warning, not a script one.
