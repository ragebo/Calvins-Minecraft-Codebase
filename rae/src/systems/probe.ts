import { system, EntityDamageCause, type Entity, type Player, type Vector3 } from "@minecraft/server";
import { DAMAGE_PROBE as P } from "../config/balance.js";
import { onScriptEvent } from "../core/events.js";
import { registerSystem } from "../core/registry.js";
import { format, tell } from "../core/ui.js";

/**
 * A measurement, not a game feature: `/scriptevent rae:probe_damage`.
 *
 * Whether several applyDamage calls on one target add up is not in the API docs, and the shotguns
 * used to deal one call per pellet. In vanilla, a target that was just hurt ignores a further hit that
 * is not bigger than the last one, for about 10 ticks. If script damage follows that rule, every pellet
 * after the first counts for nothing. Rather than assume either way, this runs a few hit patterns on a
 * cow it spawns in front of the player and reports how much health each really took, with what
 * applyDamage returned for every hit (the API says it returns false for an invulnerable target).
 *
 * The results go to the player's chat and to the content log (as warnings, which the log records).
 * Damage is small (config/balance.ts DAMAGE_PROBE) so the cow never dies, and each scenario gets a
 * fresh cow so nothing carries over.
 */

interface Hit {
    /** Ticks after the scenario's start. Hits with the same tick land in the same tick. */
    readonly tick: number;
    readonly amount: number;
    readonly cause: EntityDamageCause;
}

interface Scenario {
    readonly label: string;
    readonly hits: readonly Hit[];
}

function scenarios(): Scenario[] {

    const unit = P.unitDamage;
    const n = P.hits;
    const total = n * unit;

    const together = (count: number, amount: number, cause: EntityDamageCause = EntityDamageCause.entityAttack): Hit[] =>
        Array.from({ length: count }, () => ({ tick: 0, amount, cause }));

    return [
        { label: `A: ${n} hits of ${unit} in one tick (how the shotguns fired)`, hits: together(n, unit) },
        { label: `B: one hit of ${total} (all pellets added up)`, hits: together(1, total) },
        {
            label: `C: ${n} hits of ${unit}, ${P.spacedTicks} ticks apart`,
            hits: Array.from({ length: n }, (_, i) => ({ tick: i * P.spacedTicks, amount: unit, cause: EntityDamageCause.entityAttack }))
        },
        {
            label: `D: 2 hits of ${total / 2}, ${P.doubleTapTicks} ticks apart (a double-barrel double tap)`,
            hits: [
                { tick: 0, amount: total / 2, cause: EntityDamageCause.entityAttack },
                { tick: P.doubleTapTicks, amount: total / 2, cause: EntityDamageCause.entityAttack }
            ]
        },
        {
            label: `E: a hit of ${unit} then a hit of ${2 * unit}, one tick`,
            hits: [
                { tick: 0, amount: unit, cause: EntityDamageCause.entityAttack },
                { tick: 0, amount: 2 * unit, cause: EntityDamageCause.entityAttack }
            ]
        },
        { label: `F: ${n} hits of ${unit} in one tick, cause override`, hits: together(n, unit, EntityDamageCause.override) }
    ];
}

/** Bumped by a round reset, so a probe in flight stops. */
let epoch = 0;
let running = false;
/** Targets that exist right now, so a reset can remove them. */
const targets = new Set<Entity>();

function say(player: Player, text: string): void {
    console.warn(`[probe] ${text}`);
    if (player.isValid) tell(player, format("info", text));
}

