# TRAIN-RIDE test card: a train that really moves (slice 1, the spike)

Not an ARCH task: added on request. The old train (`systems/train.ts`) is a set-piece: a saved structure re-loaded in 5-block hops along a straight 43-block stretch, carrying nobody. It is **untouched** by this slice and still runs when `bounty:train` fires. This slice builds the first piece of a train that really moves and takes players around the map, and measures the things that cannot be known without the game.

What is new:

- **A route recorder.** You walk the track and mark it: `rae:train_mark`, `rae:train_station <name>`, `rae:train_undo`, `rae:train_clear`, `rae:train_loop`, `rae:train_info`, `rae:train_show`. The route is saved in the world (it survives a reload) and is smoothed into a curve.
- **One rideable car**, `bountysys:train_car`: 4 seats, invulnerable, no gravity or collision, so it glides along the route through whatever is in the way. Marks belong **on the track, at track height**, because the car does not follow the ground by itself.
- **`rae:train_spike`**, which drives that one car along the route two ways so we can compare them, and logs numbers to the content log: `momentum` (the car is given a velocity every tick, aimed at the next point) and `teleport` (it is placed on the next point every tick). Also `drag`, `limits` and `seats` measurements.
- A generated model (`rae/scripts/gen-train-model.mjs`): a red carriage with a gold rail and two benches, **yellow lamps at the front, red lamps at the back**.

Packs: behavior pack **0.1.8** and resource pack **1.0.15**. The resource pack holds the model, so deploy it with Minecraft **closed** and launch fresh (the game reads a resource pack at launch; a running game would also write the old pin back).

`npm test` checks the maths (curve, distance, heading, speed profile, steering), the recorder and the driver against a fake physics model, and that the packs agree with each other. It cannot say how the ride feels, whether the seats work, or what the engine does with a velocity. This card does.

## Steps

Do these in a world with a stretch of track (the old train's straight is fine: x -284 to -241 at y 94, z -269). You need op rights for `/scriptevent`.

| # | Do | Expect |
|---|---|---|
| 1 | Stand on the track at one end, feet on the surface. `/scriptevent rae:train_station Depot`. Walk along the track, `/scriptevent rae:train_mark` about every 10 blocks and at every corner, and finish with `/scriptevent rae:train_station End`. | Each command answers "Marked point N at x, y, z" or `Station "..." is point N`. After a station and a second point it says "That is a usable route". |
| 2 | `/scriptevent rae:train_info` then `/scriptevent rae:train_show`. | Length in blocks, seconds at cruise speed, the stations. Then white sparkles along the track for 10 seconds with a tall column at each station. On a corner the line should curve, not cut through blocks. |
| 3 | `/scriptevent rae:train_spike drag`, wait 5 seconds, then `/scriptevent rae:train_spike limits`, then `/scriptevent rae:train_spike seats 6`. | A test carriage appears in front of you for each. Chat says "Drag test done", lists which impulses were accepted, and how many cows sat (expected 4 of 6). `rae:train_spike stop` removes everything. **Nothing to judge here: the numbers go to the content log.** |
| 4 | `/scriptevent rae:train_spike momentum`. | A carriage stands at the Depot, nose along the route: the **yellow lamps** are the front. |
| 5 | Right-click it to sit. Note where you sit (height, which seat). | You sit on a bench inside the carriage, not sunk into the floor or floating above it. Three seconds later it sets off. |
| 6 | Ride to the End. | Smooth, without stutter, at 10 blocks a second. Round a corner it turns with the track and you turn with it. It slows and stops on the End mark. |
| 7 | Sneak to get off. Repeat with a second player: both right-click the carriage before it leaves. | You get off cleanly. Two players fit, on different seats. |
| 8 | `/scriptevent rae:train_spike teleport` and ride again. | The same route, moved by placing it every tick. **Say which of the two felt smoother.** |
| 9 | `/scriptevent rae:train_spike stop`. Leave the world, come back, look around the Depot. | No carriage is left behind. `rae:train_info` still shows your route. |

## Results so far (2026-09-20, BP 0.1.8, resource pack not yet deployed: the car was invisible)

Measured in the real game from the content log, one rider, a 65.8 block loop, 773 ticks:

- **Momentum tracks the route exactly.** Error 0.000 (mean and max) every second, `delivered=1.000`, no resyncs, no ticks held. The rider reported it worked well.
- **Drag:** a velocity moves the car by its full size on the first tick, then decays by about 0.546 a tick (0.05 -> 0.027 -> 0.015 ...). The driver clears and re-applies the velocity every tick, so it always gets the full first tick: `TRANSIT.velocityScale` stays 1.
- **Impulse limit:** none found up to 1000 blocks per tick.
- **Seats:** the 4 seats take 4 riders at the positions in the entity file (x +-0.65, z -0.90 and 0.80, feet 0.40 above the car origin, seen with cows); a 5th and 6th are refused. A player's own offset read 0.00 high, because a player's position is not the same point as a cow's.
- **Not yet seen:** the model (its facing, the seat height against the benches), a second player, and the teleport mode.

## What to tell me

1. Momentum or teleport: which one is smoother, and is either one jerky (steps, rubber-banding, the camera shaking)?
2. Which way the carriage faces: are the yellow lamps at the front?
3. Sitting: height right? Could you sit and get off? Did a second player fit?
4. Corners: does the carriage follow the track, or cut across it?
5. Anything odd: falling through the floor, riders left behind, the carriage flickering, a car still there after a reload.

## Content log

I read `C:\Users\Calvi\AppData\Roaming\Minecraft Bedrock\logs\ContentLog*.txt` afterwards. The spike writes `[train-spike]` lines (as warnings, which the log keeps):

- `drag: impulse 0.5 -> moved per tick [...], velocity readback [...]`: how far a velocity really moves a car in a tick, and how it decays. `drag summary` gives the fraction delivered: it sets `TRANSIT.velocityScale`.
- `limits: 1: ok | 2: ok | ...`: the biggest impulse the engine accepts.
- `seats: ...`: whether the car takes 4 riders and where each one sits (offsets from the car).
- `momentum t=... error(mean=... max=...) delivered=... resyncs=... held=... riders=[...]`: once a second while driving: how far the car was from where it was aimed, what share of its velocity the engine delivered, corrections, ticks held at an unloaded chunk, and where each rider sits.

Must not appear: `[Scripting][error]` lines, or a train entity or texture error naming `train_car`.

## If something is off

- **The carriage is invisible, or a purple-and-black box:** the resource pack was not picked up. Deploy it with the game closed and launch fresh; check the world's `world_resource_packs.json` says 1.0.15.
- **"Could not spawn the car":** the behavior pack is older than 0.1.8, or the entity definition failed to load (the content log names the file).
- **Riders sink into the floor, or float:** seat height is `position[1]` in `your_pack_name_BP/entities/train_car.json` (0.4 now). Tell me which and by how much.
- **It runs the wrong way round the model:** the model's front is -Z; if the yellow lamps are at the back, the yaw convention is off by 180 and it is one line in `logic/route.ts`.
- **Jerky momentum but smooth teleport (or the reverse):** that is exactly what the spike is for; report it and I set the default from your answer.

## Not checked

- The game was not run for this change: the seats, how a velocity behaves, the model's facing and the feel of the ride are all unmeasured until you do this card. The seat layout in particular is a guess (vanilla has no four-seat entity to copy: the boat's seats depend on how many are aboard).
- Where a route passes through unloaded chunks the car waits; that path is tested against a fake, not against real chunk loading.
- Slice 2 (the real train: engine plus cars, stations, waiting for riders) and slice 3 (the robbery on the train) are not started.
