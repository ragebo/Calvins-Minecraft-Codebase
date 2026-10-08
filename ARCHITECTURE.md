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
| `commands.ts` | What every system that registers custom commands needs: `ok`/`failure` answers, the player behind a command (whoever typed it, or the one who pressed an NPC's button), and safe operator-only registration of a whole list (each command on its own, so one mistake cannot take the rest down). |
| `configoverrides.ts` | The curated registry of `config/guns.ts`/`balance.ts`/`world.ts` leaf fields `systems/liveconfig.ts`'s commands can edit live, mutating the real object in place and persisting the change — see `CLAUDE.md`'s custom-command-ids entry. |
| `director.ts` | The one shared "slot" the three scripted set-piece events (fort raid, ranch raid, train robbery) take turns through, replacing V1's hand-wired lock that could get stuck taken. |
| `economy.ts` | The only place coin/bounty scores are read or written, plus the scoreboard-existence check `preflight.ts` builds on. |
| `events.ts` | The one ordered `entityDie` dispatcher, plus the `onScriptEvent`/`onSpawn` registries. A script-event handler also gets the event's origin as a third argument (a typed command, a command block, or an NPC's dialogue button and the player who pressed it). |
| `forms.ts` | Shows a form to a player, retrying automatically when a right-click-opened form is refused as `UserBusy`; `confirmForm` is a yes/no where only the yes button counts. |
| `game.ts` | Starting a round (assign roles, send everyone to a spawn) — shared by the old script events and the in-game menu, since a system can't import a system. |
| `log.ts` | The one place a failure or diagnostic goes: console always, chat only for `error()`, and only to an operator. |
| `persist.ts` | The save/restore contract and engine — one world dynamic property per registered key, survives a world reload. |
| `players.ts` | Cached "which players are X?" queries (law, alive outlaws, spectators, ...), read from `core/state`, fetched at most once a tick. Also `isOperator(player)`, the one answer to "is this an operator?" outside `core/log.ts`. |
| `preflight.ts` | Startup checks — scoreboards, the train structure, every gun/ammo item id, every hardcoded coordinate — one combined `error()` if anything's wrong. |
| `raid.ts` | The shared wave-spawn/track/reward/cleanup engine a raid config plugs into. Fort does; ranch doesn't (see `systems/raids.ts`). |
| `recordstore.ts` | A generic store for things a builder authors in game: one world property per record, written at once, refused up front when over the size cap, unreadable ones listed and never overwritten, one level of undo. `shopstore.ts` is one instance; `robberystore.ts` has the same contract and could move onto it. |
| `registry.ts` | Where a system registers itself and its reset, so a round reset can never again forget one. |
| `robberyedit.ts` | The robbery framework's editing session without a screen: each builder's selected robbery (kept on the player), the one `applyEdit` every change goes through (pure edit, whole-robbery validation, no block claimed by two robberies, then the store), binding blocks (and saving what an item frame shows), and what a wand click means. |
| `robberyforms.ts` | Every screen the builder sees (menus, the add-element form, locks, requirements, effects, loot, settings, area), as presentation over `robberyedit.ts` and `logic/robberymeta.ts`. |
| `robberyrun.ts` | Playing a robbery: starting it (and the director's slot), who may touch what, the locks, completing elements (handing a frame's loot to the thief), effects, ending, undoing a punch on an item frame, and putting the site back through one idempotent janitor. One shared loop; nothing registered per robbery. |
| `robberystore.ts` | Where robberies live: one world property each, written at once on every edit, refused up front when over the size cap, unreadable ones listed and never overwritten, one level of undo. Also the saved list of blocks a run changed and has not yet put back. |
| `robberyworld.ts` | Everything a robbery does to blocks (swing a door, fill and empty a chest, empty an item frame and show it again from a saved one-block structure, chunk-loaded checks) in one place, because it is the one file that depends on engine behavior measured once. Never throws. |
| `round.ts` | The one `IDLE -> SETUP -> ACTIVE -> ENDING -> ENDED` phase machine. Also a `Persistable`: the phase itself is never restored into an active state. |
| `screens.ts` | Menu plumbing for a builder's screens: a title, some text and buttons, each button an action that may open another screen, and one menu of a kind open per player. The shop's screens use it; `robberyforms.ts` has its own copy of the same few lines. |
| `shopedit.ts` | What a builder does to shops without a screen: which shop they are working on (kept on the player), making and copying one, the one `applyEdit` every change goes through, deals made from what they hold, services made from what they type (the game is asked whether it knows the effect, enchantment or animal), where a teleport goes (typed, or where they stand) and who may take a deal. |
| `shopforms.ts` | Every shop screen: the customer's (a deal is bought all or nothing, one the customer may not take is greyed, and one that changed while the screen was open is not bought at its new price) and the builder's (deals, services, typed teleport destinations, who can take a deal, prices, greeting, copy, bringing the NPC here, the list to pick an NPC to move, delete, undo, and the wand's offer to make a plain NPC a shop). |
| `shopitems.ts` | Items between a shop's data and the game: reading what a builder holds (name, lore, enchantments, potion), making goods, and counting, taking and handing over items in a bag (a full bag drops the rest at the player's feet). |
| `shopnpc.ts` | The vanilla NPC that carries a shop: finding it (a dynamic property says which shop), making, moving and retiring it, and pointing it at the dialogue scene. Also where each shop's NPC was last put or seen (a world property), and bringing it to a builder from an area nobody is near: the area is loaded for a moment with a temporary ticking area, the NPC is moved, the area is let go, and a new NPC is made only when the remembered place loaded and held none. |
| `shopservices.ts` | What a deal does TO a customer: a potion effect, an enchantment on the item they hold, a tame mount, a teleport. Each is two halves: `prepareService` only reads (does the game know it, does the customer hold something it fits) and answers a reason or an `apply` and an `undo`, which is what lets a deal stay all or nothing. |
| `shopstore.ts` | Where shops live: `recordstore.ts` holding `logic/shop.ts`'s saved text, one world property each. |
| `shoptrade.ts` | Carrying out a deal all or nothing: the goods are made first, the customer's side, bounty and means checked and every service prepared, then the payment taken, the goods handed over and the services done; if the game throws part-way, the services done are undone and the bag (every slot) and the coins are put back exactly. |
| `sound.ts` | The one place `playSound` is called — `playFor` (private), `playAt` (positional, from a player), `playAtPoint` (positional, from a place, no player), `playSequence` (cue lists with a `shouldPlay` re-check). |
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
| `npcprobe.ts` | Measurement spike, not a feature: how the real game treats a vanilla NPC (`rae:npc_probe`). Does a click reach a script, does `cancel` stop the game's dialogue, can a script point an NPC at a dialogue scene, what does a scene's button report, does a spawned NPC keep its mark. See `docs/test-cards/NPC-PROBE.md`. |
| `probe.ts` | Measurement spike, not a feature: measures whether stacked `applyDamage` calls add up (`rae:probe_damage`). |
| `robberybuilder.ts` | Building a robbery in game: the wand (used on a block or on nothing), fifteen operator-only `rae:robbery_*` commands, and the builder view. Hands every click to `core/robberyedit.ts` and every screen to `core/robberyforms.ts`. |
| `robberyrun.ts` | The game-event side of playing a robbery: a right-click on a bound block (cancelled at once, the work a tick later), pressure plates and tripwires, a punch on an item frame (seen after the fact, with the item entities that just appeared), and protecting bound blocks from breaking and explosions. Hands everything to `core/robberyrun.ts`. |
| `robberyprobe.ts` | Measurement spike, not a feature: Phase 0 of the in-game robbery framework (`rae:robbery_probe`, `rae:robbery_probe_ctx`). Records how the real game reports a right-click on a chest, door, button or lever, whether `cancel` stops it, and what structures, loot tables and ticking areas allow, before the framework is built on any of it. See `docs/test-cards/ROBBERY-SPIKE.md`. |
| `raids.ts` | Two raids in one file — fort plugs into `core/raid.ts`'s shared engine; ranch is hand-rolled because its countdown-that-stretches-on-reinforcement doesn't fit that shape. |
| `roles.ts` | The template file every other system was ported to match, and where role assignment and `pickRandom` live. |
| `shopbuilder.ts` | Building a shop in game: fifteen operator-only `rae:shop_*` commands (hold an item and `/rae:shop_sell 60`; `/rae:shop_move Habiti` brings an NPC to you). A shop is named by its id or the name it was given. Hands the work to `core/shopedit.ts` and the screens to `core/shopforms.ts`. |
| `shoptalk.ts` | The player's side of a shop: a click on a shop NPC opens the shop (the "before" event cancelled, or the dialogue scene's one button running `rae:npc`). The wand edits, anything else plays. |
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
| `blockclass.ts` | What kind of block a type id is (door, trapdoor, gate, container, button, lever, plate, tripwire, item frame, other), by suffix, for the robbery framework. |
| `lockpick.ts` | The pick lock's rules (a hidden target, hot/cold pings, hits to open, a jam after too many misses), with the random source and the tick passed in. |
| `robbery.ts` | A robbery as data: elements (door, chest, item frame, switch), locks (pick, key, pay), requirements, effects, settings; immutable edits that validate the whole result; the saved short-key form; `parse` never throws. |
| `robberymeta.ts` | The builder's forms as data (a field list builds a form and reads its answers back into the validators) and the plain-language summaries of what was built. |
| `route.ts` | The train's track math: smoothing, distance, heading, speed, steering. |
| `schema.ts` | Config schema-version fingerprinting and migration for persisted data. |
| `shop.ts` | An NPC shop as data: a deal is a cost (coins, items, both or nothing), rewards (items, coins, or a service: effect, enchantment, mount, teleport) and optionally who may take it (law or outlaw, a least bounty), so buying, selling, item-for-item trades, gifts and services are one shape; immutable edits that validate the whole result; finding a shop by an id or a name a builder typed; reading typed coordinates; the saved short-key form; `parse` never throws. |

