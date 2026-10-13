# Todo: five melee weapons

Status source of truth for `plan.md` in this folder. Every task: RED first (a failing test), then the code, then `check`, `test` (`node scripts/test.mjs`)
and `check:legacy` as one chain, then one commit. Deliberate-break (mutation) runs on every new rule. The owner chose to build on the typings and fix what
the game shows (no spike): every engine behavior that is not measured has a fallback and a diagnostic, and a test for each.

## Phase 0: Items

- [x] **Task 1: The five items, with their sprites, and nothing else** (M) - done
  Five item definitions in the behavior pack (`bountysys:knife`, `machete`, `baton`, `axe`, `sledgehammer`: format 1.26.50 like `pistol.json`, stack of 1,
  hand-equipped, equipment category, a display name each, an icon key each) and their sprites adopted from `weapons11.mcpack` into
  `BountySys_RP/textures/items/` (`knife.png` from `wood_sword`, `machete.png` from `iron_sword`, `baton.png` from `diamond_sword`, `axe.png` from
  `spear/diamond_spear`, `sledgehammer.png` from `spear/netherite_spear`) with entries in `item_texture.json`. The ids live once, in `config/balance.ts`'s
  new `MELEE` block, so code and item files agree. No behavior: a player can `/give` and hold them.
  - Acceptance:
    - [x] each item file's identifier equals the id in `MELEE`, and each has its own icon key, mapped in `item_texture.json` to a PNG that exists
    - [x] each sprite is 16x16 with transparency and is byte-for-byte the one in the pack (so a later change to the pack's sprite is noticed)
    - [x] each is a plain stack-1 item: not hold-to-use, no cooldown component, nothing that overrides how a tool is held
    - [x] the existing asset tests still pass, and no vanilla sword or spear is retextured (the pack is not installed; its sprites are copied)
  - Verification: check, test, check:legacy; the five sprites looked at on a contact sheet
  - Result: 4 new asset tests: the five weapons agree across both packs (id from config/balance.ts MELEE, icon, inventory name, texture map entry, sprite file), each is a plain item (equipment category, one at a time, held like a tool, no use_modifiers, no game cooldown, no durability), the five sprites are exactly the ones in weapons11.mcpack (SHA-256 pinned per sprite, since the mcpack itself is not in the repo) and 16x16 with transparency, and nothing vanilla is retextured (no wood/iron/diamond sword sprite, no spear folders). The existing asset tests cover the new sprites automatically (exist, 16x16, alpha, used by an item). 64 deliberate breaks, all caught: 53 on the data files (nine on each item file, four on item_texture.json, four on the config) and 11 on the sprites and folders themselves (each sprite swapped for another's pixels, one deleted, three vanilla-named sprites added, two spear folders added), each restored and hash-checked afterwards. Sprites mapped as the owner confirmed: knife from wood_sword, machete from iron_sword, baton from diamond_sword, axe from spear/diamond_spear, sledgehammer from spear/netherite_spear. The items carry no behavior yet (no minecraft:damage until Task 2). The sprites are a resource pack change, so reaching the game needs the game fully closed and a fresh launch (Task 9). README credit for the sprites waits for Task 8.
  - Dependencies: none
  - Files: `your_pack_name_BP/items/{knife,machete,baton,axe,sledgehammer}.json`, `BountySys_RP/textures/items/*.png`, `BountySys_RP/textures/item_texture.json`, `rae/src/config/balance.ts`, `rae/test/assets.test.mjs`

## Phase 1: The weapons

- [x] **Task 2: The core, the hurt hook, the diagnostic log and the base damage of all five** (L) - done
  `logic/melee.ts` (the first pure rules: a cooldown as a step function, the threshold and cone tests as plain functions), `core/melee.ts` (which weapon a
  player holds, by the item in the main hand; per-attacker cooldowns; per-target records cleared on a round reset; the diagnostic log), `systems/melee.ts`
  (the one `beforeEvents.entityHurt` hook, plus the `rae:melee_debug` script event), the `MELEE` numbers (knife 2, machete 4, baton 3, axe 6, sledgehammer 8),
  and `minecraft:damage` on each item with the same number, so base damage is right if either path works. The hook sets `event.damage` for a player's melee
  hit with one of the five; the after-hurt event's `damage` is compared with the number and a warning is logged once if the game did not honor it.
  - Acceptance:
    - [x] a hit with each weapon deals exactly its number (the hook sets `damage`), on a mob and on a player, in the fake's restricted before-event mode
    - [x] a hit with anything else (a fist, a gun, a vanilla sword) is left exactly as it was; a hit by a non-player is left alone
    - [x] the held weapon is read from the main hand at the moment of the hit, not remembered; a player who swaps item mid-swing gets the item they hold
    - [x] each item file carries `minecraft:damage` equal to its number in `MELEE` (an asset test), so the two paths cannot drift apart
    - [x] with `rae:melee_debug on` the pipeline is logged (the event, the weapon, the number set, the number dealt); off, nothing is logged and nothing runs
    - [x] when the number dealt differs from the number set, one `[melee]` warning says the game ignored the hurt event's damage, once per script load
    - [x] a round reset clears the per-attacker and per-target records; nothing restricted is called inside the before-event handler
  - Verification: check, test, check:legacy; deliberate breaks on every number, every pass-through and the warning
  - Result: the hurt hook sets each weapon's number (knife 2, machete 4, baton 3, axe 6, sledgehammer 8) on a player's melee hit; pass-throughs for fists, guns, vanilla swords, mobs, projectiles and the script's own override damage; the held item is read at hit time; minecraft:damage on all five items equal to MELEE; rae:melee_debug logs the pipeline; one [melee] warning if the game dealt another number; reset clears the records. 1577 tests (+18), 58-break mutation run all caught.
  - Dependencies: Task 1
  - Files: `rae/src/logic/melee.ts`, `rae/src/core/melee.ts`, `rae/src/systems/melee.ts`, `rae/src/config/balance.ts`, `your_pack_name_BP/items/*.json`, `rae/src/main.ts`, `rae/test/melee-core.test.mjs`

- [x] **Task 3: The knife's bleed** (M) - done
  A knife hit adds a bleed to the target: 1 damage at 1 second and at 2 seconds after the hit; stacks add up (capped at `maxStacks`); what is due on a tick is dealt as
  ONE hit per target (separate hits within 10 ticks would be lost to the hit window), by the knife's wielder, with `override` so it ignores armor and the hit window. One cheap
  tick handler, free when nobody is bleeding.
  - Acceptance:
    - [x] one hit: 1 damage at 20 ticks and 1 at 40, then it stops; 2 total
    - [x] three hits in a row: the stacks add up (3 a second at the peak) and the total over time is 6, none of it lost to the hit window
    - [x] a bleed on a player and on a mob; it kills, and the damage names the knife's wielder as the attacker (what the game does with that is logged under `rae:melee_debug`)
    - [x] it ends on the target's death, on a disconnect and on a round reset; the stack cap is respected
    - [x] a target that is not hit by a knife never bleeds; the knife's own 2 damage is dealt as in Task 2
    - [x] the handler does nothing, and costs nothing, with no one bleeding
  - Verification: check, test, check:legacy; deliberate breaks
  - Result: knife hit adds a stack; 1 damage at +20 and +40 ticks, stacks add up to 10 (a full target refreshes its oldest), what is due on a tick is ONE override hit per target naming the wielder (or nobody if they left); one tick handler, registered only while someone bleeds (core/melee.ts); ends on death, leave, removal, health 0 and round reset. 1596 tests (+19), 51-break mutation run all caught.
  - Dependencies: Task 2
  - Files: `rae/src/logic/melee.ts`, `rae/src/core/melee.ts`, `rae/src/systems/melee.ts`, `rae/test/melee-knife.test.mjs`

- [x] **Task 4: The machete's finishing blow** (S-M) - done
  A machete hit on a target whose health is 30% of its maximum or less kills it, whatever its armor and effects: the hook sets a huge `damage` (keeping the attacker), and a tick later a target
  that is still alive (Resistance) is `kill()`ed. Which of the two did it is logged under `rae:melee_debug`.
  - Acceptance:
    - [x] a target at 6 of 20 HP dies; one at 6.5 does not and takes 4; one at full health takes 4
    - [x] the threshold follows the target's maximum (a 40 HP mob dies at 12), not a fixed number
    - [x] a target that survives the huge hit (the fake's Resistance 5) is killed by the follow-up a tick later; one that died is not killed twice
    - [x] a creative or spectator player is not killed; a target that is already dead is left alone
    - [x] a hit with any other weapon, however low the target, does not trigger it
  - Verification: check, test, check:legacy; deliberate breaks of the threshold, the comparison, the maximum and the follow-up
  - Result: a machete hit on a target at or below 30% of its OWN maximum health (float-safe, creative/spectator excluded, dead/no-health left alone) writes a huge damage to the hurt event; a tick later a target still alive is kill()ed, a target the hit killed is not; follow-up only if the game reported the hurt (killWithoutHurtEvent is the config fallback, off); a finishing blow is not mistaken for an ignored number; reset cancels waiting follow-ups. 1611 tests (+15), 45-break mutation run all caught.
  - Dependencies: Task 2
  - Files: `rae/src/logic/melee.ts`, `rae/src/core/melee.ts`, `rae/src/systems/melee.ts`, `rae/test/melee-machete.test.mjs`

- [ ] **Task 5: The baton's stun** (M)
  A baton hit has a 25% chance (an injected random in the logic) to stun the target for 10 ticks: slowness 255 on any target and, for a player, a movement lock as well. A stun cannot be
  refreshed while it is active, always ends (even if the target leaves or dies), and never releases a player the start sequence is holding.
  - Acceptance:
    - [ ] with the dice at 0 the stun applies; at 0.25 and above it does not; the rate over many seeded hits is about 25%
    - [ ] the stun lasts exactly 10 ticks and then the target can move again (a mob and a player), with both the effect and the lock undone
    - [ ] a second stun while one is active is ignored; a hit after it ends can stun again
    - [ ] a target that dies or leaves while stunned is left in no odd state; a round reset ends every stun
    - [ ] no stun is applied while a start is under way, and a stun's end does not unlock a player the start sequence holds
    - [ ] the baton's 3 damage is dealt as in Task 2; other weapons never stun
  - Verification: check, test, check:legacy; deliberate breaks
  - Dependencies: Task 2
  - Files: `rae/src/logic/melee.ts`, `rae/src/core/melee.ts`, `rae/src/systems/melee.ts`, `rae/test/melee-baton.test.mjs`

- [ ] **Task 6: The axe's cone and cooldown** (M)
  An axe swing hits every living thing within `reach` (3 blocks) whose direction from the player is within 90 degrees of where they look, except the wielder, for 6 damage
  each, each as its own hit; then a 1 second cooldown during which a swing does nothing (shown on the action bar). A hit and a swing in the same tick count once.
  - Acceptance:
    - [ ] the cone test: in front and to either side (within 90 degrees) hits; behind does not; exactly 90 degrees is decided one way and tested; out of reach does not
    - [ ] items on the ground, the wielder and anything that cannot be hurt are skipped
    - [ ] each target takes 6, none lost to the hit window (separate targets have separate windows)
    - [ ] during the cooldown the cone does nothing, a single-target hit is cancelled in the hurt hook (the game may ignore the cancel: logged), and the action bar says how long is left; after it, it works again
    - [ ] the cooldown is per player and a round reset clears it; two players with axes do not share one
    - [ ] a swing at the air still sweeps; an axe hit on a single target is not doubled by the cone
  - Verification: check, test, check:legacy; deliberate breaks of the angle, the reach and the cooldown
  - Dependencies: Task 2
  - Files: `rae/src/logic/melee.ts`, `rae/src/core/melee.ts`, `rae/src/systems/melee.ts`, `rae/test/melee-axe.test.mjs`

- [ ] **Task 7: The sledgehammer's blocks and cooldown** (L)
  A sledgehammer swing at a block from the configured list breaks it (`setblock ... destroy`, so it drops as when mined) once per 1.5 seconds; it never breaks a block a robbery has bound or
  protected, or one outside the list; it hits entities for 8 as in Task 2.
  - Acceptance:
    - [ ] a block on the list is broken and drops; one off the list is left alone
    - [ ] every block a robbery has bound (door, chest, switch, frame) and every protected one survives a swing, with the robbery running and not; an operator is held to the same
    - [ ] the cooldown: a second swing inside 1.5 seconds breaks nothing; after it, it does
    - [ ] a swing at an entity deals 8 and does not break the block behind it
    - [ ] nothing is broken in an unloaded chunk or across a dimension; the list is read from the config at the swing
    - [ ] the break runs after the event (never inside a restricted callback)
  - Verification: check, test, check:legacy; deliberate breaks of the list, the protection and the cooldown
  - Dependencies: Task 2
  - Files: `rae/src/logic/melee.ts`, `rae/src/core/melee.ts`, `rae/src/systems/melee.ts`, `rae/src/config/balance.ts`, `rae/test/melee-sledgehammer.test.mjs`

### Checkpoint 1: the weapons
- [ ] all green; every weapon's rule has a test and deliberate breaks of it; each fallback has a test

## Phase 2: Making it yours

- [ ] **Task 8: Live numbers, docs and the test card** (M)
  `core/configoverrides.ts` registers the melee numbers (the five damages, the bleed's stack cap, the stun chance and length, the axe's reach and cooldown, the sledgehammer's cooldown) in a
  group **Melee**, so the config editor and `/rae:config` change them live (and a changed damage also changes what the hook sets; the item component stays the shipped default). `docs/test-cards/MELEE.md`
  (numbered in-game steps for each weapon, with `rae:melee_debug on`; **"what only the real game can answer" first**, each answer naming the function to change). README and ARCHITECTURE.md rows
  (named here because the rules normally forbid editing them), and the sprites' credit beside the revolver's.
  - Acceptance:
    - [ ] each number is a registered setting with a range, changes the next hit, and resets to its default
    - [ ] the card has every step the owner needs, and says what is unmeasured and where each fix would go
    - [ ] README and ARCHITECTURE.md say where melee lives; the credit is there
  - Verification: check, test, check:legacy
  - Dependencies: Tasks 3 to 7
  - Files: `rae/src/core/configoverrides.ts`, `rae/test/melee-config.test.mjs`, `docs/test-cards/MELEE.md`, `README.md`, `ARCHITECTURE.md`

### Checkpoint: complete
- [ ] every acceptance box above is ticked
- [ ] the owner has run `docs/test-cards/MELEE.md` in the real game with `rae:melee_debug on`; what it shows is fixed in a follow-up round

- [ ] **Task 9: Release** (S; only when the owner asks)
  Both packs change (the sprites are an RP change): bump the BP in four places and the RP in its manifest (header and module), gate, clean build, `deploy.ps1` for the BP and `deploy-rp.ps1` for the RP **with the game
  fully closed**, byte-verify both, read the four worlds' pins for both as JSON, tell the owner to launch fresh. No push unless asked.
  - Dependencies: all of the above.
