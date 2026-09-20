# SHOTGUN test card: pellets add up, and the damage probe

Not an ARCH task: added after a playtest report that the shotguns feel weak. Findings, in the order they matter.

## What the shotguns are configured to do

| Gun | Pellets x damage | All land | Spread (half angle) | Range |
|---|---|---|---|---|
| Pump | 8 x 2 | **16** (8 hearts) | 8 degrees | 12 blocks |
| Double-barrel | 10 x 2.5 | **25** (12.5 hearts) | 12 degrees | 8 blocks |

These numbers have not changed since the guns were added, and no config value gives "30+". A player has 20 health.

## What a target actually takes, if every landed pellet counts

The spread is wide, so "all pellets hit" only happens at point blank. Average pellets landing on a player-sized target (0.6 wide, 1.8 tall) aimed at its centre, from a simulation of the same spread the game uses:

| Distance | Pump: pellets / damage | Double-barrel: pellets / damage |
|---|---|---|
| 1-2 m | 8 / 16 | 10 to 8.2 / 25 to 20 |
| 3 m | 6.6 / 13 | 5.8 / 14 |
| 4 m | 5.2 / 10 | 4.4 / 11 |
| 6 m | 3.6 / 7 | 2.1 / 5 |
| 8 m | 2.2 / 4 | 1.2 / 3 |
| 12 m | 1.0 / 2 | (out of range) |

So even when everything works, both shotguns fall off fast: at 6 m the pump is about a pistol shot.

## The bug that made it worse

Each pellet used to be a separate `applyDamage` call on the target, all in the same tick. In vanilla, a target that was just hurt ignores a further hit that is not bigger than the last one, for about 10 ticks. If script damage follows that rule, every pellet after the first counted for **nothing**: a point-blank pump blast would do 2 damage (1 heart), not 16.

Whether script damage follows the rule is not in the API docs, so it was not assumed. Now:

- **The fix:** pellets that land on the same target are added up and dealt as one hit. That is correct whether or not the rule applies.
- **The probe:** `/scriptevent rae:probe_damage` measures it in the real game (below).

Known limit that the probe will show: if the rule applies, two shells that hit the same target within about 10 ticks (a double-barrel double tap is 4) do not stack either, because the second blast is no bigger than the first.

## Steps

Cheats on, Content Log GUI on. Stand in the open with nothing in front of you.

| # | Do | Expect |
|---|---|---|
| 1 | `/scriptevent rae:probe_damage` and stay put. | About 10 seconds later: six lines `A:` to `F:` and a `Reading:` line, all in chat. A cow appears 3 blocks in front of you for each scenario and vanishes. |
| 2 | Read the lines (or tell me to read the content log; they are logged as `[probe]` warnings). | `A:` is the old shotgun pattern (8 hits of 1 in one tick). `B:` is one hit of 8. If `A` dealt about 1 of 8 and `B` dealt 8 of 8, hits in one tick do **not** add up: the fix is what makes shotguns work. If `A` dealt 8 of 8, they do add up and the weakness is the spread and the numbers above. |
| 3 | `/give @s bountysys:pump_shotgun`, `/give @s bountysys:shotgun_ammo 64`. Shoot a zombie (20 health) from about 2 blocks. | Around 8 hearts gone in one blast (16 damage), so a second blast finishes it. Not 1 heart. |
| 4 | The same from 6 blocks. | Roughly 3 to 4 hearts, varying with the spread. |
| 5 | `/give @s bountysys:double_barrel_shotgun`. Shoot a zombie at point blank. | Most of its health in one blast (up to 25 of 20). |
| 6 | Fire both barrels as fast as you can at one zombie. | The second blast may add little or nothing if the probe's `D:` line lost damage. That is the known limit above, not a new bug. |

## Content log

- The probe writes every result line as a `[probe]` warning.
- Must not appear: `[EVENT ERROR]`, `[TICK ERROR]`, `InvalidEntityError`.

## Not checked

- The game was not run for this change. The fix is tested against a stand-in target that follows the vanilla rule; whether the real engine follows it is what the probe answers.
- The distance table comes from a simulation of the spread, not from the game.
- Whether the numbers should go up is a balance decision: to reach 30+ at point blank the pump would need 4 per pellet (32) and the double-barrel 3 (30), and they would still fall off with distance.
