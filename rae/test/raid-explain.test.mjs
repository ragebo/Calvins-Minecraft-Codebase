import { test } from "node:test";
import { fake, system, load, checks, strip } from "./helpers.mjs";

// A raid that refuses to start because nobody counted as inside now says why. Before, the line
// "No one is inside the area." alone could not tell a player who is one block too low from one who is
// eliminated (an eliminated player is skipped wherever they stand), and someone who had checked their
// coordinates could not find the cause.
//
// Driven through the public script events, the way command blocks call them, and judged by chat.

const { RAIDS } = await load("config/balance.js");
const { FORT_AREA, RANCH_AREA } = await load("config/world.js");
await load("systems/raids.js");
await load("systems/train.js");                          // only so the last test can ask for a train
const { resetAllSystems } = await load("core/registry.js");

const centre = (area) => ({ x: (area.min.x + area.max.x) / 2, y: (area.min.y + area.max.y) / 2, z: (area.min.z + area.max.z) / 2 });
const FORT = centre(FORT_AREA);
const RANCH = centre(RANCH_AREA);
const overworld = fake.dimension("overworld");

const REFUSED = "No one is inside the area.";
const NOBODY_IN_RANCH = "No outlaws are inside the ranch.";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** An empty world with every system reset. */
function scene() {
    fake.advance(400);                                   // let leftover timeouts play out
    fake.reset();
    resetAllSystems();
    fake.advance(3);
}

/** Sends a public script event, the way a command block does, and returns what was said, colours removed. */
function send(id) {
    const from = fake.chat.length;
    system.afterEvents.scriptEventReceive.emit({ id, sourceEntity: undefined, message: "" });
    return fake.chat.slice(from);
}

const fort = () => send("bounty:fort");
const ranch = () => send("bounty:ranch");

test("an eliminated player standing inside the fort is told that is why they don't count", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Calvin", { tags: ["eliminated"], location: FORT });

    const said = fort().map(strip);

    check("the refusal is first and unchanged", said[0] === REFUSED, JSON.stringify(said));
    check("then the reason, for the player", said[1] === "  Calvin: eliminated, so they don't count wherever they stand", JSON.stringify(said));
    check("and nothing more", said.length === 2, JSON.stringify(said));
    check("nothing started", overworld.spawned.length === 0);
    done();
});

test("a player who is too low says which axis, the value and the range", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Calvin", { location: { ...FORT, y: FORT_AREA.min.y - 0.5 } });

    const said = fort().map(strip);

    check("y is named with its range", said[1] === `  Calvin: y ${(FORT_AREA.min.y - 0.5).toFixed(1)} is outside ${FORT_AREA.min.y} to ${FORT_AREA.max.y}`, JSON.stringify(said));
    check("nothing else is said about x or z", said.length === 2, JSON.stringify(said));
    done();
});

test("a player off in more than one direction gets every axis, in x, y, z order", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Calvin", { location: { x: FORT_AREA.max.x + 2.5, y: FORT.y, z: FORT_AREA.min.z - 3.5 } });

    const said = fort().map(strip);

    check("x and z, joined", said[1] === `  Calvin: x ${(FORT_AREA.max.x + 2.5).toFixed(1)} is outside ${FORT_AREA.min.x} to ${FORT_AREA.max.x}; z ${(FORT_AREA.min.z - 3.5).toFixed(1)} is outside ${FORT_AREA.min.z} to ${FORT_AREA.max.z}`, JSON.stringify(said));
    done();
});

test("the edges of the area count as inside, so a player exactly on one gets no explanation", () => {
    const { check, done } = checks();
    for (const [label, spot] of [
        ["the low corner", FORT_AREA.min],
        ["the high corner", FORT_AREA.max],
        ["the bottom of the height range", { ...FORT, y: FORT_AREA.min.y }]
    ]) {
        scene();
        fake.makePlayer("Calvin", { location: spot });

        const said = fort().map(strip);

        check(`${label}: the raid starts`, said.length === 1 && said[0] === "Raid started! 1 player(s).", JSON.stringify(said));
    }
    done();
});

