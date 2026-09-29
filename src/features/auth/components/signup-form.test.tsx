// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../../../tests/support/next-router";
import { SignupForm } from "./signup-form";

const signUpAction = vi.fn();

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({
  signUpAction: (input: unknown) => signUpAction(input),
}));

async function submit(
  email = "Mila@Studio.fr",
  password = "correct-horse-battery",
) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email professionnel"), email);
  await user.type(screen.getByLabelText("Mot de passe"), password);
  await user.click(screen.getByRole("button", { name: /créer mon compte/i }));
  return user;
}

describe("SignupForm", () => {
  beforeEach(() => {
    signUpAction.mockReset();
    router.replace.mockReset();
  });

  it("signed_in: continues to /onboarding", async () => {
    signUpAction.mockResolvedValue({
      ok: true,
      data: { status: "signed_in", next: "/onboarding" },
    });
    render(<SignupForm />);
    await submit();

    expect(signUpAction).toHaveBeenCalledWith({
      email: "mila@studio.fr",
      password: "correct-horse-battery",
    });
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/onboarding"),
    );
  });

  it("confirmation_required: shows the inbox screen with the address used", async () => {
    signUpAction.mockResolvedValue({
      ok: true,
      data: {
        status: "confirmation_required",
        email: "mila@studio.fr",
        next: null,
      },
    });
    render(<SignupForm />);
    await submit();

    expect(
      await screen.findByRole("heading", { name: "Vérifie ta boîte mail." }),
    ).toBeTruthy();
    expect(screen.getByText("mila@studio.fr")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("offers a throttled resend of the confirmation email", async () => {
    signUpAction.mockResolvedValue({
      ok: true,
      data: {
        status: "confirmation_required",
        email: "mila@studio.fr",
        next: null,
      },
    });
    render(<SignupForm />);
    await submit();
    const resend = await screen.findByRole("button", { name: /renvoyer/i });
    expect((resend as HTMLButtonElement).disabled).toBe(true);
  });

  it("answers email_taken with a neutral message", async () => {
    signUpAction.mockResolvedValue({
      ok: false,
      error: {
        code: "email_taken",
        message: "Un compte existe déjà avec cette adresse email.",
      },
    });
    render(<SignupForm />);
    await submit();

    expect(
      await screen.findByText(/Si cette adresse peut être utilisée/),
    ).toBeTruthy();
    expect(screen.queryByText(/existe déjà/)).toBeNull();
    expect(screen.getByRole("link", { name: "Me connecter" })).toBeTruthy();
  });

  it("renders a backend validation error on the right field, in the product's words", async () => {
    signUpAction.mockResolvedValue({
      ok: false,
      error: {
        code: "validation_error",
        message: "Certaines informations sont invalides.",
        fieldErrors: { password: ["Ce mot de passe est trop faible."] },
      },
    });
    render(<SignupForm />);
    await submit();

    expect(await screen.findByText(/Mot de passe trop simple/)).toBeTruthy();
    expect(
      screen.getByLabelText("Mot de passe").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("enforces the backend password policy (10 characters) before calling it", async () => {
    render(<SignupForm />);
    await submit("mila@studio.fr", "123456789");

    expect(await screen.findByText("Au moins 10 caractères.")).toBeTruthy();
    expect(signUpAction).not.toHaveBeenCalled();
  });

  it("explains rate limiting", async () => {
    signUpAction.mockResolvedValue({
      ok: false,
      error: { code: "rate_limited", message: "x" },
    });
    render(<SignupForm />);
    await submit();
    expect(await screen.findByText("Un instant")).toBeTruthy();
  });
});
