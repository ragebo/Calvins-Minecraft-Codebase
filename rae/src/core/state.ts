import { world, system, type Player } from "@minecraft/server";
import type { JailSite } from "../config/world.js";
import { onSpawn } from "./events.js";
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
 *
 * DEATH HANDLERS: inside an entityDie handler the dead player's entity handle may already be
 * invalid, so calling anything on it (hasTag, addTag) can throw. `id` is still readable. So there
 * read with findRecord(deadEntity.id) (or recordOf(deadEntity)) and change with
 * updateById(deadEntity.id, ...), which never touch the entity, then call syncTags(player) once the
 * player is valid again (their next spawn: the "state:adopt" spawn handler below does it first).
 *
 * That only works if the record exists BEFORE the death, so everyone is adopted early: at their
 * first spawn (joining or respawning), and at load for whoever is already in the world.
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
// Records changed by id whose tags haven't been written yet.
const dirty = new Set<string>();
// The jail in use right now. Not a per-player fact, so it isn't on a record, but it is round state too.
let jailSite: JailSite | null = null;
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
    dirty.delete(record.id);        // the tags just read are now the truth; nothing is pending
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

/**
 * The record for a player who may no longer have a valid entity, such as a death handler's
 * deadEntity. It uses the record that exists. A player the game has never seen (which adopting
 * everyone early makes rare) is read from their tags, but only while the handle is still valid:
 * with an invalid handle there is nothing to go on, so the answer is undefined.
 */
export function recordOf(player: Player): Readonly<PlayerRecord> | undefined {
    return records.get(player.id) ?? (player.isValid ? adoptTags(player) : undefined);
}

export function allRecords(): readonly Readonly<PlayerRecord>[] {
    return [...records.values()];
}

/**
 * Changes a record by player id, without touching the entity: safe inside a death handler, where
 * the handle may be invalid. The matching tags are written by the next syncTags(player). A player
 * with no record yet gets a blank one (adopt everyone at load and spawn so this is rare).
 */
export function updateById(id: string, patch: RecordPatch): Readonly<PlayerRecord> {

    const record = records.get(id) ?? blank(id);

    Object.assign(record, patch);
    records.set(id, record);
    dirty.add(id);
    version++;

    return record;
}

/** Writes any pending record changes to the player's tags. Call it once the player is valid again. */
export function syncTags(player: Player): void {

    const record = records.get(player.id);
    if (!record || !dirty.has(record.id)) return;

    writeTags(player, record);
    dirty.delete(record.id);
}

/** Changes the record and writes the matching tags now. The normal way to change role or status. */
export function update(player: Player, patch: RecordPatch): Readonly<PlayerRecord> {

    getRecord(player);                          // first sight of this player: seed from their tags
    const record = updateById(player.id, patch);
    syncTags(player);

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

/**
 * The jail site prisoners are currently sent to, or null when none has been chosen (before the first
 * capture, and after a reset). Choosing one is the jail system's job; this is only where it is kept,
 * so the jailbreak can find the door without importing the jail.
 */
export function getJailSite(): JailSite | null {
    return jailSite;
}

export function setJailSite(site: JailSite | null): void {

    if (site === jailSite) return;

    jailSite = site;
    version++;
}

/** Increments on every change, so caches built from records can tell when they are stale. */
export function stateVersion(): number {
    return version;
}

export function clearRecords(): void {
    records.clear();
    mirrored.clear();
    dirty.clear();
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
        setJailSite(null);
    }
});

// Order 0, before any handler that decides from a record: every spawn (a join or a respawn) makes
// sure the player has a record, and writes out whatever changed while they were dead (a death
// handler can only change the record, not the invalid entity).
onSpawn("state:adopt", 0, (ctx) => {
    getRecord(ctx.player);
    syncTags(ctx.player);
});

// Everyone already in the world when the addon loads (a script reload, a world saved mid-round)
// never gets a spawn event for it, so adopt them on the first tick.
system.run(() => {
    for (const player of world.getAllPlayers()) getRecord(player);
});
