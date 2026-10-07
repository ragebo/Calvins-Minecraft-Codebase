# ROBBERY-VAULT test card: build a vault in game with the wand, then rob it

Phase 1a of the in-game robbery framework ("Vault"). You build a small robbery out of blocks you place yourself, bind
them to elements with a **Robbery Wand** and forms, and then play it: a keypad you pick, a vault door that opens by
itself, a lockbox with a price and a lock, a payout, and a site that puts itself back. No coordinates in config, no
command chains. Phase 0 (`ROBBERY-SPIKE.md`) measured how the real game reports and cancels right-clicks; this is the
first thing built on those answers, so most of this card is "does the real game agree with what the tests assumed".

- Behavior pack **0.1.41**, resource pack unchanged (1.0.27). BP only: no world needs to be open to deploy it, but a
  fresh launch is the safest way to be sure the new scripts are what you are running.
- Operators only. Run it in your test world (RAE2) as an operator, on flat ground **away from the old Saint Diego Bank**
  (the old command-block build is untouched, and two builds in one place would fight).
- `/rae:robbery_wand` (or `/give @s bountysys:robbery_wand`) gives you the wand. Everything is also a command:
  `/rae:robbery_list`, `info`, `new`, `select`, `delete`, `start [test]`, `stop`, `reset`, `activate`, `edit`, `view`,
  `undo`, `area`, `set`; type `/rae:robbery_` and the game completes them.
- Problems go to the content log as `[robbery]` lines and, if they are real failures, to every operator in chat.

`npm test` covers (787 tests, and 22 deliberate mutations of the core rules were each caught by one): the data model and its validation; the store (every edit written at once, an over-size
edit refused, an unreadable save listed and never overwritten, undo); every door and chest operation against a fake
world, including a door always swung as a pair and a chunk that is not loaded; the whole run (starting, the director's
slot, who may touch what, the locks, effects and their delays, the time limit, the empty-area fail, stop, reset, a round
reset, a robbery deleted mid-run, a crash and reload recovered by the janitor); every game-event handler **in restricted
execution** (so a forbidden call throws as it does in the game); every builder screen driven by a stand-in player,
including one test that builds the whole bank by clicking through the screens and then plays it; and all fifteen commands
under a registry that enforces the real one's rules. None of that can say what the REAL game does with a form, a
particle, a double chest or a sound: that is this card.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Build a small room (about 6 x 4 x 6) out of any blocks, with an **iron door** (two high) as its entrance, a **stone button** on the wall beside the door (outside), and a **chest** inside. Do NOT wire the button to the door with redstone. | Just a room. |
| 2 | `/rae:robbery_wand`, hold it, right-click the **air**. | The wand is in your bag. A form "A new robbery" opens. Type the name `Test Vault`, leave the id blank, submit. Chat says you made it. Its menu opens: close it. |
| 3 | Right-click the **stone button** with the wand. | The button does NOT press. A form "Test Vault: bind a block" opens with "A switch..." chosen. Name it `Keypad`, submit. Chat says it is bound and the Keypad screen opens. |
| 4 | In the Keypad screen: **Locks**, then **Add a pick lock**, accept the defaults (submit), then **Back**, **Back**. | The locks screen lists "Pick lock: 2 correct picks (+/-10), jams after 3 misses for 20s". |
| 5 | Right-click the **iron door** (either half) with the wand. | The door does not swing. The form suggests "A door"; name it `Vault door`, submit. In its screen: **Waits for**, turn on `Waits for Keypad`, submit, **Back**. |
| 6 | Right-click the **chest** with the wand: name it `Lockbox`. In its screen: **Locks**, add a **pick lock** (defaults) and a **price** (25); **Waits for** `Vault door`; **Loot**: table `chests/gold_2`, items `minecraft:diamond 2`; **When it is done**, **Add: pay out** (coins 0, bounty 250, everyone in the area), **Add: end the robbery** (won, wait 3 seconds). | Each step says "Saved/Added". A table the game does not have would be warned about. |
| 7 | Stand in the middle of the room. Wand in the air, **Area**, **A box around where I stand**, radius about 10. Then **Back**, **Start, win and fail effects**, **When it is won**, **Add: say something**: "The vault is empty!", to Everyone. | "The area is set." The main menu says **Ready to run.** |
| 8 | `/rae:robbery_set outlawsOnly off` (you have no outlaw role outside a round). `/rae:robbery_info test_vault`. | Settings and all three elements described; "Ready to run". |
| 9 | `/rae:robbery_view`. Hold the wand and point at the button, the door, the chest, a plain wall. | Sparkles mark the button, both door halves, the chest and the edges of the area. The action bar names what you point at ("Keypad (switch) Test Vault") or says to right-click to bind it. **Tell me if you see no sparkles.** `/rae:robbery_view` again turns it off. |
| 10 | With an **empty hand**, right-click the **chest**. | It does not open: "sealed tight; something else has to be done first". |
| 11 | Right-click the **button** (empty hand). | The button does not press. A slider form "Keypad" opens: "Picks 0/2, Misses 0/3". Slide it and submit. A wrong guess pings (higher when closer) and says "no luck"; keep going. Two hits and the vault door **swings open by itself**, both halves, with a clunk. |
| 12 | Right-click the open **door**. | Nothing: it stays open. |
| 13 | `/scoreboard players set @s coins 100`. Right-click the **chest**, pick it. | With fewer than 25 coins you are told the price and the pick never starts. With enough, you pick it; the 25 coins are taken only when it opens (a miss and walking away costs nothing). The chest then opens normally and holds the table's loot plus 2 diamonds. Your bounty goes up 250. |
| 14 | Wait 3 seconds. | "The vault is empty!" in chat, with a sound. The robbery is won. |
| 15 | Wait 60 seconds. | The door shuts again and the chest empties by itself. |
| 16 | Right-click the button again straight away. | It is closed for a while ("closed for another 9:xx"). `/rae:robbery_reset test_vault` clears that. |
| 17 | Start it again and miss the keypad **3 times in a row**. | "The lock jams!" Touching the button now says it is jammed for about 20 seconds; after that one hit is not enough (progress was lost). |
| 18 | Start it, open the door, then **quit to the main menu and relaunch** (or close the world) before the 60 seconds are up. Rejoin. | Within a few seconds of the area loading, the door is shut again and the chest is empty. This is the crash-recovery path. |
| 19 | With a **second account that is not an operator** (or `/deop` yourself), try to break the door, the chest and the button, and set off TNT beside them. | Breaking is refused with "That belongs to the Test Vault". TNT destroys what is around but not the three bound blocks. Operators can still break them. |
| 20 | Holding the wand in **creative**, left-click a block. | Nothing breaks. |
| 21 | Put a **command block** with `/rae:robbery_start test_vault true` behind a button and press it, then another with `/rae:robbery_activate test_vault Keypad`. | The first starts a test run (anyone can take part, no cooldown); the second completes the keypad without a pick, opening the door. |
| 22 | Make a **double chest**, right-click one half with the wand. | The form offers "Also bind the chest beside it (a double chest)", on. Bind it and run it: **does the loot appear in the chest, and in which half?** (Unmeasured until now.) |
| 23 | `/rae:robbery_delete test_vault true`, wait a second, then `/rae:robbery_undo test_vault`. | Deleting shuts the door and empties the chest by itself; undo brings the whole robbery back. |

