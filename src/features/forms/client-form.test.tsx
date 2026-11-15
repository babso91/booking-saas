// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientForm, dayLabel } from "./client-form";
import type { ClientFormActions, FormFieldDto } from "./contract";
import {
  carryOver,
  checkTemplate,
  missingAnswers,
  pruneHidden,
  visibleFields,
} from "./engine";
import { memoryClientForm, sampleFields, sampleForm } from "./memory-actions";

// The client's form against an in-memory server of the PROPOSED contract
// (docs/CLIENT_FORMS_PROPOSAL.md). The real guarantees (Hub session,
// relation, hidden answers refused, server time) are the backend's.

afterEach(cleanup);

// The recipe's fixture.
const decoration: FormFieldDto[] = [
  { id: "q1", type: "boolean", required: true, label: "Décoration ?" },
  {
    id: "q2",
    type: "short_text",
    required: true,
    showIf: { field: "q1", equals: true },
    label: "Votre style",
  },
];

describe("the form's own rules", () => {
  it("q1 false and q2 absent is valid; q1 true and q2 absent misses q2", () => {
    expect(missingAnswers(decoration, { q1: false })).toEqual({});
    expect(Object.keys(missingAnswers(decoration, { q1: true }))).toEqual([
      "q2",
    ]);
  });

  it("an unknown or later condition, or a cycle, is refused", () => {
    expect(
      checkTemplate([
        { ...decoration[1]!, showIf: { field: "q9", equals: true } },
      ]),
    ).toHaveLength(1);
    // q1 depends on q2 and q2 on q1: q1's condition points after itself.
    expect(
      checkTemplate([
        { ...decoration[0]!, showIf: { field: "q2", equals: "x" } },
        decoration[1]!,
      ]),
    ).toHaveLength(1);
    expect(checkTemplate(decoration)).toEqual([]);
    expect(checkTemplate(sampleFields)).toEqual([]);
  });

  it("a hidden answer is never kept, even through a chain of conditions", () => {
    const chain: FormFieldDto[] = [
      ...decoration,
      {
        id: "q3",
        type: "short_text",
        required: false,
        showIf: { field: "q2", equals: "fleurs" },
        label: "Quelles fleurs ?",
      },
    ];
    const answers = { q1: false, q2: "fleurs", q3: "roses" };
    expect(pruneHidden(chain, answers)).toEqual({ q1: false });
    expect(visibleFields(chain, answers).map((f) => f.id)).toEqual(["q1"]);
  });

  it("a newer version keeps what still fits, never an attestation", () => {
    const newer: FormFieldDto[] = [
      {
        id: "q-eyes",
        type: "single_choice",
        label: "Vos yeux ?",
        required: true,
        options: [{ id: "no", label: "Non" }],
      },
      sampleFields[0]!,
      sampleFields[4]!,
    ];
    expect(
      carryOver(newer, {
        "q-eyes": "very",
        "q-lenses": true,
        "q-consent": true,
      }),
    ).toEqual({ "q-lenses": true });
  });

  it("French dates say 1er", () => {
    expect(dayLabel("2026-12-01T12:00:00.000Z")).toBe("1er décembre");
    expect(dayLabel("2026-11-20T12:00:00.000Z")).toBe("20 novembre");
  });
});

const open = async (
  server = memoryClientForm(),
  actions: ClientFormActions = server.actions,
) => {
  render(<ClientForm assignmentId="fa-1" actions={actions} />);
  await screen.findByRole("heading", { name: /Préparer votre rehaussement/ });
  return server;
};
const pick = (group: RegExp, label: string) => {
  const fieldset = screen.getByRole("group", { name: group });
  const input = [...fieldset.querySelectorAll("label")]
    .find((node) => node.textContent === label)!
    .querySelector("input")!;
  fireEvent.click(input);
};
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Envoyer mes réponses" }));
const fillAll = () => {
  pick(/lentilles/, "Non");
  pick(/sensibles/, "Un peu");
  fireEvent.click(screen.getByRole("checkbox"));
};

