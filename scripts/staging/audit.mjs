#!/usr/bin/env node
// Read-only audit of the hosted staging project, through the Supabase
// Management API only: no database password, no direct connection, no write.
//
//   SUPABASE_ACCESS_TOKEN=… node scripts/staging/audit.mjs [--after]
//
// The token needs only read scopes (a scoped access token):
//   database:read  migrations history, backups, read-only SQL
//                  (POST …/database/query/read-only, run as
//                  supabase_read_only_user)
//   auth:read      Auth settings (only an allow-list of non-secret fields is
//                  kept: no SMTP password, no provider or hook secret)
//   storage:read   buckets
// Every call below is a GET, or the read-only query endpoint.
//
// Output, in backups/staging-audit-<UTC>/ (git-ignored):
//   summary.txt          what is printed, safe to share
//   migrations.json      hosted history (versions, names)
//   inventory.json       counts only (scripts/staging/inventory.sql)
//   backups.json         backup status (Free plan: none)
//   auth.json            non-secret Auth settings
//   buckets.json         buckets
//   accounts.local.json  PERSONAL DATA (emails): stays on this machine,
//                        never printed, never to be pasted anywhere
//   postcheck.json       with --after only (scripts/staging/postcheck.sql)
//
// Exit code 0: the hosted history is a prefix of the repository's (no
// remote-only version, no gap), ends exactly at EXPECTED_LAST_HOSTED (or,
// with --after, at the last migration) and the pending migrations are
// exactly EXPECTED_PENDING; 2 otherwise (STOP: analyse, no repair).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REF = process.env.STAGING_PROJECT_REF ?? "osvlzlnwjnmjscpubawa";
const API =
  process.env.SUPABASE_MANAGEMENT_API ?? "https://api.supabase.com/v1";
const BASE = "1965f8a"; // main, the integrated beta
// The state observed by the real audit of 8 Nov 2026: 24 migrations applied,
// the last one 20261016090000. The upgrade rehearsed from that exact state
// (runbook § 3) applies these eleven, in this order. Any other hosted state
// (another last version, a remote-only version, a gap) is a STOP: the
// rehearsal no longer describes it.
const EXPECTED_LAST_HOSTED = "20261016090000";
const EXPECTED_PENDING = [
  "20261017090000",
  "20261018090000",
  "20261019090000",
  "20261020090000",
  "20261021090000",
  "20261031090000",
  "20261103090000",
  "20261105090000",
  "20261106090000",
  "20261107090000",
  "20261108090000",
];
const AUTH_FIELDS = [
  "site_url",
  "uri_allow_list",
  "disable_signup",
  "external_email_enabled",
  "mailer_autoconfirm",
  "mailer_secure_email_change_enabled",
  "mailer_otp_exp",
  "password_min_length",
  "password_required_characters",
  "rate_limit_email_sent",
  "smtp_host",
  "smtp_port",
  "smtp_admin_email",
  "smtp_sender_name",
  "mailer_subjects_confirmation",
  "mailer_subjects_recovery",
  "mailer_templates_recovery_content",
  "jwt_exp",
  "refresh_token_rotation_enabled",
  "security_refresh_token_reuse_interval",
  "external_anonymous_users_enabled",
];

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error("Export SUPABASE_ACCESS_TOKEN (a read-only scoped token).");
  process.exit(1);
}
const after = process.argv.includes("--after");

// The checkout must hold main's migrations, whatever branch it is on.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
try {
  git("diff", "--quiet", BASE, "--", "supabase/migrations");
} catch {
  console.error(
    `supabase/migrations differs from ${BASE} (main). Use the checkout given in the runbook.`,
  );
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const out = join("backups", `staging-audit-${stamp}Z`);
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name, value) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });

