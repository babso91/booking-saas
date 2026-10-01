import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // PostgreSQL is the calendar authority (docs/ARCHITECTURE.md §8): the
    // application never converts schedule times with the JS runtime's own
    // time zone database. Those conversions remain for tests only.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/time/zoned",
              importNames: [
                "zonedLocalToUtc",
                "utcToZonedLocal",
                "zonedDateOf",
                "isExistingLocalTime",
                "resolveZonedLocal",
                "zonedOccurrenceOf",
                "startOfLocalDate",
                "localDateRangeToUtc",
                "zonedBoundToUtc",
              ],
              message:
                "Schedule times are converted by PostgreSQL: use @/lib/time/business-time (server) or the agenda zone (UI).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
