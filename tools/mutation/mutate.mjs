// Breaks one source file on purpose, one change at a time, and reports whether the named tests notice. See docs/TESTING.md.
//
//     node tools/mutation/mutate.mjs <mutations.mjs> [filter]
//
// The mutations file exports { file, test, mutations }: the absolute path of the file to break, the test files to run (space separated,
// relative to rae/), and a list of [name, from, to, expect?]. `from` must occur in the file exactly as written (written with \n; a file
// with Windows line endings is matched on its own). A change that does not compile does NOT count as caught unless `expect` is "compile":
// the compiler stopping it proves nothing about the tests. The original file is always put back, and checked by hash.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const { file, test, mutations } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const filter = process.argv[3];
const quick = path.resolve(import.meta.dirname, "quick.mjs");
const root = path.resolve(import.meta.dirname, "..", "..", "rae");
const original = readFileSync(file, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const fit = (text) => text.replaceAll("\n", eol);
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

function run() {
    const result = spawnSync(process.execPath, [quick, ...test.split(" ")], { cwd: root, encoding: "utf8" });
    const out = `${result.stdout}\n${result.stderr}`;
    return { compile: /error TS/.test(out), fails: Number((out.match(/ℹ fail (\d+)/) ?? [])[1] ?? 0), passes: Number((out.match(/ℹ pass (\d+)/) ?? [])[1] ?? 0), status: result.status };
}

let tried = 0;
let survived = 0;

try {
    const base = run();
    console.log(`baseline (unmutated): ${base.passes} pass, ${base.fails} fail, exit ${base.status}`);

    for (const [name, rawFrom, rawTo, expect] of mutations) {

        if (filter && !name.includes(filter)) continue;
        tried++;

        const from = fit(rawFrom);
        const to = fit(rawTo);

        if (!original.includes(from)) { console.log(`NOT FOUND     ${name}`); survived++; continue; }

        writeFileSync(file, original.replace(from, () => to));
        const r = run();
        const verdict = r.compile ? (expect === "compile" ? "caught" : "COMPILE ERROR") : r.fails > 0 ? "caught" : "SURVIVED";
        if (verdict !== "caught") survived++;
        console.log(`${verdict.padEnd(13)} ${name}${r.fails ? ` (${r.fails} failing)` : r.compile ? " (does not compile)" : ""}`);
    }

    console.log(`\n${tried - survived} of ${tried} caught`);
} finally {
    writeFileSync(file, original);
    console.log(`restored: ${hash(readFileSync(file, "utf8")) === hash(original) ? "yes, identical" : "NO - DIFFERENT"} (${hash(original)})`);
}
