# ROBBERY-TELLER test card: stick up the bank

A robbery can now have a **teller**: an NPC or villager you hold up by pointing a gun at it. Holding it up counts as touching it,
so it can **start the robbery**, open a vault door that waits for it, pay out, and spawn guards. Everything that does not depend on
the game is covered by the tests. What they cannot say is whether the game's aim ray meets an NPC or a villager, and how it feels,
which is what this card is for.

- Not deployed yet: it ships in the next behavior pack after 0.2.2 (the deploy will say which). Operators only. Run it in your test
  world, with a gun in your bag and the wand (`/rae:robbery_wand`).
- **Aiming** is the right-click toggle you already know (the zoom). The hold-up needs the gun AIMED, with the teller in the crosshair
  for its hold-up time (2 seconds unless you change it). `/rae:config_set_bool robbery.holdUpNeedsAim false` lets simply holding a gun
  and looking at the teller do instead.
- An NPC is the best teller: it stands still and cannot be hurt. A villager wanders and can be shot.
- A robbery's guards (`ROBBERY-GUARDS.md`) are separate; if you have run that card, the same test robbery works here.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Spawn an **NPC** (its spawn egg) where a teller would stand and leave its name and skin alone. `/rae:robbery_new tellers "Teller Test"`. Stand 3 or 4 blocks from the NPC, **look at it**, and run `/rae:robbery_teller Cashier`. | Chat: "Cashier is a teller. Aim a gun at it to hold it up; set what happens with the wand." The **Cashier** screen opens and says "Held up by: keeping a gun aimed at it for 2 seconds". |
| 2 | In that screen: **When it is done**, **Add: say something** ("Take it! Take it all!", to **The player who did it**), submit. Then **Add: pay out**: coins 0, bounty 100, to **The player who did it**. Back out. | Both are listed under "When it is done (2)". |
| 3 | Bind an **iron door** with the wand (name it `Vault door`): **Waits for**, turn on `Waits for Cashier`. Bind a stone **button** as `Safe`: **When it is done**, **Add: win or fail the robbery** (Won, wait 0). Menu (left-click the air): **Area**, a box around where you stand, radius 15. `/rae:robbery_set outlawsOnly off`. `/rae:robbery_info tellers`. | "Ready to run." The vault door "waits for Cashier". |
| 4 | Take a gun. From 4 blocks away **right-click** (the aim zooms) and keep the crosshair on the NPC. | An action-bar line fills: **Holding up Cashier [###-------]**. The NPC **turns to face you** and a sound plays. After about 2 seconds: the robbery **starts**, your line appears in chat, your **bounty goes up 100**, and the **vault door opens by itself**. **Tell me if no bar ever appears: it would mean the game's aim ray does not meet an NPC.** |
| 5 | Press the **button** (the Safe) with the gun put away. | The robbery is won. `/rae:robbery_reset tellers` afterwards puts the door back. |
| 6 | Hold it up again but **look away for half a second** in the middle. Then again, looking away for **two seconds** in the middle. | The half second still counts (you finish at about 2 seconds in all). The two seconds starts the bar over. |
| 7 | Stand 4 blocks away with the gun in hand **without** right-clicking (no zoom), crosshair on the NPC. | Nothing happens: the gun has to be aimed. Then `/rae:config_set_bool robbery.holdUpNeedsAim false` and try again: now holding it is enough. `/rae:config_reset robbery.holdUpNeedsAim` puts it back. |
| 8 | Switch to the law side (the `/tag` lines in step 27 of `NPC-SHOP.md`), set `outlawsOnly` back on (`/rae:robbery_set outlawsOnly on`) and hold the NPC up. | "Only outlaws can do this", **once**, not every moment you keep aiming. |
| 9 | Right-click the NPC with an **empty hand**. Then **sneak** and right-click it (you are an operator). Then click it with the **wand**. | Empty hand: nothing opens (a teller is not talked to). Sneaking: the game's own NPC screen (where its skin is changed). Wand: the **Cashier** screen. |
| 10 | Spawn a **villager** and put a pen or fence around it. Look at it and run `/rae:robbery_teller Guard`. Hold it up the same way. Right-click it to try to trade. Shoot it. | It becomes a second teller and is held up. **Tell me: does the trade screen still open? Does the villager die from a bullet? Does it wander out of the crosshair?** |
| 11 | Look at the **villager** and run `/rae:robbery_teller Cashier` (the first teller's name). | "Cashier is now this one." Cashier is the villager now and the first NPC is a plain NPC again (a right-click on it works as usual; it can be a shop's NPC, say). |
| 12 | Open Cashier's screen (wand, click it): **Hold-up time**, make it 5. Hold it up. | It now takes about 5 seconds. A time of 0 is refused. |
| 13 | **Quit to the main menu and rejoin.** Hold up the teller again. | It still works: the tag stays on the entity. |
| 14 | Delete the Cashier element (**Delete it**) and click the entity with an empty hand. | The entity is a plain NPC or villager again. Holding it up does nothing. |

## What only the real game can answer (tell me what you SEE)

1. **The ray:** does a gun aimed at an NPC, and at a villager, ever make the bar appear? From how far? Through glass? Through the
   counter? (The hold-up looks at nothing in the way, so it works through a window.)
2. **The villager:** does cancelling the click stop its trade screen? Can a bullet kill it? Does it wander?
3. **The feel:** is two seconds of aiming a hold-up, or too short or too long? Is the action-bar bar readable?
4. **Facing:** does the NPC turn toward you, and does a villager?
5. **The shop NPCs:** after a robbery teller exists, a shop's NPC still works with the wand and for customers.
6. Anything in the content log marked `[robbery]` or `[Scripting][error]`. `/scriptevent rae:log_debug on` makes a click on a teller
   write what the game reported.

## Known limits (by design, for this version)

- A villager teller can wander or be shot; if it is killed the element cannot be held up until it is given to another entity
  (`/rae:robbery_teller <its name>`). An NPC cannot.
- There is no line-of-sight check: aiming through a wall works within the reach (12 blocks).
- Several players aiming at the same teller each build their own bar; the first to finish counts, and the others are not paid.
- Nothing is pushed or deployed until you say so.
