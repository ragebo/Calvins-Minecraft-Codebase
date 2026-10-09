# ROBBERY-SUCCESS test card: a win that shuts nothing, and a reset that never shuts you in

Two changes to how a robbery comes out, from the vault problem: a win used to end the run, so a vault of many chests needed one
"last" chest, and anything not opened by then could never be opened. Everything that does not depend on the game is covered by the
tests (`test/robbery-success.test.mjs`). What they cannot say is how it plays and feels, and that is what this card is for.

- Not deployed yet: it ships in the next behavior pack after 0.2.3 (the deploy will say which). Operators only.
- **A win is a success, not an ending.** It pays the win effects and starts the reset countdown, and **shuts nothing**: the doors and
  chests that are left can still be opened, picked and bought, including the chests that were waiting on the door that won. A
  **fail** (the time limit, nobody left in the area, an alarm) still locks what is left. Whichever comes first is the only outcome.
- **The site is never put back under anyone.** When the countdown runs out it waits until nobody is standing in the robbery's
  **area**, whoever they are (outlaw, law, bystander; not someone eliminated from the round). The guards wait with it. Only an
  operator's **Stop** or **Put the site back now** puts it back at once.
- The screens say it differently now: the effect is **Win or fail the robbery** (it was "End the robbery"), with the choices
  **Won (a success: nothing is locked)** and **Failed (what is left is locked)**. The reset setting reads "Seconds from a win or
  fail until the site is put back (never while someone is inside the area)".

## Setup (about 5 minutes)

Use the Test Vault from ROBBERY-VAULT.md, or build one: a room with an **iron door** (two high), a **stone button** outside, three
**chests** inside, and an area drawn around the **whole room** (menu, **Area**, a box around where you stand, radius about 10).
The area is what "inside" means, so it has to cover everything a robber can stand in, the vault included.

| Element | Waits for | Lock | Loot | When it is done |
|---|---|---|---|---|
| `Keypad` (the button) | nothing | none | | |
| `Vault door` | `Keypad` | none | | **Add: win or fail the robbery**: **Won**, wait 0 |
| `Cash` (chest) | `Vault door` | none | items `minecraft:gold_ingot 4` | |
| `Gold` (chest) | `Vault door` | a **price** of 25 | items `minecraft:diamond 2` | |
| `Deposit` (chest) | `Gold` | none | items `minecraft:emerald 3` | |

Then `/rae:robbery_set outlawsOnly off`, `/rae:robbery_set resetAfterSeconds 30`, and make sure the time limit and the empty-area
fail are 0 (`/rae:robbery_set timeLimitSeconds 0`, `/rae:robbery_set failWhenEmptySeconds 0`). `/scoreboard players set @s coins 100`.

## The success

| # | Do | Expect |
|---|---|---|
| 1 | Empty hand: press the keypad button. | The vault door swings open and the robbery is **won** at once. **The Cash chest fills by itself** and opens normally. (Before this change the win ended the run first and the chest never filled.) |
| 2 | Open the run screen (wand menu, **Run it**). | It reads **won, still open to loot, put back in 0:xx**. |
| 3 | Open the **Gold** chest (right-click). | It still takes the 25 coins and fills with the 2 diamonds, **after the win**. With fewer than 25 coins you are told the price. |
| 4 | Open the **Deposit** chest. | It was sealed until Gold was done; now it opens. |

## The reset waits for you

| # | Do | Expect |
|---|---|---|
| 5 | Stay **inside the room** until the 30 seconds are over, watching the door. | **Nothing resets.** The door stays open, every chest keeps what is in it. The run screen reads **won, still open to loot, waiting for everyone to leave** (and gives no time). It never gives up on its own, however long you stay. |
| 6 | Walk **out of the area** (past the box you drew). | Within about a second the door shuts and every chest is empty. The robbery can start again once its cooldown is over. |
| 7 | Run it again. Have a **second player** (or an alt) stand inside while you leave. | The room stays as it is until the **last** person is out. A law player counts too, though an outlaws-only robbery would never let them take part. |
| 8 | Run it again; after the 30 seconds, with you still inside, press **Put the site back now** in the run screen. | It goes back **at once**, with you inside. An operator's reset never waits. |
| 9 | Run it again; **quit to the main menu and relaunch** (or close the world) while the door is open, and rejoin **inside the room**. | The door stays open until you walk out of the area, and then it shuts. (Rejoin outside and it shuts within a few seconds of the area loading.) |

## A failure still locks

| # | Do | Expect |
|---|---|---|
| 10 | Add an **Alarm** button with no requirement: **When it is done**, **Add: win or fail the robbery**, **Failed**. Press the alarm, then the keypad. | Nothing opens: **"It is over for now."** The chests stay as they were. |
| 11 | Put the robbery back (`/rae:robbery_reset`), then **move the Won effect from the Vault door to the Deposit chest** (so the run stays under way after the keypad), set `timeLimitSeconds 20`, press the keypad, and wait 20 seconds **without opening Gold**. | "Time is up." The run is failed: Gold can no longer be opened ("It is over for now"). The Cash chest, which was already open, still lets you take from it until the site goes back. |
| 12 | Win it (keypad), then press the alarm. | **Still a success.** Nothing changes, the chests stay open to loot: the first outcome is the only one. |

## What only the real game can answer (tell me what you SEE)

1. **Does the box match "inside the bank"?** Stand in the doorway, at the edge of the box, in the vault, in a basement under the
   floor: does the reset treat you as inside or outside the way you would? (The box is three-dimensional, floor to ceiling.)
2. **Creative and spectator:** does an operator flying about in creative or spectator mode inside the room hold the reset? (By
   design yes in creative; spectator mode is only ignored for someone eliminated from the round, not for an operator in spectator mode.)
3. **Feel:** is "it never resets while I am in there" what you wanted, or is it too strict (someone asleep in the vault keeps the
   bank from resetting for everyone: `Put the site back now` is the way out)?
4. **The chest screen:** the loot you did not take is emptied when the site goes back. Anyone with the chest open at that moment is
   inside the area, so they hold it; tell me if you ever see a chest emptied while you are looking at it.
5. **No area set:** `/rae:robbery_info` on a robbery with no area now says "No area is set, so the site is put back on time even with
   people inside it". That is the old behavior; tell me if you would rather it refused to run without an area.

## Notes

- Tests cannot see what a player looks like to the game: they place players at coordinates. The area test is the box and the
  player's feet, the same as the "everyone in the area" audience, nothing more.
- A robbery that had its win on its last element behaves as before for that element. The two differences are that nothing else
  is locked afterwards, and that the site waits for its area to empty before it is put back.