## What only the real game can answer (tell me what you SEE)

1. **Forms:** do the wand's forms open straight after the click or only after a moment (a "busy" retry)? Is the pick
   slider comfortable? Do any of the buttons or labels look cramped or cut off?
2. **Clicking:** does a click on a bound block ever also open the vanilla screen, press the button or swing the door?
   Does a click in the air always open the menu, and a click on a block never open it twice?
3. **The door:** does an iron door always open and close as one door, both halves, never half-open?
4. **Sounds:** the cues are `note.bass` (refused), `random.orb` (ping), `random.levelup` (hit), `random.anvil_use`
   (an element done), `random.break` (a jam), `block.bell.hit` (start). Any that are silent or wrong?
5. **Particles:** are the builder view's sparkles visible, and only to you?
6. **Commands:** does autocomplete offer every `/rae:robbery_` command? Does `true` work as the last argument of
   `start`, `info` and `delete`? Does `/rae:robbery_area ~ ~ ~ ~10 ~5 ~10` work? Does `/rae:robbery_new bank "Saint Diego"`
   keep the space?
7. **The double chest** (step 22), and a pressure plate: bind one as a switch and step on it.
8. Anything in the content log marked `[robbery]`, `[forms]` or `[Scripting][error]`.

## Known limits (by design, for this phase)

- A reload ends a robbery in progress; the site is put back and the next touch starts it afresh.
- There are no breakable walls, guard spawners, zones, placed-block locks or alarm heat yet (Phase 1b and later).
- Do not wire a bound vault door to real redstone: the framework controls the door, and a redstone signal can swing it.
- Nothing is pushed or deployed until you say so.
