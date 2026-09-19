// `npm run check:legacy`: a ratchet for the architecture migration.
//
// Counts patterns the ARCH work is retiring and fails if any count is HIGHER than on the
// merged `main`. It compares against `main` (via git) rather than a committed baseline file,
// so parallel branches have no shared file to conflict on. A branch may lower a count freely.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(root, "src");
const BASE_REF = process.env.LEGACY_BASE_REF ?? "main";

const PATTERNS = [
    { id: "error-to-chat", what: "errors sent to every player in chat", re: /sendMessage\((?:`|")§c\[/g },
    { id: "role-tag-read", what: "role/status read from a tag instead of core/state", re: /hasTag\("(?:law|outlaw|eliminated|in_jail|jailed|send_to_jail|escort_vulnerable|winner|native)"\)/g, exclude: ["core/state.ts"] },
    { id: "tag-write", what: "role/status tag written directly instead of via core/state update()", re: /\.(?:addTag|removeTag)\("(?:law|outlaw|eliminated|in_jail|jailed|send_to_jail|escort_vulnerable|winner|native)"\)/g, exclude: ["core/state.ts"] },
    { id: "name-as-key", what: "player.name used as a map/set key", re: /\.(?:get|set|has|delete)\(\s*[A-Za-z_.]*\.name\b|`\$\{[A-Za-z_.]*\.name\}:/g },
    { id: "private-interval", what: "system.runInterval outside core/tick.ts", re: /system\.runInterval\(/g, exclude: ["core/tick.ts"] },
    { id: "player-filter", what: "world.getAllPlayers/getPlayers outside core/tick.ts and core/players.ts", re: /world\.(?:getAllPlayers|getPlayers)\(/g, exclude: ["core/tick.ts", "core/players.ts"] },
    { id: "ui-direct", what: "title/action bar written directly instead of via core/ui", re: /onScreenDisplay\.(?:setActionBar|setTitle)\(/g, exclude: ["core/ui.ts"] },
    { id: "sound-direct", what: "playSound called directly instead of via core/sound", re: /\.playSound\(/g, exclude: ["core/sound.ts"] },
    { id: "system-import", what: "a system importing another system", re: /from "\.\/[A-Za-z-]+\.js"/g, only: /^systems\// }
];

function listSourceFiles(dir, base = dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return listSourceFiles(full, base);
        return name.endsWith(".ts") ? [path.relative(base, full).replaceAll("\\", "/")] : [];
    });
}

function count(files, read) {
    const totals = Object.fromEntries(PATTERNS.map((p) => [p.id, 0]));
    for (const file of files) {
        const text = read(file);
        if (text === null) continue;
        for (const p of PATTERNS) {
            if (p.exclude?.includes(file)) continue;
            if (p.only && !p.only.test(file)) continue;
            totals[p.id] += (text.match(p.re) ?? []).length;
        }
    }
    return totals;
}

function git(args) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
}

const now = count(listSourceFiles(srcDir), (file) => readFileSync(path.join(srcDir, file), "utf8"));

let baseline = null;
// Runs from rae/, so the pathspec is relative to it; --full-name makes git print repo-root paths
// (rae/src/...), which is what `git show <ref>:<path>` expects.
// Judge a branch by its OWN change: compare with the commit it forked from (the merge-base),
// not with a `main` that other branches have improved or worsened since.
const forkPoint = git(["merge-base", "HEAD", BASE_REF])?.trim() || BASE_REF;
const listing = git(["ls-tree", "-r", "--name-only", "--full-name", forkPoint, "--", "src"]);
if (listing !== null) {
    const files = listing.split("\n").filter((f) => f.endsWith(".ts")).map((f) => f.replace(/^rae\/src\//, ""));
    baseline = count(files, (file) => git(["show", `${forkPoint}:rae/src/${file}`]));
}

let failed = false;
console.log(`legacy-pattern ratchet (compared with ${baseline ? `${forkPoint.slice(0, 7)}, where this branch left ${BASE_REF}` : "nothing: no base ref found"})\n`);
console.log("pattern            now   base  status");
for (const p of PATTERNS) {
    const base = baseline?.[p.id];
    const status = base === undefined ? "n/a" : now[p.id] > base ? "RISES" : now[p.id] < base ? "down" : "ok";
    if (status === "RISES") failed = true;
    console.log(`${p.id.padEnd(17)} ${String(now[p.id]).padStart(4)}  ${String(base ?? "-").padStart(5)}  ${status.padEnd(6)} ${p.what}`);
}
if (failed) {
    console.error("\nA legacy pattern count went UP. Use the new module instead (see CLAUDE.md), or ask the orchestrator.");
    process.exit(1);
}
