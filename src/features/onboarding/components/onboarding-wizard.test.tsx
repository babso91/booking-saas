// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../../../tests/support/next-router";
import { OnboardingWizard } from "./onboarding-wizard";

const checkSlugAction = vi.fn();
const completeOnboardingAction = vi.fn();
const getOnboardingStatusAction = vi.fn();
const signOutAction = vi.fn();

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/onboarding/actions/onboarding", () => ({
  checkSlugAction: (input: unknown) => checkSlugAction(input),
  completeOnboardingAction: (input: unknown) => completeOnboardingAction(input),
}));
vi.mock("@/features/auth/actions/auth", () => ({
  getOnboardingStatusAction: () => getOnboardingStatusAction(),
  signOutAction: () => signOutAction(),
}));

const OWNER = "mila@studio.fr";
const DRAFT_KEY = "onboarding:draft";

/** checkSlugAction double: every slug is free except the listed ones. */
function slugsTaken(...taken: string[]) {
  checkSlugAction.mockImplementation(async ({ slug }: { slug: string }) => ({
    ok: true,
    data: {
      slug,
      available: !taken.includes(slug),
      reason: taken.includes(slug) ? "taken" : "available",
    },
  }));
}

function completed(slug: string) {
  return {
    ok: true,
    data: {
      businessId: "b-1",
      slug,
      businessName: "Studio Mila",
      timezone: "Europe/Paris",
      next: "/app",
    },
  };
}

async function fillIdentity(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Prénom"), "Mila");
  await user.type(screen.getByLabelText("Nom"), "Laurent");
  await user.type(screen.getByLabelText("Nom de ton activité"), "Studio Mila");
  await user.click(screen.getByRole("button", { name: /continuer/i }));
  await screen.findByRole("heading", { name: "Ton adresse, rien qu’à toi." });
}

/** From the slug step (slug available) to the final step. */
async function toDetails(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("Disponible pour l’instant");
  await user.click(screen.getByRole("button", { name: /continuer/i }));
  await screen.findByRole("heading", { name: "Tes règles, en douceur." });
  await user.click(screen.getByRole("button", { name: /continuer/i }));
  await screen.findByRole("heading", { name: "La touche finale." });
}

/** Success hands over to /app/welcome, which reads the business server-side. */
async function expectWelcome() {
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith("/app/welcome"),
  );
}

const finalButton = () =>
  screen.getByRole("button", { name: /créer mon espace/i });

