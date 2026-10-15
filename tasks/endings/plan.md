# Implementation Plan: configurable endings (group and solo escapes)

Saved in `tasks/endings/` because `tasks/plan.md` and `tasks/todo.md` still hold the telemetry plan. The intent this plan serves was confirmed with the owner on 2026-10-15
(interview, no SPEC.md exists); it is restated under "What the owner asked for".

## Overview

The game has exactly two endings and both live in code. The law win (`systems/endgame.ts`) fires when every outlaw is jailed or eliminated. The outlaw win is the boat escape
(`systems/boat.ts`): the whole gang stands within `BOAT.escapeRadius` of a fixed NPC (`BOAT_NPC`), together holds `ECONOMY.boatEscapePerOutlaw` x survivors coins, and
`bounty:escape` is run (by an NPC button or a command block); the coins are taken, the round ends as `outlaw_win`, and the winners are teleported to `BOAT_WIN_TELEPORT`.
The place, the price, the radius, the text and the win spot are config constants; there is no way to add a second ending.

The new game needs about three endings, and the owner wants them built in game, as the start sequence and the robberies are. This plan makes an ending a stored record an
operator edits, with two types, and turns the boat escape into the first such record, behaving exactly as it does today.

## What the owner asked for (the confirmed intent)

- An ending is a TYPE plus details: a place, a price, an optional item, a message, an optional cinematic. About three ship with the new game; operators can add more.
- **Group ending**: a group of outlaws gathers at a place and pays a set amount PER MEMBER (configurable per ending). It ends the ROUND for everyone, is announced, and may play a cinematic.
- **Solo ending**: ONE outlaw stands at a place with the money or the item and wins by themselves. They are announced, taken off the outlaw registry (not jailed, not eliminated),
  and the round does NOT end; the other outlaws keep every other option.
- **The round** ends when a group ending fires, or when no outlaw is left in play (each one escaped, jailed or eliminated). The law's win stays what it is today (the outlaws
  left in play are all jailed or eliminated), and escaped outlaws do not count against it. The round-end announcement gives the tally ("N escaped, M captured").
- Out of scope: rewards (undecided), a Dead-by-Daylight-style scoring for the law (parked), fully custom endings built from arbitrary pieces.

## What I found in the code (read directly)

- `core/round.ts` owns the phase machine (`endRound(reason)` succeeds once, from ACTIVE). `EndReason` is `law_win | outlaw_win | aborted`; telemetry and a test read it.
- `core/players.ts` decides who is an outlaw: `outlaws()` (role outlaw), `aliveOutlaws()` (not eliminated), `freeOutlaws()` (not jailed). Their users are `systems/boat.ts`,
  `systems/endgame.ts`, `core/raid.ts` and `core/robberyrun.ts` (who to spawn guards for, who a robbery counts), and the harming level in `config/balance.ts`. An escaped outlaw
  must disappear from all of them, so the change belongs in `players.ts`, once.
- `core/state.ts` has a per-player `flags: Record<string, boolean>` ("small per-player booleans that don't merit a field yet"), persisted and merged, so "escaped" fits there without
  a schema change. The existing `winner` field and tag are reused for the escapers.
- Elimination turns a player into a spectator inside `systems/jail.ts` (`enterSpectator`, remembering the game mode they had, restored at reset). A system cannot import a system, so
  an escaper who should watch needs that logic in `core/`.
