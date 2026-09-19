// The layering, enforced (CLAUDE.md rules 1 and 2):
//
//     config  <-  logic  <-  core  <-  systems
//
// A file may import its own layer and any layer to its left, never one to its right, and a system never
// imports another system. config and logic must also stay free of the game runtime: `import type` from
// "@minecraft/*" is fine (it is erased when compiled), a value import is not.
//
// This reads the TypeScript SOURCE under rae/src, not the compiled output, so a bad import is caught even in a
// file nothing imports yet, and it needs no build. Imports are read with the TypeScript parser (already a dev
// dependency) instead of regular expressions, so comments, strings and multi-line imports cannot fool it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve(import.meta.dirname, "..", "src");

/** Lowest first. A file may import its own layer and every layer before it. */
const LAYERS = ["config", "logic", "core", "systems"];

/** These layers must not touch the game runtime: from "@minecraft/*" they may only `import type`. */
const GAME_FREE = new Set(["config", "logic"]);

/**
 * Violations that exist today, each waiting for the task that removes the import. An entry matches on file
 * (relative to src) plus the import as written. The "stale" test below fails when an entry no longer matches
 * a real violation, so the entry is deleted together with the import it excuses. Never add an entry to make
 * a new import pass: fix the import.
 */
const KNOWN_VIOLATIONS = [];

// ---------------------------------------------------------------------------------------------------------
// Reading imports
// ---------------------------------------------------------------------------------------------------------

/** `type` on an import or export specifier, or `import type` on a whole clause. */
const marksType = (node) => node.isTypeOnly === true || node.phaseModifier === ts.SyntaxKind.TypeKeyword;

/** True when nothing of the import survives compilation: `import type ...`, or every name marked `type`. */
function importIsTypeOnly(clause) {
    if (!clause) return false; // `import "x"` runs the module
    if (marksType(clause)) return true;
    const bindings = clause.namedBindings;
    return !clause.name && !!bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(marksType);
}

function exportIsTypeOnly(declaration) {
    const clause = declaration.exportClause;
    return marksType(declaration) || (!!clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every(marksType));
}

/**
 * Every module a source file pulls in, as { verb, specifier, typeOnly, line }. Static imports and
 * `export ... from` are read, plus the two sneakier spellings: a dynamic import() and a type written as
 * import("...").Name. `specifier` is null for an import() whose path is computed.
 */
function importsOf(text) {
    const source = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const found = [];
    const add = (node, verb, specifier, typeOnly) => {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ verb, specifier, typeOnly, line: line + 1 });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            add(node, "imports", node.moduleSpecifier.text, importIsTypeOnly(node.importClause));
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            add(node, "re-exports", node.moduleSpecifier.text, exportIsTypeOnly(node));
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [argument] = node.arguments;
            add(node, "dynamically imports", argument && ts.isStringLiteralLike(argument) ? argument.text : null, false);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
            add(node, "type-imports", node.argument.literal.text, true);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

// ---------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------

// Paths below are relative to src, with forward slashes: "logic/bearing.ts".

const layerOf = (file) => LAYERS.find((layer) => file === layer || file.startsWith(`${layer}/`)) ?? null;

/** A system is a file directly under systems/, or a folder there. */
const systemOf = (file) => file.split("/")[1]?.replace(/\.[^./]+$/, "");

/** Why this import breaks the layering, or null when it doesn't. */
function whyForbidden(file, layer, specifier, typeOnly) {

    if (specifier === null) return "a computed path, which cannot be checked; write the path out";

    if (specifier.startsWith("@minecraft/")) {
        return GAME_FREE.has(layer) && !typeOnly
            ? `a value import from the game API; ${layer} may only use \`import type\` from it`
            : null;
    }

    if (!specifier.startsWith(".")) return null; // some other package: not a layering question

    const target = path.posix.join(path.posix.dirname(file), specifier);
    const targetLayer = layerOf(target);

    if (targetLayer === null) return `reaches ${target}, which is outside every layer`;

    const rank = LAYERS.indexOf(layer);
    if (LAYERS.indexOf(targetLayer) > rank) {
        return `reaches up into ${targetLayer}; ${layer} may only import ${LAYERS.slice(0, rank + 1).join(", ")}`;
    }

    if (layer === "systems" && targetLayer === "systems" && systemOf(target) !== systemOf(file)) {
        return "another system; systems share code only through core/ contracts and events";
    }

    return null;
}

