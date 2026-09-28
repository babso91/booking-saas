import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import type { TestProject } from "vitest/node";

export type SupabaseTestEnv = {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  serviceRoleKey: string;
};

declare module "vitest" {
  export interface ProvidedContext {
    supabase: SupabaseTestEnv;
  }
}

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations", import.meta.url),
);

function resolveEnv(): SupabaseTestEnv {
  const fromEnv = {
    apiUrl: process.env.SUPABASE_TEST_API_URL,
    dbUrl: process.env.SUPABASE_TEST_DB_URL,
    anonKey: process.env.SUPABASE_TEST_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_TEST_SERVICE_ROLE_KEY,
  };

  if (
    fromEnv.apiUrl &&
    fromEnv.dbUrl &&
    fromEnv.anonKey &&
    fromEnv.serviceRoleKey
  ) {
    return fromEnv as SupabaseTestEnv;
  }

  let status: Record<string, string>;

  try {
    status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "--output", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (error) {
    throw new Error(
      "Local Supabase is not running. Start it with `npm run db:start` " +
        "(and `npm run db:reset` to apply migrations) before `npm run test:db`.",
      { cause: error },
    );
  }

  return {
    apiUrl: status.API_URL!,
    dbUrl: status.DB_URL!,
    anonKey: status.ANON_KEY!,
    serviceRoleKey: status.SERVICE_ROLE_KEY!,
  };
}

function assertLocal(url: string) {
  const host = new URL(url).hostname;

  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `Refusing to run database tests against non-local host ${host}.`,
    );
  }
}

export default async function setup(project: TestProject) {
  const env = resolveEnv();

  assertLocal(env.apiUrl);
  assertLocal(env.dbUrl.replace(/^postgres(ql)?:/, "http:"));

  // Every migration file must have been applied: tests always run against the
  // real, fully migrated schema.
  const client = new pg.Client({ connectionString: env.dbUrl });
  await client.connect();

  try {
    const { rows } = await client.query<{ version: string }>(
      "select version from supabase_migrations.schema_migrations",
    );
    const applied = new Set(rows.map((row) => row.version));
    const missing = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => file.split("_")[0]!)
      .filter((version) => !applied.has(version));

    if (missing.length > 0) {
      throw new Error(
        `Migrations not applied: ${missing.join(", ")}. Run \`npm run db:reset\`.`,
      );
    }
  } finally {
    await client.end();
  }

  project.provide("supabase", env);
}
