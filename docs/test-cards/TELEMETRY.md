# TELEMETRY test card: does the game's log tell the report what happened

The telemetry puts one line in the game's **content log** for every round that ends, every robbery (its start, each element done, each
lock pick that opens or jams, what was paid, how it ended) and every shop (a visit, a deal done, a deal refused). The tool in
`tools/telemetry` reads the logs, keeps every event in an archive and writes a report. Everything that does not depend on the real game
is covered by the tests (the lines the game writes and the way the tool reads them are tied together by contract tests that play a round,
a robbery and a shop visit under the fake game). What they cannot say is whether the REAL game keeps these lines, whole, and when, and that is
what this card is for. Nothing here has been seen from the real game yet.

- Not deployed yet: it ships in the next behavior pack after 0.2.5 (0.2.6). RP unchanged. Operators only; you need Node.js on this
  computer for the tool (`tools\telemetry.cmd` says so if it is missing).
- **Turn the content log file on first** (once): Settings, Creator, **Enable Content Log File**. The on-screen overlay can stay off.
  If your game has a content log **level**, it must be Warning or lower (the lines are written as warnings, like every `[shop]`
  and `[robbery]` line). The logs are in `%APPDATA%\Minecraft Bedrock\logs`, one file per launch, named `ContentLog<date>_<time>_1.txt`.
- The lines hold **no player names**: a raw player id and a law or outlaw role, and nothing else about a person.
- **Close the game, or wait, before you run the tool.** The live log is written in bursts, so the newest lines may not be in the file
  yet, and the last one may be cut in half. The tool never fails on that: it says how many lines it saw cut off, and running it again
  later reads them. Closing the game to the desktop is the sure way.
