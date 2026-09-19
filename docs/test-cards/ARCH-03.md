# ARCH-03 test card: role and status live in core/state, tags are only output

Who is law or outlaw, who is jailed, eliminated, under escort or a winner used to be entity **tags** that five files wrote and a dozen read back. They now live in one record per player in `core/state`. The tags are still written (so command blocks that target `@a[tag=law]` keep working), but the game no longer reads them to decide anything in `roles`, `jail`, `jailbreak`, `endgame`, `boat` or `economy-rules`.

**Nothing about play may change.** Every message, order and number below is what the game did before. The one path that could not be tested for real is the risky one, and it is why this task exists: in an `entityDie` handler the dead player's entity can already be invalid, and the old code gave up on capture when it was. Capture (section B) is the section to spend time on.

`npm test` pins all of this against a fake game (`round-flow`, `jail-flow`, `dead-entity`, `state-jail`, plus the older `jail-spawn` and `player-id-keys`). This card checks the real game.

## Three things that legitimately look different

1. **A captured or eliminated player's tags catch up when they respawn, not at the moment of death.** The kill changes the player's record at once (the messages, the bounty and the law-win check all use it), but the tags `send_to_jail` and `eliminated` are written when the player next spawns, because the dead player's entity may be unusable until then. So `/tag <name> list` between the kill and the click on Respawn may still show the old tags. After the respawn they must be right.
2. **The law compass still reads tags** (it was not part of this task). It may keep pointing at an outlaw who was just eliminated until that outlaw respawns. That is expected; do not report it.
3. **A role tag typed by hand is no longer noticed once the player has a record.** Every player gets a record within a tick of joining, of respawning, or of the addon loading, and after that the game reads the record, not the tag. So `/tag B add outlaw` followed by `bounty:lockpick` answers `Only outlaws can attempt this.` even though `/tag B list` shows `outlaw`. Tags are output now. To give players roles for this card use `/scriptevent bounty:start_round` (and look at who got which role), or hand-tag them and then save and quit and reopen the world: the addon adopts every player's tags when it loads. (The older cards that say "run `/tag <name> add outlaw` first" need one of those two ways now.)

## Setup

1. From `rae/`: `npm run build`. If the world keeps running old scripts, bump the behavior pack version and the world's pin (README, "In-game testing" and the note above it).
2. Three players are enough for everything except B4: **L** (law), **A** and **B** (outlaws). `bounty:start_round` deals roles at random (A1), so simply read `/tag @s list` and call the LAWMAN "L" and the two OUTLAWs "A" and "B". To choose the roles yourself, `/scriptevent rae:reset`, hand-tag (`/tag L add law`, `/tag A add outlaw`, `/tag B add outlaw`), then save and quit and reopen the world (see item 3 above).
3. The `coins` and `bounty` scoreboard objectives exist (`/scriptevent rae:debug` reports any that are missing).
4. Content Log GUI on (Settings > Creator > Enable Content Log GUI) and chat visible.
5. `/scriptevent rae:debug`.
   Expected: `Systems:` includes `state` (new) as well as `roles`, `jail`, `jailbreak`, `raids`, `train`, `boat`, `guns`, `compass`, `endgame`. `Events:` still lists all ten public ids, in particular `bounty:test_capture` (it moved from `jailbreak` to `jail`) and `bounty:lockpick`.

Read a player's tags with `/tag @s list` (run by that player) or `/tag <name> list`.

## A. Round start and reset

| # | Do | Expect |
|---|---|---|
| A1 | Give leftovers first: `/tag A add eliminated`, `/tag A add in_jail`, `/tag B add winner`. Then, with three players in the world, `/scriptevent bounty:start_round`. | Every player gets the title `Rolling...` at once. About 3 seconds later (60 ticks) each gets `LAWMAN` (one player) or `OUTLAW` (two players) and chat shows `Roles Assigned!` once. Each player was teleported to a spawn of their side: law to (125, 83, 196) or (-250, 64, 234); outlaws to (-287, 68, -152), (-137, 109, -287) or (172, 82, -262). `/tag @s list` shows exactly one of `law` / `outlaw` per player and **none** of the leftovers. |
| A2 | With three players: law count is `ceil(players / 4)`. Repeat with four (still 1 law) and five (2 law) if you have them. | 1, 1 and 2 law players respectively; everyone else outlaw. |
| A3 | Alone in the world, `/scriptevent bounty:start_round`. | Chat `Not enough players to start.` Nobody's tags change. |
| A4 | `/scriptevent bounty:teleport`. | Players with a role are sent to a spawn of their side; a player with no role is not moved. |

