# 0005: Jails are stored records, and a bound block starts the lockpick

## Status
Accepted. Decided 2026-10-27 on the owner's request ("add multiple jails and be able to assign buttons to pick lock the jails"); built the same day.

## Context
There were exactly two jails, written into `config/world.ts` (`JAIL_SITES`: where prisoners are put, and the block where a redstone block is placed to open the door). A captured outlaw was sent to one at random while the jail was empty, and prisoners shared it. The lockpick minigame (`systems/jailbreak.ts`) was started **only** by the script event `bounty:lockpick`, which an operator had to wire to a command block at each jail. To add a jail, or to move one, the code had to be changed and redeployed. The lockpick itself is one global instance (one hit counter, one hidden target, one abandon timer) that assumes a single jail holds prisoners at a time.

## Decision
- A jail is a record (a name, a spot, an optional door trigger, up to eight buttons, on or off), saved one world property each (`rae:jail:<id>`) on `core/recordstore.ts`, edited on operator-only screens opened from a **Jails** button in the RAE menu (see 0001, and `core/endingstore.ts` as the model). A world that has never saved a jail has the config's two, built at the moment they are asked for; the first save makes both real.
- A **button** is any block an operator has bound to a jail: a button, a lever, a door, anything. A right-click on it is cancelled and, a tick later, starts the lockpick for that jail. The handler (`systems/jailbreak.ts`) is one before-event subscriber that decides and cancels and does everything else a tick later, as the robbery framework's does.
- An operator binds a block by **clicking it**: they press "bind a button" on the jail's screen, the screens close, and their next right-click on any block becomes the button (`core/jailbind.ts`). The click, not a ray, so no engine behavior that is unmeasured here is relied on, and it works on any block at any distance.
- **One jail holds prisoners at a time**, as before: a capture rolls among the jails that are on only when the jail is empty, and prisoners share it. A button of any other jail says "No one is held in <name>" and starts nothing. This keeps the lockpick's single global state valid and every existing jail test unchanged.
- The **door trigger is optional**. A jail made on the screens has none until an operator clicks one, because a redstone block placed at a guessed spot could replace the cell's own floor. Without one a successful jailbreak frees the prisoners and places nothing.
- **There is always a jail on.** The last jail that is on cannot be deleted or switched off (on any path, undo included), and if every saved jail turns out to be unreadable a capture falls back to the config's two instead of failing.
- `bounty:lockpick` and `bounty:test_capture` are public and unchanged. No new `/rae:` command: the editor is a menu screen, like the endings'.
- The live config editor keeps the two default jails' fields (labelled "(default)"): a restored edit still reaches a world that has not used the Jails screen. After the first save the screen is the only way to move them.
- The Teleport list in the RAE menu shows the jails that are in the world now, in the place the config's jails were.

## Alternatives considered
- **Several jails holding prisoners at once, each with its own lockpick progress.** Needs a jail on every prisoner's record, per-jail attempt state, a per-jail "who is freed", and a rule for which jail a capture goes to. It changes the capture and the lockpick and the tests that pin them, and the owner asked for more jails and buttons, not for that. Rejected for now; the cost is that a second button on an inactive jail is a polite no.
- **Bind by aiming at the block.** `getBlockFromViewDirection` has never been measured inside a form's answer in this game, and the operator may have turned by then. Rejected for the click.
- **Make a jail button a robbery `switch` element.** The robbery run brings an area, a round rule, a cooldown, a lock pipeline and a reset, none of which a jail wants, and a jail's lockpick already exists. Rejected; the two are kept apart (a block that is part of a robbery cannot be bound to a jail, and the robbery handler stands aside while an operator binds).
- **Remove the config's jail fields from the live editor, as the boat's were.** An edit already made there is a persisted override that is restored at load; removing the field would silently drop it before the first save copies it. Kept as the defaults' fields instead.
- **A new `/rae:jail` command.** The three command families are all there are (`CLAUDE.md`); a menu screen needs none.

## Consequences
- Operators can add up to eight jails, give each up to eight buttons, move them and switch them off, with no redeploy. A jail built this way works the same as the shipped two.
- **Unmeasured in the real game:** that an empty-handed right-click on a button or lever is cancelled (only a wand-in-hand cancel was measured, `CLAUDE.md`), so a bound button may also press as it normally does; and whether placing a redstone block where one already is opens the door a second time. `docs/test-cards/JAILS.md` is the run sheet.
- A pressure plate cannot be a button: it is stepped on, not right-clicked.
- Nothing protects a bound button from being broken; the owner's world is the protection, as it is for the shipped jails' door blocks.
- The door's redstone block is still never removed by this code (as before): resetting the door is the owner's contraption's job.
- Editing the **active** jail's spot while prisoners are held leaves its buttons answering "No one is held in <name>" until the next capture, because the active jail is kept by position.
