/**
 * Which build of the behavior pack this is, shown in the load line ("RAE 0.2.7 loaded.") so a stale pack, or a world still pinned to
 * an old one, shows itself without anyone digging through files. It is not a tunable number, so it is not in balance.ts.
 *
 * It must equal the behavior pack's manifest version (your_pack_name_BP/manifest.json: the header and both modules). test/assets.test.mjs
 * fails when they differ, so a version bump that forgets this file does not get as far as a commit.
 */
export const BUILD_VERSION = "0.2.7";
