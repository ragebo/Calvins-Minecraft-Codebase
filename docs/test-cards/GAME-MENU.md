# GAME-MENU test card: an in-game menu instead of the physical button

Not an ARCH task: added on request. The round used to start from a button (a command block running `/scriptevent bounty:start_round`) and reset from a typed `/scriptevent rae:reset`. Now an item opens a menu to **start a game** (random roles, or roles you pick per player), **reset it**, **teleport to key places**, and **send everyone to their spawns**.

- The item is `bountysys:game_menu` ("RAE Menu", a gold sheriff star): `/give @s bountysys:game_menu`, then right-click. `/scriptevent rae:menu` opens the same menu with no item, but it needs a player, so a command block cannot run it.
- **Anyone holding the item can use every control.** There is no permission check (your choice).
- The old script events (`bounty:start_round`, `rae:reset`, `bounty:teleport`) are unchanged, so the physical button keeps working.
- The game's actions moved from `systems/roles.ts` to `core/game.ts` so the menu and the events share them. The rules are the same.

Packs: behavior pack **0.1.17** and resource pack **1.0.20** (the icon). The resource pack needs Minecraft **closed** to deploy, then a fresh launch.

`npm test` drives the menu through fake forms: what each button does, the confirmations, cancelling, a player who leaves mid-form, a form the game refuses as busy, two right-clicks at once, and that every teleport target has a distinct name and real coordinates. It cannot say what the forms look like, whether the game shows one straight after a right-click, or whether a teleport target is solid ground. Those are this card.

## Steps

Two players are best (steps 6 to 9); one is enough for the rest. You need op rights for `/give` and `/scriptevent`.

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:game_menu`. Look at the inventory. | A gold star on a dark outline, named "RAE Menu". |
| 2 | Right-click with it. | A form titled "RAE Game Menu" with four buttons: Start game, Reset game, Teleport, Send everyone to their spawns. It opens on the first click, not the second. |
| 3 | Right-click twice fast. Close it. Right-click again. | One menu, not two stacked. It opens again after closing. |
| 4 | Put the item away. `/scriptevent rae:menu`. | The same menu. |
| 5 | Teleport, then each place in the list, one at a time (open the menu again for each). | You are moved, chat says "Teleported to <name>." **Check you land on solid ground, not in a wall or in the air.** The train, vault and boat spots are the ones most likely to be off. |
| 6 | Start game, Random roles. Read the confirmation, press "Start the game". | Everyone gets a role (with two players: one law, one outlaw), is sent to a spawn for it, sees "Rolling..." and three seconds later LAWMAN or OUTLAW. Chat says "Roles Assigned!". You are told "Game started with random roles." |
| 7 | Start game, Random roles, then press "Cancel" on the confirmation. Repeat and close the form with Esc instead. | Nothing changes. |
| 8 | Start game, Choose roles. | One dropdown per player, each starting on their current role (Outlaw if none). Pick Law for one, Outlaw for the other and press "Start the game". They get exactly those roles. |
| 9 | Choose roles again, and set one player to "Sit out". | That player gets no role, is not moved and sees no title. The rest start as picked. |
| 10 | Choose roles, set everyone to "Sit out". | Refused: "Nobody is playing...". Nothing was reset. |
| 11 | Alone: Choose roles with only yourself as Law. | It starts, with "Nobody is an outlaw." as a warning. |
| 12 | Send everyone to their spawns. | Players with a role go to a spawn for it. A player who sat out stays put. |
| 13 | Reset game, press "Cancel". Then Reset game, "Reset the game". | Cancel changes nothing. Reset clears roles and chat says "All systems reset." |
| 14 | Press the old physical button (or `/scriptevent bounty:start_round`). | It still starts a random game. |
| 15 | Have a second player leave while you have the role dropdowns open, then press Start. | It starts for the players still there, with no error. |

## What to tell me

1. Does the menu open on the first right-click, or do you have to click again? (If it is the second, the busy retry is not enough.)
2. Which teleport places put you somewhere wrong (inside a block, in the air, in the wrong spot)? Their names are in the list.
3. Do the dropdowns show the right default role?
4. Does the icon look right in the inventory and in the hand?
5. Anything odd: a stuck form, a second copy on top of the first, chat errors.

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. Must not appear: `[Scripting][error]` lines, an item error naming `game_menu`, or a texture error naming `game_menu`. A `[forms] showing a form failed` warning is reported once per distinct error and means a form did not show.
