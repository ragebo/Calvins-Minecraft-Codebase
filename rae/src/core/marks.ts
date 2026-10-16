import type { Player } from "@minecraft/server";
import type { Mark } from "../logic/start.js";
import { warn } from "./log.js";

/**
 * A camera mark taken from an operator, and the half-made one kept on them between two button presses ("mark the start here", walk, "mark the end here").
 * Used by the start sequence's camera shots (core/startforms.ts) and by an ending's cinematic (core/endingforms.ts), each under a key of its own so the
 * two never mix.
 */

/** Where the operator's camera would be if it were their eyes, and the way they face. */
export function eyeMark(player: Player): Mark {

    const head = player.getHeadLocation();
    const view = player.getRotation();

    return { x: head.x, y: head.y, z: head.z, pitch: view.x, yaw: view.y };
}

/** A place as three whole numbers, which is all an operator reading a screen needs. */
export const where = (mark: Pick<Mark, "x" | "y" | "z">): string => `${Math.round(mark.x)}, ${Math.round(mark.y)}, ${Math.round(mark.z)}`;

/** The half-made mark kept on the operator under `key`, or undefined when there is none or it is damaged (which is the same as none). */
export function pendingMark(player: Player, key: string): Mark | undefined {

    try {
        const raw = player.getDynamicProperty(key);

        if (typeof raw !== "string") return undefined;

        const list: unknown = JSON.parse(raw);

        if (!Array.isArray(list) || list.length !== 5 || !list.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;

        return { x: list[0] as number, y: list[1] as number, z: list[2] as number, pitch: list[3] as number, yaw: list[4] as number };
    } catch {
        return undefined;
    }
}

export function setPendingMark(player: Player, key: string, mark: Mark | undefined, source: string): void {

    try {
        player.setDynamicProperty(key, mark === undefined ? undefined : JSON.stringify([mark.x, mark.y, mark.z, mark.pitch, mark.yaw]));
    } catch (err) {
        warn(source, `Could not keep a mark for ${player.name}: ${err}`);
    }
}
