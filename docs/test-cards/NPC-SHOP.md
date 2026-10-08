# NPC-SHOP test card: make a shop in game with a command, and buy from it

Phases N1, N2a and N2c of the NPC work (steps 1 to 21 are the shop, 22 to 28 the services and who may take a deal, 29 to 36 typed
teleports, shops by name and moving NPCs; the first 28 were run by the owner and worked). A shop is data
plus a screen: the NPC only carries a shop id, and a click opens a form where each deal is a button. You stock it by holding an
item and saying what it costs; no commands to type into the NPC editor, and a purchase is all or nothing (the coins and the goods
move together, or nothing does). `NPC-PROBE.md` has been run (2026-10-07): of
the two ways a click can reach the shop, the first works in the real game (the shop cancels the click and opens at once), so
step 1 here needs nothing. Most of this card is "does the real game agree with what the tests assumed".

- Behavior pack **0.2.1**, resource pack unchanged (1.0.27). BP only; a fresh launch is the safest way to be sure the new scripts
  are what you are running.
- Run it as an operator in your test world (RAE2), on flat ground. `/scoreboard objectives add coins dummy` first if the world
  has no `coins` objective: a deal that uses coins says so and refuses until it exists. Step 27 also needs `/scoreboard objectives add bounty dummy` if the world has none.
- The commands are all `/rae:shop_*`; type `/rae:shop_` and the game completes them: `list`, `info`, `new`, `sell`, `buy`, `trade`,
  `service`, `edit`, `open`, `select`, `copy`, `place`, `move`, `delete`, `undo`. Operators only. A shop is named by its id or by the
  name you gave it (any case, spaces or underscores).
- Problems go to the content log as `[shop]` lines and, if they are real failures, to every operator in chat.

