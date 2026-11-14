// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignPlanner, CampaignStatus } from "./campaign-planner";
import { smsUnits, type CampaignActions, type CampaignDto } from "./contract";
import { memoryCampaigns, sampleClients } from "./memory-actions";

// Campaigns against an in-memory server of the PROPOSED contract
// (docs/GROWTH_CAMPAIGNS_PROPOSAL.md). Nothing is ever sent: the real
// guarantees (consent lock, budget, delivery keys) are the backend's.

afterEach(cleanup);

const services = [
  { id: "s-gel", name: "Remplissage gel" },
  { id: "s-lift", name: "Rehaussement de cils" },
];

const plan = (
  server = memoryCampaigns(),
  actions: CampaignActions = server.actions,
  onScheduled = vi.fn(),
) => {
  render(
    <CampaignPlanner
      services={services}
      actions={actions}
      onScheduled={onScheduled}
    />,
  );
  return { server, onScheduled };
};
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const estimated = () =>
  within(screen.getByRole("region", { name: "Estimation" }));

describe("the audience", () => {
  it("the recipe: of C1..C4, only C2 passes; the others are counted by reason", async () => {
    plan(memoryCampaigns({ clients: sampleClients().slice(0, 4) }));
    fireEvent.click(
      screen.getByLabelText("Recontacter les clientes inactives"),
    );
    click("Estimer l’audience");
    const box = await screen.findByRole("region", { name: "Estimation" });
    expect(box.textContent).toMatch(
      /^1Estimation valable jusqu’à 11:30cliente recevrait/,
    );
    expect(box.textContent).toMatch(
      /cliente recevrait ce message, sur 3 qui correspondent/,
    );
    expect(box.textContent).toMatch(/n’ont pas accepté ce type de message1/);
    expect(box.textContent).toMatch(/dernière visite annulée ou manquée1/);
  });

  it("the simulated panel is always shown, and no name appears in an estimate", async () => {
    plan();
    expect(screen.getByText("Simulé.")).toBeTruthy();
    click("Estimer l’audience");
    await screen.findByRole("region", { name: "Estimation" });
    expect(document.body.textContent).not.toMatch(/\bc\d+\b/);
  });

  it("a rebooking needs a service; a change after the estimate discards it", async () => {
    plan();
    fireEvent.click(screen.getByLabelText("Remplissage gel"));
    click("Estimer l’audience");
    expect(screen.getByText("Choisis au moins une prestation.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remplissage gel"));
    click("Estimer l’audience");
    await screen.findByRole("region", { name: "Estimation" });
    click("E-mail");
    expect(screen.queryByRole("region", { name: "Estimation" })).toBeNull();
  });

  it("SMS units follow the message length and alphabet", () => {
    expect(smsUnits("a".repeat(160))).toBe(1);
    expect(smsUnits("a".repeat(161))).toBe(2);
    expect(smsUnits("Bonjour 😊")).toBe(1);
    expect(smsUnits("😊".repeat(40))).toBe(2);
  });
});

describe("scheduling", () => {
  it("confirmed with her ceiling, scheduled once", async () => {
    const { server, onScheduled } = plan();
    click("Estimer l’audience");
    await screen.findByRole("region", { name: "Estimation" });
    fireEvent.change(estimated().getByLabelText(/Plafond d’envois/), {
      target: { value: "5" },
    });
    click("Planifier…");
    expect(screen.getByText(/Au plus 5 SMS/)).toBeTruthy();
    click("Planifier");
    await vi.waitFor(() => expect(onScheduled).toHaveBeenCalledTimes(1));
    expect(onScheduled.mock.calls[0]?.[0]).toMatchObject({
      maxUnits: 5,
      state: "scheduled",
      simulated: true,
    });
    expect(server.budget).toBe(495);
  });

  it("a stale estimate: nothing scheduled, the figures are shown again", async () => {
    const server = memoryCampaigns();
    const { onScheduled } = plan(server);
    click("Estimer l’audience");
    await screen.findByRole("region", { name: "Estimation" });
    server.staleEstimates();
    click("Planifier…");
    click("Planifier");
    await screen.findByText(/L’audience a changé depuis l’estimation/);
    expect(onScheduled).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Estimation" })).toBeTruthy();
  });

  it("above the remaining budget: refused by name", async () => {
    plan(memoryCampaigns({ budgetUnits: 3 }));
    click("Estimer l’audience");
    await screen.findByRole("region", { name: "Estimation" });
    fireEvent.change(estimated().getByLabelText(/Plafond d’envois/), {
      target: { value: "10" },
    });
    click("Planifier…");
    click("Planifier");
    await screen.findByText(/dépasse ton budget d’envois restant/);
  });

  it("a lost answer is resent with the same request id: one campaign", async () => {
    const server = memoryCampaigns();
    let lose = true;
    const schedule = vi.fn<CampaignActions["schedule"]>(async (input) => {
      const result = await server.actions.schedule(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    const { onScheduled } = plan(server, { ...server.actions, schedule });
    click("Estimer l’audience");
    await screen.findByRole("region", { name: "Estimation" });
    click("Planifier…");
    click("Planifier");
    await screen.findByText(/Pas de réponse/);
    click("Planifier…");
    click("Planifier");
    await vi.waitFor(() => expect(onScheduled).toHaveBeenCalledTimes(1));
    expect(schedule.mock.calls[0]?.[0].requestId).toBe(
      schedule.mock.calls[1]?.[0].requestId,
    );
    expect(onScheduled.mock.calls[0]?.[0].campaignId).toBe("camp-1");
  });
});

describe("the follow-up", () => {
  const scheduled = async () => {
    const server = memoryCampaigns();
    const estimate = await server.actions.estimate({
      criteria: { kind: "reactivation", inactiveDays: 30 },
      channel: "sms",
      message: "Bonjour",
    });
    if (!estimate.ok) throw new Error("estimate");
    const campaign = await server.actions.schedule({
      estimateId: estimate.data.estimateId,
      maxUnits: 50,
      requestId: "r1",
    });
    return { server, campaign: (campaign as { data: CampaignDto }).data };
  };

  it("a pause says what stays waiting and what may still arrive", async () => {
    const { server, campaign } = await scheduled();
    server.advance(campaign.campaignId);
    render(
      <CampaignStatus
        campaignId={campaign.campaignId}
        actions={server.actions}
      />,
    );
    await screen.findByRole("region", { name: "Suivi de la relance" });
    expect(
      screen.getByText(/messages en attente ne partiront pas/),
    ).toBeTruthy();
    expect(
      screen.getByText(/déjà remis peu(t|vent) encore arriver/),
    ).toBeTruthy();
    expect(screen.getByText(/envoi incertain/)).toBeTruthy();
    expect(
      screen.getByText(/ne prouve pas que la relance les a causées/),
    ).toBeTruthy();
    click("Mettre en pause");
    await screen.findByText("En pause");
    click("Annuler la relance…");
    click("Confirmer l’annulation");
    await screen.findByText("Annulée");
  });

  it("moved on meanwhile: said, and read again", async () => {
    const { server, campaign } = await scheduled();
    render(
      <CampaignStatus
        campaignId={campaign.campaignId}
        actions={server.actions}
      />,
    );
    await screen.findByText("Planifiée");
    server.advance(campaign.campaignId);
    click("Mettre en pause");
    await screen.findByText(/La campagne a avancé entre-temps/);
    await screen.findByText("En cours");
  });
});
