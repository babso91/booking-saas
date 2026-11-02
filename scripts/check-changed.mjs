#!/usr/bin/env node
// Fast checks on what this branch changed, for the development loop:
// format and lint of the changed files, and the unit tests related to them
// (vitest related). Not the validation of a milestone: that remains the
// full suite (format, lint, types, build, unit, PostgreSQL, upgrades, e2e).
//
//   npm run check:changed                 # changes since origin/main
//   npm run check:changed -- <base>       # changes since <base>
//
// It also lists the integration, upgrade and e2e test files the changes
// touch, and warns when a migration changed: those need the database and
// are run on purpose, not by this script.

import { execFileSync, spawnSync } from "node:child_process";

const base = process.argv[2] ?? "origin/main";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

const mergeBase = git("merge-base", base, "HEAD");
const changed = [
  ...new Set([
    // Committed and uncommitted changes since the base (deleted excluded).
    ...lines(git("diff", "--name-only", "--diff-filter=d", mergeBase)),
    ...lines(git("ls-files", "--others", "--exclude-standard")),
  ]),
].sort();

if (changed.length === 0) {
  console.log(`Nothing changed since ${base}.`);
  process.exit(0);
}

console.log(`${changed.length} file(s) changed since ${base}.`);

const code = /\.(ts|tsx|js|mjs|cjs)$/;
const steps = [
  {
    command: ["prettier", "--check", "--ignore-unknown"],
    files: changed,
  },
  {
    command: ["eslint", "--no-warn-ignored"],
    files: changed.filter((file) => code.test(file)),
  },
  {
    command: ["vitest", "related", "--run", "--passWithNoTests"],
    files: changed.filter((file) => file.startsWith("src/") && code.test(file)),
  },
];

let failed = false;
for (const { command, files } of steps) {
  if (files.length === 0) continue;
  console.log(`\n$ npx ${command.join(" ")} (${files.length} file(s))`);
  const result = spawnSync("npx", [...command, ...files], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}

const database = changed.filter((file) =>
  /^(tests\/(integration|upgrade|e2e)\/|supabase\/migrations\/)/.test(file),
);
if (database.length > 0) {
  console.log("\nNeeds the database, run on purpose:");
  for (const file of database) console.log(`  ${file}`);
  if (database.some((file) => file.startsWith("supabase/migrations/"))) {
    console.log(
      "  A migration changed: reset the local database, then run the related integration and upgrade tests.",
    );
  }
}

process.exit(failed ? 1 : 0);
