/**
 * Contract for state that must survive a world reload.
 *
 * Everything the game keeps in module variables is lost when the world reloads. A module that
 * needs to survive registers a Persistable; the persistence engine (built later) saves every
 * registered one to world dynamic properties and hands the data back after a reload.
 *
 * Bump `version` whenever the saved shape changes: restore() is told which version wrote the data.
 */
export interface Persistable {
    /** Stable, unique name. Also the storage key, so never rename one that has shipped. */
    readonly key: string;
    readonly version: number;
    /** Must return JSON-serialisable data. */
    save(): unknown;
    restore(data: unknown, savedVersion: number): void;
}

const registered: Persistable[] = [];

export function registerPersistable(entry: Persistable): void {

    if (registered.some((p) => p.key === entry.key)) {
        throw new Error(`Persistable "${entry.key}" is already registered`);
    }

    registered.push(entry);
}

export function listPersistables(): readonly Persistable[] {
    return registered;
}
