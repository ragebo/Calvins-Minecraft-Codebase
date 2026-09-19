# STATE-ADOPT test card: a role typed by hand reaches the records, and `rae:adopt`

Not an ARCH task: added on request after ARCH-03. Roles and status live in one record per player (`core/state`) and the tags are output. Hand-typed tags used to be ignored once a player had a record. Now `core/state` looks for tags that changed without it (about once a second) and adopts them, and `/scriptevent rae:adopt` makes the same check immediately and lists what each record says.

`npm test` pins this against a fake game (`state-adopt.test.mjs`, 22 tests, each one broken on purpose at least once to confirm it can fail). This card checks the real game, where none of it has been tried yet.

**Adopting only changes what the game believes.** Typing `/tag @s add eliminated` does not put you in spectator mode, and `/tag @s add in_jail` does not teleport you to a jail. The record says so; nothing acts on it until the next time a system looks.

## Setup

1. From `rae/`: `npm run build`, deploy, and bump the behavior pack version and the world's pin (README, "Building and testing").
2. One player is enough. Cheats on, Content Log GUI on (Settings > Creator > Enable Content Log GUI), chat visible.
3. `/scriptevent rae:reset`, so nobody has a role or status tag.

`bounty:lockpick` is the probe: it reads the record, and its reply depends on the role. Law or no role: `Only outlaws can attempt this.` An outlaw with nobody in jail: `No one is currently jailed.`

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | `/scriptevent rae:adopt` | Chat: `Adopt: 1 read, 0 changed` and `  <you>: no role`. (It says `1 changed` if you ran it within a second of the reset: the reset forgot your record, and adopting it again counts.) |
| 2 | `/scriptevent bounty:lockpick` | `Only outlaws can attempt this.` |
| 3 | `/tag @s add outlaw`, wait 2 seconds, then `/scriptevent bounty:lockpick` | `No one is currently jailed.` The reply changed because the record now says outlaw, and only the poll could have told it. |
| 4 | `/scriptevent rae:adopt` | `Adopt: 1 read, 0 changed` and `  <you>: outlaw`. (0 changed: the poll already caught it. Typing both commands in under a second gives `1 changed`; either is fine.) |
| 5 | `/tag @s add law`, wait 2 seconds, then `/tag @s list` | Only `law`. The `outlaw` tag was taken off, so a player never carries both. |
| 6 | `/scriptevent bounty:lockpick` | `Only outlaws can attempt this.` |
| 7 | `/tag @s add outlaw`, wait 2 seconds, then `/tag @s list` | Only `outlaw`. Adding the other role's tag switches you, in this direction too. |
| 8 | `/tag @s remove outlaw`, wait 2 seconds, then `/scriptevent rae:adopt` | `  <you>: no role`. |
| 9 | `/tag @s add eliminated`, `/tag @s add in_jail`, wait 2 seconds, then `/scriptevent rae:adopt` | `  <you>: eliminated in_jail`. Nothing else happens to you (see the note above). |
| 10 | `/tag @s add vip`, wait 2 seconds, then `/scriptevent rae:adopt` | Unchanged from step 9: a tag the game doesn't manage is ignored. `/tag @s list` still shows `vip`. |
| 11 | `/scriptevent rae:reset`, then `/scriptevent rae:adopt` | All the game's tags are gone (`vip` stays: it isn't the game's). `  <you>: no role`. |
| 12 | With two players: `/scriptevent bounty:start_round`, wait for `Roles Assigned!`, then `/scriptevent rae:adopt` | One line per player, each matching that player's `/tag @s list`, and `0 changed`: the game wrote those tags itself, so there was nothing new to adopt. |
| 13 | From two chained command blocks: first `/tag @a add outlaw`, then `/scriptevent rae:adopt` | Everyone's record says outlaw (a later `/scriptevent rae:adopt` typed in chat lists it). The block itself prints nothing: a command block can't read chat. |

The wait is `STATE_SYNC.reconcileIntervalTicks` in `config/balance.ts` (20 ticks, one second). Two seconds is a margin.

## Content log

- Must not appear: `[TICK ERROR] state:reconcile`, `[EVENT ERROR] rae:adopt`, `InvalidEntityError`.
- This change adds no log line of its own.

## Not checked

- The game was not run for this change. Everything above comes from the fake-API tests and from reading the code and the typings (`Entity.getTags(): string[]` is there). Whether the real engine returns tags in a way that makes the poll's comparison behave (the comparison is by set, so order does not matter) has not been observed.
- The cost in a real world. The poll makes one `getTags()` call per player per second and reuses the tick's shared player list, and the fake API confirms that count. It has not been timed in game.
- A dead player who is still in the world's player list: a record with a change waiting to be written (a kill in progress) is deliberately left alone by the poll. That path is tested with a fake dead handle, not with a real death.
