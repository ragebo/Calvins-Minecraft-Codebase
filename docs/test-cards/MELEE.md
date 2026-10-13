# MELEE test card: five melee weapons (knife, machete, baton, axe, sledgehammer)

What the weapons are meant to do (the owner's specs, damage in health points, 2 is one heart):

| Weapon | Damage | What else |
|---|---|---|
| **Knife** | 2 | Every hit adds a **bleed**: 1 damage a second later and 1 more a second after that. Bleeds stack (up to 10 on one target). |
| **Machete** | 4 | A target at **30% of its own maximum health or less** (three hearts of twenty) dies on the hit, whatever its armor or effects. |
| **Baton** | 3 | **25%** of hits **stun** for half a second (10 ticks). |
| **Axe** | 6 | Hits **everything alive within 3 blocks in the half circle in front of you**, each for 6, then a **1 second cooldown**. |
| **Sledgehammer** | 8 | A swing at a block from a list (**wood, glass, hay**) **breaks it** (it drops), once per **1.5 seconds**. Never breaks anything a robbery has bound. |

Everything that does not depend on the real game is covered by the tests (`test/melee-*.test.mjs`: about 130 tests, and about 360 deliberate breaks of the
rules, each caught). **What the tests cannot say is how the real game answers the questions below**: the code was built on the typings and carries a fallback
and a log line for each, so a wrong guess costs a line of code, not a rebuild. This card is the measurement.

- **Built, not deployed yet.** The release is a separate step because the sprites are a resource-pack change: the game has to be **quit completely** and
  launched fresh (Behavior packs are read per world, resource packs only at launch). Until it is deployed none of this is in the game.
- Items: `/give @s bountysys:knife`, `bountysys:machete`, `bountysys:baton`, `bountysys:axe`, `bountysys:sledgehammer` (also in the creative inventory,
  Equipment tab). **They work at any time, not only in a round.**
- **Turn the log on first: `/scriptevent rae:melee_debug on`**, and watch the content log. It writes one `[melee]` line for each step (examples below). `off` stops it.
  Whatever the weapons could not do because the engine refused is reported to the log as `[melee] <what> failed: <why>`, once, with the debug off too.
- Two accounts are best (one to hit, one to be hit, one of them an operator). Alone you can do everything but the player-versus-player steps (marked **PvP**).
- To be hit: `/summon cow` (10 health), `/summon zombie` (20), `/summon iron_golem` (100: for counting), `/summon armor_stand`.

## What only the real game can answer (tell me what you SEE and what the log says)

Each answer says which line to change if it is "no".

1. **Does the game use the damage the script writes into the hurt event?** Hit a cow with the baton (step 5) and read the log: `[melee] knife hit: set 2, dealt 2`
   is a yes. A warning `[melee] the knife was set to 2 but the game dealt 1` says the number was ignored (or an armored target, see 2). *If no:* the item's own
   `minecraft:damage` (same number, on each item file) is the other path; if that is ignored too, base damage stays the game's and the hook in `systems/melee.ts`
   (`listen("the hurt event", ...)`) has to become a top-up in the after event.
2. **Is that number before or after armor?** Put on iron armor (or have a friend, **PvP**) and hit: does `dealt` equal `set`, or less? *Nothing to change either
   way:* it tells us how to read the other answers.
3. **Does `cancel` stop a hit?** Axe, step 26: a click inside the cooldown should do nothing. A warning `[melee] the game reported a hurt for a hit that was
   cancelled` says the cancel was ignored. *If so:* `core/melee.ts` `axeHit`: set the hit's damage to 0 instead of cancelling it.
4. **Does a script's `applyDamage` get announced as a hurt?** Axe, step 29: with the log on, do the swept cows each write a `axe hit: set 6, dealt N` line (yes)
   or only the cow in front (no)? *Either is handled;* the answer decides whether `core/melee.ts` `ownSweep` is ever consumed.
5. **Does the bleed's "override" damage ignore armor, ignore the hit window, and give the kill to the knife's wielder?** Knife, steps 8 to 11: does a bleed
   hurt armored players the same? Do three quick hits really make 3 a second (the log's `bleed: 3 to ...`)? When a bleed kills a cow, does the kill message,
   the loot and the experience behave like a normal kill? *If not:* `core/melee.ts` `stepBleeds` (the `cause`).
6. **Does Resistance stop the machete, and is the follow-up needed?** Machete, step 15: a cow with Resistance 4 at three hearts. Which line does
   the log write: `the hit itself killed it` (the huge number did it) or `... so kill() finished it` (the follow-up did), or `no hurt event came ... nothing is
   killed` (**this one means the game sent no hurt event for a fully absorbed hit, and the cow lived**)? *If the last:* set `MELEE.machete.killWithoutHurtEvent`
   to `true` in `config/balance.ts`.
7. **Does `kill()` credit the killer, drop loot, and show in chat?** Same steps: when the follow-up kills a cow, is it a normal kill?
8. **Do slowness 255 and the movement lock stop a mob and a player?** Baton, steps 18 and 19. A stunned zombie should freeze for half a second; a stunned player
   should be unable to move, jump or sneak (they can still look and, we think, still attack). *If a player still moves:* `core/melee.ts` `stun`.
9. **What does the game send for the swing, and in what order?** Axe, steps 23 and 30: a left-click on **air**, on a **mob**, and on a **block**. The log's
   `axe: ...` lines say whether the sweep began from the hit or from the swing, and whether any click was counted twice. Sledgehammer, step 33: does a left-click on a
   block send a swing event at all? (If the sledgehammer never breaks anything, this is why.) *If no:* `systems/melee.ts` `listen("swings", ...)`: add another
   event for blocks (`playerStartBreakingBlock` or `entityHitBlock`); `MELEE.axe.swingDelayTicks` is the "a tick later" the axe waits for the hit.
10. **Does `setblock ... air destroy` drop the block's items?** Sledgehammer, step 33: planks and doors should drop themselves (glass, like in vanilla, drops
    nothing). *If nothing drops:* `core/melee.ts` `hammerSwung` (the command).
11. **Do the axe's sweep hits knock the targets back and flash them red like a normal hit?** The target in front is hit by the game itself and does; the others
    are hit by the script. *If not:* nothing to fix in the rules; tell me and we decide.
12. **The sprites and the way each is held.** Knife (wooden-sword shape), machete, baton, axe, sledgehammer in the inventory, the hotbar and the hand. Do any look
    wrong, flipped, or too big in the hand? (Resource pack: needs the fresh launch.)

## The items and the log (alone)

| # | Do | Expect |
|---|---|---|
| 1 | Quit the game completely, launch it, open the world. `/give @s bountysys:knife` and the other four. | Five items, each with its own picture, stack size 1. They can be found in the creative inventory under Equipment. |
| 2 | Hold each in turn. | Held like a tool. No use animation: a left-click swings it every time. |
| 3 | `/scriptevent rae:melee_debug on`. | "Melee logging on" in chat. `/scriptevent rae:melee_debug maybe` says how to use it and changes nothing. |
| 4 | `/summon cow` twice, `/summon iron_golem` once. | Targets. |

## Base damage

| # | Do | Expect |
|---|---|---|
| 5 | Punch a cow with an empty hand, then hit it with the **baton** (3) and the **sledgehammer** (8). | The empty hand is 1, the baton 3, the sledgehammer 8: the log writes `baton hit: set 3, dealt 3` and `sledgehammer hit: set 8, dealt 8`. A new cow dies in two sledgehammer hits (10 health). |
| 6 | (**PvP**) Hit a friend in iron armor with the sledgehammer, with the log on. | The log says what was set and what was dealt. Tell me both numbers (question 2). |

## Knife

| # | Do | Expect |
|---|---|---|
| 7 | Hit the iron golem once with the knife. | 2 damage (`knife hit: set 2, dealt 2`). One second later 1 more, a second after that 1 more: the log writes `bleed: 1 to minecraft:iron_golem from 1 stack(s)` twice, a second apart. |
| 8 | Hit the golem three times as fast as you can. | The log shows `bleed: 3 ... from 3 stack(s)` a second later and again a second after: three stacks, one hit a second (not three separate 1s). |
| 9 | Hit the golem ten times, then more. | Never more than 10 stacks (`bleed: 10 ...`). |
| 10 | Hit a cow once and let the bleed finish. Then hit a cow and kill it with the sledgehammer while it bleeds. | The bleed stops when the cow dies (no more lines). |
| 11 | Question 5: let a bleed kill a cow (hit it, step back). **(PvP)** Hit a friend in armor. | Does the cow drop loot and experience? Does the friend lose the same 1 a second through armor? |

## Machete

| # | Do | Expect |
|---|---|---|
| 12 | Hit a full-health cow once with the machete. | 4 damage (`machete hit: set 4, dealt 4`); it lives (10 health). |
| 13 | `/damage @e[type=cow,c=1] 7` (the nearest cow is left at 3 of 10, exactly 30%), then hit it. | It dies in one hit: `machete: finishing blow on minecraft:cow at 3 of 10 health`, then `finish: the hit itself killed it`. |
| 14 | A cow at 4 of 10 (`/damage ... 6`), hit it. | Not finished: 4 damage, it lives (it is above 30%). |
| 15 | A cow at 3 with Resistance: `/effect @e[type=cow,c=1] resistance 30 4 true`, then hit it. | Question 6. Which log line? Does the cow die? |
| 16 | The iron golem at 30 of 100 (`/damage ... 70`), hit it. | The threshold is of the **target's own** maximum: it dies at 30, not at 6. |
| 17 | (**PvP**) Get a friend to 6 of 20 health (`/damage`), hit them; then a friend in **creative** at 6. | The survival friend dies. The creative one does not. |

## Baton

| # | Do | Expect |
|---|---|---|
| 18 | Hit the iron golem with the baton about twenty times. | Roughly one hit in four writes `stun: minecraft:iron_golem stunned for 10 ticks`; the golem freezes for half a second each time. |
| 19 | (**PvP**) Hit a friend with the baton until one stuns. | The friend cannot move, jump or sneak for half a second, then can (question 8). Do they still look around? Can they attack? |
| 20 | Hit a stunned target again during the stun. | `stun: ... is already stunned, not refreshed`. The stun ends on time. |
| 21 | Start a game (Menu, Start game) and hit someone with the baton during the camera intro. | No stun while a game is starting (`stun: ignored ... a game is starting`), and the intro's own lock is not undone. |

## Axe

| # | Do | Expect |
|---|---|---|
| 22 | Put three cows in a row in front of you (within 3 blocks) and one behind you. Hit the front cow with the axe. | The front cow takes 6 from the game itself; the other two in front take 6 each from the sweep (`axe: swept 2`); the one behind is untouched. |
| 23 | Wait a second and swing at the **air** with cows in front. | They are all hit (`axe: swept N`). |
| 24 | Cows exactly to your left and right, at your side. | Hit (the half circle includes the sides). One a block behind your shoulder: not hit. |
| 25 | Swing again inside the second. | Nothing happens; the action bar says "Axe ready in 0.x s". |
| 26 | Hit a single cow with a click inside the cooldown. | Cancelled: it takes nothing. If it still takes damage, a warning says the cancel was ignored (question 3). |
| 27 | Swing with a cow standing 4 blocks away in front of you. | Out of reach: nothing happens to it (the swing still starts the cooldown). |
| 28 | Two players with axes swing together. | Each has their own cooldown. |
| 29 | Question 4: read the log lines for a sweep of three cows. | Does each swept cow write a `axe hit: set 6, dealt N`? |
| 30 | Question 9: swing at the air, then at a cow, then at a block. | Which `axe:` lines appear for each, and is any click counted twice (two sweeps)? |
| 31 | Question 11: do the swept cows get knocked back and flash red? | Tell me. |

## Sledgehammer

| # | Do | Expect |
|---|---|---|
| 32 | Build a wall of oak planks, glass panes, a fence, a wooden door, a hay bale, and next to them stone, an iron door and a chest. | |
| 33 | Swing the sledgehammer at the planks. | The block breaks and drops itself (question 10). `sledgehammer: broke minecraft:oak_planks at x y z`. |
| 34 | Swing again at once at the glass. | Nothing; the action bar says "Sledgehammer ready in 1.x s". After 1.5 seconds it breaks. |
| 35 | Swing at stone, the iron door, the chest, a block of any other kind. | Nothing breaks, no cooldown is spent (the next swing at wood works at once). |
| 36 | Put a cow right in front of a glass pane (between you and it) and swing at the cow. | The cow takes 8 and the glass stays (`something living is nearer than the block`). Then put the cow *behind* the pane and swing at the glass: the pane breaks. |
| 37 | (as an **adventure** mode player) Swing at planks. | Nothing: adventure players may not break blocks. |
| 38 | Build a robbery with a vault door on a **wooden door** (see ROBBERY-VAULT.md), then swing at that door, its lockbox and its keypad. | None of them breaks, whether or not the robbery is running, and for an operator too (`belongs to a robbery, so it is kept`). A block next to them still breaks. |

## The numbers and the reset

| # | Do | Expect |
|---|---|---|
| 39 | `/rae:config`, group **Melee**: eleven settings. Set **melee.knifeDamage** to 5 and hit a cow. | The log says `set 5`. Reset it: back to 2. The sledgehammer's list of blocks is not in the editor: it is in `config/balance.ts`. |
| 40 | Set **melee.axeCooldownTicks** to 0, **melee.stunChance** to 1, **melee.bleedMaxStacks** to 3. | The axe swings with no wait, every baton hit stuns, and a knife stacks at most 3. Reset all three. |
| 41 | Get a bleed running and a baton stun on a target, then Menu, Reset game. | Bleeds and stuns end at once, a stunned player can move, and every cooldown is back. |

## Afterwards

Send me the content log lines with `[melee]` in them, and which of the twelve questions came out "no". Each is a line or two of code: the weapons were built so that a wrong
guess costs that, not a rebuild.
