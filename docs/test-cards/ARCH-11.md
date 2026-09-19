# ARCH-11 test card: the logic layer and the layering test

**This task has no in-game behavior.** It creates `rae/src/logic/` for pure rules and moves two modules into it:
`core/bearing.ts` becomes `logic/bearing.ts`, and `config/schema.ts` becomes `logic/schema.ts`. It also adds a
test that fails when an import points the wrong way between layers (`config <- logic <- core <- systems`, and
systems never import each other). The only change the running game can notice is the `bearing` import in
`rae/src/systems/compass.ts`. Nothing imports `schema`, so it never runs in the game. No number, coordinate,
event id or rule changed.

The one thing to confirm in game is that the law compass still draws its readout, since the compass is the
only code that uses the moved `bearing` module.

## Automated (from `rae/`)

- `npm run check` prints only the `tsc --noEmit` line and exits 0.
- `npm test` ends with `ℹ fail 0`. The layering tests are in `rae/test/layers.test.mjs`. `bearing.test.mjs` and
  `schema.test.mjs` now load the compiled `logic/` modules.
- `npm run check:legacy` shows every pattern as `ok` or `down`, none as `RISES`.

## In game

Two players are best: A (law) and B (outlaw).

1. From `rae/`, run `npm run build`.
   Expected: no errors. `your_pack_name_BP/scripts/logic/` now holds `bearing.js` and `schema.js`. Old copies
   at `scripts/core/bearing.js` and `scripts/config/schema.js` may still be there from earlier builds. Nothing
   imports them, so they are harmless and can be deleted.
2. Open a world that has the behavior pack applied, with the content log visible (Settings > Creator > Enable
   Content Log GUI). If the world keeps running the old scripts, bump the behavior pack version (README,
   "Building and testing").
3. Wait a second after the world loads.
   Expected: green `RAE loaded.` in chat. That line only appears if `main.js` and everything it imports
   loaded, including `systems/compass.js` and the `logic/bearing.js` it now imports.
4. A runs `/tag @s add law` and `/give @s bountysys:law_compass`, then holds the compass in the main hand.
   Expected: A's action bar shows a readout that starts with `NEAREST`. With nobody tagged `outlaw` it reads
   `NEAREST  No outlaws to track`. That shows the compass system still runs, but it does not use the moved
   code, which is only called when there is a target. Go on to step 5.
5. B runs `/tag @s add outlaw`.
   Expected within about a second: A's action bar reads `NEAREST`, then a strip between `«` and `»` with a `*`
   marker on it, then B's name and a distance such as `14m`. When A faces B the `*` sits in the middle of the
   strip and is green. When A turns away it slides toward the side B is on. Once B is more than 90 degrees
   off to one side, the `*` leaves the strip and the `«` or `»` on that side lights up yellow.

## Pass and fail

- Pass: steps 1 to 5 as expected and nothing new in the content log.
- Fail: `RAE loaded.` is missing, the action bar stays empty while A holds the compass, or a red
  `[COMPASS ERROR]` line appears in chat. If `RAE loaded.` is missing, check that
  `your_pack_name_BP/scripts/logic/bearing.js` exists, and rebuild if it does not.

## Content log

There is no log line to look for. The pass condition is the absence of new errors: no script error, nothing
mentioning `bearing` or `logic`, and no `[COMPASS ERROR]` in chat.

## Not checked

The game was not run for this task. The Content Log menu path in step 2 is copied from the ARCH-02 card and was
not checked against the installed build. A single player tagged both `law` and `outlaw` (which would point the
compass at themselves) was not tried, and is not part of this card.
