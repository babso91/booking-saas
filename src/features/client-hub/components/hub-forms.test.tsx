// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sampleForm } from "@/features/forms/memory-actions";

import { HubFormPage } from "./hub-forms";

// Her form in her space, under the Hub's rule: an answer is shown only for
// the account the page confirmed. The session and the routes are mocked
// at their boundary; the Hub's own tests cover the session itself.

const { hub, api } = vi.hoisted(() => ({
  hub: {
    accepts: vi.fn(),
    distrust: vi.fn(),
    recheck: vi.fn(),
  },
  api: { fetchForm: vi.fn(), fetchForms: vi.fn(), submitForm: vi.fn() },
}));

vi.mock("../client/session", () => ({
  useClientHub: () => ({ session: { generation: 1 }, ...hub }),
  useHubRead: () => ({ status: "loading", reload: () => undefined }),
}));
vi.mock("../client/api", () => api);
vi.mock("./hub-shell", () => ({
  HubPage: ({ children }: { children: (context: object) => ReactNode }) =>
    children({}),
}));

const BUSINESS = "90000000-0000-4000-8000-000000000001";
const form = sampleForm({ title: "Avant votre rehaussement" });

beforeEach(() => {
  Object.values(hub).forEach((mock) => mock.mockReset());
  Object.values(api).forEach((mock) => mock.mockReset());
});
afterEach(cleanup);

describe("HubFormPage", () => {
  it("shows the form served for her confirmed account", async () => {
    hub.accepts.mockReturnValue(true);
    api.fetchForm.mockResolvedValue({ ok: true, data: form, account: "acc-1" });
    render(<HubFormPage businessId={BUSINESS} assignmentId="f1" />);
    expect(await screen.findByText("Avant votre rehaussement")).toBeTruthy();
    expect(api.fetchForm).toHaveBeenCalledWith(BUSINESS, "f1");
  });

  it("never shows a form served for another account, and checks who is signed in", async () => {
    hub.accepts.mockReturnValue(false);
    api.fetchForm.mockResolvedValue({ ok: true, data: form, account: "acc-2" });
    render(<HubFormPage businessId={BUSINESS} assignmentId="f1" />);
    await waitFor(() => expect(hub.distrust).toHaveBeenCalledWith(1));
    expect(screen.queryByText("Avant votre rehaussement")).toBeNull();
  });

  it("an access revoked meanwhile asks who is signed in again", async () => {
    api.fetchForm.mockResolvedValue({
      ok: false,
      error: { code: "client_hub_not_found" },
      account: null,
    });
    render(<HubFormPage businessId={BUSINESS} assignmentId="f1" />);
    await waitFor(() => expect(hub.recheck).toHaveBeenCalled());
  });
});
