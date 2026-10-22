# 0004: A shop is data and a script-driven screen, not a chain of commands in an NPC's buttons

## Status
Accepted. Decided 2026-10-07; the shop, its services and its conditions were then run by the owner and worked (`docs/test-cards/NPC-SHOP.md`).

## Context
The owner's shops were NPCs whose dialogue buttons each held a chain of commands. Each command in a chain succeeds or fails on its own, so a button could charge and then fail to give, or give and never charge: about 8 of the 72 priced buttons in the owner's main world did. The installed
`@minecraft/server` has no dialogue API and no NPC component class. A dialogue scene's buttons are static JSON in the behavior pack (`your_pack_name_BP/dialogue/`) and run as the NPC, so a script cannot write an NPC's buttons. What a script can see is a right-click on the NPC
(`playerInteractWithEntity`) and the player who pressed a button (`initiator` on the script event).

## Decision
The NPC only carries a shop id. A shop is a list of deals saved as data (see 0001), and a purchase is **one function that checks everything and then moves it, all or nothing** (`core/shoptrade.ts`). A click on a shop NPC is cancelled and a form opens (measured: cancelling the before-event stops the game's own NPC screen);
the dialogue scene's one button running `rae:npc shop` stays as the fallback, switched by `shop.interceptClicks` and `shop.useDialogueScene`. Services (a potion effect, an enchantment, a tame mount, a teleport) are done to the customer by `core/shopservices.ts`.

## Alternatives considered
- **Fill in the vanilla NPC's buttons from script.** Not possible: there is no API for it.
- **Keep command chains and fix them by hand.** The all-or-nothing guarantee cannot be had from independent commands.
- **Quests alongside shops (the original idea).** Left for later; the owner chose barter, unlimited stock and the defaults, and shops shipped first.

## Consequences
- A deal is validated when it is saved and when it is taken, and a customer who may not take one sees it greyed with the reason.
- Stock is unlimited by decision; nothing runs out.
- A name above an NPC sometimes shows wrongly in the game; the cause is unexplained and the shop itself is unaffected.
- Moving an NPC from an area nobody is near needs a temporary ticking area, because a script cannot see an entity in an unloaded chunk (`CLAUDE.md`).
