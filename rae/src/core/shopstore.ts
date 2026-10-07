import { SHOP as S } from "../config/balance.js";
import { parse, serialize, type Shop } from "../logic/shop.js";
import { createRecordStore } from "./recordstore.js";

/**
 * Where shops live: one world property each, `rae:shop:def:<id>`, holding logic/shop.ts's saved text. The rules (written at
 * once, a save that does not fit is refused, an unreadable save is listed and never overwritten, one level of undo) are
 * core/recordstore.ts's; this file only says what a shop is and how big one may be.
 */

const store = createRecordStore<Shop>({
    source: "shop",
    noun: "shop",
    prefix: "rae:shop:def:",
    maxRecords: S.maxShops,
    maxChars: S.maxSavedChars,
    parse,
    serialize,
    idOf: (shop) => shop.id
});

/** Every saved shop, readable or not, by id. */
export const listStored = store.list;
export const getStored = store.get;

/** The shop with this id, or undefined when there is none or it cannot be read. */
export const getShop = store.value;

/** Every readable shop. */
export const allShops = (): readonly Shop[] => store.all();

export const storeVersion = store.version;
export const saveShop = store.save;
export const deleteShop = store.remove;
export const undoAvailable = store.undoAvailable;
export const undoLast = store.undo;
export const rawText = store.rawText;

/** Forgets everything read so far (what a script reload leaves). For tests. */
export const forgetLoaded = store.forget;
