import type { Player } from "@minecraft/server";
import { registerSystem } from "./registry.js";

/**
 * The single source of truth for per-player game state.
 *
 * Until now the game kept this in entity TAGS (law, outlaw, eliminated, in_jail, ...) and read
 * them back with hasTag() from a dozen files. Tags are a poor database: every read is an engine
 * call, nothing checks a write, and two systems can disagree. Now each player has one record,
 * keyed by player.id, that systems read and update through this module.
 *
 * TAGS ARE OUTPUT, NOT INPUT. update() writes the matching tags so command blocks can keep
 * targeting `@a[tag=law]`, but game logic must read the record. adoptTags() is the one way
 * back from tags to the record: it exists for players whose tags were set from outside (a
 * command block, a world that was saved mid-round). This module is the only place allowed to
 * read or write those role/status tags.
 */

export type Role = "law" | "outlaw";

export interface PlayerRecord {
    readonly id: string;
    /** Assigned at round start; null before that. */
    role: Role | null;
    /** Permanently out for the round (spectator). */
    eliminated: boolean;
    /** Times law has captured this player this round: 1 = jailed once, a second capture eliminates. */
    captures: number;
    /** Physically detained right now. */
    inJail: boolean;
    /** Killed by law; goes to jail on respawn. */
    pendingJail: boolean;
    /** Freed from jail and still running from it. */
    escortVulnerable: boolean;
    winner: boolean;
    /** Chambered rounds, by gun id. */
    ammo: Record<string, number>;
    /** Small per-player booleans that don't merit a field yet. */
    flags: Record<string, boolean>;
}

export type RecordPatch = Partial<Omit<PlayerRecord, "id" | "ammo" | "flags">>;

// The tags a record is mirrored to. `jailed` means captures >= 1.
const TAG = {
    law: "law",
    outlaw: "outlaw",
    eliminated: "eliminated",
    jailed: "jailed",
    inJail: "in_jail",
    pendingJail: "send_to_jail",
    escortVulnerable: "escort_vulnerable",
    winner: "winner"
} as const;

const records = new Map<string, PlayerRecord>();
// The tags this module has written (or observed) per player, so a sync only touches the difference.
const mirrored = new Map<string, Set<string>>();
let version = 0;

function blank(id: string): PlayerRecord {
    return { id, role: null, eliminated: false, captures: 0, inJail: false, pendingJail: false, escortVulnerable: false, winner: false, ammo: {}, flags: {} };
}

function tagsFor(record: PlayerRecord): Set<string> {
    const tags = new Set<string>();
    if (record.role) tags.add(TAG[record.role]);
    if (record.eliminated) tags.add(TAG.eliminated);
    if (record.captures >= 1) tags.add(TAG.jailed);
    if (record.inJail) tags.add(TAG.inJail);
    if (record.pendingJail) tags.add(TAG.pendingJail);
    if (record.escortVulnerable) tags.add(TAG.escortVulnerable);
    if (record.winner) tags.add(TAG.winner);
    return tags;
}

function writeTags(player: Player, record: PlayerRecord): void {

    const desired = tagsFor(record);
    const current = mirrored.get(record.id) ?? new Set<string>();

    for (const tag of desired) if (!current.has(tag)) player.addTag(tag);
    for (const tag of current) if (!desired.has(tag)) player.removeTag(tag);

    mirrored.set(record.id, desired);
}

/**
 * Rebuilds a player's record from the tags they currently carry. Use it when tags were set
 * from outside this module. Ammo and flags are kept; everything tag-backed is overwritten.
 */
export function adoptTags(player: Player): Readonly<PlayerRecord> {

    const record = records.get(player.id) ?? blank(player.id);
    const observed = new Set<string>();

    const has = (tag: string): boolean => {
        const present = player.hasTag(tag);
        if (present) observed.add(tag);
        return present;
    };

    record.role = has(TAG.law) ? "law" : has(TAG.outlaw) ? "outlaw" : null;
    record.eliminated = has(TAG.eliminated);
    record.captures = has(TAG.jailed) ? Math.max(record.captures, 1) : 0;
    record.inJail = has(TAG.inJail);
    record.pendingJail = has(TAG.pendingJail);
    record.escortVulnerable = has(TAG.escortVulnerable);
    record.winner = has(TAG.winner);

    records.set(record.id, record);
    mirrored.set(record.id, observed);
    version++;

    return record;
}

/** The player's record, created (from their current tags) the first time it is asked for. */
export function getRecord(player: Player): Readonly<PlayerRecord> {
    return records.get(player.id) ?? adoptTags(player);
}

export function findRecord(id: string): Readonly<PlayerRecord> | undefined {
    return records.get(id);
}

export function allRecords(): readonly Readonly<PlayerRecord>[] {
    return [...records.values()];
}

/** Applies a change to the record and writes the matching tags. The only way to change role or status. */
export function update(player: Player, patch: RecordPatch): Readonly<PlayerRecord> {

    const record = records.get(player.id) ?? (getRecord(player) as PlayerRecord);

    Object.assign(record, patch);
    version++;
    writeTags(player, record);

    return record;
}

export function setAmmo(player: Player, gunId: string, rounds: number): void {
    (getRecord(player) as PlayerRecord).ammo[gunId] = rounds;
    version++;
}

export function setFlag(player: Player, name: string, value: boolean): void {
    (getRecord(player) as PlayerRecord).flags[name] = value;
    version++;
}

/** Increments on every change, so caches built from records can tell when they are stale. */
export function stateVersion(): number {
    return version;
}

export function clearRecords(): void {
    records.clear();
    mirrored.clear();
    version++;
}

registerSystem({
    name: "state",
    // This module writes these tags, so it declares them: a round reset clears them whatever
    // other systems happen to be loaded (roles/jail/jailbreak/endgame/boat still list theirs too).
    ownedTags: Object.values(TAG),
    reset() {
        // The registry has just removed every owned tag from every player; forget the records to match.
        clearRecords();
    }
});
