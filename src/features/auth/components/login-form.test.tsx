// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../../../tests/support/next-router";
import { LoginForm } from "./login-form";

const signInAction = vi.fn();

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({
  signInAction: (input: unknown) => signInAction(input),
}));

async function submit(email = "Mila@Studio.fr", password = "correct-horse") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Mot de passe"), password);
  await user.click(screen.getByRole("button", { name: /se connecter/i }));
}

describe("LoginForm", () => {
  beforeEach(() => {
    signInAction.mockReset();
    router.replace.mockReset();
  });

  it.each(["/app", "/onboarding"] as const)(
    "sends a valid sign-in to the destination chosen by the server (%s)",
    async (next) => {
      signInAction.mockResolvedValue({ ok: true, data: { next } });
      render(<LoginForm />);
      await submit();

      expect(signInAction).toHaveBeenCalledWith({
        email: "mila@studio.fr",
        password: "correct-horse",
      });
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(next));
    },
  );

  it("renders invalid credentials calmly, without backend text", async () => {
    signInAction.mockResolvedValue({
      ok: false,
      error: {
        code: "invalid_credentials",
        message: "Email ou mot de passe incorrect.",
      },
    });
    render(<LoginForm />);
    await submit();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Identifiants incorrects",
    );
    expect(screen.queryByText("Email ou mot de passe incorrect.")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["email_not_confirmed", "Email à confirmer"],
    ["rate_limited", "Un instant"],
    ["internal", "Petit contretemps"],
  ])("explains %s", async (code, title) => {
    signInAction.mockResolvedValue({
      ok: false,
      error: { code, message: "raw" },
    });
    render(<LoginForm />);
    await submit();
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it("shows a network error with a retry when the request fails", async () => {
    signInAction.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LoginForm />);
    await submit();

    expect(await screen.findByText("Connexion interrompue")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
  });

  it("validates locally before calling the server", async () => {
    render(<LoginForm />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /se connecter/i }));

    expect(await screen.findByText("Indique ton email.")).toBeTruthy();
    expect(signInAction).not.toHaveBeenCalled();
  });

  it("explains a failed confirmation link (/login?error=auth_callback_failed)", () => {
    render(<LoginForm callbackFailed />);
    expect(screen.getByText("Lien expiré ou déjà utilisé")).toBeTruthy();
  });
});
