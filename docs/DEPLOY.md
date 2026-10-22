# Deploying to the game

The source of truth is this repository. The game runs a copy of the built packs from its own folders, and a deploy is what puts the repo's build there. Nothing is
published anywhere: the owner's worlds load the packs from `development_behavior_packs` and `development_resource_packs`.

Two scripts do the work, `tools/deploy/deploy.ps1` (behavior pack) and `tools/deploy/deploy-rp.ps1` (resource pack). Both check first, change nothing under `-DryRun`,
back up what they replace, and verify byte for byte afterwards. **Deploy only when the owner asks**, and a request to deploy one thing is not a request to deploy another.

## Why a deploy is more than a copy

Each world pins the exact version of every pack it uses, in `world_behavior_packs.json` and `world_resource_packs.json` inside the world's folder. Changing only the
pack's own manifest does nothing for a world already pinned to the old version: it keeps loading the old content, with no error. So every deploy does three things:
bumps the pack's version, copies the files, and moves each world's pin to the new version. The game also rewrites those pin files when a world loads, so a pin changed
under a running game can be undone. That is why the scripts refuse to run while a world is open (behavior pack) or while Minecraft runs at all (resource pack: the game
reads the resource pack once, at launch).

Two lessons from earlier deploys:

- A long-running game process once served a cached older build to one world. Quitting the game completely and launching it fresh is the only way to be sure a world runs the new build.
- A pin file read with the wrong `-From` is a silent no-op. Read the real pins first (below); do not take the old version from git history.

## Procedure

Run everything from the repo root unless a step says otherwise. `rae/` holds the TypeScript project.

1. **Decide what changes.** A change to scripts alone needs the behavior pack (BP). A change under `your_pack_name_BP/items`, `entities`, `loot_tables` or `dialogue` also needs the BP.
   A change under `BountySys_RP/` needs the resource pack (RP), and the RP needs the game fully closed.
2. **Bump the versions.**
   - BP: `your_pack_name_BP/manifest.json` (the header and both modules, three places) **and** `BUILD_VERSION` in `rae/src/config/build.ts`. `test/assets.test.mjs` fails when they differ.
   - RP: `BountySys_RP/manifest.json` (the header and its module).
   Bump even a script-only change: it costs nothing and the load line ("RAE x.y.z loaded.") then says which build a world really runs.
3. **Clean build.** `tsc` never removes the output of a deleted source, so a stale file would be deployed: delete `your_pack_name_BP/scripts` (it is build output and gitignored), then `cd rae && npm run build`.
4. **Gate.** From `rae/`: `npm run check`, `npm test`, `npm run check:legacy` must all pass.
5. **Read the real pins.** For each world folder, read `world_behavior_packs.json` / `world_resource_packs.json` as JSON and note the version beside the pack's id (BP `b8f707c3-9ce5-470d-8cad-081de86c10ac`,
   RP `d834fa56-3296-4625-97d6-f50876e2f561`). That is `-From`.
6. **Dry run.** `tools/deploy/deploy.ps1 -DryRun -From 0,2,9 -To 0,2,10` (and `deploy-rp.ps1 -DryRun -From 1,0,28 -To 1,0,29`). It lists the worlds it found, whether any is open, the pins, and every
   file that differs. Read the file list: a file you did not expect to change is a finding. If a file in the **game** folder differs from the repo and you did not make that change, someone edited it there (the owner has put
   their own sprites there before). Do not overwrite it: copy it into the repo, with the owner's say-so, and commit it first.
7. **Run it.** The same command without `-DryRun`. It backs up the game's current copy next to the script (`tools/deploy/backup-before-deploy`, gitignored), copies, moves the pins and verifies.
8. **Check the result yourself.** The script prints a hash comparison; also read all the pins as JSON again and confirm every world is at the new version. A pin read as text can look right and be wrong.
9. **Tell the owner to quit the game completely and launch it fresh**, then to read the content log if anything misbehaves: `%APPDATA%\Minecraft Bedrock\logs\ContentLog*.txt` (one file per launch).
   A script error appears there as `[Scripting][error]`, and the version a world loaded appears in its `Plugin Discovered` lines.
10. **Commit the version bump** on its own. Do not push unless asked.

## Rolling back

`tools/deploy/backup-before-deploy` (and `backup-rp-before-deploy`) hold what the last deploy replaced: the manifest, the pack's folders and the four pin files. Copy them back with the game closed,
or deploy the previous commit with `-From` the version now pinned and `-To` the older one.

## Setting it up on another machine

The scripts assume this machine: the Xbox user folder that holds the worlds (`Users\9123740906447652967`) and the four world folder names are written at the top of each script, with a comment. Change them there.
Everything else is computed from the repo's location and `%APPDATA%`.

The resource pack's `sounds/` folder (the music) is in the game folder but not in the repo, because its licensing is unconfirmed. The RP script never reads, copies or deletes it, and proves that with a hash before and after.
