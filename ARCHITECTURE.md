# RAE Architecture

What the pieces of `rae/src` are for and how they fit together, as of the ARCH epic finishing
(2026-09-29, `v2`). For the rules agents must follow while editing this codebase — the seven rules,
the git-worktree workflow, the definition of done — see `CLAUDE.md`; this document doesn't restate
them, only cross-references them, so there is exactly one place they can drift out of date.

## The seven rules

`CLAUDE.md`'s "The seven rules" section is canonical. In one sentence each: layers only point
downward (`config <- logic <- core <- systems`); a system never imports another system; every
number and coordinate lives in `config/`; mutable game state lives in `core/state`, tags are
output only; `core/ui`, `core/sound`, `core/log` and `core/director` are each the one writer for
their channel; a system self-registers, so adding one edits no shared file; every change ships a
test. All four of rule 5's modules are real now — `core/sound.ts` and `core/log.ts` were the last
two to land, in this same epic.

## Layout at a glance

`CLAUDE.md`'s own layout table gives the folder-level picture. This is the file-level one:
what each file in `core/`, `systems/`, `logic/` and `config/` actually owns, in the words of its
own header comment where it has one.

### `rae/src/core/` — shared engines and contracts

| File | Owns |
|---|---|
| `aim.ts` | Camera zoom and the scope overlay — one place so guns and the aim-measurement spike do it the same way. |
| `ambience.ts` | The on/off toggle for cosmetic effects (tumbleweeds) — lives here because the system that acts on it and the system that lets a player flip it can't import each other. |
| `configoverrides.ts` | The curated registry of `config/guns.ts`/`balance.ts`/`world.ts` leaf fields `systems/liveconfig.ts`'s commands can edit live, mutating the real object in place and persisting the change — see `CLAUDE.md`'s custom-command-ids entry. |
| `director.ts` | The one shared "slot" the three scripted set-piece events (fort raid, ranch raid, train robbery) take turns through, replacing V1's hand-wired lock that could get stuck taken. |
| `economy.ts` | The only place coin/bounty scores are read or written, plus the scoreboard-existence check `preflight.ts` builds on. |
| `events.ts` | The one ordered `entityDie` dispatcher, plus the `onScriptEvent`/`onSpawn` registries. |
| `forms.ts` | Shows a form to a player, retrying automatically when a right-click-opened form is refused as `UserBusy`. |
| `game.ts` | Starting a round (assign roles, send everyone to a spawn) — shared by the old script events and the in-game menu, since a system can't import a system. |
| `log.ts` | The one place a failure or diagnostic goes: console always, chat only for `error()`, and only to an operator. |
| `persist.ts` | The save/restore contract and engine — one world dynamic property per registered key, survives a world reload. |
| `players.ts` | Cached "which players are X?" queries (law, alive outlaws, spectators, ...), read from `core/state`, fetched at most once a tick. |
| `preflight.ts` | Startup checks — scoreboards, the train structure, every gun/ammo item id, every hardcoded coordinate — one combined `error()` if anything's wrong. |
| `raid.ts` | The shared wave-spawn/track/reward/cleanup engine a raid config plugs into. Fort does; ranch doesn't (see `systems/raids.ts`). |
| `registry.ts` | Where a system registers itself and its reset, so a round reset can never again forget one. |
| `round.ts` | The one `IDLE -> SETUP -> ACTIVE -> ENDING -> ENDED` phase machine. Also a `Persistable`: the phase itself is never restored into an active state. |
| `sound.ts` | The one place `playSound` is called — `playFor` (private), `playAt` (positional), `playSequence` (cue lists with a `shouldPlay` re-check). |
| `state.ts` | The per-player record (role, eliminated, jail, ammo, flags), keyed by id. Tags are output only, adopted back on drift. |
| `telemetry.ts` | Round-by-round history (outcome, kills, deaths, ending coin total). Deliberately outside the round-reset system: it must survive the reset of the round it's recording. |
| `tick.ts` | The one `system.runInterval`. Every repeating job is a cadence-aware handler registered with `onTick`. |
| `ui.ts` | The one writer for title/action bar/chat text, arbitrated by source and priority so one line can't silently overwrite another. |

