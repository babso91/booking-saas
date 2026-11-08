#!/usr/bin/env node
// Runs one read-only SQL file and prints its rows as `psql -At` would
// (columns joined by "|", one row per line).
//
//   node scripts/staging/sql.mjs <file.sql>
//
// Target:
//   - SQL_DB_URL set: psql on that connection string (local rehearsal, or a
//     throwaway restore target), inside a read-only transaction;
//   - otherwise: the hosted project, through the Management API's read-only
//     endpoint (SUPABASE_ACCESS_TOKEN with database:read; runs as
//     supabase_read_only_user). No database password.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/staging/sql.mjs <file.sql>");
  process.exit(1);
}
const query = readFileSync(file, "utf8");

if (process.env.SQL_DB_URL) {
  const out = execFileSync(
    "psql",
    [
      process.env.SQL_DB_URL,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "begin transaction read only",
      "-f",
      file,
      "-c",
      "commit",
    ],
    { encoding: "utf8" },
  );
  process.stdout.write(
    out
      .split("\n")
      .filter((line) => line !== "BEGIN" && line !== "COMMIT")
      .join("\n"),
  );
} else {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.STAGING_PROJECT_REF ?? "osvlzlnwjnmjscpubawa";
  const api =
    process.env.SUPABASE_MANAGEMENT_API ?? "https://api.supabase.com/v1";
  if (!token) {
    console.error("Export SUPABASE_ACCESS_TOKEN, or SQL_DB_URL for psql.");
    process.exit(1);
  }
  const response = await fetch(
    `${api}/projects/${ref}/database/query/read-only`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const rows = JSON.parse(text);
  const cell = (value) =>
    value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  process.stdout.write(
    rows.map((row) => Object.values(row).map(cell).join("|")).join("\n") +
      (rows.length ? "\n" : ""),
  );
}