async function call(method, path, body) {
  const response = await fetch(`${API}/projects/${REF}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}
const sql = (file) =>
  call("POST", "/database/query/read-only", {
    query: readFileSync(join("scripts/staging", file), "utf8"),
  });

const lines = [];
const say = (line = "") => {
  lines.push(line);
  console.log(line);
};

say(
  `Audit of ${REF}, ${new Date().toISOString()}, checkout ${git("rev-parse", "--short", "HEAD")}`,
);

// 1. Migrations: hosted history against the repository's files.
const local = readdirSync("supabase/migrations")
  .filter((name) => name.endsWith(".sql"))
  .map((name) => name.split("_")[0])
  .sort();
const hosted = (await call("GET", "/database/migrations"))
  .map((entry) => entry.version)
  .sort();
save("migrations.json", await call("GET", "/database/migrations"));

const remoteOnly = hosted.filter((version) => !local.includes(version));
const missing = local.filter((version) => !hosted.includes(version));
const last = hosted.at(-1) ?? "(none)";
const gaps = missing.filter((version) => version < last);
const pending = missing.filter((version) => version > last);
say("");
say(`Migrations: ${hosted.length} hosted, ${local.length} in the repository`);
say(`  last hosted:        ${last}`);
say(`  remote only:        ${remoteOnly.join(", ") || "none"}`);
say(`  gaps (older, absent): ${gaps.join(", ") || "none"}`);
say(`  pending:            ${pending.join(", ") || "none"}`);

const expected = after ? [] : EXPECTED_PENDING;
const expectedLast = after ? EXPECTED_PENDING.at(-1) : EXPECTED_LAST_HOSTED;
const migrationsOk =
  remoteOnly.length === 0 &&
  gaps.length === 0 &&
  last === expectedLast &&
  JSON.stringify(pending) === JSON.stringify(expected);
say(`  expected:           last ${expectedLast}, ${expected.length} pending`);
say(
  `  verdict:            ${migrationsOk ? "OK" : "STOP — analyse, no repair"}`,
);

// 2. Inventory (counts only).
const inventory = await sql("inventory.sql");
save("inventory.json", inventory);
say("");
say("Inventory (counts):");
for (const row of inventory.filter((r) => r.section !== "migration")) {
  say(`  ${row.section.padEnd(15)} ${row.item.padEnd(28)} ${row.value}`);
}
const storageColumns = inventory.filter((r) => r.section === "storage_column");
say(
  `  storage.objects columns for 20261106: ${storageColumns.length === 2 ? "present" : "MISSING — STOP"}`,
);

// 3. Accounts: personal data, local file only.
const accounts = await sql("accounts.sql");
save("accounts.local.json", accounts);
say("");
say(
  `Accounts: ${accounts.length} (${accounts.filter((a) => a.confirmed).length} confirmed, ${accounts.filter((a) => Number(a.businesses) > 0).length} with a business). Details: ${join(out, "accounts.local.json")} (personal data: keep it local).`,
);
say(
  "  Each of them gets beta access when 20261107 runs. Delete none without an explicit decision.",
);

// 4. Backups.
const backups = await call("GET", "/database/backups");
save("backups.json", backups);
say("");
say(
  `Backups: ${backups.backups?.length ?? 0} listed, PITR ${backups.pitr_enabled ? "on" : "off"}, WAL-G ${backups.walg_enabled ? "on" : "off"}`,
);

// 5. Auth settings, allow-listed fields only.
const authAll = await call("GET", "/config/auth");
const auth = Object.fromEntries(
  AUTH_FIELDS.filter((key) => key in authAll).map((key) => [key, authAll[key]]),
);
auth.smtp_configured = Boolean(authAll.smtp_host);
save("auth.json", auth);
say("");
say("Auth:");
say(`  site_url:           ${auth.site_url}`);
say(`  redirect URLs:      ${auth.uri_allow_list || "(none)"}`);
say(`  sign-up disabled:   ${auth.disable_signup}`);
say(
  `  email confirmation: ${auth.mailer_autoconfirm ? "OFF (autoconfirm)" : "on"}`,
);
say(`  password min:       ${auth.password_min_length}`);
say(
  `  custom SMTP:        ${auth.smtp_configured ? `yes (${auth.smtp_host})` : "no (team addresses only)"}`,
);
say(`  recovery subject:   ${auth.mailer_subjects_recovery ?? "(default)"}`);

// 6. Buckets.
const buckets = await call("GET", "/storage/buckets");
save("buckets.json", buckets);
say("");
say(
  `Buckets: ${buckets.map((b) => `${b.id}${b.public ? " (PUBLIC)" : ""}`).join(", ") || "none"}`,
);

// 7. After the migration: the post-checks.
let postOk = true;
if (after) {
  const checks = await sql("postcheck.sql");
  save("postcheck.json", checks);
  postOk = checks.every((check) => check.ok === true);
  say("");
  say("Post-migration checks:");
  for (const check of checks)
    say(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}`);
}

writeFileSync(join(out, "summary.txt"), lines.join("\n") + "\n", {
  mode: 0o600,
});
console.log(`\nFiles: ${out}/ (summary.txt is the part to share).`);
process.exit(migrationsOk && storageColumns.length === 2 && postOk ? 0 : 2);
