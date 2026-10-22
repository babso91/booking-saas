// Mutation check of the Client Hub concurrency and session-authority
// protections (PR #25, corrections after the Codex audit).
//
// For each mutation: rewrite the migration, reset the local database, run
// the targeted PostgreSQL tests, and restore the migration (always, even on
// failure). A mutation is "detected" when at least one test fails.
//
// Requires the local Supabase stack (npm run db:start). Usage:
//   node tests/mutation/client-hub.mjs [mutation-name ...]
// Exit code 1 if a mutation is not detected or cannot be applied.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MIGRATION = "supabase/migrations/20261021090000_client_hub.sql";
const TESTS = "tests/integration/client-hub.test.ts";
const FILTER =
  "verification concurrency|logout authority|concurrent global logouts";

const mutations = {
  // The audited behaviour: no address lock before the challenge row.
  verify_without_address_lock: [
    `  v_email_key := private.abuse_key('client_hub_email:' || v_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key, 0));

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
    `  v_email_key := private.abuse_key('client_hub_email:' || v_email);

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
  ],
  // Address lock taken after the challenge row (inconsistent order).
  verify_address_lock_after_row: [
    `  where c.id = p_challenge_id
  for update;
`,
    `  where c.id = p_challenge_id
  for update;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key || ':late', 0));
`,
    // …and the early address lock removed.
    `  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key, 0));

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
    `  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
  ],
  end_session_revoked_keeps_authority: [
    `  if not found
    or v_session.revoked_at is not null
    or v_session.expires_at <= pg_catalog.now() then`,
    `  if not found
    or v_session.expires_at <= pg_catalog.now() then`,
  ],
  end_session_expired_keeps_authority: [
    `  if not found
    or v_session.revoked_at is not null
    or v_session.expires_at <= pg_catalog.now() then`,
    `  if not found
    or v_session.revoked_at is not null then`,
  ],
  // Neither lock: the revocation race is no longer ordered. (Removing only
  // the row lock is not detected: the account lock alone orders every
  // revocation of a session; the row lock is a redundant second guard.)
  end_session_without_any_lock: [
    `  where s.token_hash = v_hash
  for update;`,
    `  where s.token_hash = v_hash;`,
    `  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_account:' || v_account::text, 0));
`,
    ``,
  ],
  // The audited behaviour: no account lock before the session row.
  end_session_without_account_lock: [
    `  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_account:' || v_account::text, 0));
`,
    ``,
  ],
};

function apply(source, pairs) {
  let result = source;
  for (let i = 0; i < pairs.length; i += 2) {
    const [from, to] = [pairs[i], pairs[i + 1]];
    if (result.split(from).length !== 2) {
      throw new Error(`pattern not found exactly once: ${from.slice(0, 60)}`);
    }
    result = result.replace(from, to);
  }
  return result;
}

function reset() {
  execFileSync("npx", ["supabase", "db", "reset"], { stdio: "ignore" });
  // The API services restart with the database: let them settle.
  execFileSync("sleep", ["20"]);
}

const original = readFileSync(MIGRATION, "utf8");
const selected = process.argv.slice(2);
const names = selected.length > 0 ? selected : Object.keys(mutations);
const results = [];

try {
  for (const name of names) {
    let mutated;
    try {
      mutated = apply(original, mutations[name]);
    } catch (error) {
      results.push({ name, outcome: `NOT APPLIED (${error.message})` });
      continue;
    }
    writeFileSync(MIGRATION, mutated);
    try {
      reset();
      const run = spawnSync(
        "npx",
        [
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.mts",
          TESTS,
          "-t",
          FILTER,
        ],
        { encoding: "utf8" },
      );
      const output = `${run.stdout}${run.stderr}`;
      const failed = [...output.matchAll(/^\s+× (.+?) \d+ms$/gm)].map(
        (match) => match[1],
      );
      results.push({
        name,
        outcome: failed.length > 0 ? "detected" : "NOT DETECTED",
        failed,
      });
    } finally {
      writeFileSync(MIGRATION, original);
    }
  }
} finally {
  writeFileSync(MIGRATION, original);
  reset();
}

for (const result of results) {
  console.log(`${result.outcome.padEnd(14)} ${result.name}`);
  for (const test of result.failed ?? [])
    console.log(`               × ${test}`);
}
process.exit(results.every((r) => r.outcome === "detected") ? 0 : 1);
