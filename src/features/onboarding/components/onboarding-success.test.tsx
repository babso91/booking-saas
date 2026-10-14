// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OnboardingSuccess } from "./onboarding-success";

const fresh = { activeServices: 0, openingRanges: 0 };

describe("OnboardingSuccess (/app/welcome)", () => {
  it("a new professional is led to her services first, then hours, then the agenda", () => {
    render(<OnboardingSuccess businessName="Studio Mila" progress={fresh} />);

    expect(
      screen.getByRole("heading", { name: "Ton espace est prêt." }),
    ).toBeTruthy();
    expect(screen.getByText("Studio Mila")).toBeTruthy();
    const steps = within(
      screen.getByRole("region", { name: "Mise en route" }),
    ).getAllByRole("link");
    expect(steps.map((link) => link.getAttribute("href"))).toEqual([
      "/app/services",
      "/app/settings/hours",
      "/app",
    ]);
    expect(
      screen
        .getByRole("link", { name: /Ajouter mes prestations/ })
        .getAttribute("href"),
    ).toBe("/app/services");
    expect(
      screen
        .getByRole("link", { name: /aller à mon agenda/i })
        .getAttribute("href"),
    ).toBe("/app");
  });

  it("never promises online booking that does not exist yet", () => {
    render(<OnboardingSuccess businessName="Studio Mila" progress={fresh} />);
    expect(screen.queryByRole("button", { name: /copier/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/partage ton lien/i);
    expect(document.body.textContent).toMatch(
      /La réservation en ligne par tes clientes arrive bientôt/,
    );
  });

  it("the next step follows what is already configured", () => {
    const { rerender } = render(
      <OnboardingSuccess
        businessName="Studio Mila"
        progress={{ activeServices: 2, openingRanges: 0 }}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: /Configurer mes horaires/ })
        .getAttribute("href"),
    ).toBe("/app/settings/hours");
    expect(screen.getByText("1 étape sur 2 terminée")).toBeTruthy();

    rerender(
      <OnboardingSuccess
        businessName="Studio Mila"
        progress={{ activeServices: 2, openingRanges: 5 }}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: /Accéder à mon agenda/ })
        .getAttribute("href"),
    ).toBe("/app");
    expect(screen.getByText("2 étapes sur 2 terminées")).toBeTruthy();
  });
});
