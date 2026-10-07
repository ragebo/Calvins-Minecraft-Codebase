# NPC-SHOP test card: make a shop in game with a command, and buy from it

Phases N1 and N2a of the NPC work (steps 1 to 21 are the shop, 22 to 28 the services and who may take a deal). A shop is data
plus a screen: the NPC only carries a shop id, and a click opens a form where each deal is a button. You stock it by holding an
item and saying what it costs; no commands to type into the NPC editor, and a purchase is all or nothing (the coins and the goods
move together, or nothing does). Run `NPC-PROBE.md` first: it tells you which of the two
ways a click reaches the shop works in the real game, and step 1 here applies the answer. Most of this card is "does the real game
agree with what the tests assumed".

- Behavior pack **0.2.0**, resource pack unchanged (1.0.27). BP only; a fresh launch is the safest way to be sure the new scripts
  are what you are running.
- Run it as an operator in your test world (RAE2), on flat ground. `/scoreboard objectives add coins dummy` first if the world
  has no `coins` objective: a deal that uses coins says so and refuses until it exists.
- The commands are all `/rae:shop_*`; type `/rae:shop_` and the game completes them: `list`, `info`, `new`, `sell`, `buy`, `trade`,
  `service`, `edit`, `open`, `select`, `copy`, `place`, `delete`, `undo`. Operators only.
- Problems go to the content log as `[shop]` lines and, if they are real failures, to every operator in chat.

