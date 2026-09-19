import type { Vector3 } from "@minecraft/server";

/**
 * EVERY coordinate in the game lives here. Nothing else defines one.
 *
 * This is the file you check against the real world. If a number is
 * wrong, it is wrong in exactly one place.
 */

/** Bump whenever the shape or meaning of what this file exports changes in a way persisted data depends on. */
export const WORLD_SCHEMA_VERSION = 1;

// ---------------------------------------------------
// SPAWNS
// ---------------------------------------------------

export const LAW_SPAWNS: Vector3[] = [
    { x: 125, y: 83, z: 196 },
    { x: -250, y: 64, z: 234 }
];

export const OUTLAW_SPAWNS: Vector3[] = [
    { x: -287, y: 68, z: -152 },
    { x: -137, y: 109, z: -287 },
    { x: 172, y: 82, z: -262 }
];

// ---------------------------------------------------
// JAIL
// ---------------------------------------------------

export interface JailSite {
    /** Where the prisoner is teleported. */
    jail: Vector3;
    /** Where a redstone block is placed to open that jail's door. */
    doorTrigger: Vector3;
}

export const JAIL_SITES: JailSite[] = [
    {
        jail: { x: -254, y: 64, z: 235 },
        doorTrigger: { x: -250, y: 62, z: 236 }
    },
    {
        jail: { x: 76, y: 69, z: 214 },
        doorTrigger: { x: 85, y: 70, z: 217 }
    }
];

// ---------------------------------------------------
// RANCH RAID
// ---------------------------------------------------

export const RANCH_AREA = {
    min: { x: -295, y: 68, z: -66 },
    max: { x: -277, y: 83, z: -41 }
};

export const RANCH_LOWER_SPAWNS: Vector3[] = [
    { x: -291, y: 69, z: -59 },
    { x: -289, y: 69, z: -59 },
    { x: -283, y: 69, z: -48 },
    { x: -292, y: 69, z: -48 }
];

export const RANCH_UPPER_SPAWNS: Vector3[] = [
    { x: -283, y: 73, z: -59 },
    { x: -291, y: 73, z: -53 }
];

export const RANCH_SAFE_TRIGGER: Vector3 = { x: -284, y: 76, z: -55 };

// ---------------------------------------------------
// FORT RAID
// ---------------------------------------------------

export const FORT_AREA = {
    min: { x: -30, y: 69, z: -65 },
    max: { x: -4, y: 79, z: -39 }
};

export const FORT_SPAWNS: Vector3[] = [
    { x: -26, y: 74, z: -43 },
    { x: -26, y: 74, z: -61 },
    { x: -8, y: 74, z: -61 },
    { x: -8, y: 74, z: -43 },
    { x: -13, y: 70, z: -52 },
    { x: -17, y: 70, z: -56 },
    { x: -21, y: 70, z: -52 }
];

export const FORT_REWARD_CHEST: Vector3 = { x: -8, y: 70, z: -52 };

// ---------------------------------------------------
// TRAIN ROBBERY
// ---------------------------------------------------

export const TRAIN_START: Vector3 = { x: -284, y: 94, z: -269 };
export const TRAIN_END: Vector3 = { x: -241, y: 94, z: -269 };

/** Size of the saved train structure. NOT the track length. */
export const TRAIN_SIZE = { x: 29, y: 5, z: 3 };

export const TRAIN_VAULT_CHEST: Vector3 = { x: -236, y: 97, z: -268 };

export const BRIDGE_AREA = {
    min: { x: -212, y: 92, z: -270 },
    max: { x: -209, y: 94, z: -266 }
};

// ---------------------------------------------------
// BOAT ESCAPE
// ---------------------------------------------------

export const BOAT_NPC: Vector3 = { x: 10, y: 65, z: 154 };
export const BOAT_WIN_TELEPORT: Vector3 = { x: 369.17, y: 63.06, z: -370.01 };
