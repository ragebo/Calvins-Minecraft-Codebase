# ARCH-02: per-player state is keyed on player id, not name

Guns, compass and jailbreak used to keep per-player state in Maps keyed by `player.name`. They now key on
`player.id` (unique, and the same across loads of a world). Jailbreak also stores its contributors as ids and
looks them up among the players who are online when the breakout completes or is abandoned. In normal play
nothing should look different. What could go wrong: a system that forgets a player it should remember, or a
script error when someone disconnects mid-attempt.

**Not reproducible in game:** two players who share a display name (gamertags are unique). That case is only
covered by the fake-API tests in `rae/test/player-id-keys.test.mjs`. It has NOT been verified in the game.
Steps 1 to 3 check that normal play is unchanged. Step 4 is the one scenario that can be reproduced for real: a
contributor who disconnects.

## Setup

1. `cd rae && npm run build`, then load the world. If the world keeps running the old scripts, bump the
   behavior pack version (see README, "In-game testing").
2. Three players are enough for everything below: H (host), A and B. Two players are enough for steps 1 and 2.
3. Turn on the content log (Settings > Creator > Enable Content Log GUI) and keep it open.
4. `/scriptevent rae:debug`. Expected chat: `RAE DEBUG`, and a `Systems:` line that includes `jailbreak`, `guns`
   and `compass`. The `coins` and `bounty` scoreboards must exist; if either is reported missing, add it first.

## 1. Guns keep a separate magazine per player

1. A and B each run `/give @s bountysys:revolver` and `/give @s bountysys:handgun_ammo 64`, then hold the revolver.
2. A uses the revolver until it stops firing (6 shots).
   Expected: a gunshot for each of the 6 shots; the 7th use gives a click and the chat line
   `*click* — empty. Sneak + use to reload.`
3. B (still holding a full revolver) uses it once.
   Expected: a gunshot, and no `empty` message. B still has 5 rounds left.
4. A sneaks and uses the revolver to reload, and while that runs B keeps firing.
   Expected: `Reloading Revolver...` for A; B's shots still go off during A's reload; after about 2 seconds A
   sees `Revolver reloaded. (6/6)`.

## 2. Compass keeps a separate mode per player

1. A and B each run `/tag @s add law` and `/give @s bountysys:law_compass`, then hold the compass.
   Expected: the action bar starts with `NEAREST` for both. With nobody tagged `outlaw` it reads
   `No outlaws to track`; the mode label is still shown.
2. A sneaks and uses the compass.
   Expected: A sees `Compass now tracking the outlaw with the highest bounty.` and A's action bar starts with
   `TOP BOUNTY`. B's action bar still starts with `NEAREST`.
3. Optional, with a third player C tagged `outlaw`: with both still in `NEAREST` mode, each readout shows C's
   name and that player's own distance to C.

## 3. Reset still clears everything

1. With A's revolver empty and A in `TOP BOUNTY` mode, run `/scriptevent rae:reset`.
   Expected chat: `All systems reset.`
2. A uses the revolver.
   Expected: it fires (the magazine is full again). A's compass reads `NEAREST` again.

## 4. Jailbreak: a contributor who disconnects

Everything here is done as `outlaw`. Run `/tag <name> add outlaw` for H, A and B first. The lock needs 2
correct picks.

1. H runs `/scriptevent bounty:test_capture` (typed in chat, so it runs as H).
   Expected: H is teleported to the jail and gets `[TEST] You've been sent to jail for testing.`
2. First note A's coins with `/scoreboard players list @s`. Then A runs `/scriptevent bounty:lockpick` and
   moves the slider by ear (a miss plays a ping whose pitch rises the closer you are), then submits.
   Expected on a hit: `Found it! Correct picks: 1/2`. Close the menu that reopens.
3. A leaves the world (Save and Quit, or just disconnect).
4. B runs `/scriptevent bounty:lockpick` and finds the sweet spot too.
   Expected: `Found it! Correct picks: 2/2`, then `The jailbreak succeeded!` in chat and `+50 coins for the
   rescue!` for B. The jail door opens. H gets `You've been freed! Get away from the jail before law catches
   you.` and is weakened and slowed while near the jail.
   **Must not appear:** a red `[JAILBREAK ERROR]` line in chat, or `InvalidEntityError` in the content log.
   (In the fake-API test the old code failed exactly here: A's stale handle threw while paying out and H was
   never freed. The real game's behavior with the old code was not observed.)
5. A rejoins and runs `/scoreboard players list @s`.
   Expected: A's `coins` are the same as the value noted in step 2 (rescue coins go only to contributors who
   are online at the end).
6. H walks more than 20 blocks from the jail.
   Expected: `You made it to safety!`, and the weakness and slowness are no longer refreshed (they wear off
   within about 3 seconds).

### 4b. The abandoned-attempt path

1. Capture H again (`/scriptevent bounty:test_capture` as H). A picks once (`1/2`) and disconnects. Nobody
   else picks.
2. Wait about 30 seconds.
   Expected: chat `The breakout attempt was abandoned!`. Nothing else. **Must not appear:** any script error in
   the content log.
3. B then picks once.
   Expected: `Found it! Correct picks: 1/2` (the failed attempt was fully cleared), not `2/2`.

## Content log

Watch it through all of the steps above.

- Expected: no new `[Scripting][error]` lines, in particular none mentioning `InvalidEntityError`.
- Expected: none of `[GUN SOUND ERROR]`, `[COMPASS ERROR]`, `[JAILBREAK ERROR]`, `[EVENT ERROR]` or
  `[TICK ERROR]` in chat.
- The lines you should see are the chat messages quoted in each step (`Found it!`, `The jailbreak succeeded!`,
  `The breakout attempt was abandoned!`, `You made it to safety!`).

## If two same-named players ever can be arranged

For example two clients on a dedicated server with authentication off. Repeat step 1 and step 2 with them.
Expected: each has their own magazine, reload, mode and target, exactly as in the different-name case. Report
whether it held; this is unverified.
