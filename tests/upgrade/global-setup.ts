import type { TestProject } from "vitest/node";

import { assertLocal, resolveEnv } from "../integration/support/global-setup";

export default async function setup(project: TestProject) {
  const env = resolveEnv();
  assertLocal(env.apiUrl);
  assertLocal(env.dbUrl.replace(/^postgres(ql)?:/, "http:"));
  // Each upgrade test resets the database to the schema it starts from
  // (support.ts), before its first query.
  project.provide("supabase", env);
}
