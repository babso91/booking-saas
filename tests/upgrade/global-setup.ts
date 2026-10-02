import { execFileSync } from "node:child_process";

import type { TestProject } from "vitest/node";

import { assertLocal, resolveEnv } from "../integration/support/global-setup";

/** The schema the calendar upgrade test starts from (before civil dates). */
export const BEFORE_CIVIL_DATES = "20261004090000";

export default async function setup(project: TestProject) {
  const env = resolveEnv();
  assertLocal(env.apiUrl);
  assertLocal(env.dbUrl.replace(/^postgres(ql)?:/, "http:"));

  execFileSync(
    "npx",
    ["supabase", "db", "reset", "--version", BEFORE_CIVIL_DATES],
    { stdio: "inherit" },
  );
  project.provide("supabase", env);
}
