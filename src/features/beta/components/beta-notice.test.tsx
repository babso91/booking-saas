// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

import { BetaNotice } from "./beta-notice";

afterEach(cleanup);

describe("BetaNotice", () => {
  it("on /signup without an invitation: no form, the way in, and login", () => {
    render(<BetaNotice reason="signup" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /invitation/,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Créer/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Se connecter" }).getAttribute("href"),
    ).toBe("/login");
  });

  it("before onboarding without access: why, what to do, and a way out", () => {
    render(<BetaNotice reason="onboarding" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /Ton compte attend son invitation/,
    );
    expect(document.body.textContent).toMatch(/serait refusée/);
    expect(screen.getByRole("button", { name: /Se déconnecter/ })).toBeTruthy();
  });
});
