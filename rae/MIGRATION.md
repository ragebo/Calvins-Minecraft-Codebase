# RAE V2 Migration

The V1 -> V2 port this scaffold was written for is complete: every V1 system has been ported
(roles, jail, jailbreak, raids, train, boat, economy rules, horse, gold), and the addon has grown
well past the port (guns, the compass, tumbleweeds, the in-game menu, the ARCH foundational
modules). Guns and the train — which this file used to say not to build until the port finished —
have both existed for a long time.

For the current structure, see `ARCHITECTURE.md` at the repo root: what each file in `core/`,
`systems/`, `logic/` and `config/` owns, `main.ts`'s wiring, and the handful of deliberate
exceptions to the layer rules. This file is kept only as a historical record of the original
scaffold and setup steps below — for anything about the current architecture, `ARCHITECTURE.md` is
the one to trust; the two are not meant to be maintained in parallel.

## Original setup steps (still accurate)

1. Put this folder at the root of your repo, beside `your_pack_name_BP`.
2. Run `npm install`.
3. Check `outDir` in `tsconfig.json` matches your real pack folder name.
4. Run `npm run build`. Compiled JavaScript lands in the pack's `scripts` folder.
5. Use `npm run watch` while developing.

Never edit files in `your_pack_name_BP/scripts`. They are build output, and gitignored.

## Manifest

The manifest must list both modules:

```json
"dependencies": [
    { "module_name": "@minecraft/server", "version": "2.0.0" },
    { "module_name": "@minecraft/server-ui", "version": "2.1.0" }
]
```
