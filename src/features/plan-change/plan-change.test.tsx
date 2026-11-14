// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanChangeActions } from "./contract";
import { memoryPlanChange } from "./memory-actions";
import { PlanChange } from "./plan-change";

// The plan change against an in-memory server of the PROPOSED contract
// (docs/PLAN_CHANGE_PROPOSAL.md). Nothing is ever charged.

afterEach(cleanup);

const open = async (
  server = memoryPlanChange(),
  actions: PlanChangeActions = server.actions,
) => {
  render(<PlanChange actions={actions} />);
  await screen.findByRole("heading", { name: "Changer de formule" });
  return server;
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const text = () => (document.body.textContent ?? "").replace(/\s/g, " ");

describe("the quote", () => {
  it("the recipe: 10 € now, then 49 € a month, active only after a verified payment", async () => {
    await open();
    expect(text()).toMatch(/Simulé\. Aucun moyen de paiement n’est relié/);
    press(/^Signature\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    expect(text()).toMatch(/À payer maintenant10 €/);
    expect(text()).toMatch(/Prochain débit, le 1er décembre 2026 ?49 €/);
    expect(text()).toMatch(/Ensuite49 € par mois/);
    expect(text()).toMatch(/s’active une fois le paiement vérifié, pas avant/);
  });

  it("a downgrade is planned for the end of the period, nothing due now", async () => {
    await open(
      memoryPlanChange({ start: { plan: "signature", cadence: "monthly" } }),
    );
    press(/^Core\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    expect(text()).toMatch(/À payer maintenant0 €/);
    expect(
      screen.getByRole("button", { name: "Programmer le passage à Core" }),
    ).toBeTruthy();
  });
});

describe("confirming", () => {
  it("a requested upgrade keeps her current rights until payment is verified", async () => {
    const server = await open();
    press(/^Signature\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    press(/Passer à Signature · 10\s€ maintenant/);
    await screen.findByText("Passage à Signature par mois demandé");
    expect(text()).toMatch(/tu restes en Core avec ses fonctions actuelles/);
    expect(server.pending?.status).toBe("requested");
  });

  it("changed in another tab: nothing asked, the fresh state shown", async () => {
    const server = await open();
    press(/^Signature\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    server.bump();
    press(/Passer à Signature/);
    await screen.findByText(/Ton abonnement a changé entre-temps/);
    expect(server.pending).toBeNull();
  });

  it("an expired quote is asked again", async () => {
    let clock = Date.parse("2026-11-15T12:00:00.000Z");
    const server = memoryPlanChange({ now: () => clock });
    await open(server);
    press(/^Signature\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    clock += 20 * 60_000;
    press(/Passer à Signature/);
    await screen.findByText(/Ce devis a expiré/);
    expect(server.pending).toBeNull();
  });

  it("a lost answer is resent with the same operation id: one request", async () => {
    const server = memoryPlanChange();
    let lose = true;
    const confirm = vi.fn<PlanChangeActions["confirm"]>(async (input) => {
      const result = await server.actions.confirm(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(server, { ...server.actions, confirm });
    press(/^Signature\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    press(/Passer à Signature/);
    await screen.findByText(/Pas de réponse/);
    press(/Passer à Signature/);
    await screen.findByText("Passage à Signature par mois demandé");
    expect(confirm.mock.calls[0]?.[0].operationId).toBe(
      confirm.mock.calls[1]?.[0].operationId,
    );
  });

  it("a planned change can be cancelled", async () => {
    const server = await open(
      memoryPlanChange({ start: { plan: "signature", cadence: "monthly" } }),
    );
    press(/^Core\s*par mois$/);
    await screen.findByRole("region", { name: "Devis" });
    press("Programmer le passage à Core");
    await screen.findByText(
      /Passage à Core par mois prévu le 1er décembre 2026/,
    );
    press("Annuler ce changement");
    await screen.findByRole("region", { name: "Formules" });
    expect(server.pending).toBeNull();
  });
});
