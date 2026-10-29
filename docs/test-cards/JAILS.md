# JAILS test card: add jails in game, and start the lockpick with a button

Jails used to be two places written into the code, and the lockpick could only be started by a command block running `/scriptevent bounty:lockpick`. Now an operator makes jails on a screen, each with a spot where prisoners are put, an
optional **door trigger** (the block where a redstone block is placed when the jailbreak succeeds) and up to eight **buttons**: any block, right-clicked by an outlaw to start the lockpick for that jail. Everything that does not depend on the real
game is covered by the tests (`test/jails-*.test.mjs`: about 120 tests, and deliberate breaks of the code, each caught). What they cannot say is how the real game behaves: that is this card.

- **Not deployed yet when this was written** (the live pack was 0.2.11). When it is, quit the game completely and launch it fresh.
- **Three accounts are best**: you as an operator, one law and two outlaws (a second account or friends). Alone you can run steps 1 to 14.
- You edit it all from the RAE menu (`/give @s bountysys:game_menu`, right-click, **Jails**, which only operators see). There is no new command. `/scriptevent bounty:lockpick` and `/scriptevent bounty:test_capture` work as they always did.
- A world that has never used the Jails screen has the two jails the code always had ("Jail 1", "Jail 2"). The first thing you save makes both real; from then on the screen is the only way to move them (the config editor's "(default)" jail fields stop mattering).
- A problem goes to the content log as `[jails]` (a record that cannot be read, or no jail usable), `[jailbreak]` (a button press or a click that failed) or `[forms]`.

## What only the real game can answer (tell me what you SEE)

1. **Does an empty-handed right-click on a button or a lever get cancelled?** Only a click with the builder's wand was measured. When an outlaw presses a bound **stone button**, does the button also press (a click, the redstone pulse) as well as the lockpick form opening? If it does, the cancel does not work empty-handed
   and a bound button also does its usual thing. (`systems/jailbreak.ts`, the handler: nothing to change if it does not matter; otherwise this needs another approach.)
2. **Does the form open at once?** After pressing a bound button the "Pick the Lock" slider should be up within about a second. If it never opens, or opens twice, say so.
3. **Which blocks can be bound?** Try a stone button, a wooden button, a lever, an oak door, an iron door, a chest and a plain block. A right-click on an iron door or iron trapdoor may not reach scripts at all (it did not in the robbery spike). A **pressure plate** cannot work (it is stepped on, not right-clicked).
4. **Is the door opened the second time?** Run a jailbreak twice in one round at the same jail without removing the redstone block between them. Does the door open both times? (The code places `redstone_block` each time and never takes it away.)
5. **The Teleport list:** it should show your jails by name, in the place "Jail 1", "Jail 2" used to be. Is the list too long to use with eight jails?
6. **A jail screen with eight buttons bound** has about twenty buttons: is it usable, or does it need paging?
7. **Where do prisoners land?** The spot is the middle of the block you stood on. Is it inside the cell, and not in the wall?
8. **Anyone left unable to press, or stuck** after any of the above, however you got there.

## The editor (alone, as an operator)

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:game_menu`, right-click. | The menu has an **eighth button, Jails** (Start sequence, Endings, Jails are the last three). An account that is not an operator sees five buttons. |
| 2 | Press **Jails**. | A list: **Jail 1 (on, 0 buttons)**, **Jail 2 (on, 0 buttons)**, **Add a jail**, Back, and "2 of 8 jails". |
| 3 | **Jail 1.** | Its spot, its door trigger (the old one), "Buttons: none", and buttons Turn it off, Name, Move the jail spot to where I stand, Bind a button, Set the door trigger, Clear the door trigger, Send me to the jail spot, Delete, Back. |
| 4 | Stand in the middle of a cell you built. **Add a jail**, name `Town jail`. | Saved at once, its spot where you stood, **no door trigger** ("Door trigger: none, so nothing is placed when the jailbreak succeeds"), no buttons. |
| 5 | Add one with an **empty name**. | The box comes back with "Not saved: a name cannot be empty" in its title. Close it: nothing was saved. |
| 6 | **Town jail**, **Bind a button: click the block**. | The screens close and a line says to right-click the block that should start the lockpick within 30 seconds. Right-click a **stone button** (place one next to the cell first). |
| 7 | Open **Town jail** again. | "Buttons: x, y, z" with the block's coordinates, and a button "Remove button 1 (x, y, z)". |
| 8 | **Set the door trigger: click the block**, then right-click the block where your door's redstone input is. | "The door trigger of Town jail is now the block at ...". **Clear the door trigger** takes it away again. |
| 9 | Try to bind the same block again, and try to bind a block of Jail 1's. | Each is refused, naming the jail. |
| 10 | **Turn it off**; then try to turn the other jails off too. | The first is fine. The **last jail that is on** refuses with "at least one jail has to stay on". It also cannot be deleted. |
| 11 | **Name**: rename it; then **Undo my last change**. | The old name is back. |
| 12 | **Delete**, **Delete it**, then **Bring back town_jail** on the list. | Gone, then back exactly as it was. |
| 13 | Quit to the main menu, rejoin, open Jails. | Everything you made is still there. |
| 14 | Bind a block, then do nothing for 30 seconds and right-click an ordinary block. | The click is an ordinary one: the bind expired. |

## Using a button (an operator and two outlaws, and one law player)

Make **Town jail** the only jail that is on (turn Jail 1 and Jail 2 off), bind the stone button to it and set its door trigger. Start a game (**Choose roles**).

| # | Do | Expect |
|---|---|---|
| 15 | Outlaw A presses the bound button while **nobody is jailed**. | "No one is currently jailed." No form. |
| 16 | The law player catches outlaw B (or `/scriptevent bounty:test_capture` as B). | B is put at Town jail's spot. |
| 17 | Law presses the button. | "Only outlaws can attempt this." |
| 18 | B (the prisoner) presses it. | "You can't pick your own lock." |
| 19 | Outlaw A presses it. | The **Pick the Lock** slider opens. Listen for the ping; right-click again to try again. (Holding the right mouse button down does not open it twice.) |
| 20 | A gets two right picks (or A and C get one each). | "The jailbreak succeeded!"; B is free; the redstone block appears at the door trigger (nothing happens if you cleared it, and B is still freed). |
| 21 | Stand **law** within four blocks of the cell and press the button. | "Law is nearby: you can't work on the lock right now!" |
| 22 | Do not finish a pick for 30 seconds. | "The breakout attempt was abandoned!" and the pickers are weakened, as before. |
| 23 | Wire a command block `/scriptevent bounty:lockpick` the old way and press it. | It still works. |

## More than one jail

Turn all three jails on (Jail 1, Jail 2, Town jail) and bind a different button to each.

| # | Do | Expect |
|---|---|---|
| 24 | Capture several players in turn, freeing them in between (or `bounty:test_capture` yourself, then a jailbreak). | Over a few rounds the prisoners are sent to different jails, but **all prisoners in one stretch share one jail**. |
| 25 | With a prisoner in Jail 1, press a button bound to Town jail. | "No one is held in Town jail." No form. |
| 26 | Press the button of a jail you turned **off**. | Nothing: the click is an ordinary one (a button just presses). |
| 27 | Delete the jail a prisoner is in while they are held. | Say what you see (it is allowed). The next capture picks among the jails that are left. |

## The startup check and the config editor

| # | Do | Expect |
|---|---|---|
| 28 | Bind a button, then `/scriptevent rae:debug` or reload. | No `[Scripting][error]`. A jail whose spot is above the world (edit one with y 400 in the config editor's default field before saving) is named in the startup warning, e.g. "Jail Town jail (jail spot): y=...". |
| 29 | `/rae:config`, World: **Jail 1 (default)**. | The field is there. In a world that has not used the Jails screen, changing it moves Jail 1. After you have saved a jail, it no longer matters. |

## Must not appear

A `[jails]` or `[jailbreak]` line in the content log you did not cause (copy it to me), any `[Scripting][error]` line, a button that does nothing at all, or a player who cannot right-click ordinary blocks.

## If something is wrong, where the fix goes

| Symptom | File |
|---|---|
| The button also presses, or the form does not open | `systems/jailbreak.ts` (the `playerInteractWithBlock` handler) |
| A bind does not take the click, or takes the wrong one | `core/jailbind.ts`, and the `hasPendingBind` early returns in `systems/robberyrun.ts` and `systems/robberybuilder.ts` |
| A refusal reads wrong, or a rule is wrong | `logic/jails.ts`, `core/jailstore.ts` |
| A screen is awkward | `core/jailforms.ts` |
| Prisoners go to the wrong jail | `systems/jail.ts` (`assignJailForNewPrisoner`), `core/jailstore.ts` (`usableJails`) |
| The Teleport list | `systems/menu.ts` (`teleportTargets`), `config/world.ts` |
