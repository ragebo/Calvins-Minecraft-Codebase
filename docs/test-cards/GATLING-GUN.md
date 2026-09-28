# GATLING-GUN test card: a placed, manned gun instead of a carried one

Not an ARCH task: added on request, "for some fun" — the seventh gun, and the first one that is placed and
ridden rather than carried and fired directly. Two design questions were settled before building it (the
owner's choice each time): sustained fire is approximated from real click frequency (a ramping fire-rate
gate, not a literal "held button" signal, since Bedrock has none for a swing — the same limitation that
already forced aiming to be a toggle rather than a hold), and it's a carryable item you place yourself, not
an admin/map decoration.

- `bountysys:gatling_gun` (the item) is a normal gun in your inventory until you right-click it against a
  block: that plants `bountysys:gatling_gun` (the entity — same identifier, different registry, no clash) at
  that spot, facing the way you were standing, and takes it out of your hand. From then on the item is gone;
  the entity is what's left.
- Right-click the placed gun to sit in it (`minecraft:rideable`, one seat, vanilla "board" interaction — no
  script needed for mounting itself). While riding it, left-click fires, exactly like every other gun's
  controls, aimed by your own view direction same as always.
- The one real difference: **every click "revs" it**. The first click fires at its slowest rate; keep
  clicking within about half a second of the last one (`config/guns.ts`'s
  `GUNS.gatling_gun.automatic.graceTicks`) and the next click can fire sooner, ramping up over
  `spinUpShots` consecutive clicks to its fastest rate. Stop clicking for longer than that and it's cold
  again next time. 90 rounds a magazine, `rifle_ammo` (the same ammo the bolt rifle and repeater use), a big
  reload (100 ticks) once it runs dry — auto-reload on an empty click, same as every other gun.
- Holding it (not yet placed) and clicking does **nothing** — it only fires once placed and mounted. It also
  never has an aim zoom: nothing is ever held long enough to right-click-to-aim.

Packs: behavior pack **0.1.29**, resource pack **1.0.24** — a new entity, a new item, and a generated
model/texture (`scripts/gen-gatling-model.mjs`, same boxes-plus-flat-palette technique as the train car: a
tripod, a brass receiver, five barrels and a crank, no art drawn by hand).

`npm test` drives the whole state machine through the fake tick loop: placing it (spawns the entity at the
right spot facing the right way, empties the slot), that holding-and-clicking genuinely does nothing, that
riding it and clicking fires and the fire-rate gate actually ramps across a burst, that a long-enough pause
resets the ramp, that running dry auto-reloads from carried ammo and firing resumes once full, that
dismounting mid-reload loses it (same rule as swapping away from a held gun), and that a round reset clears
the ramp state. The fake cannot say whether holding the mouse button on empty air actually **sends** repeated
swing events at all — that's the one thing under this whole feature that was never measured against the real
engine, only reasoned about from the same constraint that already made aiming a toggle. If it turns out
holding does auto-repeat swings, this reads as genuine "hold to fire." If it doesn't, it still works, just as
"click as fast as you can" instead of a real hold. Either way the ramping still happens; only the input
effort required to sustain it differs. That's what this card is for.

## Steps

`/give @s bountysys:gatling_gun`, `/give @s bountysys:rifle_ammo 96`.

| # | Do | Expect |
|---|---|---|
| 1 | Hold it and left-click at the sky a few times. | Nothing happens — no shot, no sound. This is the "only fires once placed" rule. |
| 2 | Face a wall or the ground and right-click it. | It plants there facing the direction you were looking, and vanishes from your hand. |
| 3 | Right-click the placed gun. | You sit in it. Look around — does the view feel right, and does it look like you're actually gripping/cranking it, or does the seat look off? |
| 4 | Left-click once. | One shot, one bang. |
| 5 | **The main question.** Hold left-click down (don't click repeatedly — actually hold the button) for a couple of seconds. | Does it keep firing on its own, speeding up as it goes ("spinning up"), or does it fire once and stop until you click again? Either answer is useful — it tells us whether this engine auto-repeats a held attack at all. |
| 6 | Now deliberately click as fast as you physically can, repeatedly, for a few seconds. | It should noticeably speed up partway through — slow bangs at first, a rapid chatter by the end. Does the ramp-up feel satisfying, or too slow/fast to notice? |
| 7 | Click a few times, then wait about a second, then click again. | The next shot should sound like a cold start again (slow), not a continuation of the earlier burst. |
| 8 | Keep firing (however works from step 5/6) until it runs dry. | A dry click, then it reloads on its own — no key needed. Time how long the reload feels; is 5 seconds (100 ticks) too long or about right for how many rounds you just burned through? |
| 9 | Get off (however you dismount a vanilla ride) and get back on. | Still has whatever ammo was left; the ramp is cold again. |
| 10 | Shoot something with it a few times. | Judge the damage: each hit is meant to be weak on its own (3 damage) but the volume of fire should make up for it. Does that feel true, or does it feel too weak/strong for a gun with 90 rounds? |

## What to tell me

1. **Does holding the mouse button actually keep it firing, or do you have to click repeatedly?** (This is the one thing no test can answer — see above.)
2. Does the ramp-up (slow to fast) feel good, or does it need to be faster/slower, or need more/fewer clicks to reach full speed?
3. Does the placement land where and how you'd expect (position, facing), and does mounting feel right?
4. Does the model read as a Gatling gun at a glance, or does it need a real hand-made replacement (it's a generated placeholder, same as the train and the tumbleweed started out)?
5. Damage and magazine size: too strong, too weak, about right?
6. Anything broken: a shot with no sound, a reload that never finishes, being able to fire while just holding it (should never happen), or getting stuck unable to dismount.

## Content log

Must not appear: `[Scripting][error]` lines, an item or entity error naming `gatling`, or a `[TICK ERROR] guns` line. Since this is the first custom item this codebase places as an entity via `playerInteractWithBlock`, also watch for anything suggesting that event didn't fire the way its own documentation describes for a plain (non-block) item — the placement logic has never been exercised against the real engine before this card.
