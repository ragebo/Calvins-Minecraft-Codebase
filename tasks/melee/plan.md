# Implementation Plan: five melee weapons (knife, machete, baton, axe, sledgehammer)

(Lives in `tasks/melee/` because `tasks/plan.md` still holds the telemetry plan's unchecked owner checkpoints; nothing there is touched.)

## What the owner asked for

Five melee items, with textures supplied in `weapons11.mcpack`:

| Item | Spec, as given |
|---|---|
| **Knife** | 2 damage. Every hit applies a bleed: 2 damage over 2 seconds (1 per second). Every hit applies one, and they stack. |
| **Machete** | 4 damage. Kill threshold of 30% of max HP: a target at three hearts or lower dies on the hit, regardless of armor, potion effects and so on. |
| **Baton** | 3 damage. 25% chance of a half-second stun. |
| **Axe** | 6 damage. A 180 degree cone in front of the player (attack cooldown). |
| **Sledgehammer** | 8 damage. Can break through certain blocks (attack cooldown). |

## What I found (read-only research, 2026-10-12)

- **The texture pack** is a createtextures.com resource pack (the same source as the revolver sprite; its licence is unstated). It does not define
  weapons: it retextures vanilla item names. It holds five 16x16 item sprites with transparency (`wood_sword`, `iron_sword`, `diamond_sword`,
  `spear/diamond_spear`, `spear/netherite_spear`) and two 3D spear entity textures we do not need. Installing the pack as it is would retexture the
  player's vanilla swords and spears. So the sprites are **adopted into `BountySys_RP/textures/items/`** under the new names, as the gun sprites were.
- **Sprite mapping (confirmed by the owner)**: wood_sword = Knife, iron_sword = Machete, diamond_sword = Baton, spear/diamond_spear = Axe,
  spear/netherite_spear = Sledgehammer.
- **`world.beforeEvents.entityHurt`** exists in the installed typings (server 2.10) with **`cancel`** and a **writable `damage`**, plus `damageSource` and
  `hurtEntity`. If the real game honors them for a player's melee hit, exact damage, the attack cooldowns and the machete's finishing blow can be decided in
  one place. **That is not measured.**
- **Measured before** (2026-09-19, `rae:probe_damage`): a script `applyDamage` follows the vanilla hit window. A second hit of equal or smaller damage within
  about 10 ticks on the same target is **lost**, and `applyDamage` still returns true. `EntityDamageCause.override` **bypasses** that window (8 of 8 in one
  tick); whether it bypasses armor is untested. This shapes the bleed (tick damage must not be lost) and the axe (several targets, each with its own window).
- **Before-event callbacks are restricted** (measured 2026-10-06): inside one, `applyDamage`, `addEffect`, `setPermutation`, `runCommand` and friends throw.
  Setting `event.damage` or `event.cancel` is fine; everything else is deferred with `system.run`.
- **The test fake needs no change for the hurt events**: it builds `world.beforeEvents.*` and `afterEvents.*` signals on demand for any name, and has a
  restricted mode for before-events. No friendly-fire rule exists in the gun code, so melee follows vanilla PvP unless the owner says otherwise.
- **Blocks the sledgehammer must not break**: a robbery's bound blocks are protected only through `world.beforeEvents.playerBreakBlock` and the explosion
  event (`systems/robberyrun.ts`). A script that destroys a block itself bypasses both, so the sledgehammer has to ask the robbery store before it breaks
  anything.

## The approach the owner chose: build now, fix later

The owner chose to build on the typings and fix what the game shows, instead of running a measurement spike first. That is faster to a playable first
version and costs one risk: some engine behavior is guessed. The plan keeps that risk small in three ways, and the final test card is the measurement:

1. **Every unknown has a fallback built in**, so the weapon does something sensible whichever way the game answers (the table below).
2. **A diagnostic switch** (`/scriptevent rae:melee_debug on`) writes the hit pipeline to the content log: which events fired, what `damage` the hurt event
   held, what was actually dealt, and a one-time `[melee]` warning the first time something the code relied on did not happen (for example "the game
   ignored the damage set in the hurt event"). So the first real run says exactly what to fix.
3. **`docs/test-cards/MELEE.md`** puts "what only the real game can answer" first, and each answer says which line of code to change.

| Unknown (not measured) | What the code does so it works either way |
|---|---|
| Does `beforeEvents.entityHurt` fire for a player's melee hit, and does setting `damage` change what is dealt? | The hook sets `damage` to the weapon's number **and** each item carries `minecraft:damage` with the same number, so base damage is right if either works. The after-hurt event's `damage` is compared with the number and a warning is logged once if they differ |
| Is that `damage` before or after armor? | The number is applied as the damage the hook sets (armor then behaves as the game decides); the card records what was seen |
| Does `cancel` stop a hit (the cooldowns)? | The cone and the block-breaking extras always respect the cooldown. A single-target hit during a cooldown is cancelled **if** the game lets it; if not, it deals base damage and only the extra is on cooldown (documented in the card) |
| Does `kill()` credit the killer? Does `override` damage ignore armor and Resistance? | The machete sets a huge `damage` in the hook (keeps the attacker), and if the target is still alive a tick later (Resistance) it is `kill()`ed. Whether either credits the killer is logged; the card checks it |
| Does slowness 255 stop a mob and a player? | A stun applies both slowness 255 and, for a player, a movement lock (`core/cinematic.ts`), for 10 ticks |
| Does the bleed's `override` damage ignore armor and keep the attacker? | Bleed uses `override` with the attacker; the card checks armor and kill credit |
| Can a script break a block after a hit and does it drop? | The sledgehammer runs `setblock ... destroy` after the event (drops as when mined) |

## Architecture

```
config/balance.ts   MELEE: every number (damage, bleed length, the 30% threshold, the stun chance and length, the axe's reach and cooldown,
                    the sledgehammer's cooldown and list of breakable blocks) and the five item ids
logic/melee.ts      pure rules: the bleed ledger as a step function, the cone test, the threshold test, a cooldown step, the stun roll with an injected random
core/melee.ts       which weapon a player holds, per-attacker cooldowns, per-target bleed and stun records (cleared on a round reset), the diagnostic log
systems/melee.ts    the event glue only: the before-hurt hook, the hit and swing events, one cheap tick handler for the bleed, the debug script event
items               bountysys:knife, machete, baton, axe, sledgehammer  (stack 1, hand-equipped, equipment category, minecraft:damage = the weapon's number)
```

Layers stay `config <- logic <- core <- systems`; a system imports no system.

## Decisions I made that you did not state (change any; the defaults hold unless you say so)

- **"Damage" is health points, as in vanilla**: 2 is one heart. (This matches your machete line: 30% of 20 HP is 6 HP, which is three hearts.)
- **Bleed**: each hit adds its own 2-second bleed that deals 1 damage at 1 second and 1 at 2 seconds; stacks add up (three stacks deal 3 a second) and are dealt as
  one hit per second (separate hits would be lost to the hit window). It ignores armor, works on players and mobs, kills, credits the knife's wielder, and ends
  on death, on a disconnect and on a round reset. Capped at 10 stacks for performance.
- **Machete**: the check is "current health is 30% of max or less" (so exactly three hearts counts), before the hit lands. It works on players and mobs; a
  creative or spectator player is skipped (they cannot be hurt).
- **Baton**: a hit has a 25% chance to stun for 10 ticks. A stun cannot be refreshed while it is active. A stunned mob or player cannot move; they can still
  attack, because a script cannot stop that.
- **Axe**: 6 damage to every living thing within 3 blocks whose direction from the player is within 90 degrees either side of where they look (a 180 degree
  half circle), except the wielder. **Cooldown 1 second**; a swing during it does nothing (a quiet sound, and the cooldown on the action bar).
- **Sledgehammer**: 8 damage to what it hits. Its swing at a **block** from a configured list breaks it, with drops, once per **1.5 seconds**. Default list:
  glass and glass panes, planks, fences and fence gates, wooden doors and trapdoors, hay. **It never breaks a block a robbery has bound or protected.**
- Melee works **any time**, not only in an active round, like the guns. No team rules beyond vanilla.
- Players get the items with `/give` or from a shop (the shop builder stocks whatever item you hold). Nothing hands them out automatically.
- The numbers are in `/rae:config` (a group **Melee**); the list of breakable blocks is in `config/balance.ts` (the editor takes numbers, switches and
  positions, not lists).

## Task List

### Phase 0: Items
- [ ] Task 1: The five items, with their sprites, and nothing else

### Phase 1: The weapons (Task 2 first; 3 to 7 do not depend on each other)
- [ ] Task 2: The core, the hurt hook, the diagnostic log and the base damage of all five
- [ ] Task 3: The knife's bleed
- [ ] Task 4: The machete's finishing blow
- [ ] Task 5: The baton's stun
- [ ] Task 6: The axe's cone and cooldown
- [ ] Task 7: The sledgehammer's blocks and cooldown

### Checkpoint 1: the weapons
- [ ] all green; every weapon's rule is covered by a test and by deliberate breaks of that rule; each fallback in the table above has a test

### Phase 2: Making it yours
- [ ] Task 8: Live numbers, docs and the test card

### Checkpoint: complete
- [ ] every acceptance box ticked; check, test, check:legacy green
- [ ] (owner) `docs/test-cards/MELEE.md` run in the real game, with `rae:melee_debug on`; what it shows is fixed in a follow-up round

- Task 9: release (only when asked)

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `beforeEvents.entityHurt` does not behave as the typings suggest for melee (does not fire, `damage` ignored, or is pre-armor) | High | Item `minecraft:damage` as the second path; the diagnostic log and a one-time warning say which happened; the card measures it |
| The machete's finishing blow does not credit the killer, so a kill gives no bounty or kill count | High | The hook keeps the attacker where it can; the card checks the kill feed and the bounty; if it fails the fix is one function (named in the card) |
| A bleed or cone tick is lost to the 10-tick hit window | Med | Sum what is due into one hit per target per tick; bleed uses `override` |
| A before-event handler calls a restricted API and throws | Med | Only `damage`/`cancel` are touched in it; everything else is deferred; the fake's strict-before mode runs every test |
| The sledgehammer breaks a robbery's bound block or a protected one | High | It asks the robbery store first; a test plays a robbery and swings at every bound block |
| Per-target records (bleed, stun) outlive the target or a round | Med | Cleared on death, disconnect and round reset; a test for each |
| A stun releases a player the start sequence is holding | Low | A stun does not apply while a start is under way (nobody can fight then) and uses the same lock wrapper |
| Swing and hit events are unreliable in count and timing (measured earlier) | Med | Decide from state (what is held, what is in front) rather than from event timing; a per-player cooldown dedupes a hit and a swing in the same tick |
| Building before measuring means some of it is wrong on the first real run | Med | Accepted by the owner; the debug log and the card are built so the first run finds it, and each fallback is a separate, small, tested function |
| The sprites' licence is unstated | Low | Credited in the README beside the revolver's; the owner decides if that is enough |

## Not in this plan

Durability, enchanting, crafting recipes, throwing the axe, kill-feed text, custom attack animations or held-item poses (a flat item is held like a tool), 3D
models, sounds for each weapon, team or round rules, automatic distribution (loot tables, spawns), and the two spear entity textures. A measurement spike
(`rae:melee_probe`) was considered and the owner chose to build first; it can still be added later if the first run leaves a question the log cannot answer.

## Open questions (a default is used unless you say otherwise)

1. Cooldown lengths: **axe 1 s, sledgehammer 1.5 s**, and the sledgehammer's default block list above. All are numbers you can change in game (the list in the config file).
2. Plan folder `tasks/melee/` rather than `tasks/` (the telemetry plan is not finished). **Default: yes.**
