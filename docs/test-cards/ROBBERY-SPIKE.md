# ROBBERY-SPIKE test card: how the real game reports chests, doors, buttons and levers

Phase 0 of the in-game robbery framework: a measurement, not a feature. The framework will let you build a
robbery out of blocks you place yourself (an iron door, a chest, a button...) and wire behavior onto them with a
wand. Whether that works depends on things nobody has measured in this game: does a right-click on a chest, door,
lever or button reach a script; does setting `cancel` really stop the chest opening or the door swinging; can a
script read and fill a chest, make loot from a loot table, save a big structure, keep it across a relaunch. (The
one block interaction tried before, placing the Gatling gun, did NOT fire.) This card records the facts; the
design branches on them (decision table at the bottom), so please run all of it before the framework is built.

- `/scriptevent rae:robbery_probe <command>` and `/rae:robbery_probe_ctx <text>` (a custom command, operators only).
- The item `bountysys:robbery_wand` ("Robbery Wand", it borrows the menu's icon) is the real builder wand, here only
  so the probe can see what a right-click with it does. Get it with `/give @s bountysys:robbery_wand`.
- Everything is written to the content log as `[robbery-probe]` lines; the findings are the `RESULT` lines. I read
  the log afterwards, so you mostly just have to click things and tell me anything surprising you SEE.
- **Run it in your test world (RAE2), as an operator, on flat open ground.** `bench` overwrites a strip about 40
  blocks long (starting 2 east and 3 south of you) and `structure place` overwrites a small area east of you.
  `cancel on` switches itself off after 2 minutes so a forgotten flag cannot leave chests unopenable.

Behavior pack **0.1.40**, resource pack unchanged (1.0.27). BP-only: it needs no world open, but a fresh launch is
the safest way to be sure the new item and scripts are what you are running.

`npm test` covers: each kind of block event is recorded (and nothing is logged until `log on`); "did the click do
its thing" is judged right for doors (open_bit changed), containers (opened event), buttons and levers; a held
right-click is judged once per press; `cancel` really sets `cancel` in the matching before-event and switches
itself off (timeout and round reset); every probe survives an API that throws and logs the engine's own error text;
`bench`, `door`, `container`, `loot`, `structure`, `view`, `tick` and `itemprop` do what they say against a fake
world; the command-context probe reports who the origin is. None of that can say what the REAL game does, which
is what this card is for.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | `/give @s bountysys:robbery_wand`, then `/scriptevent rae:robbery_probe log on`, then `/scriptevent rae:robbery_probe bench`. | The wand is in your hand. Chat lists the bench order (chest, trapped_chest, barrel, crafting_table, stone, stone_button, lever, stone_pressure_plate, wooden_door, iron_door, trapdoor, iron_trapdoor, fence_gate) and says if any could not be placed: place those by hand. Also place a **double chest** (two chests side by side) next to the bench. |
| 2 | Right-click each bench block with an **empty hand**. Step on the pressure plate. | Normal Minecraft behavior (chests open, doors swing, button/lever work). Close any chest screen each time. |
| 3 | Repeat step 2 holding the **wand**, then holding a **stick**. Also left-click each block once with the wand. | Same. Note anything the wand does by itself (it should do nothing). |
| 4 | Repeat on the chest and the wooden door while **sneaking**. | Normal behavior (a sneak-click on a chest may do nothing: that is fine, tell me). |
| 5 | `/scriptevent rae:robbery_probe report`. | A list of rows, one per block and held item, like `chest [hand]: after+before+container+useOn | normal 1/1 | cancelled - | cancel untested`. |
| 6 | `/scriptevent rae:robbery_probe cancel on`. Repeat the right-clicks (empty hand AND wand) on the chest, double chest, barrel, wooden door, iron door, trapdoor, iron trapdoor, fence gate, button, lever. **Watch what happens** and say which still opened, swung or pressed. Then `cancel off`. | If cancel works: the chest does not open, the door does not swing, the button/lever do not press. If it does not: they behave normally anyway. Either answer is fine, I need to know which, per block. |
| 7 | `/scriptevent rae:robbery_probe cancel break on`, try to break a bench block, then `cancel break off`. Optional: `cancel explode on`, blow up TNT next to the bench, `cancel explode off`. | Breaking is refused while it is on. Explosions leave the bench alone (or not). |
| 8 | `/scriptevent rae:robbery_probe report` again. | The cancelled column is now filled in: `cancel EFFECTIVE` or `cancel INEFFECTIVE` per block. |
| 9 | `/scriptevent rae:robbery_probe restricted on`, right-click the chest, `restricted off`. | Nothing visible. The log gets one `RESULT restricted[before interact] ...` line per API, showing which ones are refused inside a before-event. |
| 10 | `/rae:robbery_probe_ctx hi` from chat (autocomplete should offer it). Then put a command block with `/rae:robbery_probe_ctx hi` next to a lever and pull it. Then, if you have one, an NPC whose dialogue button runs it. | Chat says "Context probe ran". The log shows `ctx origin = ...` (who the game says ran it: the player, a block, or an NPC plus the player who clicked) and which world changes a command may make. A non-op (second account, or `/deop` yourself) should be refused by the game itself. |
| 11 | Look at the **iron door**: `door check`, then `door open both`, wait 6 seconds, `door close both`, `door open lower`, `door close both`, `door open upper`. Then place a block beside the door, break it, and `door check` again. | Watch the door: does it swing, does it snap shut by itself, does only one half move? The log samples the state at +1, +20, +40 and +100 ticks. |
| 12 | Look at the chest: `container`. Then the double chest, the barrel and the trapped chest. | The chest is filled with a few items and emptied again. The log has its size (27 single, 54 double), whether items can be set and read back. |
| 13 | `/scriptevent rae:robbery_probe loot` | Chat says it is done. The log says whether the pack's `chests/gold_2` table, a vanilla one and a made-up one are found, and what items they make. |
| 14 | `/scriptevent rae:robbery_probe structure sizes` (flat, loaded ground). | Brief lag. The log lists which cube sizes (8 up to 128) the game accepted and the exact error text for the first one it refused. |
| 15 | `structure save 8 6 8`, then **quit to the main menu and relaunch the game**, rejoin, then `structure verify`, then `structure place`, then `structure unloaded`. | `verify` says whether the saved structure survived the relaunch. `place` rebuilds it 8 blocks east of you (overwrites that area). `unloaded` reports what happens saving from a far-away area. |
| 16 | `/scriptevent rae:robbery_probe view`, with a second player nearby if you can. | You see a ring of sparkles and a floating "robbery probe" label for 20 seconds. **Does the second player see them?** (They should not.) |
| 17 | `tick create`, `tick list`, quit and relaunch, `tick list`, `tick remove`. | The log shows whether the ticking area exists and whether it survived the relaunch. |
| 18 | Hold the wand, `/scriptevent rae:robbery_probe itemprop`. | The log says whether the wand accepts a dynamic property. |
| 19 | `/scriptevent rae:robbery_probe log off`. | Done. |

## What to tell me

1. Just say "done". I read the content log (every `RESULT` line) and the report.
2. Anything you SAW that the log cannot show: a chest that opened despite `cancel on`, an iron door that snapped shut,
   a wand right-click that opened something instead of doing nothing, particles a second player could see.
3. Which bench blocks could not be placed automatically.

## What the results decide

| Result | Design consequence |
|---|---|
| Right-click on chests, doors, buttons, levers reaches the before-event and `cancel` works everywhere | Full interception: a locked door or chest simply refuses to open. |
| Iron doors or buttons never reach the before-event | Their locks go through a "keypad" switch instead; the wand warns when you wire a lock straight onto an iron door. |
| Only the after-events fire | Observe-and-react: close a door again a tick after it swings, treat the container-opened event as the trigger. Docs say never to wire a vault door to real redstone. |
| The wand's right-click does not reach a script on interactive blocks | `/rae:robbery_edit` (aim, run the command) becomes the main way to edit; the wand works on everything else. |
| Command callbacks are read-only | Commands validate, then make the change one tick later. |
| The loot-table API cannot see this pack's tables | Chests are filled with the proven `loot insert` command instead. |
| Structures have a small size limit, or do not survive a relaunch | Breakable walls are capped, or stored block by block inside the robbery's own data. |
| Particles or floating text are visible to everyone | The builder view is just an action-bar readout of what you are aiming at. |

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. Must not appear: a
`[Scripting][error]` line naming `robberyprobe`, or `before interact failed`. A `restricted[...] ... THREW` line is
a finding, not a bug. Delete nothing: the `RESULT` lines are the deliverable.

## Not checked

Real redstone, hoppers and dispensers touching a bound block; arrows pressing buttons; many players at once;
performance with a lot of events; the wand's editing forms (not built yet: the wand only gets recorded here).
