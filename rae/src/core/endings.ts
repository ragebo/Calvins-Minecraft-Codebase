import { world, type Player } from "@minecraft/server";
import { fillText, groupVerdict, type Ending } from "../logic/endings.js";
import { getCoins, takeCoins } from "./economy.js";
import { getEnding, listEndings } from "./endingstore.js";
import { endRound, isPhase } from "./round.js";
import { getRecord, update } from "./state.js";
import { aliveOutlaws } from "./players.js";

/**
 * Running an ending (logic/endings.ts is what one is and when it is met, core/endingstore.ts keeps them; the plan is tasks/endings/plan.md).
 *
 * `attemptEnding` is what a player's try becomes: the script event `rae:ending <id>` (run by an NPC's button or a command block), or `bounty:escape`,
 * which is the boat's. It checks in the order the boat always has (who, then whether a round is running, then the gathering, then the money), says what
 * is wrong in the ending's own words, and on success takes the coins, ends the round and announces it.
 *
 * Nothing is kept between attempts: whether a round has already ended is core/round.ts's job, so two attempts in one tick cannot both win.
 */

function say(player: Player, text: string): void {
    if (text.length > 0) player.sendMessage(text);
}

function announce(text: string): void {
    if (text.length > 0) world.sendMessage(text);
}

/** A player's try at the ending with this id. Every refusal says why, to the player alone or to everyone, as the boat did. */
export function attemptEnding(player: Player, id: string): void {

    if (id.length === 0) {
        const ids = listEndings().map((stored) => stored.id).join(", ");
        say(player, `§cUse rae:ending <id>. Endings: ${ids.length > 0 ? ids : "none yet"}.`);
        return;
    }

    const ending = getEnding(id);

    if (!ending) {
        say(player, `§cThere is no ending ${id}.`);
        return;
    }

    if (!ending.enabled) {
        say(player, "§cThat ending is switched off.");
        return;
    }

    if (getRecord(player).role !== "outlaw") {
        say(player, ending.texts.outlawsOnly);
        return;
    }

    // Without this, an eliminated outlaw trying after law has already won would leave nobody in play, and the gathering and the money checks would
    // both pass on an empty gang, announcing an escape with nobody in it.
    if (!isPhase("ACTIVE")) {
        say(player, "§cNo round is running.");
        return;
    }

    if (ending.kind === "group") attemptGroup(player, ending);
    else say(player, "§cThat ending is not ready yet.");
}

function attemptGroup(player: Player, ending: Ending): void {

    const survivors = aliveOutlaws();
    const verdict = groupVerdict(ending, survivors.map((outlaw) => ({ id: outlaw.id, coins: getCoins(outlaw), at: outlaw.location })));

    if (!verdict.ok) {
        if (verdict.why === "nobody") say(player, "§cNo outlaw is left to escape.");
        else if (verdict.why === "gather") announce(ending.texts.gather);
        else {
            announce(`§cThe gang needs §e${verdict.need} coins§c to escape.`);
            announce(`§7Combined money: §e${verdict.have}`);
        }
        return;
    }

    const byId = new Map(survivors.map((outlaw) => [outlaw.id, outlaw] as const));

    for (const charge of verdict.charges) {
        const payer = byId.get(charge.id);
        if (payer) takeCoins(payer, charge.take);
    }

    // The round was active a moment ago and nothing in between can change that (script code runs to the end), so this is only ever false on a genuine
    // same-tick race with another ending or the law's win. It is checked rather than assumed.
    if (!endRound("outlaw_win", ending.id)) return;

    announce(ending.texts.headline);
    announce(fillText(ending.texts.detail, { coins: verdict.owed, count: survivors.length }));

    for (const outlaw of survivors) update(outlaw, { winner: true });

    if (ending.winSpot) {
        world.getDimension("overworld").runCommand(`tp @a[tag=winner] ${ending.winSpot.x} ${ending.winSpot.y} ${ending.winSpot.z}`);
    }
}
