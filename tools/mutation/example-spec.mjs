// An example spec for tools/mutation/run.mjs: break the money functions on purpose and see whether the tests notice.
//
//     node tools/mutation/run.mjs tools/mutation/example-spec.mjs
//
// Every `from` must match the source exactly. A change that does not compile does not count as caught, so write each break so it still
// compiles: `&& Math.abs(0) === 1` turns a condition off, `* 0` zeroes a value, `void x` uses a name without calling it.
// Pick breaks that change behavior; one that changes nothing visible (an equivalent mutant) survives for a good reason, and the fix is to
// delete the redundant code rather than to test it.
const SRC = new URL("../../rae/src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export const test = "test/*.test.mjs";

export const targets = [{
    file: `${SRC}/core/economy.ts`,
    mutations: [
        ["takeCoins takes more than there is", `const taken = Math.min(current, amount);`, `const taken = amount;`],
        ["takeCoins never writes", `if (taken > 0) setCoins(target, current - taken);`, `if (taken > 0 && Math.abs(0) === 1) setCoins(target, current - taken);`],
        ["addCoins replaces instead of adds", `obj.setScore(target, getCoins(target) + amount);`, `obj.setScore(target, amount);`]
    ]
}];
