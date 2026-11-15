// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormEditorActions } from "./contract";
import { dependentsOf, draftProblems, move, newField } from "./draft";
import { FormEditor } from "./form-editor";
import { memoryFormEditor, sampleTemplate } from "./memory-editor";

// The template editor against an in-memory server of the PROPOSED contract
// (docs/CLIENT_FORMS_PROPOSAL.md, "Éditeur"). The real guarantees (frozen
// versions, canonical hash, tenant) are the backend's.

afterEach(cleanup);

const open = async (
  server = memoryFormEditor(),
  actions: FormEditorActions = server.actions,
) => {
  render(
    <FormEditor
      templateId="ft-lift"
      businessName="Atelier Maëlys"
      actions={actions}
    />,
  );
  await screen.findByRole("heading", { name: /Préparer votre rehaussement/ });
  return server;
};
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const question = (n: number) => within(screen.getAllByRole("listitem")[n - 1]!);

describe("the draft's own rules", () => {
  it("moves clamp at both ends", () => {
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  it("a publication needs a title, labelled questions and distinct choices", () => {
    const choice = newField("single_choice");
    const problems = draftProblems({
      ...sampleTemplate().draft,
      title: " ",
      fields: [choice],
    });
    expect(problems._title).toMatch(/titre/);
    expect(problems[choice.id]).toMatch(/Écris la question/);
    expect(
      draftProblems({
        ...sampleTemplate().draft,
        fields: [
          {
            ...choice,
            label: "Q",
            options: [
              { id: "a", label: "Oui" },
              { id: "b", label: "Oui" },
            ],
          },
        ],
      })[choice.id],
    ).toMatch(/même libellé/);
    expect(draftProblems(sampleTemplate().draft)).toEqual({});
  });

  it("the questions depending on one are found", () => {
    expect(
      dependentsOf(sampleTemplate().draft.fields, "q-eyes").map((f) => f.id),
    ).toEqual(["q-eyes-detail"]);
  });
});

describe("editing", () => {
  it("moving a question with the keyboard: announced, focus kept on the arrow", async () => {
    await open();
    const down = question(1).getByRole("button", {
      name: "Descendre la question 1",
    });
    down.focus();
    fireEvent.click(down);
    expect(
      screen.getByText(
        /« Portez-vous des lentilles de contact \? » est maintenant la question 2 sur 5/,
      ),
    ).toBeTruthy();
    expect(question(2).getByText(/Question 2 · Oui \/ non/)).toBeTruthy();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Descendre la question 2",
    );
  });

  it("moving a condition above its question is said, and blocks publication", async () => {
    await open();
    // "Qu'est-ce qui les irrite" (3) depends on "Vos yeux" (2).
    click("Monter la question 3");
    click("Enregistrer le brouillon");
    await screen.findByText("Brouillon enregistré.");
    click("Publier…");
    expect(question(2).getByText(/placée avant celle-ci/)).toBeTruthy();
    expect(screen.queryByText(/Publier la version 4 \?/)).toBeNull();
  });

  it("a question others depend on cannot be removed until their condition changes", async () => {
    await open();
    click("Retirer la question 2");
    expect(question(2).getByText(/dépend de cette question/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("a new question gets the focus, then needs a label to publish", async () => {
    await open();
    click("Texte court");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect((document.activeElement as HTMLInputElement).name).toMatch(
      /^label-q-/,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });
});

describe("saving and publishing", () => {
  it("publish is offered only once saved, confirmed, and freezes the next version", async () => {
    const server = await open();
    fireEvent.change(screen.getByLabelText("Titre vu par tes clientes"), {
      target: { value: "Avant vos cils" },
    });
    expect(
      (screen.getByRole("button", { name: "Publier…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    click("Enregistrer le brouillon");
    await screen.findByText("Brouillon enregistré.");
    click("Publier…");
    expect(screen.getByText(/Publier la version 4 \?/)).toBeTruthy();
    click("Publier la version 4");
    await screen.findByText(/Version 4 publiée\. Les formulaires/);
    expect(server.template.published[0]).toMatchObject({ number: 4 });
    expect(server.template.draft.title).toBe("Avant vos cils");
  });

  it("saved elsewhere: her version stays, she chooses which to keep", async () => {
    const server = await open();
    fireEvent.change(screen.getByLabelText("Titre vu par tes clientes"), {
      target: { value: "Le mien" },
    });
    server.touch((t) => ({
      ...t,
      draftVersion: t.draftVersion + 1,
      draft: { ...t.draft, title: "Le leur" },
    }));
    click("Enregistrer le brouillon");
    await screen.findByText(/enregistré ailleurs/);
    expect(
      (screen.getByLabelText("Titre vu par tes clientes") as HTMLInputElement)
        .value,
    ).toBe("Le mien");
    fireEvent.click(
      await screen.findByRole("button", { name: "Garder ma version" }),
    );
    await screen.findByText("Brouillon enregistré.");
    expect(server.template.draft.title).toBe("Le mien");
  });

  it("a lost answer is resent with the same request id", async () => {
    const server = memoryFormEditor();
    let lose = true;
    const saveDraft = vi.fn<FormEditorActions["saveDraft"]>(async (input) => {
      const result = await server.actions.saveDraft(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(server, { ...server.actions, saveDraft });
    fireEvent.change(screen.getByLabelText("Titre vu par tes clientes"), {
      target: { value: "Encore" },
    });
    click("Enregistrer le brouillon");
    await screen.findByText(/Pas de réponse/);
    click("Enregistrer le brouillon");
    await screen.findByText("Brouillon enregistré.");
    expect(saveDraft.mock.calls[0]?.[0].requestId).toBe(
      saveDraft.mock.calls[1]?.[0].requestId,
    );
    expect(server.template.draftVersion).toBe(5);
  });
});

describe("the client's preview", () => {
  it("shows the draft as the client will see it, and never sends", async () => {
    const server = memoryFormEditor();
    await open(server);
    click("Aperçu cliente");
    await screen.findByText(/c’est ce que verra ta cliente/);
    expect(screen.queryByRole("button", { name: /Envoyer/ })).toBeNull();
    expect(screen.getByText("Atelier Maëlys")).toBeTruthy();
  });
});