/** A spot the given distance in front of the player, on their level. */
function inFront(player: Player): Vector3 {

    const view = player.getViewDirection();
    const flat = Math.hypot(view.x, view.z) || 1;
    const at = player.location;

    return {
        x: at.x + (view.x / flat) * P.distanceInFront,
        y: at.y,
        z: at.z + (view.z / flat) * P.distanceInFront
    };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.001;
const num = (value: number): string => String(Math.round(value * 100) / 100);

interface Measured {
    readonly label: string;
    readonly dealt: number;
    readonly expected: number;
}

function runScenario(player: Player, scenario: Scenario, mine: number, done: (result: Measured | null) => void): void {

    const stillMine = (): boolean => epoch === mine && player.isValid;

    let target: Entity;

    try {
        target = player.dimension.spawnEntity(P.targetType, inFront(player));
    } catch (error) {
        say(player, `${scenario.label}: could not spawn a ${P.targetType} (${error})`);
        done(null);
        return;
    }

    targets.add(target);

    const health = target.getComponent("minecraft:health");

    if (!health) {
        say(player, `${scenario.label}: the ${P.targetType} has no health component to read`);
        removeTarget(target);
        done(null);
        return;
    }

    const before = health.currentValue;
    const returned: boolean[] = [];
    const ticks = [...new Set(scenario.hits.map((hit) => hit.tick))].sort((a, b) => a - b);

    for (const tick of ticks) {

        system.runTimeout(() => {

            if (!stillMine() || !target.isValid) return;

            for (const hit of scenario.hits.filter((h) => h.tick === tick)) {
                returned.push(target.applyDamage(hit.amount, { cause: hit.cause, damagingEntity: player }));
            }
        }, 1 + tick);
    }

    const readAt = 1 + ticks[ticks.length - 1] + P.settleTicks;

    system.runTimeout(() => {

        if (!stillMine() || !target.isValid) {
            removeTarget(target);
            done(null);
            return;
        }

        const dealt = before - health.currentValue;
        const expected = scenario.hits.reduce((sum, hit) => sum + hit.amount, 0);

        say(player, `${scenario.label}: dealt ${num(dealt)} of ${num(expected)} (applyDamage returned ${returned.map(String).join(", ")})`);

        removeTarget(target);
        done({ label: scenario.label, dealt, expected });
    }, readAt);
}

function removeTarget(target: Entity): void {

    targets.delete(target);

    try {
        if (target.isValid) target.remove();
    } catch {
        // Already gone: nothing left to remove.
    }
}

/** What the six results mean for the shotguns, in a line or two. */
function reading(results: readonly Measured[]): string[] {

    const [a, b, c, d] = results;
    const unit = P.unitDamage;
    const lines: string[] = [];

    if (near(a.dealt, a.expected)) lines.push("Reading: hits in the same tick ADD UP, so pellets are not being swallowed.");
    else if (a.dealt <= unit + 0.001 && near(b.dealt, b.expected)) lines.push(`Reading: hits in the same tick do NOT add up (only ${num(a.dealt)} of ${num(a.expected)} counted), but one summed hit does. Sum the pellets into one hit.`);
    else lines.push(`Reading: hits in the same tick only partly add up (${num(a.dealt)} of ${num(a.expected)}).`);

    if (!near(c.dealt, c.expected)) lines.push(`Hits ${P.spacedTicks} ticks apart still lost damage (${num(c.dealt)} of ${num(c.expected)}), so any invulnerability window here is longer than that.`);
    if (!near(d.dealt, d.expected)) lines.push(`A second shot ${P.doubleTapTicks} ticks later lost damage (${num(d.dealt)} of ${num(d.expected)}): a fast double tap is affected.`);

    return lines;
}

function start(player: Player): void {

    if (running) {
        say(player, "The damage probe is already running.");
        return;
    }

    running = true;
    const mine = epoch;
    const all = scenarios();
    const results: Measured[] = [];

    // A run that a reset stopped still has timers pending. When they fire they must not clear the
    // flag of the run that replaced it, or a second probe could start on top of the first.
    const finish = (): void => {
        if (epoch === mine) running = false;
    };

    say(player, `Damage probe: ${all.length} scenarios on a ${P.targetType} ${P.distanceInFront} blocks in front of you. Stay put.`);

    const next = (index: number): void => {

        if (epoch !== mine || !player.isValid) {
            finish();
            return;
        }

        if (index >= all.length) {
            finish();

            for (const line of reading(results)) say(player, line);

            return;
        }

        runScenario(player, all[index], mine, (result) => {

            if (result === null) {
                finish();
                return;
            }

            results.push(result);
            system.runTimeout(() => next(index + 1), P.gapTicks);
        });
    };

    next(0);
}

onScriptEvent("rae:probe_damage", (player) => {

    if (!player) {
        console.warn("[probe] rae:probe_damage has to be run by a player, so there is someone to stand in front of.");
        return;
    }

    start(player);
});

registerSystem({
    name: "probe",
    reset() {
        // A probe in flight notices the new epoch and stops; whatever it spawned goes now.
        epoch++;
        running = false;
        for (const target of [...targets]) removeTarget(target);
    }
});
