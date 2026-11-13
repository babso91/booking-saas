// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisitNotesActions } from "./contract";
import { checkSheet, copyFrom, differences, draftOf } from "./draft";
import {
  memoryVisitNotes,
  sampleFields,
  samplePreparation,
} from "./memory-actions";
import { VisitSheet } from "./visit-sheet";

// The visit's technical sheet against an in-memory server of the PROPOSED
// contract (docs/CRM_VISIT_NOTES_PROPOSAL.md): what the screen shows, sends
// and keeps. The real guarantees (locks, tenant, history) are the backend's.

afterEach(cleanup);

const open = async (
  server = memoryVisitNotes(),
  actions: VisitNotesActions = server.actions,
) => {
  render(<VisitSheet appointmentId="a-visit" actions={actions} />);
  await screen.findByRole("heading", { name: "Préparer la visite" });
  return server;
};
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const sheet = () =>
  within(screen.getByRole("region", { name: "Fiche de cette visite" }));

describe("the draft's own rules", () => {
  it("an earlier sheet is copied for the fields that still exist; the others are named", () => {
    const { draft, removed } = copyFrom(
      samplePreparation().lastRecord!,
      sampleFields,
    );
    expect(draft.values).toEqual({ "f-length": "11", "f-curl": "CC" });
    expect(removed).toEqual(["Épaisseur"]);
  });

  it("a number must be one, a choice one of hers, a product named", () => {
    expect(
      checkSheet(
        {
          values: { "f-length": "onze", "f-curl": "Z" },
          products: [{ name: "", quantity: "2", unit: "ml" }],
        },
        sampleFields,
      ),
    ).toMatchObject({
      "f-length": expect.stringMatching(/nombre/),
      "f-curl": expect.stringMatching(/plus proposée/),
      "product:0": expect.stringMatching(/Nomme/),
    });
  });

  it("differences are the fields where hers and the saved one disagree", () => {
    const mine = { values: { "f-length": "12", "f-curl": "D" }, products: [] };
    const theirs = draftOf(
      {
        ...samplePreparation().lastRecord!,
        fieldValues: [
          { fieldId: "f-length", label: "Longueur", value: "12", unit: "mm" },
          { fieldId: "f-curl", label: "Courbure", value: "C", unit: null },
        ],
      },
      sampleFields,
    );
    expect(differences(mine, theirs, sampleFields)).toEqual([
      { fieldId: "f-curl", label: "Courbure", mine: "D", theirs: "C" },
    ]);
  });
});

