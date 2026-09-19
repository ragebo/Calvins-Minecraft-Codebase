import { world, type Player } from "@minecraft/server";
import { STATE_SYNC } from "../config/balance.js";
import type { JailSite } from "../config/world.js";
import { onScriptEvent, onSpawn } from "./events.js";
import { registerSystem } from "./registry.js";
import { onTick } from "./tick.js";
import { format, tell } from "./ui.js";

/**
 * The single source of truth for per-player game state.
 *
 * Until now the game kept this in entity TAGS (law, outlaw, eliminated, in_jail, ...) and read
 * them back with hasTag() from a dozen files. Tags are a poor database: every read is an engine
 * call, nothing checks a write, and two systems can disagree. Now each player has one record,
 * keyed by player.id, that systems read and update through this module.
 *
 * TAGS ARE OUTPUT, NOT INPUT. update() writes the matching tags so command blocks can keep
 * targeting `@a[tag=law]`, but game logic must read the record. This module is the only place
 * allowed to read or write those role/status tags.
 *
 * The one way back from tags to the record is adoption, for tags that were set from outside: a
 * world saved mid-round, a command block, or a person typing `/tag @s add law`. Nothing tells the
 * script when a tag changes, so a poll (every STATE_SYNC.reconcileIntervalTicks) compares each
 * player's tags with what this module last wrote or saw, and adopts any difference. The person who
 * typed the tag wins over the record. `/scriptevent rae:adopt` makes the same check right now, for
 * everyone, and lists what the records say. A record with a change of its own still waiting to be
 * written (see DEATH HANDLERS) is never overwritten by the poll. Adopting only changes what the game
 * believes: it does not run the side effects of the change (no gamemode, no teleport, no kit).
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

// The same tags as a set, to pick them out of everything else a player carries.
const MANAGED: ReadonlySet<string> = new Set(Object.values(TAG));

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

/** The managed tags the player carries right now: one engine call, whatever else they carry. */
function managedTagsOf(player: Player): Set<string> {

    const observed = new Set<string>();

    for (const tag of player.getTags()) {
        if (MANAGED.has(tag)) observed.add(tag);
    }

    return observed;
}

