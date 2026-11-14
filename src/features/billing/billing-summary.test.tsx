// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingSummary } from "./billing-summary";
import type { BillingActions } from "./contract";
import { memoryBilling, sampleSummary } from "./memory-actions";

// The billing page against an in-memory server of the PROPOSED contract
// (docs/BILLING_SUMMARY_PROPOSAL.md). No provider, no charge, no invoice.

afterEach(cleanup);

const open = async (
  server = memoryBilling(),
  actions: BillingActions = server.actions,
) => {
  render(<BillingSummary actions={actions} />);
  await screen.findByRole("heading", { name: "Facturation" });
  await screen.findByRole("region", { name: "Factures" });
  return server;
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const text = () => (document.body.textContent ?? "").replace(/\s/g, " ");

describe("the page", () => {
  it("invoices: preparing, issued (simulated) and unavailable are distinct; no zero for an unknown amount", async () => {
    await open();
    await screen.findByText("En préparation");
    expect(text()).toMatch(
      /Simulé\. Aucun prestataire de paiement n’est relié/,
    );
    expect(text()).toMatch(/novembre 2026En préparation—/);
    expect(text()).toMatch(/octobre 2026Émise · document simulé49 €/);
    expect(text()).toMatch(/septembre 2026Indisponible pour le moment—/);
    expect(text()).not.toMatch(/0 €/);
  });

  it("a late payment is said with its grace date, everything going on meanwhile", async () => {
    await open(
      memoryBilling({
        start: sampleSummary({
          state: "past_due",
          graceUntil: "2026-11-21T00:00:00.000Z",
        }),
      }),
    );
    expect(text()).toMatch(
      /Tout continue jusqu’au 21 novembre 2026 : ton site, tes réservations et tes rappels/,
    );
    expect(text()).toMatch(/Tes clientes ne voient rien/);
  });

  it("no provider: the payment portal says why it cannot open", async () => {
    await open();
    press("Gérer le moyen de paiement");
    await screen.findByText(/aucun prestataire de paiement n’est relié/);
  });
});

describe("cancelling", () => {
  it("consequences and appointments said before; a receipt after; undone until it takes effect", async () => {
    const server = await open();
    press("Résilier…");
    expect(text()).toMatch(/Il reste actif jusqu’au 1er décembre 2026/);
    expect(text()).toMatch(
      /Tes 14 rendez-vous à venir restent dans ton agenda, avec leurs rappels/,
    );
    press("Confirmer la résiliation");
    await screen.findByText(/Résiliation enregistrée \(reçu rc-1\)/);
    expect(text()).toMatch(/Résiliation prévue le 1er décembre 2026/);
    press("Annuler la résiliation");
    await screen.findByText(/Résiliation annulée/);
    expect(server.summary.cancellation).toBeNull();
  });

  it("changed elsewhere: nothing modified, the fresh state shown", async () => {
    const server = await open();
    press("Résilier…");
    server.bump();
    press("Confirmer la résiliation");
    await screen.findByText(/Ton abonnement a changé entre-temps/);
    expect(server.summary.cancellation).toBeNull();
  });

  it("a lost answer is resent with the same operation id: one cancellation", async () => {
    const server = memoryBilling();
    let lose = true;
    const requestCancellation = vi.fn<BillingActions["requestCancellation"]>(
      async (input) => {
        const result = await server.actions.requestCancellation(input);
        if (lose) {
          lose = false;
          return { ok: false, error: { code: "network" } };
        }
        return result;
      },
    );
    await open(server, { ...server.actions, requestCancellation });
    press("Résilier…");
    press("Confirmer la résiliation");
    await screen.findByText(/Pas de réponse/);
    press("Confirmer la résiliation");
    await screen.findByText(/Résiliation enregistrée \(reçu rc-1\)/);
    expect(requestCancellation.mock.calls[0]?.[0].operationId).toBe(
      requestCancellation.mock.calls[1]?.[0].operationId,
    );
  });
});
