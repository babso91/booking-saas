import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockAuthGateway, mockOnboardingGateway } from "./mock";
import { setMockScenario } from "./mock-scenario";

const input = {
  firstName: "Mila",
  lastName: "Laurent",
  businessName: "Studio Mila",
  slug: "mila-cils",
  timezone: "Europe/Paris",
  minimumBookingNoticeMinutes: 120,
  maximumBookingAdvanceDays: 90,
  bufferMinutes: 10,
};

async function settle<T>(promise: Promise<T>) {
  await vi.runAllTimersAsync();
  return promise;
}

describe("mock gateway", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    setMockScenario("auto");
    await settle(mockAuthGateway.signOut());
  });

  it("requires a session before onboarding", async () => {
    const status = await settle(mockOnboardingGateway.getOnboardingStatus());
    expect(status).toEqual({ ok: false, error: { code: "unauthorized" } });
  });

  it("walks through sign-up, slug check and onboarding", async () => {
    expect(
      await settle(
        mockAuthGateway.signUp({
          email: "mila@studio.fr",
          password: "motdepasse",
        }),
      ),
    ).toEqual({
      ok: true,
      data: { status: "session" },
    });

    const taken = await settle(mockOnboardingGateway.checkSlug("studio-mila"));
    expect(taken.ok && taken.data.availability).toBe("taken");
    expect(taken.ok && taken.data.suggestions.length).toBeGreaterThan(0);

    const free = await settle(mockOnboardingGateway.checkSlug("mila-cils"));
    expect(free.ok && free.data.availability).toBe("available");

    expect(
      await settle(mockOnboardingGateway.completeOnboarding(input)),
    ).toEqual({
      ok: true,
      data: { slug: "mila-cils", businessName: "Studio Mila" },
    });
    expect(
      await settle(mockOnboardingGateway.completeOnboarding(input)),
    ).toEqual({
      ok: false,
      error: { code: "already_onboarded" },
    });
  });

  it("asks for email confirmation when requested", async () => {
    const result = await settle(
      mockAuthGateway.signUp({
        email: "mila+verify@studio.fr",
        password: "motdepasse",
      }),
    );
    expect(result).toEqual({
      ok: true,
      data: { status: "confirmation_required", email: "mila+verify@studio.fr" },
    });
  });

  it("follows forced scenarios", async () => {
    setMockScenario("network");
    expect(
      await settle(mockAuthGateway.signIn({ email: "a@b.fr", password: "x" })),
    ).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("rejects the wrong password", async () => {
    expect(
      await settle(
        mockAuthGateway.signIn({ email: "a@b.fr", password: "wrong-password" }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "invalid_credentials" },
    });
  });
});