describe("preparing the visit", () => {
  it("shows her preferences, the last sheet as it was written and the client's tags", async () => {
    await open();
    expect(screen.getByText(/Yeux sensibles : colle douce/)).toBeTruthy();
    expect(screen.getByText(/Dernière fiche · 14 octobre/)).toBeTruthy();
    // A field that no longer exists is still read on the old sheet.
    expect(screen.getByText("Épaisseur")).toBeTruthy();
    const tags = within(screen.getByRole("list", { name: "Étiquettes" }));
    expect(
      tags
        .getByRole("button", { name: "Yeux sensibles" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // Archived: kept on her history, not offered.
    expect(tags.getByText("Ancienne offre · archivée")).toBeTruthy();
    expect(tags.queryByRole("button", { name: /Ancienne offre/ })).toBeNull();
  });

  it("a tag is attached by its id, and shown from the server's answer", async () => {
    const server = await open();
    click("Fidèle");
    await waitFor(() =>
      expect(server.state.clientTagIds).toContain("t-regular"),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Fidèle" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("taking the last sheet's values over says where they come from and what was left out", async () => {
    await open();
    click("Reprendre ces valeurs");
    expect(
      (screen.getByLabelText("Longueur (mm)") as HTMLInputElement).value,
    ).toBe("11");
    expect(
      screen.getByText(
        /Valeurs reprises de la visite du 14 octobre\. Non repris, ces champs n’existent plus : Épaisseur\./,
      ),
    ).toBeTruthy();
  });
});

describe("this visit's sheet", () => {
  it("a draft is saved by version; validated, it is read-only and only corrected", async () => {
    const server = await open();
    type("Longueur (mm)", "12");
    click("CC");
    click("Ajouter un produit");
    type("Nom du produit 1", "Colle sensitive");
    click("Enregistrer le brouillon");
    await waitFor(() =>
      expect(server.state.current).toMatchObject({
        state: "draft",
        version: 1,
      }),
    );
    expect(server.state.current!.fieldValues).toEqual([
      { fieldId: "f-length", label: "Longueur", value: "12", unit: "mm" },
      { fieldId: "f-curl", label: "Courbure", value: "CC", unit: null },
    ]);

    click("Valider la fiche");
    await sheet().findByRole("button", { name: "Corriger cette fiche" });
    expect(server.state.current).toMatchObject({
      state: "recorded",
      supersedesId: null,
    });
    expect(screen.queryByLabelText("Longueur (mm)")).toBeNull();
    expect(sheet().getByText("12 mm")).toBeTruthy();
  });

  it("a correction is a new sheet that says what it replaces and why", async () => {
    const server = await open();
    type("Longueur (mm)", "12");
    click("Valider la fiche");
    await sheet().findByRole("button", { name: "Corriger cette fiche" });
    const first = server.state.current!.id;

    click("Corriger cette fiche");
    type("Longueur (mm)", "13");
    click("Valider la correction");
    expect(
      screen.getByText(/Dis en une phrase ce qui est corrigé/),
    ).toBeTruthy();
    type("Ce qui est corrigé", "Longueur notée par erreur");
    click("Valider la correction");
    await sheet().findByText(/Correction : Longueur notée par erreur/);
    expect(server.state.current).toMatchObject({
      state: "recorded",
      supersedesId: first,
      correctionReason: "Longueur notée par erreur",
    });
    expect(sheet().getByText("13 mm")).toBeTruthy();
  });

  it("what is not a number is said on its field, and nothing is sent", async () => {
    const server = await open();
    const save = vi.spyOn(server.actions, "saveDraft");
    type("Longueur (mm)", "douze");
    click("Enregistrer le brouillon");
    expect(screen.getByText(/Un nombre, par exemple/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("changed elsewhere: her text stays, the saved values are offered field by field", async () => {
    const server = await open();
    type("Longueur (mm)", "12");
    click("D");
    // Another device saved a draft meanwhile.
    server.state.current = {
      id: "n-elsewhere",
      version: 4,
      state: "draft",
      serviceName: "Pose volume",
      fieldValues: [
        { fieldId: "f-length", label: "Longueur", value: "10", unit: "mm" },
        { fieldId: "f-curl", label: "Courbure", value: "D", unit: null },
      ],
      products: [],
      recordedAt: null,
      supersedesId: null,
      correctionReason: null,
    };
    click("Enregistrer le brouillon");
    const diff = within(
      await screen.findByRole("group", {
        name: "Différences avec la fiche enregistrée",
      }),
    );
    // Only what differs; hers is still in the form.
    expect(diff.getByText(/toi : 12 · enregistré : 10/)).toBeTruthy();
    expect(diff.queryByText("Courbure")).toBeNull();
    expect(
      (screen.getByLabelText("Longueur (mm)") as HTMLInputElement).value,
    ).toBe("12");
    fireEvent.click(diff.getByRole("button", { name: "Prendre l’enregistré" }));
    expect(
      (screen.getByLabelText("Longueur (mm)") as HTMLInputElement).value,
    ).toBe("10");
    // Saved again on the version read: accepted.
    type("Observations", "Rendu naturel");
    click("Enregistrer le brouillon");
    await waitFor(() =>
      expect(server.state.current).toMatchObject({ version: 5 }),
    );
  });

  it("a lost answer is resent with the same request id", async () => {
    const server = memoryVisitNotes();
    const calls: string[] = [];
    let lose = true;
    const actions: VisitNotesActions = {
      ...server.actions,
      saveDraft: async (input) => {
        calls.push(input.requestId);
        if (lose) {
          lose = false;
          await server.actions.saveDraft(input);
          return { ok: false, error: { code: "network" } };
        }
        return server.actions.saveDraft(input);
      },
    };
    await open(server, actions);
    type("Longueur (mm)", "12");
    click("Enregistrer le brouillon");
    await screen.findByText("Pas de réponse");
    click("Enregistrer le brouillon");
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe(calls[0]);
    // Saved once: the replay answered the first save.
    await waitFor(() =>
      expect(server.state.current).toMatchObject({ version: 1 }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Pas de réponse")).toBeNull(),
    );
  });

  it("the visit changed of client: nothing is attached, and it is said", async () => {
    const server = memoryVisitNotes();
    await open(server, {
      ...server.actions,
      saveDraft: async () => ({
        ok: false,
        error: { code: "visit_client_changed" as never },
      }),
    });
    type("Longueur (mm)", "12");
    click("Enregistrer le brouillon");
    await screen.findByText("Ce rendez-vous a changé de cliente");
    expect(server.state.current).toBeNull();
  });

  it("a visit that cannot be read offers a retry", async () => {
    const server = memoryVisitNotes();
    let down = true;
    render(
      <VisitSheet
        appointmentId="a-visit"
        actions={{
          ...server.actions,
          preparation: async (id) =>
            down
              ? { ok: false, error: { code: "network" } }
              : server.actions.preparation(id),
        }}
      />,
    );
    await screen.findByText("La visite n’a pas pu être chargée");
    down = false;
    click("Réessayer");
    await screen.findByRole("heading", { name: "Préparer la visite" });
  });
});
