# LIVE-CONFIG test card: tune guns, coordinates and balance numbers without a redeploy

Every tunable number and coordinate in this addon used to be a compiled-in TypeScript constant, so changing one meant edit,
rebuild, redeploy, and relaunch. `/rae:config` changes one while the game is running, with the change applying immediately and
surviving a world reload.

**Reworked on 2026-10-11 (not deployed yet; it ships in the next behavior pack after 0.2.4).** There were six commands
(`config_list`, `_get`, `_set_number`, `_set_bool`, `_set_coordinate`, `_reset`), and with the robbery (16) and shop (15)
commands typing `/rae:` listed 38 entries. Now there is ONE command per area, three in all (`/rae:config`, `/rae:robbery`,
`/rae:shop`), and `/rae:config` typed alone opens an **editor**.

- `/rae:config` with nothing after it opens the editor. `/rae:config list`, `get <field>`, `set <field> <value>`,
  `reset <field>` and `help` are the typed way. The `field` is tab-completed by the game from the list of every setting's id.
- A value is a number, `on`/`off` for a switch, or a position: `here` (the middle of the block you stand in), `x y z` in quotes
  (or `x,y,z`), or `~ ~ ~` (also the middle of your block; `~ ~1 ~-2` is one up and two back from it).
- **Operator only.** The engine itself refuses a non-operator before the addon's code runs.
- `core/configoverrides.ts` is the registry (every gun's balance numbers, every named coordinate in `config/world.ts`, and the
  gameplay-tuning namespaces in `config/balance.ts`). `core/configforms.ts` is the editor and `systems/liveconfig.ts` the command;
  both only talk to the registry.
- The one command is built differently from the six it replaces: **every parameter is optional** (an optional list of actions
  first, then the field, then a value). The old commands had mandatory parameters. The typings allow it and the tests' stand-in for
  the engine accepts it, but whether the real game completes and runs it that way is exactly what this card is for.

`npm test` covers: the registry's rules (a bare enum name, an enum used before it exists, the permission level); every action;
a number out of range or not whole refused with what the setting takes and the value left alone; `here`, `~` and typed positions;
the editor's groups, search, changed list, the right control per kind, a result shown at the top of the next screen, a refused
value shown again with what was typed, the put-it-back switch; and that exactly three `/rae:` commands exist. None of that can say
how the command bar looks, whether the editor opens while the chat is still up, or what a real refusal looks like.

## Steps

You need operator rights. A second, non-operator account helps for step 13 but isn't required.

