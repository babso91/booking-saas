// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setConsentSchema } from "../schemas";
import { ClientConsents } from "./client-consents";

// A client's consents, from what the professional sees and does, with the
// Server Actions mocked at their boundary; commands checked by their schema.

const { actions } = vi.hoisted(() => ({
  actions: { getClientConsentsAction: vi.fn(), setConsentAction: vi.fn() },
}));
vi.mock("@/features/marketing-consent/actions", () => ({
  getClientConsentsAction: (...args: unknown[]) =>
    actions.getClientConsentsAction(...args),
  setConsentAction: (...args: unknown[]) => actions.setConsentAction(...args),
}));

const CLIENT = "80000000-0000-4000-8000-000000000001";
const consent = (channel: "email" | "sms", state: string, source = null) => ({
  purpose: "marketing",
  channel,
  state,
  proofVersion: state === "granted" ? "optin-v1" : null,
  source,
  changedAt: state === "unknown" ? null : "2026-11-02T10:00:00.000Z",
});

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(cleanup);

describe("ClientConsents", () => {
  it("says plainly who may receive offers, never offering to record an agreement", async () => {
    actions.getClientConsentsAction.mockResolvedValue({
      ok: true,
      data: [consent("email", "unknown"), consent("sms", "withdrawn")],
    });
    render(<ClientConsents clientId={CLIENT} />);
    expect(
      await screen.findByText("Aucun accord : elle ne reçoit pas d’offres"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Ne veut plus d’offres le 2 novembre/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accord/i })).toBeNull();
  });

  it("notes that she does not want offers any more", async () => {
    actions.getClientConsentsAction.mockResolvedValue({
      ok: true,
      data: [consent("email", "granted"), consent("sms", "unknown")],
    });
    actions.setConsentAction.mockImplementation(async (input) => {
      setConsentSchema.parse(input);
      return {
        ok: true,
        data: { ...consent("email", "withdrawn", "professional" as never) },
      };
    });
    render(<ClientConsents clientId={CLIENT} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Elle ne veut plus d’offres" }),
    );
    expect(await screen.findByText(/Ne veut plus d’offres le/)).toBeTruthy();
    expect(actions.setConsentAction.mock.calls[0]![0]).toMatchObject({
      clientId: CLIENT,
      purpose: "marketing",
      channel: "email",
      action: "withdraw",
    });
  });
});