function sameTags(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {

    if (a.size !== b.size) return false;

    for (const tag of a) {
        if (!b.has(tag)) return false;
    }

    return true;
}

/**
 * The role the tags name. Normally there is one role tag. When someone hand-adds the OTHER role's
 * tag without removing the first, both are present, and the one that is new is what they meant:
 * typing `/tag @s add outlaw` on a law player makes them an outlaw. `known` is what this module last
 * wrote or saw, and it never holds both roles, so both being new means a first sight: law, as
 * adoption always has.
 */
function roleFrom(observed: ReadonlySet<string>, known: ReadonlySet<string> | undefined): Role | null {

    const law = observed.has(TAG.law);
    const outlaw = observed.has(TAG.outlaw);

    if (!law && !outlaw) return null;
    if (law !== outlaw) return law ? "law" : "outlaw";

    // Only the outlaw tag being the newcomer makes them an outlaw; a new law tag, or a tie, is law.
    const lawIsNew = !known?.has(TAG.law);
    const outlawIsNew = !known?.has(TAG.outlaw);

    return outlawIsNew && !lawIsNew ? "outlaw" : "law";
}

/**
 * Makes the record say what `observed` (the managed tags the player carries) say, then makes the
 * tags agree with the record. The only tag this ever removes is a role tag that lost to the other
 * one, so a player never carries both. Ammo and flags are kept; everything tag-backed is overwritten.
 */
function adoptObserved(player: Player, observed: ReadonlySet<string>): PlayerRecord {

    const record = records.get(player.id) ?? blank(player.id);

    record.role = roleFrom(observed, mirrored.get(record.id));
    record.eliminated = observed.has(TAG.eliminated);
    record.captures = observed.has(TAG.jailed) ? Math.max(record.captures, 1) : 0;
    record.inJail = observed.has(TAG.inJail);
    record.pendingJail = observed.has(TAG.pendingJail);
    record.escortVulnerable = observed.has(TAG.escortVulnerable);
    record.winner = observed.has(TAG.winner);

    records.set(record.id, record);
    mirrored.set(record.id, new Set(observed));
    dirty.delete(record.id);        // the tags just read are now the truth; nothing is pending
    version++;

    writeTags(player, record);      // removes the losing role tag, if there was one

    return record;
}

/**
 * Rebuilds a player's record from the tags they currently carry. Use it when tags were set
 * from outside this module and the record must follow now. Ammo and flags are kept; everything
 * tag-backed is overwritten, including a change that was waiting to be written.
 */
export function adoptTags(player: Player): Readonly<PlayerRecord> {
    return adoptObserved(player, managedTagsOf(player));
}

/** What reconcile() found: the tags were `same` as last seen, the record `adopted` them, or a change of its own is `pending`. */
type Reconciled = "same" | "adopted" | "pending";

/**
 * Brings one player's record in line with the tags they carry, when those changed without this
 * module (a hand-typed /tag, a command block). Unlike adoptTags() it never discards a change that is
 * waiting to be written, and it does nothing (no version bump) when the tags are what was last seen.
 * The player's handle must be valid.
 */
function reconcile(player: Player): Reconciled {

    const record = records.get(player.id);

    if (!record) {
        adoptTags(player);              // never seen: nothing to compare with
        return "adopted";
    }

    if (dirty.has(record.id)) return "pending";

    const observed = managedTagsOf(player);
    const known = mirrored.get(record.id);

    if (known && sameTags(observed, known)) return "same";

    adoptObserved(player, observed);

    return "adopted";
}

interface Tally {
    /** Players whose tags were looked at. */
    read: number;
    /** Records created or changed to follow their tags. */
    changed: number;
    /** Records left alone because a change of their own is still waiting to be written. */
    pending: number;
}

function reconcileAll(players: readonly Player[]): Tally {

    const tally: Tally = { read: 0, changed: 0, pending: 0 };

    for (const player of players) {

        // A player who disconnected since the list was taken has nothing to read.
        if (!player.isValid) continue;

        tally.read++;

        const outcome = reconcile(player);

        if (outcome === "adopted") tally.changed++;
        else if (outcome === "pending") tally.pending++;
    }

    return tally;
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
// never gets a spawn event for it, so adopt them on the first tick, then stand down.
const stopAdoptingAtLoad = onTick("state:adopt-at-load", (ctx) => {
    reconcileAll(ctx.players);
    stopAdoptingAtLoad();
}, { everyTicks: 1 });

// Tags typed by hand (or set by a command block) have no event, so look for them. This rides the
// shared tick loop, and its player list is the one every other handler due on the tick shares.
onTick("state:reconcile", (ctx) => {
    reconcileAll(ctx.players);
}, { everyTicks: STATE_SYNC.reconcileIntervalTicks });

// `/scriptevent rae:adopt`: the same check right now instead of at the next poll, for whoever is
// online. The reply lists what each record says, which is the only place a person can see them.
// A command block gets no reply: it can't read chat.
onScriptEvent("rae:adopt", (source) => {

    const players = world.getAllPlayers();
    const tally = reconcileAll(players);

    if (!source) return;

    const pending = tally.pending > 0 ? `, ${tally.pending} skipped (change pending)` : "";

    tell(source, format("info", `Adopt: ${tally.read} read, ${tally.changed} changed${pending}`));

    for (const player of players) {

        const record = player.isValid ? records.get(player.id) : undefined;
        if (!record) continue;

        const tags = [...tagsFor(record)];

        tell(source, format("info", `  ${player.name}: ${tags.length > 0 ? tags.join(" ") : "no role"}`));
    }
});