## B. Capture: law kills an outlaw (the risky path)

Use a real kill by the law player (a sword, or a gun from README). `/kill` has no killer and will not capture anyone.

| # | Do | Expect |
|---|---|---|
| B1 | `/scoreboard players set A bounty 120`. L kills A. Watch chat, and A's screen. | Chat, in this order: `L collected a bounty of 120 coins from A!` then `A was captured by the law and sent to jail!`. L's `coins` rose by 120 (`/scoreboard players list L`); A's `bounty` is 0. **No red `[DEATH ERROR]` line.** A has not moved yet: A is on the death screen. |
| B2 | A clicks Respawn. | A appears at one of the two jail sites, (-254, 64, 235) or (76, 69, 214), **not** at an outlaw spawn, and stays there. A sees `You have been captured! This is your second and final life.` `/tag @s list` for A: `outlaw`, `jailed`, `in_jail`, and **no** `send_to_jail`. |
| B3 | An outlaw with a bounty of 0 is killed by L. | The capture line only: no `collected a bounty` line. |
| B4 | (Needs a fourth player, C, an outlaw.) L kills C while A is still in jail. C respawns. | C appears at the **same** jail site as A. |
| B5 | An outlaw dies to something that is not law (a fall, drowning, a mob). | No capture message. The outlaw respawns at an outlaw spawn, not in jail, tags unchanged. |
| B6 | (Needs a second law player, so five players.) One law player kills the other. | No capture message; the victim respawns at a law spawn. |

## C. Jailbreak

With A in jail (B free, B2 done). The lock needs 2 correct picks (the slider is 0 to 100; within 10 of the hidden target counts; a miss plays a ping that rises in pitch the closer you are).

