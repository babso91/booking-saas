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

  it("keeps the record a write collided with, so the screen can open it", async () => {
    const result = await callAction(async () => ({
      ok: false as const,
      error: {
        code: "client_email_conflict" as const,
        message: "Cet email est déjà utilisé par une autre cliente.",
        fieldErrors: { email: ["Cet email est déjà utilisé."] },
        conflict: {
          clientId: "30000000-0000-4000-8000-000000000001",
          displayName: "Emma Laurent",
        },
      },
    }));
    expect(result).toEqual({
      ok: false,
      error: {
        code: "client_email_conflict",
        fieldErrors: { email: ["Cet email est déjà utilisé."] },
        conflict: {
          clientId: "30000000-0000-4000-8000-000000000001",
          displayName: "Emma Laurent",
        },
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
