import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Migration upgrade tests: the local database is reset to an older schema,
// filled with historical data, then migrated to the latest schema (the path
// a populated environment takes), and the data is checked. Destructive:
// local Supabase only; the database ends fully migrated.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./tests/support/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/upgrade/**/*.test.ts"],
    globalSetup: ["tests/upgrade/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