`npm test` covers (the model, the store, every deal against a fake bag, every screen driven by a stand-in player, the commands under
a registry that enforces the real one's rules, the click routes in restricted execution, and 79 deliberate breaks of the rules that
move money, protect work or keep a customer from what they may not take, each caught by a test). None of that can say how the REAL game treats a click on an NPC, a potion, an
enchanted bow, a full bag or a form: that is this card.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Set the click route from the probe: if the game's own NPC box still opened in probe step 5, run `/rae:config_set_bool shop.interceptClicks false`; otherwise leave it. | The command says it changed the setting. |
| 2 | `/rae:shop_new Habiti` | An NPC appears in front of you, facing you, named Habiti above its head. Chat says it is in front of you and how to stock it. `/rae:shop_list` shows `habiti: Habiti, no deals yet, 1 NPC`. |
| 3 | Hold an iron sword: `/rae:shop_sell 60`. Hold 6 arrows: `/rae:shop_sell 15`. Hold 3 feathers: `/rae:shop_buy 8`. | Each answers "Added to Habiti: ..." with the deal in words: "Iron Sword for 60 coins", "Arrow x6 for 15 coins", "Sell Feather x3 for 8 coins". |
| 4 | Put 9 gold ingots in your bag, hold a diamond, run `/rae:shop_trade`, choose Gold Ingot, how many 3, extra coins 10. | "Added: Diamond for Gold Ingot x3 + 10 coins." `/rae:shop_info` lists all four deals. |
| 5 | `/scoreboard players set @s coins 100`, put the items away, then right-click Habiti (empty hand, standing). | The shop opens: the greeting line (none yet), "You have 100 coins.", four deal buttons and Close. (If the game's own NPC box ALSO opened, the click route in step 1 is wrong: say so.) |
| 6 | Press **Iron Sword for 60 coins**. | The screen stays open with "Bought Iron Sword for 60 coins." and "You have 40 coins."; a sword is in your bag; a soft ping. |
| 7 | Press the sword again. | "Not yet: you need 60 coins (you have 40)."; nothing taken; a low note. The button is greyed once you cannot afford it. |
| 8 | Press **Arrow x6 for 15 coins**. | 15 coins gone, 6 arrows arrive. |
| 9 | Hand over feathers: with 2 feathers press **Sell Feather x3**, then with 3 or more. | With 2: "Not yet: you need Feather x3 (you have 2)." With 3: they leave your bag and 8 coins arrive. |
| 10 | Trade: with 3 gold and 10 coins press **Diamond for Gold Ingot x3 + 10 coins**. | The gold and the coins go, a diamond comes. |
| 11 | **A full bag:** fill every slot with stone and buy something. | The item drops at your feet (as `/give` does), the coins are still taken, and the screen says the bag was full. |
| 12 | **Real items:** hold a splash potion of swiftness and run `/rae:shop_sell 25`; hold a named, enchanted bow (flame) and `/rae:shop_sell 100`. Open the shop as a customer and buy both. | You get the same potion (splash, swiftness) and a bow with the same name and the flame enchantment. (This is the first time the game's `Potions.resolve` and enchantment calls run for real.) |
| 13 | **The wand:** `/rae:robbery_wand`, then click Habiti with it. | The builder's screen opens (the deals, a Close button), not the customer's. **Tell me if the game's own NPC box also opens.** |
| 14 | In it: **Greeting** (type "Howdy, stranger."), **Rename** (to "Habiti the Horseman"), **Deals**, pick the sword, **Change the price** to 75, **Move down**, **Remove** one with the confirmation. | Each says what it did. The NPC's name above its head follows the rename. A customer sees the greeting above the purse. |
| 15 | Walk away, then **Bring its NPC here**. Then **Copy this shop to a new NPC here** ("Second Stall"). | The NPC walks to you; a second NPC appears with the same deals, named Second Stall. |
| 16 | **Undo the last change** (it appears once something changed). Then **Delete this shop** (confirm). | The change goes back. The shop and its NPC disappear; `/rae:shop_undo habiti` brings the shop back, and `/rae:shop_place habiti` puts its NPC out again. |
| 17 | Sneak and right-click an NPC as an operator. | The game's own NPC screen opens (with its editor), not the shop. |
| 18 | With a second account that is not an operator: open the shop and buy something; try `/rae:shop_list`; click the NPC holding the robbery wand. | The shop works for them. The command is refused ("operator"). The wand does nothing special: they get the shop. |
| 19 | Quit to the main menu and open the world again. | The shops and their NPCs are still there and still work. (If the NPC shows the game's ordinary box after the reload, the dialogue scene assignment did not survive: tell me.) |
| 20 | Make a plain NPC (`/summon npc`) and click it with the wand. | It offers to make it a shop. **Yes**, name it: it becomes one, and its editor opens. |
| 21 | `/rae:shop_new "Mule Dealer"` (with the quotes). | A shop called Mule Dealer with the id `mule_dealer`. (Does a quoted name keep its space?) |
| 22 | **An effect:** `/rae:shop_service`, **A potion EFFECT**: Effect `regeneration`, Level `3`, Seconds `10`, Coins `20`. Then buy it as a customer. | "Added: Regeneration 3 (10s) for 20 coins." After buying, 20 coins are gone and you have Regeneration III for about 10 seconds. (First time `addEffect` runs for real: is the level right, and is it 10 seconds and not 10 ticks?) |
| 23 | **A typo:** the same form with Effect `regen`, then `Jump Boost`. | `regen`: nothing is added and chat says the game does not know "regen" and lists the usual ones. `Jump Boost` (capitals and a space): added as Jump Boost. |
| 24 | **An enchantment:** `/rae:shop_service`, **An ENCHANTMENT**: `flame`, level 1, 100 coins. As a customer press it with an empty hand, then holding an iron sword, then holding a bow. | Empty hand: the button is greyed and pressing it says "Not yet: hold the item you want enchanted." Sword: "Flame 1 does not fit the iron sword you hold." Bow: it gains Flame I and 100 coins go; nothing else about the bow changes (name, other enchantments). |
| 25 | **An animal:** **A tame ANIMAL**: `horse`, 35 coins; buy it. Try `unicorn`, then add `cow` and press it. | A horse appears about two blocks in front of you, tame to you (it does not buck you off when you get on). `unicorn` is refused with "try horse, mule, donkey". The cow deal is accepted, but pressing it says something went wrong and nothing was charged, no cow is left standing, and the content log has a `[shop]` line saying a cow cannot be tamed. |
| 26 | **A teleport:** walk to a spot, `/rae:shop_service`, **A TELEPORT**, name it "Angeles", 25 coins. Walk away and buy it. Then do the same standing in the Nether. | You land where you stood when you made it; the button reads "Teleport to Angeles for 25 coins". The nether one takes you to the nether. |
| 27 | **Who can take a deal:** open Deals, pick a deal, **Who can take it**: Side **Law only**. Open the shop as a law player and as an outlaw. Then try **Outlaws only**, and a least bounty of 20 (set your bounty below and above it). | The deal reads "(law only)". The outlaw sees it greyed, and pressing it says "Not yet: only law players can do this." with nothing taken; a law player buys it normally. A bounty requirement says "you need a bounty of 20 (you have N)" until you have it. Set it to Anyone and 0: it is open to all again. |
| 28 | Quit to the main menu and open the world again. Look at the services and the law-only deal. | They are all still there with the same prices and conditions, and still work. |

## What only the real game can answer (tell me what you SEE)

1. **The click:** one screen or two? Does the game's own NPC box appear with the shop (step 5) or the wand's screen (step 13)? Does a click
   ever open the shop twice?
2. **The NPC:** does it appear facing you, with its name above its head? Does it keep its skin and name across a relaunch? Can a player
   hurt or push it?
3. **The screen:** is the shop form readable (long deal names, greyed buttons, the purse line)? Does it come up straight after the click
   or only after a moment (a "busy" retry)?
4. **Items:** does a potion come out as the same potion, an enchanted named bow as the same bow, in a full bag at your feet?
5. **Commands:** does autocomplete offer every `/rae:shop_` command? Does `shop_sell` take the whole stack you hold? Does a quoted
   name keep its space?
6. **The coins:** is a purchase exactly the price, a sale exactly the payout, and does a refused deal move nothing at all?
7. **The services:** is an effect the strength and length the deal says? Does the game say Flame does not fit a sword (and not throw)?
   Is the horse tame, and not inside you? Does a teleport land where the builder stood, in the right dimension? Do the effect,
   enchantment and animal names work typed bare (`flame`, `horse`) or does the game want `minecraft:`? (The code tries both; tell me
   if either lookup ever failed.)
8. Anything in the content log marked `[shop]`, `[forms]`, `[npc-probe]` or `[Scripting][error]`.

## Known limits (by design, for this phase)

- Coins and items, and services (an effect, an enchantment on the item in hand, a tame animal, a teleport) with law, outlaw and
  bounty conditions; no limits per player or restocking yet. Stock is unlimited.
- The builder's screens add one service per deal. The model and the engine already let one deal carry several (all or nothing), but
  there is no screen to combine them yet.
- A builder can add any animal the game knows; one that cannot be tamed (a cow) is refused when a customer tries it, with nothing
  charged. A teleport goes to the spot the builder stood on, not to typed coordinates.
- A shop has no pages of dialogue yet (your 59-NPC guidebook is the model for them).
- A shop's NPC is a vanilla NPC with the default look; its skin is chosen in the game's own NPC screen (operator, sneak and click).
- The trade form asks for one kind of item (plus coins); the model allows up to three kinds.
- Nothing is pushed or deployed until you say so.