| # | Do | Expect |
|---|---|---|
| 1 | In chat type `/rae:` and look at the list. | **Three entries**: `rae:config`, `rae:robbery`, `rae:shop`. (Before: 38.) |
| 2 | Type `/rae:config ` (with the trailing space). | The list of actions appears (list, get, set, reset, help). **If it does not, or the command does not appear at all, tell me first**: it means the game does not accept a command whose parameters are all optional, and the design needs another shape. |
| 3 | `/rae:config help`. | One line for the bare command and one per action, each with what follows it. |
| 4 | Type `/rae:config get ` and wait. | A dropdown of setting ids, tab-completable. Type `revolver` and see it filter. |
| 5 | `/rae:config get revolver.fireRateTicks`. | Its value, label, default and what it takes, e.g. `revolver.fireRateTicks = 8  (Revolver: fire rate (ticks); default 8; a whole number, at least 1)`. |
| 6 | `/rae:config list`. | "Nothing is changed from the default" and the list of groups with their sizes. |
| 7 | Hold the revolver and start aiming (don't stop). While still aiming, run `/rae:config set revolver.fireRateTicks 2`. Keep firing without re-equipping. | The reply says `revolver.fireRateTicks: 8 -> 2.` The gun fires noticeably faster within a shot or two. |
| 8 | `/rae:config list` again. | It now lists `revolver.fireRateTicks = 2  (default 8)` under "Changed from the default (1)". |
| 9 | `/rae:config set revolver.fireRateTicks 0`, then `... 2.5`, then `... fast`. | Each refused in words that name the setting and what it takes; the fire rate stays at 2. |
| 10 | `/rae:config reset revolver.fireRateTicks`. | Back to 8, and the reply says it is the default. |
| 11 | Stand somewhere reasonable, then `/rae:config set world.lawSpawn.1 here`. Die as law (or have a law player die) and respawn. Then try `~ ~ ~`, `"10 70 20"` and `10,70,20`. | The respawning law player lands where you stood. All four position forms work. |
| 12 | `/rae:config set world.lawSpawn.1 999999 999999 999999` (quote it: `"999999 999999 999999"`). | Refused: a build-limit reason, and the spawn point is unchanged. |
| 13 | As a non-operator (or after taking your own operator off), try `/rae:config`. | The game itself refuses it, like any other operator-only vanilla command. |
| 14 | `/rae:config set revolver.aim.scope on`, then aim the revolver. | The scope overlay shows while aiming. `/rae:config reset revolver.aim.scope` turns it off. |

### The editor

| # | Do | Expect |
|---|---|---|
| 15 | `/rae:config` with nothing after it, then close the chat. | The editor opens: "Find a setting by name...", a button per group with its size (Guns, World, Economy, ...), and Close. The text says how many settings there are and how many are changed. **If it does not open while the chat is up, or only after you close it, say which.** |
| 16 | Press **Economy**, then **Economy: coins per gold ingot**. | A box for a whole number, labelled with what it takes, holding the current value. |
| 17 | Type a new number and submit. | You land back on the Economy list. **At the top of it**: `Economy: coins per gold ingot: 10 -> 12.` and that setting is marked `(changed)`. Nothing was said in chat. |
| 18 | Open that setting again and type `-5`. | The **same form comes back**, its title `Not saved: must be at least 0...`, with `-5` still in the box. Type `7` and it saves. |
| 19 | Open it again. | There is now a second switch, "Put it back to the default (10)". Turn it on and submit: the next screen says it is back to its default. |
| 20 | Go back to the first screen. Press **Guns**. | It lists the guns (Revolver, Repeater, ...) instead of 65 buttons; a gun's part shows plain names (`fire rate (ticks)  =  8`). |
| 21 | Press **Find a setting by name...** and type `reload`. | A list of every reload setting of every gun. Type `zzzz` instead: "Nothing is called zzzz" at the top of the first screen. Type a letter such as `e`: the first 40, with a note to type more. |
| 22 | Change two settings, then reopen the editor. | A **Changed from the default (2)** button appears on the first screen, and the text says 2 are changed. |
| 23 | Open a position (World, then Boat escape NPC). Turn on "Use the block I am standing on instead" and submit. | The position becomes the middle of your block (x.5, y, z.5). Type letters in X instead: refused, the form back with them still typed. |
| 24 | Repeat steps 5, 7 and 11's edits, then **fully close and relaunch Minecraft**, rejoin the world. | Every edit is still in effect: this is the headline ask. Reset whatever you don't want to keep afterward (the editor's "Changed" list shows them all). |
| 25 | `/scriptevent rae:persist_reset`. | Chat says saved data was cleared, "takes effect on the next load": the live values from step 24 do NOT change immediately; only a relaunch after this would revert them. |

## What to tell me

1. Step 1 and step 2 first: three entries, and the action list after `/rae:config `. Everything else depends on them.
2. Does the field list in step 4 appear and narrow as you type?
3. Does the editor open while the chat is still up (steps 15 and 16 are the first time this codebase opens a form straight from a
   command)? Is the notice at the top of the next screen easy to see, or do you miss it?
4. Do the position forms in step 11 all work, and is "the middle of the block I stand in" what you meant by `here` and `~ ~ ~`?
5. What does the non-operator refusal in step 13 actually look like?
6. Anything broken: a command that doesn't appear, an edit that doesn't take effect, a value that reverts on its own, or anything
   in the content log below.

## Content log

Must not appear: any `[Scripting][error]` line, `[configoverrides] ...`, `[persist] "config-overrides" ...`, `registering rae:config
failed`, or an uncaught exception naming `liveconfig`, `configforms` or `customCommandRegistry`.

## Not checked

Whether every single registered field (there are well over a hundred) actually works is not exhaustively hand-tested here: the
steps sample across guns, world coordinates and a balance number, on the theory that if the registry mechanism works for one of
each kind, it works for all of them (they're all built from the same few code paths). If a specific field misbehaves, say which one.