/** Every violation in one source file. main.ts, and anything else outside the four layers, is not checked. */
function checkSource(file, text) {
    const layer = layerOf(file);
    if (layer === null) return [];
    return importsOf(text).flatMap(({ verb, specifier, typeOnly, line }) => {
        const reason = whyForbidden(file, layer, specifier, typeOnly);
        return reason === null ? [] : [{ file, line, verb, specifier, reason }];
    });
}

/** One line naming the file and the import. */
const describeViolation = ({ file, line, verb, specifier, reason }) =>
    `src/${file}:${line}: ${verb} ${specifier === null ? "(a computed path)" : `"${specifier}"`}: ${reason}`;

// ---------------------------------------------------------------------------------------------------------
// The real tree and the allow-list
// ---------------------------------------------------------------------------------------------------------

function sourceFiles(dir = SRC) {
    return readdirSync(dir).sort().flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return name.endsWith(".ts") ? [full] : [];
    });
}

const relativeToSrc = (full) => path.relative(SRC, full).split(path.sep).join("/");

const scanTree = () => sourceFiles().flatMap((full) => checkSource(relativeToSrc(full), readFileSync(full, "utf8")));

/** Splits violations into those nobody excused, and allow-list entries that excuse nothing any more. */
function applyAllowList(violations, known) {
    const excuses = (entry, violation) => entry.file === violation.file && entry.specifier === violation.specifier;
    return {
        unexpected: violations.filter((violation) => !known.some((entry) => excuses(entry, violation))),
        stale: known.filter((entry) => !violations.some((violation) => excuses(entry, violation)))
    };
}

test("the source tree respects the layering (config <- logic <- core <- systems)", () => {
    const { unexpected } = applyAllowList(scanTree(), KNOWN_VIOLATIONS);
    assert.equal(unexpected.length, 0, `\n  ${unexpected.map(describeViolation).join("\n  ")}\n  (CLAUDE.md rules 1 and 2)`);
});

test("KNOWN_VIOLATIONS holds no entry whose import is already gone", () => {
    const { stale } = applyAllowList(scanTree(), KNOWN_VIOLATIONS);
    const lines = stale.map((entry) => `${entry.file} no longer imports "${entry.specifier}" (${entry.removedBy}): delete that entry from KNOWN_VIOLATIONS`);
    assert.equal(stale.length, 0, `\n  ${lines.join("\n  ")}`);
});

test("the scan reaches every layer, so a wrong path cannot make the checks pass by seeing nothing", () => {
    const files = sourceFiles().map(relativeToSrc);
    for (const layer of LAYERS) {
        assert.ok(files.some((file) => layerOf(file) === layer), `no .ts file found under src/${layer}/ (scanning ${SRC})`);
    }
});

// ---------------------------------------------------------------------------------------------------------
// The checker itself, on small in-memory sources: [what, file, source, the imports it must report]
// ---------------------------------------------------------------------------------------------------------

/** Fails once, listing every row where the reported imports differ from the expected ones. */
function expectReported(rows) {
    const wrong = [];
    for (const [what, file, source, expected] of rows) {
        const got = checkSource(file, source).map((violation) => violation.specifier);
        if (JSON.stringify(got) !== JSON.stringify(expected)) {
            wrong.push(`${what}: expected ${JSON.stringify(expected)}, reported ${JSON.stringify(got)}`);
        }
    }
    assert.equal(wrong.length, 0, `\n  ${wrong.join("\n  ")}`);
}