- The tool: double-click `tools\telemetry.cmd` (or `node tools/telemetry/cli.mjs --open` from `C:\rae`). It reads the logs, adds the new events
  to `telemetry-data\events.jsonl`, writes `telemetry-data\report.html` and one CSV per kind of event in `telemetry-data\csv\`, and opens the
  report. Running it twice changes nothing the second time. It only reads the logs and only writes into `telemetry-data` (which git ignores).

## Part A: does anything come out at all? (3 minutes)

| # | Do | Expect |
|---|---|---|
| A1 | Quit the game completely. Launch it fresh, open RAE2, stand still for 10 seconds, then quit to the desktop. | Nothing to see in the game. A new `ContentLog...` file is in the logs folder. |
| A2 | Open that newest log in Notepad and search for `[telemetry]`. | **One line**: `...[Scripting][warning]-[telemetry] {"v":1,"k":"boot","w":"...","b":"...","n":1,"t":...,"bv":"0.2.6"}`. If there is none, say so first: the rest of this card depends on it (see "If nothing shows" below). |
| A3 | Double-click `tools\telemetry.cmd`. | The window says `Read N log files: 1 telemetry line, 1 new, 0 already known.` and the report opens. |
| A4 | Read the report. | Header: "from 1 event" and today's date. **Rounds**: "No finished rounds in this data yet." **About this data**: "The game's scripts loaded 1 time", one world (an id of 6 letters and digits, which is RAE2) with 1 event, one build `0.2.6` with 1 event, "The game's rate limit dropped no lines." |
| A5 | Run the tool again. | `0 new, 1 already known.` Nothing in the report changes. |

## Part B: a session with known figures (about 15 minutes)

Run it as an operator in RAE2. It needs the shop **Habiti** from `NPC-SHOP.md` steps 2 to 4 (an iron sword for 60 coins, 6 arrows for 15
coins, a buy-back of 3 feathers for 8 coins), and the **Test Vault** from `ROBBERY-VAULT.md` (id `test_vault`, `outlawsOnly off`). If your
shop or robbery has other names or prices, the figures below change the same way; the page should still say what you did. Have 3 feathers
in your bag. Launch fresh so the first line of this launch is the boot line.

| # | Do | Expect |
|---|---|---|
| B1 | `/scoreboard players set @s coins 100`. Open Habiti. Buy the **iron sword** (60). Press the sword again. Press **Sell Feather x3**. Close. | The sword is bought; the second press is refused ("you need 60 coins (you have 40)"); the feathers sell for 8. |
| B2 | Open Habiti again (a second visit). Buy the **arrows** (15). Close. | Bought. |
| B3 | RAE menu: **Start game**, **Choose roles**, you as **Law**, the rest "Sit out" (the game warns "Nobody is an outlaw."). Wait for the LAWMAN title, then menu: **Reset game**, **Reset the game**. | A round starts and is reset while under way. (A reset before the round is under way, during the 3 seconds of "Rolling...", is not a round and records nothing.) |
| B4 | **Win the Test Vault for real**: `ROBBERY-VAULT.md` steps 10 to 14 (pick the keypad, pick the lockbox with at least 25 coins, wait for "The vault is empty!"). Do not jam it. Walk out of the area and wait for the door to shut (or `/rae:robbery reset test_vault`). | The run is won and pays the lockbox's 250 bounty. |
| B5 | A **test run**: `/rae:robbery start test_vault test`, then `/rae:robbery stop test_vault`. | A run starts and stops. |
| B6 | Quit to the desktop. Run `tools\telemetry.cmd`. | See the figures below. The window says `Read N log files: 19 telemetry lines, 18 new, 1 already known.` The 1 is Part A's boot line; this launch wrote 18 (a boot line, 6 shop, 1 round, 8 for the won run, 2 for the test run), if you did nothing else in the world and did not jam a lock. If you skipped Part A it is 18 new and 0 already known. |

### What the report should say after B6

| Where | Expect |
|---|---|
| Rounds | **1 round**, **Aborted 1**; law win rate "n/a, no round was decided". The row's coins at the end is a number: tell me if it looks wrong. |
| Robberies | A note first: **"1 test run is left out (run with --include-tests to see it)."** Then **Robbery: test_vault**: **Runs 1**, **Win rate 100%, 1 of 1 decided**, **Paid per run 0 coins, 250 bounty** (more bounty if someone else stood in the area). |
| Robbery elements table | `Keypad (switch)`, `Vault door (door)` and `Lockbox (chest)` each **1** done, **100%** of runs, **0** jams. The Lockbox is done after the Keypad. Average misses is however many times you missed. |
| Robbery latest runs | One row: **Won**, a length you can believe, **3 of 3**, People **1**, Coins 0, Bounty 250. Run `tools\telemetry.cmd --include-tests`: a second row, **Stopped**, marked `test`. |
| Shop: habiti | **Visits 2** (1 customer), **Deals done 3** (1.5 per visit), **Spent by customers 75**, **Paid to customers 8**. Top deals: `Iron Sword for 60 coins` (buy, 1, 60 coins), `Arrow x6 for 15 coins` (buy, 1, 15), `8 coins for Feather x3` (sell, 1, received 8). **Why customers were refused: "Not yet: you need # coins (you have #)." 1.** No services line. |
| Coin flow | **Coins in 8** (0 from robberies, 8 from shop sales), **Coins out 75**, **Net -67**, and "Last round ended with N coins". The note says the bounty (250) is not coins. |
| About this data | The scripts loaded **2 times** (Part A's launch and this one), the build `0.2.6`, no lines dropped, **0 damaged, 0 skipped**. Both launches are the same world id. |

### The off switch, and running it twice

| # | Do | Expect |
|---|---|---|
| B7 | Launch again. `/rae:config set telemetry.events off`. Open Habiti and **buy the arrows** (you have enough). Then `/rae:config set telemetry.events on`. Open Habiti once more and close it without buying. | The first reply says `telemetry.events: true -> false.` Everything still works with it off. |
| B8 | Quit to the desktop. Run `tools\telemetry.cmd`. | **2 new** (this launch's boot line and the one visit) and the rest "already known". Habiti now says **Visits 3, Deals done 3** (1 per visit): **the arrows bought while it was off are not there**, and the visit made while it was off is not either. The scripts loaded **3 times**. |
| B9 | `/rae:config` typed alone, then **Telemetry**. | A group of one setting, the switch, on. |

## If nothing shows (A2 or B6 fails)

1. Is there a **new** `ContentLog` file for this launch? If not, the log file setting is off or the game could not write it.
2. Does the file have `[Scripting]` lines at all (a `[shop]` or `[Watchdog]` line, a `Plugin Discovered [BountySys]` line)? If there are
   some but no `[telemetry]`, the level may be set too high, or the build running is not 0.2.6 (a world may serve a cached older
   one: a full quit and relaunch is the only way to be sure).
3. A `[telemetry-problem]` line means the writer itself failed once this launch; copy that line to me.
4. `tools\telemetry.cmd` printing "No telemetry in the logs yet" is the tool telling you the same thing.

## What only the real game can answer (tell me what you SEE)

1. **Does the line appear at all, and look like the sample in A2?** Is it one whole line, or cut? (A line the game cut would show up in the
   report's data panel as "damaged".)
2. **When does a line reach the file while the game is still running?** Do a shop deal and open the log in Notepad straight away (do not
   quit): is the line already there, there after a minute, or only once you quit?
3. **Do the times match your clock?** The report's "When" column against the time you did things. The tool takes the date from the log's
   file name and the time of day from each line; a log that crosses midnight is the case most likely to be off.
4. **Does the game delete old logs?** Count the files in the logs folder now and after a few more launches. (The archive keeps their
   events either way; this only tells me how soon an event is at risk before the first run of the tool.)
5. **Does it lag?** Any `[Watchdog] Slowdown from 'BountySys'` line that was not there before, or a gun or a shop that feels slower.
6. **Two worlds, two ids?** If you open another world and play a round, the report's Worlds table should show a second id, and the
   first one should still be RAE2.
7. **Is the report useful?** What is missing, what is noise. The next things to count are a small change to the same stream.

## Must not appear

`[telemetry-problem]`, any `[Scripting][error]` line, `[forms]` or `[robbery]` failures, a chat error to an operator, or a figure in the report
that does not match what you did.

## Notes

- The report reads only what the game wrote. A world with the content log off, or with `telemetry.events` off, simply has nothing in it.
- The rate limit (200 lines a minute) is far above what play makes; if it ever drops lines, the data panel says how many.
- Delete `telemetry-data\` any time to start the archive over; the next run rebuilds it from the logs that still exist.
