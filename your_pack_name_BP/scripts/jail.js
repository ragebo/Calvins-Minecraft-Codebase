import { world } from "@minecraft/server";

//====================================
// JAIL LOCATIONS
//====================================

// Each entry needs BOTH the jail's teleport point AND its own
// doorTrigger point (where the redstone block gets placed to
// open THAT jail's door). One entry gets picked at random
// whenever the jail is currently empty. Add as many as you want
// — just make sure each one's doorTrigger actually corresponds
// to a working redstone setup at that specific jail.
export const JAIL_LOCATIONS = [
    {
        jail: { x: -254, y: 64, z: 235 },
        doorTrigger: { x: -250, y: 62, z: 236 }
    },
    {
        jail: { x: 76, y: 69, z: 214 },
        doorTrigger: { x: 85, y: 70, z: 217 }
    }
];

let activeJailEntry = null;

// Is anyone currently physically detained right now? Distinct
// from the "jailed" tag, which is permanent (marks second-life).
export function isJailOccupied() {
    return world.getAllPlayers().some(player => player.hasTag("in_jail"));
}

// Call this ONLY when a NEW prisoner is captured. Rolls a fresh
// jail entry if the jail is currently empty (or none picked
// yet); otherwise reuses whatever jail is already active, so
// multiple prisoners always share the same one. Returns just the
// teleport point, same shape as before — nothing calling this
// needs to change.
export function assignJailForNewPrisoner() {

    if (!isJailOccupied() || !activeJailEntry) {
        activeJailEntry = JAIL_LOCATIONS[Math.floor(Math.random() * JAIL_LOCATIONS.length)];
    }

    return activeJailEntry.jail;
}

// Read-only lookup of wherever the jail currently is. Never
// rolls a new one — for systems that just need to know where it
// is right now, like the jailbreak lockpick zone.
export function getCurrentJail() {
    return activeJailEntry ? activeJailEntry.jail : null;
}

// The door-trigger point that matches whichever jail is
// currently active. Used to open the right door, not just
// whichever one happens to be first in the list.
export function getCurrentDoorTrigger() {
    return activeJailEntry ? activeJailEntry.doorTrigger : null;
}

// Call this at round reset so a new round starts with no active
// jail until someone is actually captured.
export function resetJail() {
    activeJailEntry = null;
}