# Testing

Three layers of checking, and a fourth that only the real game can do.

## The three commands

Run from `rae/`.

| Command | What it proves |
|---|---|
| `npm run check` | The TypeScript compiles in `strict` mode with `noUnusedLocals` (a name that is declared and never read is an error). |
| `npm test` | Compiles to `.test-build/`, installs a fake `@minecraft/server` where the compiled code looks for the real one, and runs every `test/*.test.mjs` under Node's test runner. |
| `npm run check:legacy` | Counts the old patterns the refactor retired (direct role-tag reads, private timers, errors sent to chat, ...) and fails if any count is higher than its baseline. A count going down is welcome. |

A change is ready to commit when all three pass. `test/layers.test.mjs` also enforces the layer rules (`config` ← `logic` ← `core` ← `systems`, systems never import systems) from the source, so a bad import fails `npm test`.

## The fake game

The tests run the real compiled game code against `test/fake/minecraft-server.mjs`, a fake of the parts of the scripting API the game uses (players, entities, dimensions, scoreboards, events, forms, the camera, dynamic properties, containers, structures).
Time is the fake's: `fake.advance(n)` runs `n` ticks, so a timer test never waits. See `test/helpers.mjs` and any existing test for the shape; the essentials are listed in `CLAUDE.md`.

What the fake **cannot** tell you is how the real engine behaves. Every engine fact in this project is one of three kinds, and the docs say which:

- read from the typings (`rae/node_modules/@minecraft/server/index.d.ts`),
- **measured** in the real game (a test card or probe, with the date and build),
- or **unmeasured**: built to the typings and the fake, not yet seen. `CLAUDE.md`'s gotchas and each test card mark these "NOT yet run in the game".

Treat "tests pass" and "it works in the game" as different claims. Never write the second from the first.

## Test cards

Each feature that touches the real game has a card in `docs/test-cards/`: numbered in-game steps with what to expect, **what only the real game can answer** first (each with the file a fix would go in), and a "must not appear" list
(content-log lines that would mean a bug). The owner runs the cards, and what they find is fixed in a follow-up. When a card's open questions get answered, update the card and the gotcha in `CLAUDE.md` with the date and build.

## Checking that the tests would catch a regression (deliberate breaks)

A green suite does not prove a behavior is tested. The way to find out is to break the code on purpose, one change at a time, and see whether a test fails. `tools/mutation/` does this:

```
node tools/mutation/run.mjs <spec.mjs>
```

A spec lists the test files to run and, for each source file, a list of `[name, from, to]` text replacements. `tools/mutation/example-spec.mjs` is a working example. For each replacement the tool rewrites the file, runs the named tests, reports **caught** or **SURVIVED**,
and always puts the original back (it checks a hash). Run it with nothing else editing `rae/`.

Rules learned the hard way:

- **A break that does not compile is not a catch.** The compiler stopping it says nothing about the tests, so the tool reports it as `COMPILE ERROR`. Write each break so it still compiles: `&& Math.abs(0) === 1` switches a condition off, `* 0` zeroes a value, `void x` keeps a name used.
- **A survivor is a finding.** Either a test is missing (add it, watch it fail against the break, then pass) or the code is redundant. If two guards make the same decision, the second can never change the outcome: delete it rather than test it.
- **Equivalent breaks** (a change with no observable effect) survive for a good reason; do not write tests for them. They are usually a sign the code can be simpler.
- **Name the tests narrowly while writing a spec, then widen.** A break that survives a narrow test list may be caught by the whole suite (`test/*.test.mjs`). A break that survives the whole suite is a real gap.
- Source files may have Windows line endings. The tool matches a replacement written with `\n` against the file's own line ending, so write specs with `\n`.
- Write specs and patch scripts to a file with an editor tool, not a shell heredoc: a shell can swallow the backslashes and trip on apostrophes.

When a feature ships with a mutation run, say so in its commit message with the numbers ("N deliberate breaks, all caught"). They are the evidence behind the claim.

## Characterization tests

Before changing behavior that other things depend on (tick cadences, death-handler order, round flow, jail rotation, compass output), write tests that pin the **current** behavior, watch them pass on the old code, make the change, and watch what moved.
The boat escape was migrated to a configurable ending this way: its existing flow tests were left unchanged and had to keep passing.