test("a player who counts starts the raid, and nothing explains anything", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Calvin", { location: FORT });
    fake.makePlayer("Elsewhere", { location: { x: 0, y: 64, z: 0 } });    // outside, but someone is inside, so no refusal

    const said = fort().map(strip);

    check("only the start line", said.length === 1 && said[0] === "Raid started! 1 player(s).", JSON.stringify(said));
    check("mobs came", overworld.spawned.length > 0);
    done();
});

test("every player who doesn't count is listed, in the order the world holds them, each with their own reason", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Ann", { tags: ["eliminated"], location: FORT });
    fake.makePlayer("Bo", { location: { ...FORT, y: 10 } });
    fake.makePlayer("Cy", { tags: ["eliminated"], location: { x: 0, y: 0, z: 0 } });   // eliminated AND far away: eliminated is the reason

    const said = fort().map(strip);

    check("three players, three lines, after the refusal", said.length === 4 && said[0] === REFUSED, JSON.stringify(said));
    check("Ann: eliminated", said[1].startsWith("  Ann: eliminated"), said[1]);
    check("Bo: too low", said[2] === `  Bo: y 10.0 is outside ${FORT_AREA.min.y} to ${FORT_AREA.max.y}`, said[2]);
    check("Cy: eliminated, not a list of axes", said[3].startsWith("  Cy: eliminated") && !said[3].includes(" is outside "), said[3]);
    done();
});

test("a crowd is capped: the first few by name, the rest counted", () => {
    const { check, done } = checks();
    scene();
    const cap = RAIDS.failureListMaxPlayers;
    const crowd = cap + 3;
    for (let i = 0; i < crowd; i++) fake.makePlayer(`P${i}`, { tags: ["eliminated"], location: FORT });

    const said = fort().map(strip);

    check(`the refusal, ${cap} names and one summary`, said.length === cap + 2, `${said.length} lines: ${JSON.stringify(said)}`);
    check("the last name is the cap-th player", said[cap].startsWith(`  P${cap - 1}:`), said[cap]);
    check("the rest are counted", said[cap + 1] === "  and 3 more", said[cap + 1]);
    done();
});

test("with nobody online at all (a command block, an empty world) it only refuses", () => {
    const { check, done } = checks();
    scene();

    const said = fort().map(strip);

    check("just the refusal", same(said, [REFUSED]), JSON.stringify(said));
    done();
});

test("the explanation goes to everyone in chat, in the quiet grey the game uses for hints", () => {
    const { check, done } = checks();
    scene();
    const calvin = fake.makePlayer("Calvin", { tags: ["eliminated"], location: FORT });

    const said = fort();

    check("the refusal keeps its red", said[0] === `§c${REFUSED}`, said[0]);
    check("the reason is grey", said[1].startsWith("§7  Calvin:"), said[1]);
    check("it is world chat, not a private message", calvin.messages.length === 0);
    done();
});

test("the ranch says the same after its own two lines, using the ranch's area", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Calvin", { tags: ["outlaw", "eliminated"], location: RANCH });
    fake.makePlayer("Pat", { tags: ["outlaw"], location: { ...RANCH, y: RANCH_AREA.max.y + 2 } });

    const said = ranch().map(strip);

    check("the two lines it always printed, unchanged", same(said.slice(0, 2), ["Ranch raid started!", NOBODY_IN_RANCH]), JSON.stringify(said));
    check("Calvin: eliminated", said[2] === "  Calvin: eliminated, so they don't count wherever they stand", said[2]);
    check("Pat: too high, against the RANCH's height range", said[3] === `  Pat: y ${(RANCH_AREA.max.y + 2).toFixed(1)} is outside ${RANCH_AREA.min.y} to ${RANCH_AREA.max.y}`, said[3]);
    check("and nothing more", said.length === 4, JSON.stringify(said));
    check("nothing started", overworld.spawned.length === 0);
    done();
});

test("a refused start still frees the slot for the other events", () => {
    const { check, done } = checks();
    scene();
    fake.makePlayer("Calvin", { tags: ["eliminated"], location: FORT });

    fort();
    const then = send("bounty:train").map(strip);

    check("the train starts right after", then.includes("The train is moving out!"), JSON.stringify(then));
    done();
});