const GAME = "@minecraft/server";

test("checker: reads each import form, and tells a type-only import from a value import", () => {
    // [source, what importsOf must find: [verb, specifier, typeOnly]]. Guards the "not reported" rows below
    // against passing only because an import was never seen.
    const rows = [
        [`import type { A } from "m";`, [["imports", "m", true]]],
        [`import type * as ns from "m";`, [["imports", "m", true]]],
        [`import type D from "m";`, [["imports", "m", true]]],
        [`import { type A, type B } from "m";`, [["imports", "m", true]]],
        [`import { A, type B } from "m";`, [["imports", "m", false]]],
        [`import { A } from "m";`, [["imports", "m", false]]],
        [`import D from "m";`, [["imports", "m", false]]],
        [`import D, { type A } from "m";`, [["imports", "m", false]]],
        [`import * as ns from "m";`, [["imports", "m", false]]],
        [`import "m";`, [["imports", "m", false]]],
        [`import {} from "m";`, [["imports", "m", false]]],
        [`export type { A } from "m";`, [["re-exports", "m", true]]],
        [`export type * from "m";`, [["re-exports", "m", true]]],
        [`export { type A } from "m";`, [["re-exports", "m", true]]],
        [`export { A, type B } from "m";`, [["re-exports", "m", false]]],
        [`export * from "m";`, [["re-exports", "m", false]]],
        [`export * as ns from "m";`, [["re-exports", "m", false]]],
        [`export const a = 1;\nexport { a as b };`, []],
        [`const a = await import("m");`, [["dynamically imports", "m", false]]],
        [`const a = await import(name);`, [["dynamically imports", null, false]]],
        [`type T = import("m").A;`, [["type-imports", "m", true]]]
    ];
    const wrong = [];
    for (const [source, expected] of rows) {
        const got = importsOf(source).map(({ verb, specifier, typeOnly }) => [verb, specifier, typeOnly]);
        if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${source}\n      expected ${JSON.stringify(expected)}\n      found    ${JSON.stringify(got)}`);
    }
    assert.equal(wrong.length, 0, `\n  ${wrong.join("\n  ")}`);
});

test("checker: a value import of the game API is reported in logic and config, and import type is not", () => {
    expectReported([
        ["logic, value import", "logic/fake.ts", `import { world } from "${GAME}";`, [GAME]],
        ["logic, namespace import", "logic/fake.ts", `import * as mc from "${GAME}";`, [GAME]],
        ["logic, side-effect import", "logic/fake.ts", `import "${GAME}";`, [GAME]],
        ["logic, the UI package too", "logic/fake.ts", `import { ModalFormData } from "@minecraft/server-ui";`, ["@minecraft/server-ui"]],
        ["logic, value mixed with types", "logic/fake.ts", `import { world, type Player } from "${GAME}";`, [GAME]],
        ["logic, value re-export", "logic/fake.ts", `export { world } from "${GAME}";`, [GAME]],
        ["logic, star re-export", "logic/fake.ts", `export * from "${GAME}";`, [GAME]],
        ["logic, import type", "logic/fake.ts", `import type { Vector3 } from "${GAME}";`, []],
        ["logic, import type namespace", "logic/fake.ts", `import type * as mc from "${GAME}";`, []],
        ["logic, every name marked type", "logic/fake.ts", `import { type Vector3, type Player } from "${GAME}";`, []],
        ["logic, export type", "logic/fake.ts", `export type { Vector3 } from "${GAME}";`, []],
        ["config, value import", "config/fake.ts", `import { world } from "${GAME}";`, [GAME]],
        ["config, import type", "config/fake.ts", `import type { Vector3 } from "${GAME}";`, []],
        ["core may use the game API", "core/fake.ts", `import { world } from "${GAME}";`, []],
        ["systems may use the game API", "systems/fake.ts", `import { world, system } from "${GAME}";`, []]
    ]);
});

test("checker: an import that points up a layer is reported", () => {
    expectReported([
        ["core imports a system", "core/fake.ts", `import { x } from "../systems/compass.js";`, ["../systems/compass.js"]],
        ["core re-exports a system", "core/fake.ts", `export { x } from "../systems/compass.js";`, ["../systems/compass.js"]],
        ["core imports main", "core/fake.ts", `import { x } from "../main.js";`, ["../main.js"]],
        ["logic imports core", "logic/fake.ts", `import { x } from "../core/economy.js";`, ["../core/economy.js"]],
        ["logic imports a system", "logic/fake.ts", `import { x } from "../systems/compass.js";`, ["../systems/compass.js"]],
        ["logic imports something outside src", "logic/fake.ts", `import { x } from "../../elsewhere.js";`, ["../../elsewhere.js"]],
        ["a type-only import still counts", "logic/fake.ts", `import type { X } from "../core/economy.js";`, ["../core/economy.js"]],
        ["config imports core", "config/fake.ts", `import { x } from "../core/economy.js";`, ["../core/economy.js"]],
        ["config imports a system", "config/fake.ts", `import { x } from "../systems/compass.js";`, ["../systems/compass.js"]],
        ["config imports logic", "config/fake.ts", `import { x } from "../logic/bearing.js";`, ["../logic/bearing.js"]],
        ["a nested logic file is judged by where its import lands", "logic/deeper/fake.ts", `import { x } from "../../core/economy.js";`, ["../../core/economy.js"]]
    ]);
});

test("checker: a system importing another system is reported, however it is spelled", () => {
    expectReported([
        ["sibling by ./", "systems/fake.ts", `import { x } from "./jail.js";`, ["./jail.js"]],
        ["sibling by ../systems/", "systems/fake.ts", `import { x } from "../systems/jail.js";`, ["../systems/jail.js"]],
        ["sibling, type only", "systems/fake.ts", `import type { X } from "./jail.js";`, ["./jail.js"]],
        ["sibling, side effect only", "systems/fake.ts", `import "./jail.js";`, ["./jail.js"]],
        ["sibling, multi-line", "systems/fake.ts", `import {\n    a,\n    b\n} from "./jail.js";`, ["./jail.js"]],
        ["another system's folder", "systems/guns/fake.ts", `import { x } from "../jail.js";`, ["../jail.js"]],
        ["files of one system's own folder", "systems/guns/fake.ts", `import { x } from "./engine.js";`, []]
    ]);
});

test("checker: the imports the layering allows are not reported", () => {
    expectReported([
        ["logic imports config", "logic/fake.ts", `import { X } from "../config/balance.js";`, []],
        ["logic imports a logic sibling", "logic/fake.ts", `import { x } from "./bearing.js";`, []],
        ["a nested logic file imports logic and config", "logic/deeper/fake.ts", `import { a } from "../bearing.js";\nimport { b } from "../../config/balance.js";`, []],
        ["config imports a config sibling", "config/fake.ts", `import { X } from "./world.js";`, []],
        ["core imports config, logic and core", "core/fake.ts", `import { a } from "../config/balance.js";\nimport { b } from "../logic/bearing.js";\nimport { c } from "./events.js";`, []],
        ["systems import config, logic and core", "systems/fake.ts", `import { a } from "../config/balance.js";\nimport { b } from "../logic/bearing.js";\nimport { c } from "../core/registry.js";`, []],
        ["a package that is not the game API is not a layering question", "core/fake.ts", `import x from "some-package";`, []],
        ["main.ts is the entry point and imports every system", "main.ts", `import "./systems/jail.js";\nimport { x } from "./core/tick.js";`, []],
        ["a file outside the four layers is not checked", "elsewhere/fake.ts", `import { world } from "${GAME}";\nimport { x } from "../systems/jail.js";`, []]
    ]);
});

test("checker: reads every way an import can be written, and ignores text that only looks like one", () => {
    expectReported([
        ["multi-line import with a value in it", "logic/fake.ts", `import {\n    world, system,\n    type Player\n} from "${GAME}";`, [GAME]],
        ["multi-line import, every name marked type", "logic/fake.ts", `import {\n    type Vector3,\n    type Player\n} from "${GAME}";`, []],
        ["a comment inside the braces", "logic/fake.ts", `import { /* the engine */ world } from "${GAME}";`, [GAME]],
        ["dynamic import of the game API", "logic/fake.ts", `const mc = await import("${GAME}");`, [GAME]],
        ["dynamic import up a layer", "core/fake.ts", `const s = await import("../systems/jail.js");`, ["../systems/jail.js"]],
        ["dynamic import with a computed path", "logic/fake.ts", `const m = await import(name);`, [null]],
        ["a type written as import(...) reaches up", "logic/fake.ts", `type T = import("../core/economy.js").Foo;`, ["../core/economy.js"]],
        ["a type written as import(...) from the game API is erased", "logic/fake.ts", `type P = import("${GAME}").Player;`, []],
        ["a line comment", "logic/fake.ts", `// import { world } from "${GAME}";\nexport const a = 1;`, []],
        ["a block comment", "core/fake.ts", `/*\nimport { x } from "../systems/jail.js";\n*/\nexport const a = 1;`, []],
        ["a string", "core/fake.ts", `const s = 'import { x } from "../systems/jail.js"';`, []],
        ["a template literal", "core/fake.ts", "const s = `import { x } from \"../systems/jail.js\"`;", []],
        ["several violations come back in source order", "core/fake.ts", `import { a } from "../systems/a.js";\nexport * from "../systems/b.js";`, ["../systems/a.js", "../systems/b.js"]]
    ]);
});

