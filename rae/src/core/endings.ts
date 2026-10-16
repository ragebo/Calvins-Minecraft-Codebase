import { world, type Player } from "@minecraft/server";
import { ENDINGS as E } from "../config/balance.js";
import { cinematicShot, fillText, groupVerdict, roundVerdict, soloVerdict, tally, type Ending, type Standing } from "../logic/endings.js";
import { getCoins, takeCoins } from "./economy.js";
import { getEnding, listEndings } from "./endingstore.js";
import { endRound, isPhase } from "./round.js";
import { aliveOutlaws, everyOutlaw, lawPlayers, players } from "./players.js";
import { enterSpectator } from "./spectate.js";
import { playPan } from "./startsequence.js";
import { emit } from "./telemetryevents.js";
import { ESCAPED, getRecord, isEscaped, setFlag, update, type PlayerRecord } from "./state.js";
import { bagOf, countOf, takeFrom } from "./shopitems.js";

/**
 * Running an ending (logic/endings.ts is what one is and when it is met, core/endingstore.ts keeps them; the plan is tasks/endings/plan.md).
 *
 * `attemptEnding` is what a player's try becomes: the script event `rae:ending <id>` (run by an NPC's button or a command block), or `bounty:escape`,
 * which is the boat's. It checks in the order the boat always has (who, then whether a round is running, then the gathering, then the money), says what
 * is wrong in the ending's own words, and on success takes the price, announces it and acts:
 *   - a GROUP ending ends the round as an outlaw win and takes every outlaw in play to the win spot;
 *   - a SOLO ending takes ONE outlaw out of the game for good (a flag on their record, which every "who is in play" question honors), makes them a
 *     spectator and a winner for themselves, and the round goes on.
 * After either, and after every death or spawn, `checkRoundOver` asks whether any outlaw is left in play.
 *
 * Nothing is kept between attempts: whether a round has already ended is core/round.ts's job, so two attempts in one tick cannot both end it.
 */

function say(player: Player, text: string): void {
    if (text.length > 0) player.sendMessage(text);
}

function announce(text: string): void {
    if (text.length > 0) world.sendMessage(text);
}

/** Who got away and who was caught, said after a round's end, only when someone got away: a round nobody escaped says nothing extra. */
function announceTally(escaped: number, captured: number): void {
    if (escaped > 0) announce(`§7${escaped} escaped, ${captured} captured.`);
}

/**
 * What an ending does once it is announced and the round has been told: play its cinematic, if it has one, for the players it is for, and only then
 * `then` (moving the winners). With no cinematic there is no camera, no lock and no delay: `then` runs at once. The round's own state never waits for
 * this; a reset in the middle lets everyone go and `then` never runs (core/startsequence.ts holds the safety).
 */
function celebrate(ending: Ending, winners: readonly Player[], then: () => void): void {

    const shot = cinematicShot(ending);

    if (!ending.cinematic || !shot) {
        then();
        return;
    }

    playPan(ending.cinematic.audience === "all" ? players() : winners, shot, ending.cinematic.seconds, then);
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

    const record = getRecord(player);

    if (record.role !== "outlaw") {
        say(player, ending.texts.outlawsOnly);
        return;
    }

    // Without this, an eliminated outlaw trying after law has already won would leave nobody in play, and the gathering and the money checks would
    // both pass on an empty gang, announcing an escape with nobody in it.
    if (!isPhase("ACTIVE")) {
        say(player, "§cNo round is running.");
        return;
    }

    if (isEscaped(record)) {
        say(player, "§cYou have already escaped.");
        return;
    }

    if (ending.kind === "group") attemptGroup(player, ending);
    else attemptSolo(player, ending, record);
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

    // Counted before the gang is marked: whoever escaped alone earlier, and whoever was eliminated, are already known to the record. A jailed outlaw
    // is in the gang (the boat always took them), so jail does not make someone captured here.
    const alone = tally(everyOutlaw().map((outlaw) => ({ ...standingOf(getRecord(outlaw)), inJail: false })));

    // The round was active a moment ago and nothing in between can change that (script code runs to the end), so this is only ever false on a genuine
    // same-tick race with another ending or the law's win. It is checked rather than assumed.
    if (!endRound("outlaw_win", ending.id)) return;

    announce(ending.texts.headline);
    announce(fillText(ending.texts.detail, { coins: verdict.owed, count: survivors.length }));

    // A gang with nobody who got away alone before it keeps the two lines it always had.
    if (alone.escaped > 0) announceTally(alone.escaped + survivors.length, alone.captured);

    for (const outlaw of survivors) update(outlaw, { winner: true });

    const spot = ending.winSpot;

    celebrate(ending, survivors, () => {
        if (spot) world.getDimension("overworld").runCommand(`tp @a[tag=winner] ${spot.x} ${spot.y} ${spot.z}`);
    });
}

