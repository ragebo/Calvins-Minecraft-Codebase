// `npm test`: compile src/ into .test-build/, install the fake game API where the compiled
// code will look for @minecraft/server, then run every test under the built-in node test runner.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".test-build");

function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(out, { recursive: true, force: true });

// Same compiler settings as the real build, different destination (so the game pack isn't touched).
run([path.join(root, "node_modules", "typescript", "bin", "tsc"), "--outDir", out]);

writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module" }));

for (const [pkg, file] of [["server", "minecraft-server.mjs"], ["server-ui", "minecraft-server-ui.mjs"]]) {
    const dir = path.join(out, "node_modules", "@minecraft", pkg);
    mkdirSync(dir, { recursive: true });
    cpSync(path.join(root, "test", "fake", file), path.join(dir, "index.js"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@minecraft/${pkg}`, version: "0.0.0-fake", type: "module", main: "index.js" }));
}

run(["--test", "test/**/*.test.mjs"]);