Five of these fit the "engines and contracts" label more loosely, worth knowing going in:
`telemetry.ts` and `configoverrides.ts` are both `Persistable`-only with no `registerSystem` hook by
design (a round reset must never erase round history or a live-tuned value); `game.ts` is
domain-specific round-start logic shared by two callers, not generic infrastructure; `preflight.ts`
is a one-shot startup validator; `ambience.ts` is a single shared boolean. None of that is a
problem — the label just describes most of the folder, not a strict rule every file satisfies.

### `rae/src/systems/` — one file per gameplay system

| File | Owns |
|---|---|
| `aimprobe.ts` | Measurement spike, not a feature: logs raw swing/use/drop/input signals to the content log (`rae:aim_spike`). |
| `boat.ts` | The outlaws' win: escape by boat once every survivor is near it with enough combined coin. |
| `compass.ts` | The law's locator — an action-bar bearing strip toward the nearest, or highest-bounty, outlaw. |
| `economy-rules.ts` | The death penalty (drop inventory, coin gain/loss) for any cause of death, not just a kill. |
| `endgame.ts` | Law's win: every outlaw eliminated or jailed, with nobody left who could ever attempt a rescue. |
| `gold.ts` | Converts gold nuggets/ingots/blocks landing in an inventory into coins. |
| `guns.ts` | One shared firing engine for all 7 guns — hitscan shotguns, projectile guns, manual priming, the manned Gatling gun — parameterized entirely by `config/guns.ts`. |
| `horse.ts` | Standardizes a spawned horse's state. |
| `jail.ts` | Picks the active jail site; a first capture jails an outlaw, a second eliminates them. |
| `jailbreak.ts` | The lockpick/rescue minigame for freeing a jailed outlaw. |
| `liveconfig.ts` | The `rae:config_*` custom commands (list/get/set/reset) that edit `core/configoverrides.ts`'s registry live, each operator-gated and autocompleted by the engine itself. |
| `menu.ts` | The in-game menu item: start or reset the game, teleport to the key places. |
| `probe.ts` | Measurement spike, not a feature: measures whether stacked `applyDamage` calls add up (`rae:probe_damage`). |
| `raids.ts` | Two raids in one file — fort plugs into `core/raid.ts`'s shared engine; ranch is hand-rolled because its countdown-that-stretches-on-reinforcement doesn't fit that shape. |
| `roles.ts` | The template file every other system was ported to match, and where role assignment and `pickRandom` live. |
| `train.ts` | The train-robbery structure swap and its movement (backup/restore, wave timing) — a different "train" from `transit.ts`. |
| `transit.ts` | Self-described spike: the route recorder plus a one-car momentum/teleport experiment, driven by `logic/route.ts`'s math. |
| `tumbleweed.ts` | A purely ambient rolling entity — real physics plus a custom roll animation; its own header documents the resulting gunfire-passthrough trade-off. |

"One file per gameplay system" is the right mental model but not literally true everywhere:
`aimprobe.ts` and `probe.ts` say so themselves ("a measurement, not a game feature");
`transit.ts`'s own header calls itself "SLICE 1... a spike"; `roles.ts` doubles as the porting
template; `raids.ts` is two raids; `endgame.ts`/`boat.ts` are the two symmetric halves of one win
condition, in separate files. None of this needs fixing — it's just what's actually there.

### `rae/src/logic/` — pure rules, no game imports

| File | Owns |
|---|---|
| `bearing.ts` | Compass direction math and display. |
| `route.ts` | The train's track math: smoothing, distance, heading, speed, steering. |
| `schema.ts` | Config schema-version fingerprinting and migration for persisted data. |

All three hold to "no game imports" exactly as documented, modulo `bearing.ts`/`route.ts` each
importing `Vector3` as a type only (erased at compile time, so it costs nothing at runtime).

### `rae/src/config/` — numbers and coordinates, mostly

| File | Owns |
|---|---|
| `balance.ts` | Every tunable number. |
| `guns.ts` | Every gun and ammo stat — plus their item ids, display names and sound-cue ids, which aren't numbers at all. |
| `world.ts` | Every coordinate — plus the train structure's name and the Overworld's build-limit Y bounds. |

