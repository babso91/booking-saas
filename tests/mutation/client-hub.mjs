// Mutation check of the Client Hub protections: the code verification's
// lock order (PR #25), and the sessions in the browser (PR #26: one cookie
// per session, server-side resolution, identity of every answer, the pages'
// identity check).
//
// For each mutation: rewrite one source file, reset the local database when
// the file is a migration, run the targeted tests, and restore the file
// (always, even on failure). A mutation is "detected" when at least one
// test fails.
//
// Requires the local Supabase stack (npm run db:start). Usage:
//   node tests/mutation/client-hub.mjs [mutation-name ...]
// Exit code 1 if a mutation is not detected or cannot be applied.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const HUB = "supabase/migrations/20261021090000_client_hub.sql";
const SLOTS = "supabase/migrations/20261024090000_client_hub_session_slots.sql";
const ROUTE = "src/features/client-hub/data/route.ts";
const COOKIES = "src/features/client-hub/data/session.ts";
const VERIFY = "src/app/api/client-hub/session/verify/route.ts";
const PAGES = "src/features/client-hub/client/session.tsx";

const DB_TESTS = [
  "--config",
  "vitest.integration.config.mts",
  "tests/integration/client-hub.test.ts",
];
const VERIFY_FILTER = ["-t", "^verification concurrency"];
const SESSION_FILTER = [
  "-t",
  "^(sessions|one browser, several session cookies|resolution concurrency|logout authority|concurrent global logouts) ",
];
const ROUTE_TESTS = ["src/features/client-hub/data"];
const PAGE_TESTS = ["src/features/client-hub/components/hub.test.tsx"];

