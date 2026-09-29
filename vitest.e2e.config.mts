import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// End-to-end auth flows against `next start` on http://localhost:3000 and the
// local Supabase stack. Requires `npm run build` and `npm run db:start`.
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
    include: ["tests/e2e/**/*.test.ts"],
    globalSetup: ["tests/e2e/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
