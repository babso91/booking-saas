import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({}),
}));
vi.mock("./session", async (original) => ({
  ...(await original<typeof import("./session")>()),
  getSessionState: async () => state.current,
}));

import { requirePractitioner, requireReadyBusiness } from "./guards";

const ready = (role: "owner" | "admin" | "practitioner") => ({
  status: "ready",
  user: { id: "u", email: "u@x.fr", emailConfirmed: true },
  business: {
    id: "b",
    membershipId: "m",
    role,
    slug: "s",
    name: "n",
    timezone: "Europe/Paris",
  },
});

beforeEach(() => {
  state.current = null;
});

describe("the area's guards", () => {
  it("owner and admin enter /app", async () => {
    for (const role of ["owner", "admin"] as const) {
      state.current = ready(role);
      await expect(requireReadyBusiness()).resolves.toMatchObject({
        status: "ready",
      });
    }
  });

  it("a practitioner never runs a page of /app: sent to her agenda", async () => {
    state.current = ready("practitioner");
    await expect(requireReadyBusiness()).rejects.toThrow(
      "REDIRECT /mon-agenda",
    );
  });

  it("her agenda is hers only: owner and admin are sent to /app", async () => {
    state.current = ready("practitioner");
    await expect(requirePractitioner()).resolves.toMatchObject({
      status: "ready",
    });
    state.current = ready("owner");
    await expect(requirePractitioner()).rejects.toThrow("REDIRECT /app");
    state.current = { status: "unauthenticated" };
    await expect(requirePractitioner()).rejects.toThrow("REDIRECT /login");
  });
});
