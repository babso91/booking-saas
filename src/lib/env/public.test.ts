import { describe, expect, it } from "vitest";

import { parsePublicEnv } from "./public";

describe("parsePublicEnv", () => {
  it("accepts a complete public configuration", () => {
    expect(
      parsePublicEnv({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-anon-key",
      }),
    ).toEqual({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-anon-key",
    });
  });

  it("rejects missing or invalid public values", () => {
    expect(() =>
      parsePublicEnv({
        NEXT_PUBLIC_APP_URL: "not-a-url",
      }),
    ).toThrow();
  });
});
