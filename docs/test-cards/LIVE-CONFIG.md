# LIVE-CONFIG test card: tune guns, coordinates and balance numbers without a redeploy

Added on request: every tunable number and coordinate in this addon used to be a compiled-in
TypeScript constant, so changing one meant edit, rebuild, redeploy, and relaunch. Six commands now
let an operator change one while the game is running, with the change applying immediately and
surviving a world reload — no redeploy, no relaunch.

- `/rae:config_list [category]`, `/rae:config_get <field>`, `/rae:config_set_number <field> <value>`,
  `/rae:config_set_bool <field> <value>`, `/rae:config_set_coordinate <field> <value>`,
  `/rae:config_reset <field>`. Every `field` argument is tab-completed by the game itself.
  `_set_coordinate`'s value accepts Bedrock's own relative syntax (`~ ~ ~` for where you're standing).
- **Operator only.** Unlike every other command in this addon, these are real custom commands
  (`CustomCommandRegistry`, not `/scriptevent`), so the permission check is the engine's own — a
  non-operator should see the command refused before it ever reaches this addon's code at all.
- `core/configoverrides.ts` is the registry (every gun's balance numbers, every named coordinate in
  `config/world.ts`, and the gameplay-tuning namespaces in `config/balance.ts` — not internal
  engine/measurement-tool settings, and not a few fields proven stale-cached regardless, see its own
  header comment). `systems/liveconfig.ts` is the six commands, which only talk to that registry.
- This is the first thing in this codebase built on `CustomCommandRegistry` — real autocomplete and an
  engine-enforced permission level are things a plain `/scriptevent` cannot give, which is why it was
  chosen despite being new ground here. If anything about it doesn't behave the way the installed API
  types describe, that's exactly what this card exists to catch.

Behavior pack **0.1.38**, resource pack unchanged (no UI/asset files touched — everything here is
chat/command output).

`npm test` covers: setting a field mutates the real `GUNS`/`config/balance.ts`/`config/world.ts`
object in place (not a copy); a vector3 field keeps its object identity so every other reference to it
(the game menu's own teleport list) sees the edit too; bad input (non-finite, wrong type, a non-whole
number for a whole-number field, out of a field's declared range, a coordinate outside the Overworld
build limit) is refused with the live value left unchanged; reset reverts to the exact compiled
default after several edits; an unknown field id is refused cleanly everywhere, never thrown; a
non-operator is refused and an operator is allowed; a live edit survives a real save/restore round
trip through `core/persist.ts`; a saved override for a field that no longer exists is skipped and
reported while the rest still restore; the three stale-cached fields (the scripted train's
start/end/speed numbers) are never registered; every command is built with
`CommandPermissionLevel.GameDirectors` and the right field-kind enum. None of this can say whether the
command bar actually shows the autocomplete, whether `~ ~ ~` really works, or whether the engine's own
permission refusal looks the way a player would expect — that's what this card is for.

## Steps

You need operator rights. A second, non-operator account helps for steps 9–10 but isn't required.

| # | Do | Expect |
|---|---|---|
| 1 | Type `/rae:config_get ` (with the trailing space) and wait. | A dropdown of field ids appears, tab-completable — try typing `revolver` and see it filter. |
| 2 | `/rae:config_get revolver.fireRateTicks`. | Reports the current value and label, e.g. `revolver.fireRateTicks = 8 (Revolver: fire rate (ticks))`. |
| 3 | `/rae:config_list Guns`. | A multi-line list of every gun field and its current value. `/rae:config_list` with no category lists everything; an unknown category name is refused cleanly. |
| 4 | Hold the revolver and start aiming (don't stop). While still aiming, in another window/tab run `/rae:config_set_number revolver.fireRateTicks 2`. Keep firing without re-equipping. | The gun fires noticeably faster within a shot or two — no need to stop aiming or re-draw the gun. |
| 5 | `/rae:config_set_number revolver.fireRateTicks 0`. | Refused: a whole-number/range reason, and the live fire rate is unchanged from step 4. |
| 6 | `/rae:config_reset revolver.fireRateTicks`. | Back to the original value (8). `/rae:config_get` confirms it. |
| 7 | Stand somewhere reasonable, then `/rae:config_set_coordinate world.lawSpawn.1 ~ ~ ~`. Die (or have a law player die) and respawn. | The respawning law player lands where you stood, not the original spawn point. |
| 8 | `/rae:config_set_coordinate world.lawSpawn.1 999999 999999 999999`. | Refused: a build-limit/finite reason, and the spawn point from step 7 is unchanged. |
| 9 | As a non-operator (or temporarily `/op` yourself off), try any `/rae:config_*` command. | The game itself refuses it — this should look like trying any other op-only vanilla command, not an addon-specific error. |
| 10 | `/rae:config_set_bool revolver.aim.scope true`, then aim the revolver. | The scope overlay now shows while aiming the revolver, same as the bolt-action rifle's. `/rae:config_reset revolver.aim.scope` turns it back off. |
| 11 | Repeat steps 2, 4 and 7's edits, then **fully close and relaunch Minecraft**, rejoin the world. | Every edit is still in effect — this is the headline ask. Reset whatever you don't want to keep afterward. |
| 12 | `/scriptevent rae:persist_reset`. | Chat says saved data was cleared, "takes effect on the next load" — the live values from step 11 do NOT change immediately (same as every other persisted key); only a relaunch after this would revert them. |

## What to tell me

1. Does tab-completion actually appear for `field` on every command, and does it narrow sensibly as
   you type (e.g. typing a gun's name filters to that gun's fields)?
2. Does `~ ~ ~` (and a partial relative coordinate like `~5 ~ ~-3`) work for `_set_coordinate`?
3. What does the non-operator refusal in step 9 actually look like — does it read like a normal
   permission error, or does something from this addon's own code leak through?
4. Anything broken: a command that doesn't appear at all, an edit that doesn't take effect, a value
   that reverts on its own, or anything in the content log below.

## Content log

Must not appear: any `[Scripting][error]` line, `[configoverrides] ...`, `[persist] "config-overrides"
...`, or an uncaught exception naming `liveconfig` or `customCommandRegistry`.

## Not checked

Whether every single registered field (there are well over a hundred) actually works is not
exhaustively hand-tested here — the steps above sample across guns, world coordinates and a balance
number, on the theory that if the registry/command mechanism works for one of each kind, it works for
all of them (they're all built from the same few code paths). If a specific field misbehaves, say
which one.
