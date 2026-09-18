import { world, type Vector3, type Player, type Entity } from "@minecraft/server";
import { RAIDS } from "../config/balance.js";
import { onDeath } from "./events.js";
import { onTick } from "./tick.js";
import { addCoins } from "./economy.js";

/**
 * Fixes the duplication problem from V1.
 *
 * Ranch raid, fort raid and train guards all did the same thing:
 * spawn tagged mobs, track them, reward kills, clean up. Three files,
 * three copies, three sets of bugs.
 *
 * Now the pattern lives here once. A raid is a config object.
 */

export interface Area {
    min: Vector3;
    max: Vector3;
}

export interface WaveSpawn {
    /** Entity type id, e.g. "minecraft:pillager". */
    type: string;
    /** Count = base + ceil(players * perPlayer). */
    base: number;
    perPlayer: number;
    /** Which spawn list to use. Defaults to the raid's main list. */
    spawnList?: Vector3[];
}

export type AdvanceMode =
    /** Next wave when the current one is fully killed. */
    | { kind: "onClear" }
    /** Next wave on a timer, regardless of leftovers. */
    | { kind: "onTimer"; secondsPerWave: number };

export interface RaidConfig {
    readonly id: string;
    readonly area: Area;
    readonly spawns: Vector3[];
    readonly waves: WaveSpawn[][];
    readonly advance: AdvanceMode;
    /** Coin reward per mob type when a player kills it. */
    readonly killRewards?: Record<string, { min: number; max: number }>;
    /** Give players inside the area regeneration while active. */
    readonly healPlayers?: boolean;
    /** Only outlaws count as participants. Default counts anyone alive. */
    readonly outlawsOnly?: boolean;
    /** Called when every wave is done. */
    onComplete(participants: readonly Player[]): void;
    /** Called if everyone leaves the area. */
    onFail?(): void;
}

interface RaidState {
    active: boolean;
    wave: number;
    secondsLeft: number;
    advancing: boolean;
}

const raids = new Map<string, { config: RaidConfig; state: RaidState }>();

function tagFor(id: string): string {
    return `raid_${id}`;
}

function inside(loc: Vector3, area: Area): boolean {
    return (
        loc.x >= area.min.x && loc.x <= area.max.x &&
        loc.y >= area.min.y && loc.y <= area.max.y &&
        loc.z >= area.min.z && loc.z <= area.max.z
    );
}

function participantsOf(config: RaidConfig): Player[] {
    return world.getAllPlayers().filter((player) =>
        !player.hasTag("eliminated") &&
        (!config.outlawsOnly || player.hasTag("outlaw")) &&
        inside(player.location, config.area)
    );
}

function aliveDefenders(id: string): Entity[] {
    return world
        .getDimension("overworld")
        .getEntities({ tags: [tagFor(id)] });
}

function clearDefenders(id: string): void {
    for (const entity of aliveDefenders(id)) {
        entity.kill();
    }
}

function spawnWave(config: RaidConfig, waveIndex: number, playerCount: number): void {

    const wave = config.waves[waveIndex];

    if (!wave) return;

    const dimension = world.getDimension("overworld");
    const count = Math.max(1, playerCount);

    for (const entry of wave) {

        const total = entry.base + Math.ceil(count * entry.perPlayer);
        const list = entry.spawnList ?? config.spawns;

        for (let i = 0; i < total; i++) {

            try {

                const spot = list[Math.floor(Math.random() * list.length)];
                const mob = dimension.spawnEntity(entry.type, spot);

                mob.addTag(tagFor(config.id));

                mob.addEffect("weakness", 20000000, {
                    amplifier: RAIDS.mobWeaknessAmplifier,
                    showParticles: false
                });

            } catch (error) {
                world.sendMessage(
                    `§c[RAID ERROR] ${config.id} could not spawn ${entry.type}: ${error}`
                );
            }
        }
    }
}

export function registerRaid(config: RaidConfig): void {

    raids.set(config.id, {
        config,
        state: { active: false, wave: 0, secondsLeft: 0, advancing: false }
    });

    // Kill rewards, handled by the shared death dispatcher.
    if (config.killRewards) {

        onDeath(`raid:${config.id}`, 200, (ctx) => {

            if (!ctx.dead.hasTag(tagFor(config.id))) return;
            if (!ctx.killer) return;

            const range = config.killRewards?.[ctx.dead.typeId];

            if (!range) return;

            const reward =
                Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;

            addCoins(ctx.killer, reward);
            ctx.killer.sendMessage(`§a+${reward} coins`);
        });
    }

    // One shared tick handler per raid, driven by the single loop.
    onTick(`raid:${config.id}`, () => {

        const entry = raids.get(config.id);

        if (!entry || !entry.state.active) return;

        const { state } = entry;
        const participants = participantsOf(config);

        // Everyone left. Fail.
        if (participants.length === 0) {
            stopRaid(config.id);
            config.onFail?.();
            return;
        }

        if (config.healPlayers) {
            for (const player of participants) {
                player.addEffect("regeneration", RAIDS.playerRegenTicks, {
                    amplifier: 0,
                    showParticles: false
                });
            }
        }

        if (config.advance.kind === "onTimer") {

            state.secondsLeft--;

            if (state.secondsLeft > 0) return;

            advance(config.id, participants);
            state.secondsLeft = config.advance.secondsPerWave;

        } else {

            if (aliveDefenders(config.id).length > 0) return;
            if (state.advancing) return;

            advance(config.id, participants);
        }
    });
}

function advance(id: string, participants: readonly Player[]): void {

    const entry = raids.get(id);

    if (!entry) return;

    const { config, state } = entry;

    state.advancing = true;

    state.wave++;

    if (state.wave >= config.waves.length) {
        stopRaid(id);
        config.onComplete(participants);
        state.advancing = false;
        return;
    }

    world.sendMessage(`§6Wave ${state.wave + 1}!`);
    spawnWave(config, state.wave, participants.length);

    state.advancing = false;
}

export function startRaid(id: string): void {

    const entry = raids.get(id);

    if (!entry) {
        world.sendMessage(`§c[RAID ERROR] Unknown raid: ${id}`);
        return;
    }

    const { config, state } = entry;

    if (state.active) {
        world.sendMessage(`§cThat raid is already running.`);
        return;
    }

    const participants = participantsOf(config);

    if (participants.length === 0) {
        world.sendMessage("§cNo one is inside the area.");
        return;
    }

    state.active = true;
    state.wave = 0;
    state.advancing = false;

    if (config.advance.kind === "onTimer") {
        state.secondsLeft = config.advance.secondsPerWave;
    }

    world.sendMessage(`§4Raid started! ${participants.length} player(s).`);

    spawnWave(config, 0, participants.length);
}

export function stopRaid(id: string): void {

    const entry = raids.get(id);

    if (!entry) return;

    entry.state.active = false;
    entry.state.wave = 0;
    entry.state.advancing = false;

    clearDefenders(id);
}

export function resetAllRaids(): void {
    for (const id of raids.keys()) {
        stopRaid(id);
    }
}
