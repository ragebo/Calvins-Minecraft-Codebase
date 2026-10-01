# GUN-FEEDBACK test card: recoil, hit markers, and an ammo/reload readout

Three backlog items (GUN-03, GUN-07, GUN-09), built together on request right after MUZZLE-LIGHT.md's
muzzle flash: all three are about what firing *tells the shooter*, not what a bystander sees.

**GUN-03, recoil.** Every shot now shakes the shooter's camera (`core/aim.ts`'s new `shakeCamera`, wrapping
`Camera.addShake`), scaled per gun by `config/guns.ts`'s new `recoil: { intensity, duration }`. This is a
camera *shake*, not a literal "the view kicks up and eases back": this engine has no confirmed scripting
call that forces a real connected player's own look direction (a player's camera is otherwise
client-controlled), while `Camera.addShake` is a real, documented engine feature built for exactly this kind
of per-shot feedback. The bolt-action rifle gets the biggest single-shot punch; the Gatling gun gets the
smallest per-shot value on purpose, since it can fire every 2 ticks once spun up with no human bottleneck —
many small shakes stacking at that rate should already read as a sustained rumble, where a bolt-action-sized
shake that often would be nauseating rather than punchy.

**GUN-07, hit markers and a kill cue.** Landing a shot now plays a sound to the shooter alone (never
positionally — nobody else should hear it) and flashes a short action-bar line: `HIT` normally, `KILL` in
red if that shot was lethal. Both guns' damage paths (hitscan's `fireHitscan`, every projectile's
`projectileHitEntity` handler) already funnelled through one shared function, `dealGunDamage`, so this is one
change covering every gun rather than two.

**GUN-09, an ammo/reload readout.** Loaded rounds and reload progress used to only ever reach chat
(`"Reloading..."`, `"X reloaded. (n/m)"`), which scrolls away mid-fight. A new action-bar line
(`core/ui.ts`, same arbitration every other action-bar writer here uses) now shows `<gun name> | n/max`
continuously while holding a gun (or riding the Gatling gun), switching to a `Reloading... Ns` countdown
while a reload is in progress. The chat lines are unchanged — this is in addition, not a replacement.

`npm test` covers: every gun's shake matches its own configured intensity/duration, including the Gatling
gun's automatic loop; a landed shot plays the hit marker and posts `HIT`, a lethal one plays the kill marker
and posts `KILL` instead, a miss posts neither, and a bystander never hears the shooter's own marker; the
ammo readout shows the right name and count for every held gun and for the mounted Gatling gun, drops by one
after firing, shows a live countdown while reloading and returns to the full count once the reload actually
finishes, posts nothing for a non-gun item, and never throws if the player becomes invalid between ticks (a
real bug this round: the first version crashed trying to report a lagging/disconnected player's own name,
since the one existing player had already gone invalid by the time the error path tried to read it — fixed
by skipping an invalid player before doing any work, the same guard `guns:gatling-aim` already used). None of
this can say whether the shake actually feels like recoil, whether the hit marker reads clearly in the heat
of a fight, or whether the readout is positioned/sized well — that's what this card is for.

Behavior pack **0.1.34**. No resource-pack change: nothing here is a new particle, model, or sound file —
`Camera.addShake`, the hit/kill sounds, and the action-bar text are all built from vanilla sounds and the
engine's own camera API.

## Steps

`/give @s bountysys:revolver`, `/give @s bountysys:bolt_rifle`, `/give @s bountysys:pistol`,
`/give @s bountysys:gatling_gun`, and ammo for each.

| # | Do | Expect |
|---|---|---|
| 1 | Fire the bolt-action rifle, then the pistol, back to back. | Both kick the camera, but the bolt-action's kick should feel noticeably bigger — it's configured as the strongest. |
| 2 | Hold any gun and watch the action bar without doing anything else. | `<gun name> \| n/max` shows continuously, not just right after firing. |
| 3 | Fire a few times, watching the count. | The number drops by one each shot, refreshing within a fraction of a second. |
| 4 | Empty the magazine (or press Q early) to start a reload. | The line switches to `Reloading <gun>... Ns`, counting down; once it finishes, it jumps back to the full count. |
| 5 | Shoot a mob or another player without killing it. | A short, distinct sound only you hear, and a brief `HIT` on your action bar. |
| 6 | Finish it off. | A different, more pronounced sound, and `KILL` instead of `HIT`, in red. |
| 7 | Have someone stand near you while you get a hit marker. | They should hear and see nothing from your hit marker — it's private to you. |
| 8 | Place and ride the Gatling gun, then fire it for a few seconds. | The ammo readout shows the Gatling gun's own name and count while mounted, and the recoil shake should feel like a steady rumble rather than individual kicks once it's spun up. |

## What to tell me

1. Does the recoil read as a believable kick, or does it feel more like random jitter? Is the relative
   ranking (bolt-action strongest, pistol/Gatling weakest) right, or does something need rebalancing?
2. Is the hit marker's sound and `HIT`/`KILL` text clear enough to notice mid-fight without being annoying
   on a gun that fires often?
3. Is the ammo readout positioned/legible well, and does it ever visibly fight with the compass (it shouldn't
   — you can't hold a compass and a gun at once, but say so if it ever looks wrong)?
4. Anything broken: a shake that lingers oddly, a hit marker that fires without a real hit (or vice versa), a
   readout that gets stuck on the wrong number or never clears.

## Content log

Must not appear: `[aim] shake failed`, `[gun effects] hit marker failed`, `[guns] ammo readout for ...`, or
any `[Scripting][error]` line.

## Not checked

Whether the recoil, the hit marker, and the readout actually *feel* good together — amount, timing, size —
is unseen until played. The camera shake specifically has never been used anywhere in this codebase before
this round, so its real-game behavior (does it stack sensibly across rapid shots, does it look right at the
Gatling gun's fire rate) is also genuinely new ground.
