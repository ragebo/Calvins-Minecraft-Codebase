# RAPID-FIRE test card: fast follow-up shots no longer lose damage

Not an ARCH task: found while assessing what to work on next, not reported by a playtest. `rae:probe_damage` (2026-09-19) measured that script `applyDamage` follows vanilla's own post-hit invulnerability: a target that was just hurt ignores a **repeat** hit within about 10 ticks unless the new hit is **bigger** than the last one. The shotgun fix (`docs/test-cards/SHOTGUN.md`) already solved this **within one blast** by summing all of a blast's pellets into one hit. Nothing solved it **across separate trigger pulls** until now — the double-barrel's second barrel (4 ticks after the first), a rapid-clicked revolver (8 ticks) or semi rifle (6 ticks) could have a follow-up shot's damage vanish outright on a still target.

## The fix

`dealGunDamage` (`systems/guns.ts`) keeps a short per-target ledger of what a gun last dealt it and when. A new hit that would otherwise be swallowed (no bigger than the last one, within `HIT_WINDOW_TICKS`, `config/guns.ts`) is **added to the pending total** instead of dealt on its own — the same "sum instead of separately deal" idea the shotgun fix already uses, stretched across time instead of across one blast's pellets. Both damage call sites (`fireHitscan`'s summed pellet hit, and the `projectileHitEntity` handler used by every projectile gun) go through it now.

**Known, accepted limit:** the ledger only knows about damage guns themselves dealt. If a target took some unrelated hit (a fall, a punch, another player's gun) right before your shot, vanilla's real window is global and could still swallow part of it in a way this fix can't see — a separate, unmeasured edge case, not what this fixes.

**Why not skip the window entirely** (`EntityDamageCause.override`, also measured to bypass it): its effect on armor is untested, and using it for every gun risked quietly making them all ignore armor along with the window. This fix never changes *how* damage is resolved, only sums up how much when a shot would otherwise vanish.

`npm test` (`test/guns-pellets.test.mjs`) fires the same armed player twice in a row against a stand-in target that follows the exact vanilla rule: a rapid follow-up within the window lands the combined total; one after the window passes lands on its own; a second shot already bigger than the first isn't inflated further. It cannot say whether the real engine's window is really ~10 ticks (that's what the probe measures) or whether this feels right in a real gunfight.

## Steps

You need op rights for `/give` and `/scriptevent`. A zombie (20 health) or a cow works as a target; stay at a fixed, close range so the shot always lands.

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:double_barrel_shotgun`, `/give @s bountysys:shotgun_ammo 64`. Fire both barrels as fast as you can at a zombie from point blank. | Both blasts land in full (up to 25 each, so the zombie should die or come very close to it from two shots, not survive on a sliver from a "wasted" second barrel). |
| 2 | `/give @s bountysys:revolver`, `/give @s bountysys:handgun_ammo 64`. Click as fast as the gun allows, several times, at a still zombie. | Every shot's damage adds up — the zombie's health drops roughly `4 x number of shots`, not less. |
| 3 | Same with the semi rifle. | Same: every shot counts. |
| 4 | Wait a couple of seconds between two shots on a fresh target (well past the window) with any gun. | Nothing different from before: two independent full-damage hits. |
| 5 | Fire the double-barrel once landing only some pellets (stand at the edge of its spread, past the effective range for a full hit, or hit a small target so some pellets miss), then immediately fire a full, unobstructed blast. | The second, bigger blast lands as itself — it should not look inflated beyond a normal full blast. |

## Content log

Must not appear: `[Scripting][error]` lines, or anything naming `guns.ts` or `dealGunDamage`.

## Not checked

- The exact width of the real window (10 ticks is the probe's best measurement, not a documented constant); if a gun right at the edge (the pistol or bolt rifle, 10-tick fire rate) ever seems to lose a hit, that boundary is the first thing to re-measure.
- Interaction with a hit from something other than a gun landing just before a shot (the accepted limit above).