All eight hold to "no game imports" exactly as documented, modulo `bearing.ts`/`route.ts` each
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

One deliberate exception to rule 3: **data authored in game is world data, not config.** The recorded train
route (`systems/transit.ts`, a world dynamic property) is the precedent, and the robbery framework follows it:
the robberies a builder wires up with the wand (positions, names, loot, effects) are saved in the world (one
property per robbery, `core/robberystore.ts`), and `config/balance.ts`'s `ROBBERY` block holds only caps,
defaults and tuning. NPC shops follow the same deal (`core/shopstore.ts`, `config/balance.ts`'s `SHOP` block).

### The robbery framework's shape

It is deliberately core-heavy, and the reason is a rule, not taste: systems never import systems, and the legacy
ratchet flags a systems file importing a sibling, so anything two systems would share lives in `core/`, and each
system stays one thin file.

```
logic/robbery.ts       the data, its validation and edits        logic/lockpick.ts   the pick lock's rules
logic/robberymeta.ts   forms as data, plain-language summaries   logic/blockclass.ts what a block is
        |
core/robberystore.ts   saved robberies + the "blocks to put back" list     core/robberyworld.ts   doors, chests, frames, chunks
core/robberyrun.ts     playing one: locks, effects, ending, the janitor    core/robberyedit.ts    editing without a screen
core/robberyforms.ts   every builder screen
        |
systems/robberyrun.ts      game events -> core/robberyrun.ts (right-click, punches, plates, protection)
systems/robberybuilder.ts  the wand, the commands, the builder view
```

Two decisions carry the design. **Everything a before-event or command callback may not do is deferred**: those
callbacks are restricted (a typings-level `@privilege no-restricted-execution`, measured in the real game), so a
handler decides and cancels at once and hands the rest to `system.run`; the fake enforces the same rule
(`fake.strictBefore`). **Putting a site back is one idempotent path**: every block a run changes is noted in a
saved, position-keyed list *before* it changes, and a normal end, a manual reset, a round reset, a deleted
robbery, a crash and a reload all end with the janitor reading that list and restoring each block once its chunk is
loaded. What is not kept across a reload is the run itself; a reload ends a robbery in progress.

**Item frames are the one element a script cannot see into.** A frame is a block with a block entity, and the installed
typings have no item-frame API, so nothing can read what it shows or change it. The framework uses the only tools
there are: a frame's loot is set on the element and never read from the frame; a frame is emptied by replacing its
block with air and then the same permutation; and it is shown again by placing a one-block structure saved when it was
bound (`captureFrame`, `emptyFrame`, `restoreFrame` in `core/robberyworld.ts`). The structure's id is keyed by
position, like the janitor's list, so putting a frame back still works after its element has been edited or deleted.
A punch is reported only after it has happened (`playerStartBreakingBlock`, `entityHitBlock`) and the popped item
arrives as an `entitySpawn`, so `frameHit` in `core/robberyrun.ts` undoes it a few ticks later: it removes just the item
entities that appeared near the frame in that window (`systems/robberyrun.ts` tracks spawns, and only while some
robbery has a frame) and restores the frame. A punch whose item was never reported as a spawn is not undone; the
thief keeps that item. Because the script can never read a frame, it cannot know one was emptied behind its back, so a run
notes EVERY frame of its robbery in the janitor's list the moment it starts (`noteFrames`), and so does a manual reset:
whatever happened, the end of the run re-places each frame from its saved copy. For the same reason the edit layer
refuses to save a frame that is waiting to be put back (it may be empty, and the empty copy would be what comes back).
A frame is put back by clearing the spot and placing the saved copy as a NEW block (`restoreFrame`): placed over the frame
already standing there the copy filled it where nobody could see the item (the owner's report on BP 0.2.1, 2026-10-08).
All of this is built on typings and tests, not on a measurement; `docs/test-cards/ROBBERY-FRAME.md` is what turns it into one.

### The NPC shops' shape

A shop is data plus a screen, not a chain of NPC commands. The vanilla NPC only carries a shop id; a click opens a form; a purchase is one function that checks and then moves everything, so the failures a hand-typed button chain has (charging and then not giving, or giving and not charging) cannot happen.

```
logic/shop.ts          the deal model, validation, edits, the saved form
        |
core/recordstore.ts, shopstore.ts   saved shops               core/shopitems.ts   items <-> data, bags
core/shoptrade.ts      a deal, all or nothing                 core/shopnpc.ts     the NPC that carries a shop
core/shopservices.ts   what a deal does to a customer         core/shopedit.ts    what a builder does
core/shopforms.ts      every screen
        |
systems/shoptalk.ts      a click on a shop NPC, and the dialogue scene's button
systems/shopbuilder.ts   the /rae:shop_* commands
systems/npcprobe.ts      the measurement of how the game treats an NPC
```

How a click reaches the shop was unmeasured when this was built, so both routes were built and two live switches (`shop.interceptClicks`, `shop.useDialogueScene`) choose between them. Either the "before" event for a click on an NPC is cancelled and the shop opens a tick later (one screen, if the game honours the cancel), or the NPC is pointed at one static dialogue scene (`your_pack_name_BP/dialogue/rae_npc.json`) whose one button runs `/scriptevent rae:npc shop`. An NPC's button runs as the NPC with the pressing player as the initiator, which `core/events.ts` hands a handler as its `origin`. `docs/test-cards/NPC-PROBE.md` measured which works (2026-10-07): the first. The cancel stops the game's NPC screen, so `interceptClicks` stays on and the scene is the fallback, and what an operator's sneak-click lands on.

Moving an NPC has a shape of its own, because a script can only see an NPC in an area that is loaded and nobody is near most of the map. The world keeps one small property per shop (`rae:shop:at:<id>`, the dimension and whole-block position where its NPC was last put or seen; a placement, a customer's or the wand's click, and `/rae:shop_list` refresh it). Bringing an NPC to a builder (`bringShopNpc`) goes: loaded already, move it; else if a place is remembered, load that area with a temporary ticking area (`createTickingArea` resolves when the chunks are loaded and ticking), look for the shop's NPC for a second (a newly loaded area's entities can take a few ticks), move it while the area is still loaded, then remove the area; else it is gone. "Gone" is only ever concluded after the remembered place was loaded and searched, or when nothing is remembered, because a new NPC is made only from "gone": when the area will not load (no room, a refusal, a timeout) the answer is "stuck", nothing is made, and the builder is told where the NPC was last seen. One fetch runs at a time.

## `main.ts`: what it wires

Two kinds of content, both intentional:

- **Imports that register things.** `core/economy.ts`, `core/events.ts`, `core/game.ts`,
  `core/log.ts`, `core/preflight.ts`, `core/registry.ts`, `core/tick.ts` and `systems/roles.ts`'s
  `pickRandom` are imported for their exports. All 24 files in `systems/` are imported purely for
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
