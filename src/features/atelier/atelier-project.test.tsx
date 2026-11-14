// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AtelierProject } from "./atelier-project";
import type { AtelierActions } from "./contract";
import { memoryAtelier, sampleAtelier } from "./memory-actions";

// The Atelier order, pro side, against an in-memory server of the PROPOSED
// contract (docs/ATELIER_PROPOSAL.md). Nothing is billed or published.

afterEach(cleanup);

const open = async (
  server = memoryAtelier(),
  actions: AtelierActions = server.actions,
) => {
  render(<AtelierProject orderId="AT1" actions={actions} />);
  await screen.findByRole("heading", { name: "Création de ton site" });
  return server;
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const text = () => document.body.textContent ?? "";

describe("the order", () => {
  it("the recipe: quote v2, two corrections included, proposal made on draft 12", async () => {
    await open();
    expect(text()).toMatch(/Devis v2149\s?€/);
    expect(text()).toMatch(/2 corrections incluses · 2 restantes/);
    expect(text()).toMatch(/Aucun paiement depuis cette page/);
    expect(text()).toMatch(/faite sur ton brouillon n° 12/);
  });

  it("an expired access shows nothing of the project", async () => {
    render(
      <AtelierProject
        orderId="AT1"
        actions={memoryAtelier({ expired: true }).actions}
      />,
    );
    await screen.findByText("Cet accès a expiré");
    expect(text()).not.toMatch(/Univers Alma/);
  });
});

describe("corrections", () => {
  it("a retried correction counts once", async () => {
    const server = memoryAtelier();
    let lose = true;
    const requestCorrection = vi.fn<AtelierActions["requestCorrection"]>(
      async (input) => {
        const result = await server.actions.requestCorrection(input);
        if (lose) {
          lose = false;
          return { ok: false, error: { code: "network" } };
        }
        return result;
      },
    );
    await open(server, { ...server.actions, requestCorrection });
    press("Demander une correction");
    fireEvent.change(screen.getByLabelText("Ce qu’il faut corriger"), {
      target: { value: "Photo d’accueil plus claire" },
    });
    press("Demander la correction");
    await screen.findByText(/Pas de réponse/);
    press("Demander la correction");
    await screen.findByText(/Correction demandée\. L’atelier/);
    expect(requestCorrection.mock.calls[0]?.[0].requestId).toBe(
      requestCorrection.mock.calls[1]?.[0].requestId,
    );
    expect(server.view.order.correctionsUsed).toBe(1);
    expect(text()).toMatch(/1 restante/);
  });

  it("outside the quote: a separate quote, nothing counted or billed", async () => {
    const server = await open();
    press("Demander une correction");
    fireEvent.change(screen.getByLabelText("Ce qu’il faut corriger"), {
      target: { value: "Ajouter une boutique" },
    });
    press("Demander la correction");
    await screen.findByText(/dépasse ce qui est prévu au devis/);
    expect(server.view.order.correctionsUsed).toBe(0);
  });

  it("none left: the button is off and the reason said", async () => {
    const start = sampleAtelier();
    start.order.correctionsUsed = 2;
    await open(memoryAtelier({ start }));
    expect(text()).toMatch(/toutes utilisées/);
    expect(
      (
        screen.getByRole("button", {
          name: "Demander une correction",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("applying", () => {
  it("applied to her draft, never published", async () => {
    const server = await open();
    press("Appliquer à mon brouillon");
    await screen.findByText(/Rien n’est publié/);
    expect(server.view.currentDraftRevision).toBe(13);
    expect(server.view.proposals[0]?.state).toBe("applied");
  });

  it("her draft moved on (revision 13): nothing overwritten, she chooses", async () => {
    const server = await open();
    server.editDraft();
    press("Appliquer à mon brouillon");
    await screen.findByText(
      /Ton brouillon a changé depuis cette proposition \(il est au n° 13/,
    );
    expect(server.view.currentDraftRevision).toBe(13);
    expect(server.view.proposals[0]?.state).toBe("submitted");
    press("Demander une reprise sur mon brouillon");
    await screen.findByText(/ne compte pas comme une correction/);
    expect(server.view.order.correctionsUsed).toBe(0);
  });
});