`guns.ts` in particular holds real identifier and label strings alongside its numbers. That's a
minor stretch of "numbers and coordinates only," not a violation worth fixing: those strings need
exactly one home too, and `config/guns.ts` is already it for everything else about a gun.

## `main.ts`: what it wires

Two kinds of content, both intentional:

- **Imports that register things.** `core/economy.ts`, `core/events.ts`, `core/game.ts`,
  `core/log.ts`, `core/preflight.ts`, `core/registry.ts`, `core/tick.ts` and `systems/roles.ts`'s
  `pickRandom` are imported for their exports. All 18 files in `systems/` are imported purely for
  their self-registration side effect (per rule 6, importing a system is what makes it exist — order
  never matters, since handler ordering is declared explicitly wherever it's registered).
  `core/telemetry.ts` is imported the same way, for its `onDeath`/`onPhase`/persist registrations.
- **Six top-level registrations:** `rae:debug` (prints registered systems, event ids, and the
  scoreboard check), `rae:reset` (calls `resetGame()`), a startup `system.run` (announces load,
  runs `runPreflightChecks()`), and three `onSpawn`/`onTick` handlers — see below.

### The three pieces of gameplay logic still living in `main.ts` directly

Backlog item **SYS-17** already targets two of these for relocation into their own system files
("Move the water poison rule and the spawn glue... `main.ts` should hold the imports and the debug
commands only"):

1. **`main:respawn-placement`** (`onSpawn`, order 200) — sends anyone with a `law`/`outlaw` tag that
   nothing earlier has already placed to a random point from `LAW_SPAWNS`/`OUTLAW_SPAWNS`. This is
   SYS-17's "spawn glue."
2. **`main:water-poison`** (`onTick`, every tick) — applies vanilla poison to any player standing in
   water. This is SYS-17's "water poison rule."
3. **`main:saturation`** (`onSpawn`, order 0) — grants every spawning player an effectively
   permanent vanilla `saturation` effect (hunger prevention). **Not what it sounds like:** an earlier
   version of this document's own planning pass mis-read this as a guard against too many players
   spawning on top of each other and called it "spawn saturation." It is not that — it is the
   ordinary Minecraft status effect that keeps a player from getting hungry, unrelated to spawn
   crowding. SYS-17 doesn't currently name it; whether it's worth moving alongside the other two is
   an open call, not a bug.

**A real gap, found while writing this doc, not yet on any backlog item:** neither
`main:respawn-placement` nor `core/game.ts`'s `teleportToSpawn()` (the menu/script-event path for
the same thing) has any guard against two players landing on the exact same spawn point — each just
calls `pickRandom` on the spawn list independently. If that's ever visibly happened, it isn't a
regression; the placement logic has always worked this way.

## Deliberate exceptions to rule 2 (no import cycles)

Three call sites read the full player list directly (`world.getAllPlayers()`) instead of going
through `core/players.ts`'s cached queries, every one of them because routing through
`core/players.ts` would create a real cycle, not because anyone forgot:

- **`core/registry.ts`** and **`core/state.ts`** — `core/players.ts` already imports `core/state.ts`,
  so either of these routing back through `core/players.ts` closes a cycle (`registry -> players ->
  state -> registry`, or the symmetric path through `state`). Neither call site runs often enough to
  need the cache (a handful of times per round, or an on-demand admin command).
- **`core/log.ts`**'s `error()` — needs the full player list to find online operators to message.
  `log.ts` is deliberately standalone (`registry.ts`, `economy.ts`, `tick.ts`, `events.ts`,
  `game.ts`, `round.ts` and `director.ts` all call into it, and several of those sit underneath
  nearly everything else in `core/`), so it cannot import anything from `core/` — including
  `core/players.ts` — without risking exactly that cycle.

If a future change ever "fixes" one of these into going through `core/players.ts`, check for a
cycle first — that's exactly what each one is avoiding.

## What this doesn't cover

Nothing here is about `your_pack_name_BP`/`BountySys_RP` (the compiled behavior/resource packs) or
the deploy process — see `README.md` for the gun/train/tumbleweed feature-level detail, and ask
about deploy steps rather than assume; they're operational, not architectural, and change more
often than this document should.
