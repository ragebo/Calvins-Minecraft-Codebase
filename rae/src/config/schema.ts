/**
 * Versioning for the shape of the config, so saved data is never silently
 * misread after the config changes.
 *
 * Each config file exports a *_SCHEMA_VERSION integer. describeSchema()
 * folds them into one fingerprint such as "balance@1,guns@1,world@1".
 * Anything persisted between rounds should store that fingerprint next to
 * its data. When loading, migrator.migrate(savedFingerprint, data) returns
 * the data as-is if the fingerprint matches, upgrades it through the
 * registered migrations if it does not, and answers { ok: false, reason }
 * when no chain of migrations leads to the running config. The caller must
 * then refuse or discard the saved data, never guess.
 *
 * BUMP POLICY
 *  - Bump a file's version whenever the shape or meaning of what it exports
 *    changes in a way persisted data depends on: a key renamed, removed or
 *    retyped, a unit or scale changed, an id, index or ordering that saved
 *    data points at reshuffled.
 *  - Do not bump for a plain tuning change that nothing saved refers to.
 *  - A bump changes the fingerprint, so older saves are refused until a
 *    migration from the old fingerprint to the new one is registered.
 *  - Adding or removing a file in CONFIG_SCHEMA changes the fingerprint
 *    too, and is handled the same way.
 *
 * Pure module: no game API imports, so it loads and tests anywhere.
 */

import { BALANCE_SCHEMA_VERSION } from "./balance.js";
import { GUNS_SCHEMA_VERSION } from "./guns.js";
import { WORLD_SCHEMA_VERSION } from "./world.js";

export const CONFIG_SCHEMA = Object.freeze({
    balance: BALANCE_SCHEMA_VERSION,
    guns: GUNS_SCHEMA_VERSION,
    world: WORLD_SCHEMA_VERSION
});

/**
 * Canonical fingerprint of a schema: "key@version" pairs, sorted by key and
 * joined with commas. The same schema gives the same string whatever order
 * its keys were written in. Keys are ordered by plain code-unit comparison,
 * never a locale-aware one, so the string is identical on every machine.
 */
export function describeSchema(schema: Readonly<Record<string, number>> = CONFIG_SCHEMA): string {
    return Object.keys(schema)
        .sort()
        .map((key) => `${key}@${schema[key]}`)
        .join(",");
}

/** One upgrade step: turns data saved under fingerprint `from` into data valid under `to`. */
export interface Migration {
    readonly from: string;
    readonly to: string;
    migrate(data: unknown): unknown;
}

export type MigrationResult =
    | { readonly ok: true; readonly data: unknown }
    | { readonly ok: false; readonly reason: string };

export interface Migrator {
    /**
     * Adds one upgrade step. Registration order does not matter, except as
     * a tie-break: of two equally short chains, the one whose first step was
     * registered earlier is used.
     */
    register(migration: Migration): void;
    /**
     * Brings `data`, saved under fingerprint `saved`, up to the current one.
     * Never throws: every failure comes back as { ok: false, reason }.
     */
    migrate(saved: string, data: unknown): MigrationResult;
}

/** Text for a message. Never throws, even for a value that refuses to be printed. */
function show(value: unknown): string {
    try {
        return String(value);
    } catch {
        return "(unprintable)";
    }
}

export function createMigrator(current: string): Migrator {

    // The registered steps, grouped by the fingerprint each one leaves.
    const stepsFrom = new Map<string, Migration[]>();

    /** Shortest chain of steps from `saved` to `current`, or null when none exists. */
    function findChain(saved: string): Migration[] | null {

        // Breadth first, so the first chain found is a shortest one. Each
        // fingerprint is entered at most once, which is what makes a cycle
        // (A>B and B>A) harmless: the search always runs out of new places.
        const seen = new Set<string>([saved]);
        const queue: { at: string; chain: Migration[] }[] = [{ at: saved, chain: [] }];

        // Entries leave the queue as they are searched, so it never holds more than the current frontier.
        for (let entry = queue.shift(); entry; entry = queue.shift()) {

            for (const step of stepsFrom.get(entry.at) ?? []) {
                if (seen.has(step.to)) continue;
                seen.add(step.to);

                const chain = [...entry.chain, step];
                if (step.to === current) return chain;
                queue.push({ at: step.to, chain });
            }
        }

        return null;
    }

    return {
        register(migration) {
            const steps = stepsFrom.get(migration.from);
            if (steps) steps.push(migration);
            else stepsFrom.set(migration.from, [migration]);
        },

        migrate(saved, data) {

            if (saved === current) return { ok: true, data };

            const refusal = `Cannot migrate saved config "${show(saved)}" to "${show(current)}"`;

            const chain = findChain(saved);
            if (chain === null) {
                return { ok: false, reason: `${refusal}: no chain of registered migrations connects them.` };
            }

            let migrated = data;
            for (const step of chain) {
                try {
                    migrated = step.migrate(migrated);
                } catch (error) {
                    return {
                        ok: false,
                        reason: `${refusal}: the step "${show(step.from)}" -> "${show(step.to)}" threw ${show(error)}`
                    };
                }
            }

            return { ok: true, data: migrated };
        }
    };
}

/** The migrator for the config the game is running now. */
export const migrator = createMigrator(describeSchema());
