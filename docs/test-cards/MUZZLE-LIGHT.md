# MUZZLE-LIGHT test card: every gun flashes, two guns actually light up

Not an ARCH task: added on request, in two parts.

**Part 1, every gun: a real muzzle flash, not just smoke.** Until now only the two shotguns had
`minecraft:basic_flame_particle` in their `effects.muzzle` list (`config/guns.ts`) — the revolver,
pistol, bolt-action, semi-auto (Repeater) and Gatling gun showed smoke only. All five now get flame
particles too, same technique, no new art.

**Part 2, the experimental one: the revolver and the Repeater briefly become a real light source.**
Particles never cast light in this engine, and there is no dynamic-light scripting call at all — the
only way to actually light up the surroundings is a light-emitting *block*. `systems/guns.ts`'s new
`flashMuzzleLight` places an invisible `minecraft:light_block_15` at the shot (rounded to whichever
block it falls in) and clears it back to air 3 ticks later (`config/guns.ts`'s `effects.muzzleLight`).

**Why only two guns, and not the Gatling gun:** placing or clearing a light-emitting block costs a
real lighting recalculation — a materially different load than a particle. Doing that on *every shot*
of a gun that can re-fire every couple of ticks with no human bottleneck (the Gatling gun's
self-sustaining fire loop) risked real, repeated lag, especially since this project already has an
open, never-explained lag report from a few days before this. The revolver and the Repeater were
picked instead because both have an *enforced* slow cadence — `primeTicks` (a non-firing cycle click
between shots) roughly doubles their real interval, so even mashing the trigger can't push the light
flash past about once every 16-30 ticks. This is deliberately a small, cheap-to-undo experiment: if it
looks bad or costs anything noticeable, dropping `muzzleLight` from these two guns' config is a
one-line revert with no other consequences.

**Safety rules `flashMuzzleLight` follows, and why:** it only ever places into a block that is
currently *air* — never a real block, so it can never destroy or replace anything a player built. And
when the timer goes to clear it, it only clears the block if it's *still* that same light block — if
a player has since built something real there, or a second overlapping flash already replaced it,
it's left alone rather than risking wiping out the wrong thing.

`npm test` checks all of this against a fake block store: the light appears and then clears itself,
a gun without `muzzleLight` never touches a block at all, a real block already there is never
displaced, a block that changed after the flash placed it is never wrongly cleared, and a bad light
id is reported once (via `core/log.ts`) and never breaks firing. None of that can say whether the
flash actually looks right, whether the light is noticeable enough to matter, or whether it costs
anything real in a busy game — that's what this card is for.

Behavior pack **0.1.33** (no resource-pack change: every particle and block id here is vanilla).

## Steps

`/give @s bountysys:revolver`, `/give @s bountysys:semi_rifle`, `/give @s bountysys:pistol`,
`/give @s bountysys:bolt_rifle`, `/give @s bountysys:gatling_gun`, and enough ammo for each
(`bountysys:handgun_ammo`, `bountysys:rifle_ammo`).

| # | Do | Expect |
|---|---|---|
| 1 | Fire the pistol and the bolt-action rifle somewhere dim, at night or underground. | A flash at the muzzle (new), same as the shotguns already had — but no actual light on the ground or walls nearby. |
| 2 | Fire the revolver somewhere genuinely dark. | The same flash, **and** a brief real flicker of light right at the muzzle — the ground/wall near the shot should visibly brighten for a fraction of a second, not just show a particle. |
| 3 | Fire the Repeater (semi_rifle) the same way. Remember it needs a prime click between shots (fire, click again to cycle, then fire again). | Same brief real light on the shot that actually fires; the prime click itself shows nothing. |
| 4 | Fire the revolver or Repeater rapidly (as fast as the prime cycle allows) for 10+ seconds. | Watch and listen for anything unusual: stutter, a delay before firing, chat/content-log errors. This is the actual lag test. |
| 5 | Fire the revolver point-blank at a wall, a chest, a door — anything solid. | The wall/chest/door must be completely unaffected — no missing block, no flicker replacing it. This checks the "never displace a real block" rule. |
| 6 | Ride and fire the Gatling gun for a while. | Muzzle flash only (new), same as every other gun now — confirm it does **not** flicker with real light. |

## What to tell me

1. Does the revolver's/Repeater's light flash actually read as light — brightening the ground/walls
   — or is it too brief/dim to notice at all? (If unnoticeable, `muzzleLight`'s `level`/`ticks` in
   `config/guns.ts` are easy to raise.)
2. Any lag, stutter, or delay when firing the revolver or Repeater repeatedly — this is the main risk
   this feature was built around, so a clear "yes" or "no" here matters more than usual.
3. Does every gun's new flash look right, or does any of them look wrong/too subtle/too much?
4. Anything broken: a missing block anywhere you fired near solid terrain, a stuck light that never
   goes away, or content-log errors naming `gun effects`.

## Content log

Must not appear: `[gun effects] minecraft:light_block_15 failed` (the light-block id itself was
rejected — would mean this engine build doesn't support it, or a typo), `[gun effects]
minecraft:basic_flame_particle failed`, or any `[Scripting][error]` line.

## Not checked

- Whether the light is actually visible/noticeable is unseen until it's fired in a dark spot.
- Whether it costs anything measurable is unseen without a real, sustained-fire playtest (step 4).
- The revolver's and Repeater's light-block placement was chosen as a small, safe first test, not a
  final design — if it looks good and costs nothing, extending it to other slow guns (pistol,
  bolt-action) is a config change away; the Gatling gun and any other fast/sustained-fire gun should
  stay excluded regardless, per the reasoning above.
