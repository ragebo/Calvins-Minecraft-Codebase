// Runs mutate.mjs once per target of a spec file and sums the result. See docs/TESTING.md.
//
//     node tools/mutation/run.mjs <spec.mjs>
//
// The spec exports { test, targets: [{ file, mutations }] }: the test files to run (relative to rae/) and, for each source file to
// break, its list of [name, from, to, expect?]. See example-spec.mjs. Run it with nothing else touching rae/ (it rewrites source files
// for a moment, and puts each one back).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

const { test, targets } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const scratch = mkdtempSync(path.join(tmpdir(), "rae-mutations-"));

let total = 0;
let caught = 0;

for (const [i, target] of targets.entries()) {
    const modulePath = path.join(scratch, `target-${i}.mjs`);
    writeFileSync(modulePath, `export const file = ${JSON.stringify(target.file)};\nexport const test = ${JSON.stringify(test)};\nexport const mutations = ${JSON.stringify(target.mutations)};\n`);

    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "mutate.mjs"), modulePath], { encoding: "utf8" });
    const out = `${result.stdout}${result.stderr}`;

    console.log(`=== ${path.basename(target.file)}`);
    console.log(out.split("\n").filter((line) => !line.startsWith("caught") && line.trim() !== "").join("\n"));

    total += target.mutations.length;
    caught += (out.match(/^caught/gm) ?? []).length;
}

console.log(`\nALL FILES: ${caught} of ${total} caught`);