test("checker: a violation names the file, the line and the import", () => {
    const [violation] = checkSource("logic/fake.ts", `export const a = 1;\nimport { world } from "${GAME}";`);
    assert.ok(violation, "no violation reported");
    const message = describeViolation(violation);
    assert.match(message, /src\/logic\/fake\.ts:2\b/, message);
    assert.ok(message.includes(`"${GAME}"`), message);

    const [core] = checkSource("core/fake.ts", `import { x } from "../systems/compass.js";`);
    assert.match(describeViolation(core), /src\/core\/fake\.ts:1: imports "\.\.\/systems\/compass\.js"/);

    const [system] = checkSource("systems/fake.ts", `import { x } from "./jail.js";`);
    assert.match(describeViolation(system), /src\/systems\/fake\.ts:1: imports "\.\/jail\.js"/);
});

test("allow-list: an excused violation passes, an unexcused one fails, and an entry whose import is gone is stale", () => {
    const violation = (file, specifier) => ({ file, line: 1, verb: "imports", specifier, reason: "x" });
    const known = [{ file: "systems/a.ts", specifier: "./b.js", removedBy: "TEST" }];

    const excused = applyAllowList([violation("systems/a.ts", "./b.js")], known);
    assert.equal(excused.unexpected.length, 0, "the excused import must not count");
    assert.equal(excused.stale.length, 0, "the entry still matches, so it is not stale");

    const other = applyAllowList([violation("systems/a.ts", "./b.js"), violation("systems/a.ts", "./c.js")], known);
    assert.deepEqual(other.unexpected.map((v) => v.specifier), ["./c.js"], "a different import in the same file is not excused");

    const otherFile = applyAllowList([violation("systems/z.ts", "./b.js")], known);
    assert.equal(otherFile.unexpected.length, 1, "the same import in another file is not excused");
    assert.equal(otherFile.stale.length, 1, "and the entry then matches nothing, so it is stale");

    const gone = applyAllowList([], known);
    assert.deepEqual(gone.stale, known, "the import is gone, so the entry must be reported for deletion");
});
