// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { OfferDto } from "./offers";
import { PlanOverview } from "./plan-overview";

afterEach(cleanup);

const offers: OfferDto[] = (
  [
    ["core", "month", 2900],
    ["core", "year", 29000],
    ["signature", "month", 4900],
    ["signature", "year", 49000],
  ] as const
).map(([planCode, cadence, amountMinor]) => ({
  planCode,
  cadence,
  amountMinor,
  priceVersionId: "v1",
  currency: "EUR",
  displayTaxMode: "ttc",
}));

const card = (name: "Core" | "Signature") =>
  within(
    screen
      .getAllByRole("listitem")
      .find((item) => item.textContent?.startsWith(name))!,
  );

describe("her offer", () => {
  it("without listed offers (today): her plan and what it allows, no price, no purchase", () => {
    render(<PlanOverview current="core" offers={null} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /Core · mode Simple/,
    );
    expect(document.body.textContent).not.toMatch(/€/);
    expect(screen.queryByRole("group", { name: "Facturation" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /souscri|passer/i }),
    ).toBeNull();
    expect(
      screen.getByText("Changer d’offre n’est pas encore possible en ligne."),
    ).toBeTruthy();
    expect(card("Core").getByText("Ton offre")).toBeTruthy();
    expect(card("Signature").queryByText("Ton offre")).toBeNull();
  });

  it("listed: yearly first, with its real total, its month and what is saved", () => {
    render(<PlanOverview current="signature" offers={offers} />);
    const signature = card("Signature");
    expect(signature.getByText("Ton offre")).toBeTruthy();
    expect(signature.getByText(/490,00\s€/)).toBeTruthy();
    expect(
      signature.getByText(
        /Soit 40,83\s€ par mois, réglés en une fois\. 2 mois offerts\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Tarifs indicatifs/)).toBeTruthy();
  });

  it("monthly: the monthly price and its year, nothing said to be saved", () => {
    render(<PlanOverview current="core" offers={offers} />);
    fireEvent.click(screen.getByRole("button", { name: "Mensuel" }));
    const core = card("Core");
    expect(core.getByText(/29,00\s€/)).toBeTruthy();
    expect(core.getByText(/Soit 348,00\s€ sur un an\./)).toBeTruthy();
    expect(core.queryByText(/offert/)).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Mensuel" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
