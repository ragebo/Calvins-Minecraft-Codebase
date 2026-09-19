# logic: pure rules

Layers point down: `config <- logic <- core <- systems` (CLAUDE.md, rules 1 and 2).
`rae/test/layers.test.mjs` reads the source and fails on any import that points the wrong way.

## What belongs here

Deterministic rules: plain values in, plain values out, the same answer every time.

- No engine calls, and no value imports from `@minecraft/*`. `import type { Vector3 } from "@minecraft/server"`
  is fine, because type imports are erased when the code is compiled.
- No module state. A rule gets everything it needs as arguments and returns a result; mutable game state
  lives in `core/state`.
- Nothing that varies behind your back: no `Math.random()`, `Date.now()` or `system.currentTick`. If a rule
  needs a random number or the current tick, take it as a parameter.
- Imports only from `../config/` and from other files in `logic/`. Never `core/` or `systems/`.

`schema.ts` is the one file that bends the state rule: it moved here because it has no engine imports, and it
exports one shared `migrator` instance. New logic should stay stateless.

## The template

`bearing.ts`. Small exported functions (`relativeBearing`, `bearingBar`), numbers passed in as options rather
than read from config inside the rule, and only a type import from the game API. The system that uses it
(`systems/compass.ts`) does the engine work and calls into it.

## Tests

Logic is unit-tested under `rae/test/` against the compiled output: `bearing.test.mjs` and `schema.test.mjs`
call the exported functions directly. A new rule ships with a test in the same change.