- Authored data is stored on `core/recordstore.ts` (the start sequence's shots and commands, shops, robberies): written at once, size-capped, unreadable never overwritten, one undo.
  "Never saved means the defaults" is its established rule (`core/startstore.ts`), which is how the boat ending can be seeded from today's config.
- Operator screens: `core/startforms.ts` opened by an operator-only button in `systems/menu.ts`. Marks are taken by standing (`standingPoint` in `core/configoverrides.ts`).
  The camera lives in `core/cinematic.ts` (`playShot`, `lock`, `unlock`, `clearCamera`) and the start sequence's `held` record protects a locked player.
- The boat's tests (`test/round-flow.test.mjs`, "boat win: ...") already characterize the whole boat flow, messages included. They are the safety net for the migration and must
  keep passing UNCHANGED.
- The boat's numbers are also live-config fields (`world.boatNpc`, `world.boatWinTeleport`, `economy.boatEscapePerOutlaw`, `boat.escapeRadius`) and preflight points. Once the
  boat is a stored record those fields would silently change nothing, so they have to go (the lesson of the melee config: a setting nothing reads is worse than none).

## Architecture

```
config/balance.ts     ENDINGS: caps (how many endings, how big one may be), the shipped boat defaults, the cinematic's seconds
logic/endings.ts      pure: the ending record (parse never throws, serialize, validate), edit operations, the group verdict (who is missing, what is owed,
                      how the cost is split), the solo verdict, the round tally, "is the round over"
core/endingstore.ts   the endings on core/recordstore.ts (rae:ending:<id>); never saved = the boat seeded from today's config; saved empty = no endings
core/endings.ts       the engine: attempt(player, id) for either type, the escaper leaving play, the round-over rule, the announcement, the cinematic; one registerSystem reset
core/spectate.ts      enterSpectator/leaveSpectator lifted out of systems/jail.ts so jail and endings share it (no behavior change for jail)
core/endingforms.ts   the operator screens (list, add, edit, place by standing, messages, cinematic marks, preview, delete)
systems/endings.ts    glue only: the scriptevents (rae:ending <id>, and bounty:escape as an alias of the boat ending) and the menu button; replaces systems/boat.ts
```

Layers stay `config <- logic <- core <- systems`; a system imports no system. `core/endings.ts` must not import `core/game.ts` (it is called by it).

## Decisions I made that the owner did not state (change any; the defaults hold unless said)

1. **The trigger is a script event**, `rae:ending <id>`, run from an NPC button or a command block, exactly how `bounty:escape` works today. `bounty:escape` stays as an alias of the
   ending with id `boat`, so the world's existing NPC keeps working. Standing in the place does nothing by itself.
2. **A group ending needs every outlaw still in play to be at the place**, jailed ones included (the boat's tested rule), and the price is `pricePerMember x outlaws in play`, paid from
   the pooled coins of the gathered group in the order the boat uses today. Escaped outlaws are no longer members.
3. **A solo ending is for one outlaw**: within the radius, holding at least `price` coins and/or the named item (a switch says whether the item is consumed). Both set means both.
4. **An escaper leaves play as a spectator** (like an eliminated player, with the game mode they had given back at reset), keeps the `winner` tag, is announced, and may be taken to a
   win spot. They cannot be hurt, jailed or counted by raids and robberies.
5. **All outlaws escaped ends the round as `outlaw_win`. Some escaped and the rest jailed or eliminated is `law_win`** (the law is judged on who is left in play), and the
   announcement says "N escaped, M captured". No new end reason.
6. **A cinematic is one pan** (a start mark and an end mark taken by standing, plus seconds) per ending, for `all` players or just the `winners`, played after the announcement.
   For a group ending the winners are teleported to the win spot after it. The existing intro shots are NOT shared: they are a random pool for intros.
7. **The boat's four live-config fields are removed** and preflight reads the endings' places instead. The boat ending is seeded from the old values only while nothing has been saved.
8. At most 12 endings; each ending's record is size-capped.
9. The ending's id appears in the telemetry `round.end` event, and a solo escape writes its own telemetry event.

## Task list

See `todo.md` (nine tasks in three phases, with checkpoints). Order and dependencies:

```
T1 pure model --> T2 store+boat seed --> T3 engine (boat becomes an ending, tests unchanged) --> [Checkpoint 1]
                                                            |
T4 escaped flag in players.ts --> T5 solo ending + round-over rule --> T6 tally + telemetry --> [Checkpoint 2]
                                                            |
T7 operator screens --> T8 cinematic --> T9 retire the boat config, docs, test card --> [Checkpoint: complete] --> T10 release (only when asked)
```

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The migration changes how the boat behaves | High (the outlaws' only way out) | The boat's tests run unchanged against the new engine at Task 3, including every message; the seed copies the old numbers; `bounty:escape` stays |
| An escaped player still counted somewhere (a raid, a robbery, the harming level) | Medium | One change in `players.ts`, with a test per caller, and a test that fails if a new query forgets the flag |
| Spectating an alive player (`gamemode spectator`) misbehaves, or its game mode is not given back | Medium | Reuse the tested elimination code; reset restores; unmeasured in the real game, so the test card asks |
| A cinematic left running at a round end locks players | Medium | It rides the start sequence's pattern: a generation number a reset moves on, every lock released by one function, and the safety net on join |
| Two endings fire in the same tick, or a group and a solo in the same tick | Medium | `endRound` already succeeds once; an escaper is marked before anything else runs; tests for both orders |
| An operator saves a bad ending (no place, a price below zero, the same id twice) | Low | `validate` refuses it with a reason shown on the screen; the record store refuses an oversized or unreadable save |
| Deleting an ending mid-round | Low | The engine reads the store at each attempt; a deleted ending simply cannot be attempted |

## Unmeasured in the real game (the test card will ask)

How the pan looks for several players at once at a round's end; whether `gamemode spectator` on an alive escaper behaves like an elimination; whether an NPC dialogue button can run
`rae:ending <id>` as it runs `bounty:escape`; what an escaper sees.

## Open questions for the owner (none block starting)

- Should stepping into an ending's place fire it automatically for a solo escape, instead of needing an NPC or command block? (Not built; a later task if wanted.)
- Is "spectator" right for an escaper, or should they keep playing as a bystander?
- Rewards, and how the law is scored, when you decide them.