describe("OnboardingWizard (real contract shapes)", () => {
  beforeEach(() => {
    for (const mock of [
      checkSlugAction,
      completeOnboardingAction,
      getOnboardingStatusAction,
      signOutAction,
    ]) {
      mock.mockReset();
    }
    router.replace.mockReset();
    slugsTaken();
  });

  it("completes onboarding, hands over to /app/welcome and clears the local draft", async () => {
    const user = userEvent.setup();
    completeOnboardingAction.mockResolvedValue(completed("studio-mila"));
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await waitFor(() =>
      expect(checkSlugAction).toHaveBeenCalledWith({ slug: "studio-mila" }),
    );
    await toDetails(user);
    await user.type(screen.getByLabelText(/Téléphone/), "06 12 34 56 78");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toContain(
      "06 12 34 56 78",
    );

    await user.click(finalButton());

    await expectWelcome();
    expect(completeOnboardingAction).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Mila",
        lastName: "Laurent",
        businessName: "Studio Mila",
        slug: "studio-mila",
        phone: "06 12 34 56 78",
        minimumBookingNoticeMinutes: 120,
        maximumBookingAdvanceDays: 90,
        bufferMinutes: 10,
      }),
    );
    expect(finalButton().getAttribute("data-state")).toBe("success");
    // Nothing (phone, address…) is kept once the space exists.
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("sends a single request on double click and never shows success early", async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => {};
    completeOnboardingAction.mockReturnValue(
      new Promise((done) => (resolve = done)),
    );
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await toDetails(user);
    await user.click(finalButton());
    await user.click(finalButton());

    expect(completeOnboardingAction).toHaveBeenCalledTimes(1);
    expect(finalButton().getAttribute("aria-busy")).toBe("true");
    expect(router.replace).not.toHaveBeenCalled();

    resolve(completed("studio-mila"));
    await expectWelcome();
  });

  it("marks a taken slug and only offers variants the server confirmed", async () => {
    const user = userEvent.setup();
    slugsTaken("studio-mila", "studio-mila-beaute");
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);

    expect(await screen.findByText("Déjà utilisé")).toBeTruthy();
    const variants = await screen.findByText(
      "Ces variantes sont libres pour l’instant :",
    );
    const list = within(variants.parentElement!);
    await waitFor(() =>
      expect(list.getAllByRole("button").length).toBeGreaterThan(0),
    );
    const offered = list
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(offered).not.toContain("studio-mila-beaute");
    expect(offered).toContain("studio-mila-atelier");

    // Cannot continue with a taken slug.
    await user.click(screen.getByRole("button", { name: /continuer/i }));
    expect(
      await screen.findByText("Ce lien est déjà pris. Choisis une variante."),
    ).toBeTruthy();
  });

  it("recovers from a slug_taken race at submit without losing anything", async () => {
    const user = userEvent.setup();
    completeOnboardingAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "slug_taken",
        message:
          "Cette adresse de page est déjà utilisée. Choisissez-en une autre.",
        fieldErrors: {
          slug: [
            "Cette adresse de page est déjà utilisée. Choisissez-en une autre.",
          ],
        },
      },
    });
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await toDetails(user);
    await user.type(screen.getByLabelText(/Adresse ou quartier/), "Lyon");
    slugsTaken("studio-mila");
    await user.click(finalButton());

    // Back on the slug step, with the product's copy and verified variants.
    expect(
      await screen.findByRole("heading", {
        name: "Ton adresse, rien qu’à toi.",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Ce lien vient d’être pris. Choisis une des variantes."),
    ).toBeTruthy();
    expect(screen.queryByText(/Choisissez-en une autre/)).toBeNull();
    const variant = await screen.findByRole("button", {
      name: "studio-mila-lyon",
    });

    // Everything typed is still there.
    const draft = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY)!).draft;
    expect(draft).toMatchObject({
      firstName: "Mila",
      lastName: "Laurent",
      location: "Lyon",
    });

    completeOnboardingAction.mockResolvedValueOnce(
      completed("studio-mila-lyon"),
    );
    await user.click(variant);
    await toDetails(user);
    await user.click(finalButton());

    await expectWelcome();
    expect(completeOnboardingAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        slug: "studio-mila-lyon",
        location: "Lyon",
        firstName: "Mila",
      }),
    );
  });

  it("shows backend validation errors on the right step, in the product's words", async () => {
    const user = userEvent.setup();
    completeOnboardingAction.mockResolvedValue({
      ok: false,
      error: {
        code: "validation_error",
        message: "Certaines informations sont invalides.",
        fieldErrors: {
          businessName: ["Too big: expected string to have <=120 characters"],
        },
      },
    });
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await toDetails(user);
    await user.click(finalButton());

    expect(
      await screen.findByRole("heading", { name: "Faisons connaissance." }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Vérifie le nom de ton activité (120 caractères maximum).",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Too big/)).toBeNull();
    expect(
      screen.getByLabelText("Nom de ton activité").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("already_onboarded (retry): confirms with the onboarding status, then welcomes", async () => {
    const user = userEvent.setup();
    completeOnboardingAction.mockResolvedValue({
      ok: false,
      error: {
        code: "already_onboarded",
        message: "Votre activité est déjà configurée.",
      },
    });
    getOnboardingStatusAction.mockResolvedValue({
      ok: true,
      data: {
        status: "ready",
        next: "/app",
        user: { email: OWNER, emailConfirmed: true },
        business: {
          slug: "studio-mila",
          name: "Studio Mila",
          timezone: "Europe/Paris",
        },
      },
    });
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await toDetails(user);
    await user.click(finalButton());

    await expectWelcome();
    expect(getOnboardingStatusAction).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("unauthenticated: asks to sign in again and keeps the answers", async () => {
    const user = userEvent.setup();
    completeOnboardingAction.mockResolvedValue({
      ok: false,
      error: { code: "unauthenticated", message: "Vous devez être connectée." },
    });
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await toDetails(user);
    await user.click(finalButton());

    expect(await screen.findByText("Session expirée")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Me reconnecter" }).getAttribute("href"),
    ).toBe("/login");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toContain("Studio Mila");
  });

  it("shows a network error with a retry when the request never completes", async () => {
    const user = userEvent.setup();
    completeOnboardingAction.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    completeOnboardingAction.mockResolvedValueOnce(completed("studio-mila"));
    render(<OnboardingWizard owner={OWNER} />);

    await fillIdentity(user);
    await toDetails(user);
    await user.click(finalButton());
    await user.click(await screen.findByRole("button", { name: "Réessayer" }));

    await expectWelcome();
  });

  it("restores the draft of the same account only", async () => {
    const saved = (owner: string) =>
      JSON.stringify({
        owner,
        step: 0,
        draft: { firstName: "Camille", businessName: "Écrin de Camille" },
      });

    window.sessionStorage.setItem(DRAFT_KEY, saved("someone@else.fr"));
    const { unmount } = render(<OnboardingWizard owner={OWNER} />);
    expect((screen.getByLabelText("Prénom") as HTMLInputElement).value).toBe(
      "",
    );
    unmount();

    window.sessionStorage.setItem(DRAFT_KEY, saved(OWNER));
    render(<OnboardingWizard owner={OWNER} />);
    expect((screen.getByLabelText("Prénom") as HTMLInputElement).value).toBe(
      "Camille",
    );
  });

  it("signs out through the backend and clears the draft", async () => {
    const user = userEvent.setup();
    signOutAction.mockResolvedValue({ ok: true, data: { next: "/login" } });
    render(<OnboardingWizard owner={OWNER} />);
    await user.type(screen.getByLabelText("Prénom"), "Mila");

    await user.click(screen.getByRole("button", { name: "Se déconnecter" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});
