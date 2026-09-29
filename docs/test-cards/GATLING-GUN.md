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

**v3 (this one)**, from the owner's playtest of v2 — this time with a screenshot, not just a description —
three smaller fixes:
1. **The rider sat too high.** The seat's `position` (in `minecraft:rideable`) moved from `[0, 0.85, 0.3]` to
   `[0, 0.5, 0.3]` — a straight height drop, nothing else about mounting changed.
2. **The barrels themselves now spin while firing**, the one visual piece v1/v2 never had: a real Gatling gun
   reads as "spinning up," not just "the camera tilts." The model gained a third bone, `barrels` (the five
   barrels and their muzzle caps), parented to `turret` so it still inherits the pitch tracking, but pivoting
   on its own separately so it can spin around its own length independently. A second client-synced property,
   `bountysys:barrel_spin`, drives it through the same molang technique as `aim_pitch` — a new
   `onTick("guns:gatling-aim", ...)` block reads the active fire loop's own burst count (the same ramp state
   `fireCuesFor` already uses for the fire-cue pitch) and advances the property by a bigger step the more
   spun-up the burst is, wrapped modulo 360 so it never grows unbounded. When nothing is firing the property
   is simply left alone — the barrels coast to a stop wherever they were, they don't snap back to 0.
3. **Max fire rate slowed slightly.** `fireRateTicksSpunUp` went from 1 tick to 2 — the fastest possible gap
   between shots doubled, everything else about the ramp (`fireRateTicksStart` 8, `spinUpShots` 12) unchanged.

Packs: behavior pack **0.1.31**, resource pack **1.0.26** — the model gained a third bone, the entity gained
the barrel-spin property alongside the existing aim-pitch one, and the seat moved.

`npm test` drives the whole thing through the fake tick loop: placing it now via a mocked raycast (and the
"nothing in range" case), that holding it still does nothing, that one click starts a loop that keeps firing
and accelerating with **no further clicks at all** (verified both by shot count over time and by the fire
cue's own pitch climbing, not just "many shots happened"), that a second click genuinely stops it (nothing
plays afterward, not just "fires less"), that running dry stops the loop and reloads on its own, that
dismounting mid-burst or mid-reload stops it, that a round reset really kills a running loop rather than
leaving it scheduled, that the mount's yaw and its aim-pitch property both track the rider every tick, that
the barrel-spin property advances every tick while a loop is running and ramps the same way the fire rate
does (measured as a wrap-safe per-tick delta, early burst vs. deep into the spun-up part), that it stays
wrapped into `[0, 360)` over a burst long enough to turn it several times, and that it freezes — not resets
— the instant firing stops. None of this can say whether the resource-pack animation actually reads either
property the way it's meant to, whether the barrels visibly read as "spinning" rather than just twitching,
or whether the new seat height and fire rate feel right — that's what this card is for.

## Steps

`/give @s bountysys:gatling_gun`, `/give @s bountysys:rifle_ammo 96`.

| # | Do | Expect |
|---|---|---|
| 1 | Hold it and left-click at the sky a few times. | Nothing happens — no shot, no sound. |
| 2 | Look at a wall or the ground and right-click. | It plants where you were looking, facing the direction you were facing, and vanishes from your hand. |
| 3 | **New:** if you're not looking at anything in range (over a ledge into open air, say), right-click. | You're told there's nothing in range to place it on, and it stays in your hand. |
| 4 | Right-click the placed gun to sit in it. | **New:** you should sit noticeably lower than before — v2's seat sat you too high above the receiver. |
| 5 | Look around — up, down, left, right — without clicking anything. | Does the gun visibly turn to follow where you're looking? Does the barrel cluster tilt up/down without the tripod itself tipping over, or does the whole thing lurch, or does nothing move at all? |
| 6 | **The main fix.** Left-click once, then let go and don't click again. | Does it keep firing on its own, getting faster over roughly the first couple of seconds, without you touching anything else? **New:** do the barrels themselves visibly spin faster as it ramps up, on top of the sound/rate ramp? |
| 7 | While it's firing on its own, click once more. | It should stop immediately — no more shots, and **new:** the barrels should coast to a stop rather than snapping back to their start position. |
| 8 | Click again to restart it, then look around while it's firing. | Does it keep tracking your aim while it's actively shooting, or does it lock in place until you stop? The barrels should keep spinning throughout, independent of the tracking. |
| 9 | Let it run all the way through the magazine on its own. | It reloads by itself once empty — no key needed. Does 5 seconds (100 ticks) feel like the right length for a reload this size? |
| 10 | Start it firing, then dismount. | It should stop firing (and the barrels should stop spinning) the moment (or within a fraction of a second of) you get off. |
| 11 | Shoot something with it for a while. | **New:** the max rate is slightly slower than before (`fireRateTicksSpunUp` 1→2 ticks) — does full-speed fire still feel like a Gatling gun, or is it now too slow? Damage is still 3 per hit. |

## What to tell me

1. **Does the seat height look right now**, sitting in it from a first-person view like the reference screenshot?
2. **Do the barrels read as spinning** — a real rotating-barrel-cluster look — rather than a flicker, a snap, or no visible motion at all? Does the spin rate itself feel like it's ramping up along with the fire rate, and does it coast to a smooth stop rather than jumping back to 0?
3. **Does the aim-tracking still look right** — does the barrel cluster follow your look direction smoothly, does the tripod stay planted, and is up/down the right way round (not inverted)?
4. **Does the slightly slower max fire rate feel right**, or does it need to go back up?
5. Does placement still land where you'd expect, unaffected by the seat/model changes?
6. Anything broken: firing that doesn't stop when it should, tracking or spin that snaps or glitches, a reload that never finishes, or getting stuck unable to dismount.

## Content log

Must not appear: `[Scripting][error]` lines, an item or entity error naming `gatling`, or a `[TICK ERROR] guns` line. Specifically watch for anything about `bountysys:aim_pitch` or `bountysys:barrel_spin` (both client-synced properties) or `gatling_gun.animation.json` / `gatling_gun.geo.json` (the animation and model files, changed again this round) — either would show up as a resource-pack load error or a `[Molang]` warning, not a script one.
