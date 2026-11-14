// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { money, type OfferQuoteActions } from "./contract";
import { ELIGIBLE, memoryOfferQuote, REGULAR } from "./memory-actions";
import { QuoteSummary } from "./quote-summary";

// The slot's exact quote against an in-memory server of the PROPOSED
// contract (docs/OFFER_QUOTE_PROPOSAL.md). The real guarantees (locks,
// quota counter, price snapshot) are the backend's.

afterEach(cleanup);

const open = async (
  startsAt = ELIGIBLE,
  server = memoryOfferQuote(),
  actions: OfferQuoteActions = server.actions,
  onChooseAnotherSlot = vi.fn(),
) => {
  render(
    <QuoteSummary
      input={{ serviceId: "s-gel", optionChoiceIds: ["o-art"], startsAt }}
      serviceName="Pose gel"
      slotLabel="mardi 17 novembre à 14:00"
      actions={actions}
      onChooseAnotherSlot={onChooseAnotherSlot}
    />,
  );
  await screen.findByRole("region", { name: "Récapitulatif du prix" });
  return { server, onChooseAnotherSlot };
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const text = () => document.body.textContent ?? "";
const eur = (cents: number) => money(cents).replace(/\s/g, " ");

describe("the quote", () => {
  it("the recipe: base, options, discount, total and deposit apart", async () => {
    await open();
    const summary = text().replace(/\s/g, " ");
    expect(summary).toContain(`Pose gel${eur(6000)}`);
    expect(summary).toContain(`Options${eur(1500)}`);
    expect(summary).toContain(`Heure creuse : −15 %−${eur(1125)}`);
    expect(summary).toContain(`Total${eur(6375)}`);
    expect(summary).toContain(`Acompte demandé (à part)${eur(2000)}`);
    expect(summary).toMatch(/Prix garanti jusqu’à 11:15/);
  });

  it("the other slot the same day has no offer", async () => {
    await open(REGULAR);
    expect(text().replace(/\s/g, " ")).toContain(`Total${eur(7500)}`);
    expect(text()).not.toMatch(/Heure creuse/);
  });
});

describe("a code", () => {
  it("refused: one generic reason, the slot stays chosen", async () => {
    await open();
    press("J’ai un code");
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "FAUX" },
    });
    press("Appliquer");
    await screen.findByText(/ne peut pas être utilisé pour ce créneau/);
    expect(text().replace(/\s/g, " ")).toContain(`Total${eur(6375)}`);
  });

  it("accepted: it replaces the offer; removed, the offer is back", async () => {
    await open();
    press("J’ai un code");
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "bienvenue10" },
    });
    press("Appliquer");
    await screen.findByText(/Code BIENVENUE10 appliqué/);
    expect(text().replace(/\s/g, " ")).toContain(`Total${eur(6750)}`);
    press("Retirer le code");
    await screen.findByText("J’ai un code");
    expect(text()).toMatch(/Heure creuse/);
  });
});

describe("booking", () => {
  it("the last offer used meanwhile: never the normal price silently", async () => {
    const { server } = await open();
    server.useQuota();
    press(/^Réserver pour/);
    await screen.findByText(/L’offre vient d’être épuisée/);
    expect(server.bookings).toBe(0);
    expect(text().replace(/\s/g, " ")).toMatch(
      new RegExp(`passe de ${eur(6375)} à ${eur(7500)}`),
    );
    press(`Réserver pour ${money(7500)}`);
    await screen.findByText("C’est réservé");
    expect(server.bookings).toBe(1);
  });

  it("an expired quote: the price is asked again before booking", async () => {
    let clock = Date.parse("2026-11-14T10:00:00.000Z");
    const server = memoryOfferQuote({ now: () => clock });
    await open(ELIGIBLE, server);
    clock += 20 * 60_000;
    press(/^Réserver pour/);
    await screen.findByText(/Le prix a été mis à jour/);
    expect(server.bookings).toBe(0);
  });

  it("the slot taken meanwhile: nothing booked, she picks another", async () => {
    const { server, onChooseAnotherSlot } = await open();
    server.take(ELIGIBLE);
    press(/^Réserver pour/);
    await screen.findByText("Ce créneau vient d’être pris");
    press("Choisir un autre créneau");
    expect(onChooseAnotherSlot).toHaveBeenCalled();
  });

  it("a lost answer is resent with the same request id: one booking", async () => {
    const server = memoryOfferQuote();
    let lose = true;
    const confirm = vi.fn<OfferQuoteActions["confirm"]>(async (input) => {
      const result = await server.actions.confirm(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(ELIGIBLE, server, { ...server.actions, confirm });
    press(/^Réserver pour/);
    await screen.findByText(/Pas de réponse/);
    press(/^Réserver pour/);
    await screen.findByText("C’est réservé");
    expect(confirm.mock.calls[0]?.[0].requestId).toBe(
      confirm.mock.calls[1]?.[0].requestId,
    );
    expect(server.bookings).toBe(1);
  });
});