| # | Do | Expect |
|---|---|---|
| C1 | Before any picking: A (the prisoner) runs `/scriptevent bounty:lockpick`. L runs it. | A: `You can't pick your own lock — you need help.` L: `Only outlaws can attempt this.` No menu opens for either. (An outlaw with an empty jail is checked in F2.) |
| C2 | B runs `/scriptevent bounty:lockpick` and finds the sweet spot. The menu reopens after each pick; the hidden target is rolled again after a hit, so find the new sweet spot (picks less than a second apart are ignored). | `Found it! Correct picks: 1/2`, then `2/2`, then chat `The jailbreak succeeded!`. B gets `+50 coins for the rescue!`. The jail door opens (a redstone block appears at that site's door trigger: (-250, 62, 236) for the first site, (85, 70, 217) for the second). A gets `You've been freed! Get away from the jail before law catches you.` and is weakened and slowed. A's bounty is cleared. `/tag @s list` for A: `in_jail` gone, `escort_vulnerable` present, `jailed` still there. |
| C3 | A walks more than 20 blocks from the jail. | `You made it to safety!` and the effects wear off within about 3 seconds. `escort_vulnerable` is gone from A's tags. |
| C4 | With L standing within 4 blocks of the jail, B tries the lock. | `Law is nearby — you can't work on the lock right now!` and the pick does not count. |
| C5 | Start a picking attempt (one correct pick) and do nothing for 30 seconds. | `The breakout attempt was abandoned!` and B is weakened. Nothing else. |

## D. Second capture eliminates

| # | Do | Expect |
|---|---|---|
| D1 | A has been captured before (`jailed` tag, in jail or freed). L kills A again. | Chat `A has been permanently eliminated!` (plus a bounty line only if A had one). No `sent to jail` line. |
| D2 | A clicks Respawn. | A is in spectator mode and sees `You have been permanently eliminated.` A is **not** teleported to a spawn. `/tag @s list` for A includes `eliminated`. |
| D3 | If A was still in jail when eliminated: B runs the lockpick. | The menu opens (an eliminated prisoner still counts as someone in jail: kept on purpose from the old behavior). A is swept up by the breakout too. |

## E. The law wins

| # | Do | Expect |
|---|---|---|
| E1 | Get A eliminated (D2), with B free. L kills B (first capture); B respawns in jail. | The moment B respawns in jail: `THE LAW HAS WON!` and `Every outlaw is captured or eliminated — no one is left to break them out.` in chat. L now has the `winner` tag; A and B do not. A capture only puts B in jail at respawn, so the win comes at the respawn, not at the kill. |
| E2 | Let more deaths and respawns happen. | The message is **not** repeated. |
| E3 | The last free outlaw, who was captured once before (after C3, A is exactly that), is killed by L while every other outlaw is in jail or eliminated. | The win is announced at the kill itself, before that outlaw respawns. |
| E4 | While any outlaw is still free (not jailed, not eliminated), other outlaws are captured. | No law win. |

## F. Reset

| # | Do | Expect |
|---|---|---|
| F1 | After E, `/scriptevent rae:reset`. | Chat `All systems reset.` `/tag @s list` for every player shows none of `law`, `outlaw`, `jailed`, `in_jail`, `send_to_jail`, `eliminated`, `escort_vulnerable`, `winner`. |
| F2 | An outlaw runs `/scriptevent bounty:lockpick`. | `No one is currently jailed.` The reset emptied the jail. |
| F3 | `/scriptevent bounty:start_round` again, then capture someone. | Roles are dealt afresh (A1), the capture works as in B, and the jail site is chosen again (it may be either of the two). A law win can be announced again. |

## G. The solo shortcuts

| # | Do | Expect |
|---|---|---|
| G1 | One player types `/scriptevent bounty:test_capture` in chat (works with or without a role). | They are teleported to a jail site on the next tick and see `[TEST] You've been sent to jail for testing.` `/tag @s list`: `jailed` and `in_jail` (plus whatever role they had). |
| G2 | A second player does the same. | They go to the **same** site. |

## H. Death penalty (independent of role changes, but it reads the record now)

| # | Do | Expect |
|---|---|---|
| H1 | A law player with 0 coins dies (`/kill` is fine here: the penalty applies to any cause of death). | Nothing in chat about money, and their inventory is kept. |
| H2 | An outlaw with 0 coins and some items in the inventory dies. | Chat `<name> had no money and dropped their inventory!` and the items lie where they died. |
| H3 | Anyone with 101 coins dies. | `coins` becomes 50 and chat says `<name> died and lost half their money!`. Law included. |
| H4 | (Only if you have a homestead villager, tag `homestead`.) An outlaw kills it, then a law player kills another. | The outlaw: `You robbed a homestead! +N coins` (N from 15 to 40) and `Your bounty increased by 25!`. Law: nothing. |

## I. Boat escape

| # | Do | Expect |
|---|---|---|
| I1 | Law runs `/scriptevent bounty:escape`. | `Only outlaws can use the escape boat.` |
| I2 | An outlaw runs it while another surviving outlaw is not at the boat (10, 65, 154 within 16 blocks). | `All surviving outlaws must gather at the escape boat!` (a jailed outlaw counts as a survivor and blocks it: old behavior). |
| I3 | All surviving outlaws at the boat, but together holding less than 250 coins per survivor. | `The gang needs 500 coins to escape.` and `Combined money: N` (for two outlaws). |
| I4 | All at the boat with enough. | `THE OUTLAWS HAVE ESCAPED!` and `The gang pooled 500 coins and escaped by boat!`; every surviving outlaw has `winner` and is teleported to (369.17, 63.06, -370.01). Eliminated outlaws are neither required nor winners. |

## Content log

Watch it through every step.

- **Must not appear:** `InvalidEntityError` anywhere, any `[Scripting][error]` line, and no chat line starting `[DEATH ERROR]`, `[SPAWN ERROR]`, `[EVENT ERROR]`, `[TICK ERROR]`, `[JAILBREAK ERROR]` or `[RESET ERROR]`. (Before this task, with an invalid dead handle, `endgame:law-win-check` threw `InvalidEntityError` on every death and `jail:capture` silently did nothing. A `[DEATH ERROR]` on a kill in section B means the record for the dead player was missing or a handler still touches the dead entity.)
- **Lines to look for** are the chat messages quoted above. This task adds no log line of its own.
- If a step in B fails, note whether A had spawned at least once since the world loaded (a player's record is created at their first spawn, or at load if they were already in the world), and whether the failure is "no capture message" (the record was not found) or "captured but respawned at an outlaw spawn" (the spawn handler did not see the pending jail).

## Not checked

- The game was not run for this task. Everything above is from the fake-API tests and from reading the code.
- Whether the real engine hands `entityDie` an invalid handle for a dead player (the tests cover both cases), and whether `Player.name` really throws on one (the code no longer depends on it: it takes the name from the scoreboard identity when the handle is invalid). If you see an `InvalidEntityError` in the log during B, that answers the first question.
- The `/tag <name> list` output format and the Content Log menu path are from memory of the Bedrock UI, not checked against the installed build. The claim that reopening the world re-adopts hand-set tags follows from the code (the addon runs its load-time adoption again) but was not tried.
