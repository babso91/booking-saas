// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisitFormsActions } from "./contract";
import { memoryVisitForms, sampleVisitForms } from "./memory-actions";
import { VisitForms } from "./visit-forms";

// The forms of a visit, pro side, against an in-memory server of the
// contract (docs/CLIENT_FORMS_CONTRACT.md, "Côté pro").

afterEach(cleanup);

const open = async (
  server = memoryVisitForms(),
  actions: VisitFormsActions = server.actions,
) => {
  render(<VisitForms appointmentId="a-visit" actions={actions} />);
  await screen.findByRole("heading", { name: "Formulaires" });
  return server;
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const text = () => document.body.textContent ?? "";

describe("reading the answers", () => {
  it("shows them as sent, with the attestation text the client saw, then marks them read", async () => {
    const server = await open();
    expect(text()).toMatch(/Reçu, à relire/);
    press("Lire les réponses");
    expect(text()).toMatch(/Portez-vous des lentilles de contact \?Oui/);
    expect(text()).toMatch(/Vos yeux sont-ils sensibles \?Très/);
    expect(text()).toMatch(/Le mascara waterproof/);
    expect(text()).toMatch(/Confirmé : « J’ai lu les conseils de préparation/);
    // A question never shown to her (no answer) is not listed.
    expect(text()).not.toMatch(/Un effet que vous aimeriez/);
    press("Marquer comme relu");
    await screen.findByText(/Relu le 15 novembre/);
    expect(server.state.assignments[0]?.status).toBe("completed");
  });

  it("changed meanwhile: said, and read again", async () => {
    const server = await open();
    server.state.assignments[0]!.version = 9;
    press("Lire les réponses");
    press("Marquer comme relu");
    await screen.findByText(/a changé entre-temps/);
  });
});

describe("sending and withdrawing", () => {
  it("a form is sent; the same one twice is refused by name", async () => {
    const server = await open();
    fireEvent.change(screen.getByLabelText("Envoyer un formulaire"), {
      target: { value: "tv-consent" },
    });
    press("Envoyer");
    await screen.findByText(/Lina le trouvera dans son espace/);
    expect(text()).toMatch(/Consentement photoVersion 1/);
    expect(server.state.assignments).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Envoyer un formulaire"), {
      target: { value: "tv-3" },
    });
    press("Envoyer");
    await screen.findByText(/déjà demandé à Lina/);
  });

  it("withdrawn while unanswered; if she has just answered, it says so", async () => {
    const start = sampleVisitForms();
    start.assignments.push({
      ...start.assignments[0]!,
      assignmentId: "fa-2",
      status: "assigned",
      submission: null,
      version: 1,
    });
    const server = await open(memoryVisitForms({ start }));
    press("Annuler la demande");
    server.clientSubmits("fa-2");
    // The panel still holds the old version: the server refuses.
    const confirm = screen.getAllByRole("button", {
      name: "Annuler la demande",
    });
    fireEvent.click(confirm[confirm.length - 1]!);
    await screen.findByText(/a changé entre-temps|vient de répondre/);
    expect(server.state.assignments[1]?.status).toBe("submitted");
  });

  it("a lost answer is resent with the same request id: one form sent", async () => {
    const server = memoryVisitForms();
    let lose = true;
    const assign = vi.fn<VisitFormsActions["assign"]>(async (input) => {
      const result = await server.actions.assign(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(server, { ...server.actions, assign });
    fireEvent.change(screen.getByLabelText("Envoyer un formulaire"), {
      target: { value: "tv-consent" },
    });
    press("Envoyer");
    await screen.findByText(/Pas de réponse/);
    press("Envoyer");
    await screen.findByText(/Lina le trouvera/);
    expect(assign.mock.calls[0]?.[0].requestId).toBe(
      assign.mock.calls[1]?.[0].requestId,
    );
    expect(server.state.assignments).toHaveLength(2);
  });
});