describe("filling it in", () => {
  it("a hidden question appears with its answer, and its answer is cleared when hidden", async () => {
    await open();
    expect(screen.queryByLabelText(/irrite/)).toBeNull();
    pick(/sensibles/, "Très");
    fireEvent.change(screen.getByLabelText(/irrite/), {
      target: { value: "Le mascara" },
    });
    pick(/sensibles/, "Non");
    expect(screen.queryByLabelText(/irrite/)).toBeNull();
    pick(/sensibles/, "Très");
    expect((screen.getByLabelText(/irrite/) as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("missing answers are said under each question, nothing is sent", async () => {
    const server = memoryClientForm();
    const submit = vi.fn(server.actions.submit);
    await open(server, { ...server.actions, submit });
    pick(/lentilles/, "Oui");
    send();
    expect(screen.getByText("Merci de choisir une réponse.")).toBeTruthy();
    expect(screen.getByText("Merci de confirmer pour continuer.")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "1 sur 3",
    );
  });

  it("sent: the attestation text shown is captured, the receipt says it is waiting for review", async () => {
    const server = memoryClientForm();
    const submit = vi.fn(server.actions.submit);
    await open(server, { ...server.actions, submit });
    fillAll();
    send();
    await screen.findByText("Réponses envoyées");
    expect(submit.mock.calls[0]?.[0].answers).toEqual([
      { fieldId: "q-lenses", value: false },
      { fieldId: "q-eyes", value: "little" },
      {
        fieldId: "q-consent",
        value: true,
        attestedText: sampleFields[4]!.attestationText,
      },
    ]);
    expect(server.form.status).toBe("submitted");
  });

  it("a lost answer is resent with the same request id: one receipt", async () => {
    const server = memoryClientForm();
    let lose = true;
    const submit = vi.fn<ClientFormActions["submit"]>(async (input) => {
      const result = await server.actions.submit(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(server, { ...server.actions, submit });
    fillAll();
    send();
    await screen.findByText(/Pas de réponse/);
    send();
    await screen.findByText("Réponses envoyées");
    expect(submit.mock.calls[0]?.[0].requestId).toBe(
      submit.mock.calls[1]?.[0].requestId,
    );
    expect(server.form.receipt?.receiptId).toBe("r-1");
  });

  it("a newer version: what still fits is kept, the attestation asked again", async () => {
    const server = memoryClientForm(undefined, {
      newerVersion: {
        templateVersionId: "tv-4",
        fields: [
          sampleFields[0]!,
          sampleFields[1]!,
          {
            ...sampleFields[4]!,
            attestationText: "J’ai lu les nouveaux conseils.",
          },
        ],
      },
    });
    await open(server);
    fillAll();
    send();
    await screen.findByText(/vient d’être mis à jour/);
    await screen.findByText("J’ai lu les nouveaux conseils.");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    send();
    await screen.findByText("Réponses envoyées");
    expect(server.form.templateVersionId).toBe("tv-4");
  });
});

describe("its states", () => {
  it.each([
    ["expired", "Ce formulaire a expiré"],
    ["revoked", "Ce formulaire n’est plus demandé"],
    ["completed", "C’est complet"],
  ] as const)("%s says so, with no form", async (status, title) => {
    await open(memoryClientForm(sampleForm({ status, canSubmit: false })));
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Envoyer/ })).toBeNull();
  });

  it("an unknown or foreign form says only that it is not available", async () => {
    render(
      <ClientForm assignmentId="other" actions={memoryClientForm().actions} />,
    );
    await screen.findByText("Ce formulaire n’est pas disponible");
  });

  it("expired while filling in: sending shows the expired state", async () => {
    const server = memoryClientForm();
    await open(server);
    fillAll();
    server.form.status = "expired";
    send();
    await waitFor(() =>
      expect(screen.getByText("Ce formulaire a expiré")).toBeTruthy(),
    );
  });

  it("answers are never written to the browser's storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await open();
    fillAll();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
