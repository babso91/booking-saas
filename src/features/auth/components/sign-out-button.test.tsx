// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  draftKeyFor,
  readDraftRaw,
  writeDraftRaw,
} from "@/features/businesses/client/draft-scope";
import {
  creationKey,
  editKey,
  readEditDraft,
  readPendingCreation,
  writeEditDraft,
  writePendingCreation,
} from "@/features/services/client/service-drafts";
import { router } from "../../../../tests/support/next-router";
import { SignOutButton } from "./sign-out-button";

const signOutAction = vi.fn();

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({
  signOutAction: () => signOutAction(),
}));

describe("SignOutButton", () => {
  it("signs out once even when activated repeatedly, then clears every draft", async () => {
    let finish: (value: unknown) => void = () => {};
    signOutAction.mockReturnValue(new Promise((done) => (finish = done)));
    window.sessionStorage.setItem("onboarding:draft:user-a", "{}");
    window.sessionStorage.setItem("onboarding:draft:user-b", "{}");
    render(<SignOutButton />);
    const button = screen.getByRole("button", { name: /se déconnecter/i });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(signOutAction).toHaveBeenCalledTimes(1);

    finish({ ok: true, data: { next: "/login" } });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(window.sessionStorage.length).toBe(0);
  });

  it("Q. forgets every identity's setup drafts (services, hours), and nothing else", async () => {
    signOutAction.mockResolvedValue({ ok: true, data: { next: "/login" } });
    const scope = { userId: "user-a", businessId: "business-a" };
    const draft = {
      name: "Soin",
      description: "",
      duration: "60",
      price: "40",
    };
    const base = {
      id: "service-1",
      name: "Soin",
      description: null,
      durationMinutes: 60,
      priceCents: 4000,
      active: true,
      displayOrder: 0,
      version: 1,
    };
    writePendingCreation(creationKey(scope), {
      draft,
      key: null,
      unconfirmed: true,
    });
    writeEditDraft(editKey(scope, "service-1"), { draft, base });
    writeDraftRaw(draftKeyFor(scope, "hours"), "{}");
    window.sessionStorage.setItem("crm:directory", "/app/clients");
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole("button", { name: /se déconnecter/i }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(readPendingCreation(creationKey(scope))).toBeNull();
    expect(readEditDraft(editKey(scope, "service-1"), "service-1")).toBeNull();
    expect(readDraftRaw(draftKeyFor(scope, "hours"))).toBeNull();
    expect(window.sessionStorage.getItem("crm:directory")).toBe("/app/clients");
  });

  it("stays usable and says so when sign-out fails", async () => {
    signOutAction.mockResolvedValue({
      ok: false,
      error: { code: "internal", message: "x" },
    });
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole("button", { name: /se déconnecter/i }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /se déconnecter/i })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });
});
