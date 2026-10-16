# ENDINGS test card: ways out of the game, made in game

An ending is a way an outlaw gets out, and it is made in game now instead of being written into the code. Two kinds. A **group** ending: every outlaw still in play
gathers at its place and the gang pays a price **per member** between them; it ends the round as an outlaw win. A **solo** ending: one outlaw at its place with the
coins and/or the item it asks for leaves alone; the round goes on, and the others keep every option. A round ends when no outlaw is left in play: all escaped is the
outlaws' win; the rest jailed or eliminated (whoever escaped earlier) is the law's win, and the announcement says "N escaped, M captured" when anyone escaped. An ending
can have a camera pan (a **cinematic**) played after its announcement. Everything that does not depend on the real game is covered by the tests
(`test/endings-*.test.mjs`: 121 tests, and about 400 deliberate breaks of the code, each caught). What they cannot say is how the real game behaves: that is this card.

- **Deployed as behavior pack 0.2.9**. When it is deployed, quit the game completely and launch it fresh. The resource pack is unchanged.
- **Three accounts are best** (one law, two outlaws). Alone you can run steps 1 to 12.
- You edit it all from the RAE menu (`/give @s bountysys:game_menu`, right-click, **Endings**, which only operators see). There is no new command.
  Players try an ending with `/scriptevent rae:ending <id>` (an NPC's dialogue button or a command block runs the same line); `bounty:escape` still tries the boat.
- A world that has never saved an ending has **one: the boat**, built from the old boat settings. The first thing you save makes it a real record, so from then on
  editing it on the Endings screens is the only way (the four boat entries in `/rae:config` are gone).
- A problem goes to the content log as `[endings]` (a record that cannot be read), `[forms]` (a screen the game would not show) or `[cinematic]` (a camera or lock the
  game refused: it says which, once).

## What only the real game can answer (tell me what you SEE)

1. **Spectator for someone still in the round.** A solo escaper is put in spectator mode while the round goes on. Does that work for a player the game still counts
   as alive? Can they fly around and watch, and do they stay spectators until the next Start? (If not: `core/spectate.ts`.)
2. **The pan.** Does the camera appear at the start mark and drift smoothly to the end mark? Does it jump, start from your own view, or stutter? Is it where you
   marked it (the marks are your **eyes**, not your feet)? (`core/cinematic.ts`, the two calls of `playShot`.)
3. **Several players in a pan at once** (audience "every player"): does everyone see their own camera at the same moment? Can they still look around? Are they all
   given their view back at the end?
4. **Order of events at a group ending with a pan:** announcement first, then the pan, then the winners appear at the win spot. Is the announcement readable under the camera?
5. **Locked players during a pan:** can a mob hurt them? Can they still open the chat?
6. **A button in an NPC's dialogue running `rae:ending <id>`** (or a command block running `/scriptevent rae:ending <id>`): does it work for a player who is not an operator?
7. **The screens as screens:** do the text boxes show what was typed after a refusal (the title says "Not saved: ...")? Are the long messages readable? Does Preview close the menu
   so the screen is not over the camera?
8. **An existing world's boat:** open a world you played before this. Does `bounty:escape` (or the old NPC button) still work as it did, with the old price and place, before you touch anything?
9. **"N escaped, M captured":** does the line read right under the announcement, and are the numbers right in the rounds below?

## The editor (alone, as an operator)

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:game_menu`, right-click. | The menu has a **seventh button, Endings** (Start sequence is the sixth). An account that is not an operator sees five. |
| 2 | Press **Endings**. | A list: **Escape boat (group, on)**, **Add an ending**, Back, and "1 of 12 endings". |
| 3 | **Escape boat.** | A screen with its place, radius, "Price: N coins from each outlaw in the gang", and the win spot; buttons Turn it off, Name/radius/price, Messages, Cinematic, Move the place to where I stand, Set the win spot to where I stand, Delete, Back. |
| 4 | **Add an ending**: name `Sky tower`, type **Solo**. | It is saved at once, placed where you stand, and the next screen says so. It appears as **Sky tower (solo, on)**. |
| 5 | Add one with an **empty name**. | The box comes back with "Not saved: a name cannot be empty" in its title and the type you picked kept. Close it: nothing was saved. |
| 6 | **Sky tower**, **Name, radius and price**: price `-5`, then `abc`, then radius `0`. | Each comes back with the reason and what you typed. Then price `100`, radius `8`. Saved. |
| 7 | Hold something (an emerald), **Take the item from my hand**. | "It asks for N x minecraft:emerald". With an **empty hand** it says your hand is empty. Then **Name, radius and price** also shows **Item count** and a switch **the item is taken**. |
| 8 | Walk somewhere else, **Move the place to where I stand**, then **Set the win spot to where I stand** somewhere else again. | Both saved, each the middle of the block you stood on. **Clear the win spot** appears only now. |
| 9 | **Messages**: change the headline to `{player} FLEW AWAY!`. | Saved. `{coins}`, `{player}` and `{count}` are filled in when it is said. |
| 10 | **Turn it off**, then `/scriptevent rae:ending sky_tower` (as any player). | "That ending is switched off." Turn it on again. |
| 11 | **Delete** it, **Delete it**. Back at the list press **Bring back sky_tower**. | It is gone, then it is back exactly as it was. (**Undo my last change** on an ending's screen undoes its last edit.) |
| 12 | Quit to the main menu and rejoin; open Endings. | Everything you saved is still there. |

## A group ending (two outlaws and a law player)

Make a **group** ending `pier` for the place you will stand, price `100`, radius `10`, with a win spot, or just use the boat. Start a game (**Choose roles**: you and a friend outlaw, the third law).

| # | Do | Expect |
|---|---|---|
| 13 | As an outlaw: `/scriptevent rae:ending pier` while **not** near the place. | A line to everyone: the "gather" message. Nothing is taken. |
| 14 | Both outlaws at the place, with **less** than 100 each combined. | "The gang needs 200 coins to escape" and "Combined money: N". Nothing is taken. |
| 15 | Give them 100 each (`/scoreboard players set @s coins 100`) and try again. | The headline and detail are announced, the coins are taken (100 each, or from whoever has them, in order), the round ends as an **outlaw win**, and the winners are taken to the win spot. |
| 16 | As the **law** player: `/scriptevent rae:ending pier`. | "Only outlaws can escape." |
| 17 | Try again after the round ended. | "No round is running." |

## A solo ending

Make a **solo** ending `tower` (price 100) somewhere away from the pier, with a win spot. Start a game with two outlaws and a law player.

| # | Do | Expect |
|---|---|---|
| 18 | Outlaw A far from the tower: `/scriptevent rae:ending tower`. | Only A is told the "gather" message. |
| 19 | A at the tower with 10 coins. | "You need 100 coins to escape (you have 10)." |
| 20 | A at the tower with 100. | Announced to everyone in the ending's words. A pays 100, is taken to the win spot, becomes a **spectator**, and is a winner. **The round goes on.** |
| 21 | A: `/scriptevent rae:ending tower` again. | "You have already escaped." |
| 22 | Outlaw B (still playing) uses the pier / boat. | B alone is the gang: it needs only B at the place and B's price. The round ends as an outlaw win. The announcement ends with "**2 escaped, 0 captured**". |
| 23 | New game, A escapes through the tower, then the law jails B. | With nobody free but a prisoner, the round ends as the **law's** win, and the announcement ends with "**1 escaped, 1 captured**". |
| 24 | New game with two outlaws; both escape through the tower. | After the second: "EVERY OUTLAW HAS ESCAPED!" ... "2 escaped, 0 captured." The outlaws win. |
| 25 | Give the tower an **item** (not coins: price `0`, an emerald x 2, taken) and escape with 1 emerald, then 2. | "You need 2 of emerald to escape (you have 1)", then it works and the 2 are taken. With the switch off, they are only checked. |

## The cinematic

Make the tower's pan: **Tower, Cinematic, Mark the start of the pan here**, walk somewhere with a view, look at something, **Mark the end here**. Default 8 seconds, for the winners.

| # | Do | Expect |
|---|---|---|
| 26 | **Preview.** | The menu closes, you cannot move, the camera pans start to end over 8 seconds and hands your view back. While a game is starting it refuses. |
| 27 | **Length and audience**: `3`, the switch **on** (every player). Start a game with two outlaws and escape through the tower. | The announcement, then **everyone's** camera pans for 3 seconds, locked; then the escaper appears at the win spot. The round was already ended or going on in the background: it does not wait. |
| 28 | The same with the switch **off**. | Only the escaper sees the pan. |
| 29 | A group ending with a pan (the pier). | The announcement, the pan, **then** the winners are at the win spot. |
| 30 | Start the pan and **reset the game** from the menu in the middle. | Everyone can move at once with their own view, and nobody is taken to a win spot. |
| 31 | Start the pan and **quit to the main menu**, then rejoin. | When the world loads nobody is left locked or in a camera. |
| 32 | **Remove the cinematic**, escape again. | No camera, no lock, no pause: the escaper is at the win spot at once. |

## Telemetry (optional)

In the content log: a group ending that ended a round writes `"k":"round.end"` with `"ending":"pier"`, and each solo escape writes `"k":"ending.escape"` with the ending id, who
(`p`), the coins and, when one was taken, the `item` and `count`. `node tools/telemetry/cli.mjs` reads them as before.

## Must not appear

An `[endings]` or `[cinematic]` line in the content log you did not cause (copy it to me), any `[Scripting][error]` line, a player who cannot move after a pan is over, or
a round that does not end when the last outlaw is out.

## If something is wrong, where the fix goes

| Symptom | File |
|---|---|
| A spectator escaper can still be hurt or seen wrongly | `core/spectate.ts` |
| The pan jumps, or a second pan ends early | `core/cinematic.ts` (`playShot`), `core/startsequence.ts` (`playPan`) |
| The wrong people are in the pan, or the order of announcement / pan / teleport is wrong | `core/endings.ts` (`celebrate`) |
| A refusal reads wrong | `core/endings.ts` (the messages), `config/balance.ts` (`ENDINGS.texts`) |
| A screen is awkward | `core/endingforms.ts` |
| The "N escaped, M captured" line | `core/endings.ts` (`announceTally`) |
| An old world's boat differs from before | `core/endingstore.ts` (`defaultBoat`) |
