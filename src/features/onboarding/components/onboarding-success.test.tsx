// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OnboardingSuccess } from "./onboarding-success";

const fresh = { activeServices: 0, openingRanges: 0 };

describe("OnboardingSuccess (/app/welcome)", () => {
  it("a new professional is led to her services first, then hours, then her site", () => {
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
      "/app/site",
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

  it("says that services and hours open online booking, then offers her site", () => {
    render(<OnboardingSuccess businessName="Studio Mila" progress={fresh} />);
    expect(document.body.textContent).not.toMatch(/arrive bientôt/i);
    expect(document.body.textContent).toMatch(
      /tes clientes pourront réserver en ligne/,
    );
    const site = screen.getByRole("link", { name: /Ton site/ });
    expect(site.getAttribute("href")).toBe("/app/site");
    expect(site.textContent).toMatch(/Créer/);
  });

  it("shows her site as online once a version is published", () => {
    render(
      <OnboardingSuccess
        businessName="Studio Mila"
        progress={fresh}
        sitePublished
      />,
    );
    expect(screen.getByRole("link", { name: /Ton site/ }).textContent).toMatch(
      /En ligne/,
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
