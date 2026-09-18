# RAE V2 Migration

## What this scaffold contains

```
src/
  config/
    world.ts        All coordinates. Nothing else defines one.
    balance.ts      All tunable numbers. Nothing else defines one.
  core/
    registry.ts     System registration and round reset.
    events.ts       One entityDie subscriber. One scriptevent subscriber.
    tick.ts         One interval loop, shared by every system.
    economy.ts      The only file that touches coins and bounty.
    raid.ts         Shared wave engine for ranch, fort and train guards.
  systems/
    roles.ts        PORTED. Use as the template.
  main.ts           Entry point and debug commands.
```

## Setup

1. Put this folder at the root of your repo, beside `your_pack_name_BP`.
2. Run `npm install`.
3. Check `outDir` in `tsconfig.json` matches your real pack folder name.
4. Run `npm run build`. Compiled JavaScript lands in the pack's `scripts` folder.
5. Use `npm run watch` while developing.

Never edit files in `your_pack_name_BP/scripts`. They are build output.
Add that folder to `.gitignore`.

## Manifest

Your manifest must list both modules. V1 was missing the second one:

```json
"dependencies": [
    { "module_name": "@minecraft/server", "version": "2.0.0" },
    { "module_name": "@minecraft/server-ui", "version": "2.0.0" }
]
```

## Porting rules

For each V1 system, in this order: roles (done), jail, jailbreak,
raids, train, boat, economy rules, horse, gold, harming.

1. Move every coordinate into `config/world.ts`.
2. Move every tunable number into `config/balance.ts`.
3. Replace `world.afterEvents.entityDie.subscribe` with `onDeath`.
4. Replace `system.afterEvents.scriptEventReceive.subscribe` with `onScriptEvent`.
5. Replace `system.runInterval` with `onTick`.
6. Replace direct `coinsObj` and `bountyObj` calls with the economy module.
7. Call `registerSystem` and declare `ownedTags` plus `reset`.
8. Ranch and fort become `registerRaid` config objects, not files.

## Port first, add features second

Do not build guns or the train until the port is finished and tested.
A broken port and a broken feature look identical in the content log.

## Verify after each system

Run `npm run check`. Then in game, run `/scriptevent rae:debug`.
It lists every registered system and every registered event id.
