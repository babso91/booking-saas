import { describe, expect, it } from "vitest";

import { callAction } from "./call-action";

describe("callAction", () => {
  it("passes successful results through", async () => {
    expect(
      await callAction(async () => ({ ok: true, data: { next: "/app" } })),
    ).toEqual({
      ok: true,
      data: { next: "/app" },
    });
  });

  it("keeps the code and field names but drops the backend message", async () => {
    const result = await callAction(async () => ({
      ok: false as const,
      error: {
        code: "slug_taken" as const,
        message: "Cette adresse de page est déjà utilisée.",
        fieldErrors: { slug: ["Cette adresse de page est déjà utilisée."] },
      },
    }));
    expect(result).toEqual({
      ok: false,
      error: {
        code: "slug_taken",
        fieldErrors: { slug: ["Cette adresse de page est déjà utilisée."] },
      },
    });
  });

  it("turns a failed Server Action request into a network error", async () => {
    expect(
      await callAction(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toEqual({ ok: false, error: { code: "network" } });
  });
});
