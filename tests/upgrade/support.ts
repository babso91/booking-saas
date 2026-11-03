import { execFileSync } from "node:child_process";

/**
 * Resets the local database to the schema of `version` (that migration and
 * every earlier one): the state a deployed database was in. Call before the
 * test's first query (the reset restarts the database).
 */
export function resetTo(version: string) {
  execFileSync("npx", ["supabase", "db", "reset", "--version", version], {
    stdio: "inherit",
  });
}

/** Then the rest of the migration chain, as a deployment applies it. */
export function migrateUp() {
  execFileSync("npx", ["supabase", "migration", "up", "--local"], {
    stdio: "inherit",
  });
}

// Comparing rows before and after the chain of migrations: a later
// migration may add a column (with a default) to a table without rewriting
// any existing value, which still changes the row's text. The tests compare
// the columns their own migration knew: `to_jsonb(row) - 'added_column'`
// (for instance the catalogue's appointments.options_snapshot and
// services.category_id / options_revision).