function attemptSolo(player: Player, ending: Ending, record: Readonly<PlayerRecord>): void {

    if (record.eliminated) {
        say(player, "§cYou are out of the game.");
        return;
    }

    if (record.inJail) {
        say(player, "§cYou cannot escape from jail.");
        return;
    }

    const bag = bagOf(player);
    const itemCount = ending.item && bag ? countOf(bag, { type: ending.item.id, amount: 1 }) : 0;
    const verdict = soloVerdict(ending, { coins: getCoins(player), at: player.location, itemCount });

    if (!verdict.ok) {
        if (verdict.why === "far") say(player, ending.texts.gather);
        else if (verdict.why === "poor") say(player, `§cYou need §e${verdict.need} coins§c to escape (you have §e${verdict.have}§c).`);
        else say(player, `§cYou need §e${verdict.need}§c of ${ending.item?.id.replace(/^[a-z0-9_.-]+:/, "").replace(/_/g, " ") ?? "the item"} to escape (you have §e${verdict.have}§c).`);
        return;
    }

    takeCoins(player, verdict.takeCoins);
    if (verdict.takeItem > 0 && ending.item && bag) takeFrom(bag, { type: ending.item.id, amount: verdict.takeItem });

    setFlag(player, ESCAPED, true);
    update(player, { winner: true });

    announce(fillText(ending.texts.headline, { coins: verdict.takeCoins, player: player.name, count: 1 }));
    announce(fillText(ending.texts.detail, { coins: verdict.takeCoins, player: player.name, count: 1 }));

    emit("ending.escape", {
        id: ending.id,
        p: player.id,
        coins: verdict.takeCoins,
        ...(verdict.takeItem > 0 && ending.item ? { item: ending.item.id, count: verdict.takeItem } : {})
    });

    const spot = ending.winSpot;

    celebrate(ending, [player], () => {
        if (spot && player.isValid) player.teleport({ x: spot.x, y: spot.y, z: spot.z });
    });

    enterSpectator(player);

    checkRoundOver();
}

const standingOf = (record: Readonly<PlayerRecord>): Standing => ({ escaped: isEscaped(record), eliminated: record.eliminated, inJail: record.inJail });

/**
 * Whether any outlaw is left in play, asked after every death, every spawn and every escape. When none is, the round ends: as the law's win when the
 * outlaws still in play are all jailed or eliminated (whoever escaped before), or as the outlaws' win when every one of them escaped.
 */
export function checkRoundOver(): void {

    const everyone = everyOutlaw().map((outlaw) => standingOf(getRecord(outlaw)));
    const verdict = roundVerdict(everyone);

    if (verdict === "running") return;

    // False if no round is active, or one already ended (someone else's win, or this same check running again): nothing left to announce.
    if (!endRound(verdict)) return;

    const standings = tally(everyone);

    if (verdict === "law_win") {
        world.sendMessage("§9§lTHE LAW HAS WON!");
        world.sendMessage("§7Every outlaw is captured or eliminated — no one is left to break them out.");

        for (const player of lawPlayers()) update(player, { winner: true });
        announceTally(standings.escaped, standings.captured);
        return;
    }

    announce(E.allEscaped.headline);
    announce(fillText(E.allEscaped.detail, { count: standings.escaped }));
    announceTally(standings.escaped, standings.captured);
}