`npm test` covers (the model, the store, every deal against a fake bag, every screen driven by a stand-in player, the commands under
a registry that enforces the real one's rules, the click routes in restricted execution, and 136 deliberate breaks of the rules that
move money, protect work or keep a customer from what they may not take, each caught by a test). None of that can say how the REAL game treats a click on an NPC, a potion, an
enchanted bow, a full bag or a form: that is this card.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Nothing to set: the probe showed the cancel works, so `shop.interceptClicks` stays on (its default). | If a click on a shop NPC ever shows the game's own NPC box, run `/rae:config_set_bool shop.interceptClicks false` and tell me. |
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
| 17 | Sneak and right-click an NPC as an operator. | The game's own screens open, not the shop: in the probe an edit-style screen came first and, after clicking in it, the NPC's own box. **Tell me what that first screen is** (fields for name, skin, commands?). |
| 18 | With a second account that is not an operator: open the shop and buy something; try `/rae:shop_list`; click the NPC holding the robbery wand. | The shop works for them. The command is refused ("operator"). The wand does nothing special: they get the shop. |
| 19 | Quit to the main menu and open the world again. | The shops and their NPCs are still there and still work. (If the NPC shows the game's ordinary box after the reload, the dialogue scene assignment did not survive: tell me.) |
| 20 | Make a plain NPC (`/summon npc`) and click it with the wand. | It offers to make it a shop. **Yes**, name it: it becomes one, and its editor opens. |
| 21 | `/rae:shop_new "Mule Dealer"` (with the quotes). | A shop called Mule Dealer with the id `mule_dealer`. (Does a quoted name keep its space?) |
| 22 | **An effect:** `/rae:shop_service`, **A potion EFFECT**: Effect `regeneration`, Level `3`, Seconds `10`, Coins `20`. Then buy it as a customer. | "Added: Regeneration 3 (10s) for 20 coins." After buying, 20 coins are gone and you have Regeneration III for about 10 seconds. (First time `addEffect` runs for real: is the level right, and is it 10 seconds and not 10 ticks?) |
| 23 | **A typo:** the same form with Effect `regen`, then `Jump Boost`. | `regen`: nothing is added and chat says the game does not know "regen" and lists the usual ones. `Jump Boost` (capitals and a space): added as Jump Boost. |
| 24 | **An enchantment:** `/rae:shop_service`, **An ENCHANTMENT**: `flame`, level 1, 100 coins. As a customer press it with an empty hand, then holding an iron sword, then holding a bow. | Empty hand: the button is greyed and pressing it says "Not yet: hold the item you want enchanted." Sword: "Flame 1 does not fit the iron sword you hold." Bow: it gains Flame I and 100 coins go; nothing else about the bow changes (name, other enchantments). |
| 25 | **An animal:** **A tame ANIMAL**: `horse`, 35 coins; buy it. Try `unicorn`, then add `cow` and press it. | A horse appears about two blocks in front of you, tame to you (it does not buck you off when you get on). `unicorn` is refused with "try horse, mule, donkey". The cow deal is accepted, but pressing it says something went wrong and nothing was charged, no cow is left standing, and the content log has a `[shop]` line saying a cow cannot be tamed. |
| 26 | **A teleport:** walk to a spot, `/rae:shop_service`, **A TELEPORT**, name it "Angeles", 25 coins. Walk away and buy it. Then do the same standing in the Nether. | You land where you stood when you made it; the button reads "Teleport to Angeles for 25 coins". The nether one takes you to the nether. |
| 27 | **Who can take a deal:** open Deals, pick a deal, **Who can take it**: Side **Law only**. Open the shop once after `/tag @s add law` and once after `/tag @s add outlaw` (wait a second after each: your side follows the tag). Then try **Outlaws only**, and a least bounty of 20: `/scoreboard players set @s bounty 5`, open the shop, then `... bounty 30`, open it again. | The deal reads "(law only)". The outlaw sees it greyed, and pressing it says "Not yet: only law players can do this." with nothing taken; a law player buys it normally. A bounty requirement says "you need a bounty of 20 (you have N)" until you have it. Set it to Anyone and 0: it is open to all again. |
| 28 | Quit to the main menu and open the world again. Look at the services and the law-only deal. | They are all still there with the same prices and conditions, and still work. |
| 29 | **A teleport you type:** stand well away from the shop's NPC. `/rae:shop_service`, **A TELEPORT**. Look at the boxes, then type X `5000`, Y `80`, Z `5000`, the name "Far Camp", coins 10. | The boxes started as your own position. "Added: Teleport to Far Camp for 10 coins." You did not need to be near the NPC at all. |
| 30 | Buy it from the shop. | You arrive at 5000, 80, 5000 (the game loads the place around you; if it is open sky you fall, which is correct). |
| 31 | **Change where it goes:** click the NPC with the wand, **Deals**, the teleport deal. | The deal's screen says "Goes to 5000, 80, 5000 in the overworld" and has **Change where it goes**; a deal that is not a teleport has neither. |
| 32 | Press **Change where it goes**: the boxes start as the current place. Set X to `100` and the Dimension to **The nether**, save, and buy it. Then stand somewhere new, press it again, turn on **Use where I am standing now instead**, save. Then try a word in X, and Y `6300`. | "It now goes to 100, 80, 5000 in the nether" and you land there. After the switch it goes where you stood. A word or Y 6300 says which box and why, and changes nothing. |
| 33 | **Shops by name:** `/rae:shop_info "mule dealer"` (any case), `/rae:shop_select Habiti`, `/rae:shop_copy Habiti "Second Stall"`. Try a start of a name: `/rae:shop_info Mul`. Make two shops whose names start the same and try the start. | Each finds the shop by its name. A start that fits one shop works; a start that fits two names both and asks for the id. `/rae:shop_delete Mul true` is refused (delete wants the whole name or the id). |
| 34 | **Move a nearby NPC:** stand in a different spot in the same town and run `/rae:shop_move Habiti`. | "Habiti's NPC is in front of you." The same NPC (its name above its head), no second one. |
| 35 | **Move one from far away:** make sure the NPC's place is known (stand near it and run `/rae:shop_list`, which says "NPC: at x, y, z"). Then go several hundred blocks away (`/tp @s ~600 ~ ~`), wait ten seconds, and run `/rae:shop_list` (it should say "not loaded, last at ..."), then `/rae:shop_move <name>`. | "Loading the area where X's NPC was last seen..." then "X's NPC came from x, y, z in the overworld and is in front of you." It is the same NPC and nothing is left behind at the old spot. **Tell me how long it took and whether it came.** |
| 36 | **Nothing gets duplicated:** `/rae:shop_move` with no name and pick a shop from the list. Then `/kill` a shop's NPC while you are near it, go away, and `/rae:shop_move` that shop; then `/rae:shop_place` it. | The list shows each shop with where its NPC is. Moving the killed one says "is not at ... any more" and makes nothing; `/rae:shop_place` then makes a new one. |

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
8. **The fetch (steps 35 and 36):** after "Loading the area...", does the NPC come, and how long does it take? Is anything left
   behind (a second NPC at the old spot, an NPC that cannot be clicked)? When it fails, what does it say? This is the first time a
   script-made ticking area is used to reach an entity, so the content log's `[shop]` lines matter here.
9. **Names above NPCs:** when does a name not show correctly (right after making one, after a rename, after a move, far away)?
10. Anything in the content log marked `[shop]`, `[forms]`, `[npc-probe]` or `[Scripting][error]`.

## Known limits (by design, for this phase)

- Coins and items, and services (an effect, an enchantment on the item in hand, a tame animal, a teleport) with law, outlaw and
  bounty conditions; no limits per player or restocking yet. Stock is unlimited.
- The builder's screens add one service per deal. The model and the engine already let one deal carry several (all or nothing), but
  there is no screen to combine them yet.
- A builder can add any animal the game knows; one that cannot be tamed (a cow) is refused when a customer tries it, with nothing
  charged.
- Deleting a shop removes only its NPCs that are loaded. One far away stays and says "That shop has closed." when clicked; bring it
  to you first (`/rae:shop_move`) and delete the shop after, or kill it by hand.
- An NPC placed before the game remembered places has no remembered place until someone clicks it, uses the wand on it, or runs
  `/rae:shop_list` near it; until then `/rae:shop_move` can only move it while it is loaded.
- A shop has no pages of dialogue yet (your 59-NPC guidebook is the model for them).
- A shop's NPC is a vanilla NPC with the default look; its skin is chosen in the game's own NPC screen (operator, sneak and click).
- The trade form asks for one kind of item (plus coins); the model allows up to three kinds.
- Nothing is pushed or deployed until you say so.