const mutations = {
  // --- Code verification (PR #25) -------------------------------------
  // The audited behaviour: no address lock before the challenge row.
  verify_without_address_lock: {
    file: HUB,
    tests: [...DB_TESTS, ...VERIFY_FILTER],
    pairs: [
      `  v_email_key := private.abuse_key('client_hub_email:' || v_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key, 0));

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
      `  v_email_key := private.abuse_key('client_hub_email:' || v_email);

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
    ],
  },
  // Address lock taken after the challenge row (inconsistent order).
  verify_address_lock_after_row: {
    file: HUB,
    tests: [...DB_TESTS, ...VERIFY_FILTER],
    pairs: [
      `  where c.id = p_challenge_id
  for update;
`,
      `  where c.id = p_challenge_id
  for update;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key || ':late', 0));
`,
      `  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key, 0));

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
      `  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'`,
    ],
  },

  // --- Resolution in PostgreSQL (PR #26) --------------------------------
  // "The most recent wins" across accounts: a planted or crossed session
  // of another account would be chosen.
  resolve_chooses_across_accounts: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `  if (select pg_catalog.count(distinct l.account_id) from pg_catalog.unnest(v_live) l) > 1 then`,
      `  if false then`,
    ],
  },
  resolve_keeps_the_oldest: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `array_agg(l order by l.created_at desc, l.id desc)`,
      `array_agg(l order by l.created_at asc, l.id asc)`,
    ],
  },
  resolve_leaves_the_others_live: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `  where s.id in (select l.id from pg_catalog.unnest(v_live) l)
    and s.id <> v_winner.id;`,
      `  where false;`,
    ],
  },
  // A token counts under any session's name.
  token_not_bound_to_its_name: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `    join private.client_hub_sessions s
      on s.id = p.session_id
     and s.token_hash`,
      `    join private.client_hub_sessions s
      on s.token_hash`,
      `    where s.id in (
        select p.session_id
        from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) as p(session_id, token)
        where p.token ~ '^[0-9a-f]{64}$'
          and s.token_hash`,
      `    where s.id in (
        select s.id
        from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) as p(session_id, token)
        where p.token ~ '^[0-9a-f]{64}$'
          and s.token_hash`,
    ],
  },
  // Accounts locked in presentation order (not uuid order): two
  // resolutions presenting them in opposite orders wait for each other.
  accounts_locked_unsorted: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `    select distinct s.account_id
    from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) as p(session_id, token)`,
      `    select s.account_id
    from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) with ordinality as p(session_id, token, n)`,
      `    order by s.account_id
  loop`,
      `    order by p.n
  loop`,
    ],
  },
  accounts_not_locked: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client_hub_account:' || v_account::text, 0));
  end loop;`,
      `    null;
  end loop;`,
    ],
  },
  // Rows not read again under the locks: a session ended meanwhile wins.
  sessions_not_rechecked_under_lock: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `          and s.token_hash = pg_catalog.encode(extensions.digest(p.token, 'sha256'), 'hex'))
      and s.revoked_at is null
      and s.expires_at > p_now
    order by s.id
    for update;`,
      `          and s.token_hash = pg_catalog.encode(extensions.digest(p.token, 'sha256'), 'hex'))
    order by s.id
    for update;`,
    ],
  },
  sign_in_keeps_the_presented: {
    file: SLOTS,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `  where s.id = any(v_replaced)
    and s.id <> v_session;`,
      `  where false;`,
    ],
  },

  // --- Cookies and routes (PR #26) --------------------------------------
  // The former protocol: one cookie name for every session.
  one_shared_cookie_name: {
    file: COOKIES,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      "  `${SESSION_COOKIE_PREFIX}${sessionId}`;",
      "  `${SESSION_COOKIE_PREFIX}00000000-0000-4000-8000-000000000000`;",
      "  if (!NAME.test(sessionCookieName(sessionId)) || !TOKEN.test(token)) {",
      "  if (!TOKEN.test(token)) {",
    ],
  },
  winner_cookie_deleted_too: {
    file: ROUTE,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `    over = presented.names.filter((name) => name !== kept);`,
      `    over = presented.names;`,
    ],
  },
  cookies_deleted_when_the_database_fails: {
    file: ROUTE,
    tests: ROUTE_TESTS,
    pairs: [
      `  let over: string[] | null = null;`,
      `  let over: string[] | null = presented.names;`,
    ],
  },
  answers_name_no_account: {
    file: ROUTE,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [
      `  if (account) response.headers.set(ACCOUNT_HEADER, account);`,
      ``,
    ],
  },
  too_many_cookies_examined: {
    file: COOKIES,
    tests: ROUTE_TESTS,
    pairs: [
      `  const kept = excessive ? [] : [...pairs.values()];`,
      `  const kept = [...pairs.values()];`,
    ],
  },
  sign_in_keeps_the_presented_cookies: {
    file: VERIFY,
    tests: [...DB_TESTS, ...SESSION_FILTER],
    pairs: [`    appendCleared(response, presented.names);\n`, ``],
  },

  // --- The pages (PR #26) -----------------------------------------------
  pages_accept_any_account: {
    file: PAGES,
    tests: PAGE_TESTS,
    pairs: [
      `      account !== null &&
      account === now.account`,
      `      true`,
    ],
  },
  pages_sign_out_on_a_late_401: {
    file: PAGES,
    tests: PAGE_TESTS,
    pairs: [
      `      if (owner !== generation.current) return; // an older session's answer
      check({ fresh: false, veil: true });`,
      `      if (owner !== generation.current) return; // an older session's answer
      checks.current += 1;
      expiresAt.current = null;
      advance({ status: "signed-out", reason: "expired" });`,
      `    [check],
  );
  const isCurrent`,
      `    [advance],
  );
  const isCurrent`,
    ],
  },
  pages_recheck_without_limit: {
    file: PAGES,
    tests: PAGE_TESTS,
    pairs: [`        if (doubts.current === 0) {`, `        if (true) {`],
  },
  profile_without_account_confirms: {
    file: PAGES,
    tests: PAGE_TESTS,
    pairs: [
      `        if (result.ok && result.account) {`,
      `        if (result.ok) {`,
      `              account: result.account,`,
      `              account: result.account ?? "unnamed",`,
    ],
  },
};

function apply(source, pairs) {
  let result = source;
  for (let i = 0; i < pairs.length; i += 2) {
    const [from, to] = [pairs[i], pairs[i + 1]];
    if (result.split(from).length !== 2) {
      throw new Error(`pattern not found exactly once: ${from.slice(0, 60)}`);
    }
    // A function: "$" in the replacement is literal text.
    result = result.replace(from, () => to);
  }
  return result;
}

function reset() {
  execFileSync("npx", ["supabase", "db", "reset"], { stdio: "ignore" });
  // The API services restart with the database: let them settle.
  execFileSync("sleep", ["20"]);
}

function failing(tests) {
  const run = spawnSync("npx", ["vitest", "run", ...tests], {
    encoding: "utf8",
  });
  const output = `${run.stdout}${run.stderr}`;
  return {
    status: run.status,
    failed: [...output.matchAll(/^\s+× (.+?) \d+ms$/gm)].map((m) => m[1]),
  };
}

// Tests failing without any mutation prove nothing: they must pass first.
const baselines = new Map();
function baseline(tests) {
  const key = tests.join(" ");
  if (!baselines.has(key)) {
    const { failed } = failing(tests);
    if (failed.length > 0) {
      throw new Error(`failing without mutation: ${failed.join("; ")}`);
    }
    baselines.set(key, true);
  }
}

const selected = process.argv.slice(2);
const names = selected.length > 0 ? selected : Object.keys(mutations);
const results = [];
let databaseChanged = false;

for (const name of names) {
  const mutation = mutations[name];
  if (!mutation) {
    results.push({ name, outcome: "NOT APPLIED (unknown)" });
    continue;
  }
  if (databaseChanged) {
    reset();
    databaseChanged = false;
  }
  baseline(mutation.tests);
  const original = readFileSync(mutation.file, "utf8");
  let mutated;
  try {
    mutated = apply(original, mutation.pairs);
  } catch (error) {
    results.push({ name, outcome: `NOT APPLIED (${error.message})` });
    continue;
  }
  const migration = mutation.file.startsWith("supabase/");
  writeFileSync(mutation.file, mutated);
  try {
    if (migration) {
      databaseChanged = true;
      try {
        reset();
      } catch {
        results.push({ name, outcome: "NOT APPLIED (migration fails)" });
        continue;
      }
    }
    const run = failing(mutation.tests);
    const failed = run.failed;
    results.push({
      name,
      // A run that fails without any failing test (a syntax error, say)
      // proves nothing.
      outcome:
        failed.length > 0
          ? "detected"
          : run.status !== 0
            ? "ERROR (no test ran)"
            : "NOT DETECTED",
      failed,
    });
    console.error(`${results.at(-1).outcome}: ${name}`);
  } finally {
    writeFileSync(mutation.file, original);
  }
}
if (databaseChanged) reset();

for (const result of results) {
  console.log(`${result.outcome.padEnd(14)} ${result.name}`);
  for (const test of result.failed ?? [])
    console.log(`               × ${test}`);
}
process.exit(results.every((r) => r.outcome === "detected") ? 0 : 1);
