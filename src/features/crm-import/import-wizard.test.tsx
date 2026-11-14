// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CrmImportActions } from "./contract";
import { guessMapping, neutralizeCell, parseCsv, toCsv } from "./csv";
import { ImportWizard } from "./import-wizard";
import { memoryCrmImport, sampleCsv } from "./memory-actions";

// The import wizard against an in-memory server of the PROPOSED contract
// (docs/CRM_IMPORT_PROPOSAL.md). The real guarantees (canonical email,
// tenant isolation, row keys, batches) are the backend's.

afterEach(cleanup);

describe("the file's own rules", () => {
  it("reads BOM, quotes, doubled quotes, CRLF and either separator", () => {
    expect(
      parseCsv('﻿nom;email\r\n"Dupont; Lina";a@b.fr\r\n"Le ""Studio""";\r\n'),
    ).toEqual([
      ["nom", "email"],
      ["Dupont; Lina", "a@b.fr"],
      ['Le "Studio"', ""],
    ]);
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("a report never turns a cell into a formula", () => {
    expect(neutralizeCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(neutralizeCell("+33 6")).toBe("'+33 6");
    expect(neutralizeCell("Lina")).toBe("Lina");
    expect(toCsv([["=1;2"]])).toBe('﻿"\'=1;2"\r\n');
  });

  it("the header gives a first guess she can correct", () => {
    expect(
      guessMapping(["Prénom", "Nom", "Adresse e-mail", "Portable", "Notes"]),
    ).toEqual({
      0: "firstName",
      1: "lastName",
      2: "email",
      3: "phone",
      4: null,
    });
  });
});

const upload = async (content = sampleCsv, name = "clientes.csv") => {
  const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
  fireEvent.change(input, {
    target: { files: [new File([content], name, { type: "text/csv" })] },
  });
  await screen.findByRole("region", { name: "Colonnes" });
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const rowText = () =>
  screen
    .getAllByRole("listitem")
    .map((li) => li.textContent)
    .join("\n");

describe("the wizard", () => {
  it("the recipe's preview writes nothing and says each row's fate", async () => {
    const server = memoryCrmImport();
    render(<ImportWizard actions={server.actions} />);
    await upload();
    press("Voir l’aperçu");
    await screen.findByText(/Aperçu : rien n’est encore enregistré/);
    expect(server.created).toEqual([]);
    const text = rowText();
    expect(text).toMatch(/Lina MartinLigne 2Nouvelle/);
    expect(text).toMatch(
      /Ligne 3 · même e-mail qu’une ligne plus hautÀ examiner/,
    );
    expect(text).toMatch(
      /Sarah BenaliLigne 4 · téléphone seul, déjà utilisé : à examinerÀ examiner/,
    );
    expect(text).toMatch(/=Jeanne RouxLigne 5Nouvelle/);
    expect(text).toMatch(/Ligne 7 · e-mail invalideIgnorée/);
    expect(text).toMatch(
      /Maya LopezLigne 8 · cette cliente existe déjàDéjà là/,
    );
    expect(
      screen.getByRole("button", { name: "Importer 3 nouvelles fiches" }),
    ).toBeTruthy();
  });

  it("a contact created meanwhile becomes a row to examine; the report keeps every unimported row", async () => {
    const server = memoryCrmImport();
    render(<ImportWizard actions={server.actions} />);
    await upload();
    press("Voir l’aperçu");
    await screen.findByRole("button", { name: "Importer 3 nouvelles fiches" });
    server.addContact("ines@example.test");
    press("Importer 3 nouvelles fiches");
    await screen.findByText("Importation terminée");
    expect(server.created).toEqual(["Lina Martin", "=Jeanne Roux"]);
    expect(rowText()).toMatch(
      /Inès DupontLigne 6 · une fiche a été créée entre-temps/,
    );
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return "blob:report";
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    press("Télécharger les lignes à examiner");
    const report = await (blob as unknown as Blob).text();
    expect(report.split("\r\n").length).toBe(6); // header + 4 rows + final newline
    expect(report).toContain(
      '4;"téléphone seul, déjà utilisé : à examiner";Sarah;Benali;;0622222222',
    );
  });

  it("without an email or phone column, no preview is asked", async () => {
    const server = memoryCrmImport();
    const preview = vi.fn(server.actions.preview);
    render(<ImportWizard actions={{ ...server.actions, preview }} />);
    await upload("Prénom;Ville\nLina;Paris");
    expect(
      screen.getByText("Indique au moins la colonne e-mail ou téléphone."),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Voir l’aperçu",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(preview).not.toHaveBeenCalled();
  });

  it("a lost answer is resent with the same request id: imported once", async () => {
    const server = memoryCrmImport();
    let lose = true;
    const commit = vi.fn<CrmImportActions["commit"]>(async (input) => {
      const result = await server.actions.commit(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    render(<ImportWizard actions={{ ...server.actions, commit }} />);
    await upload();
    press("Voir l’aperçu");
    await screen.findByRole("button", { name: "Importer 3 nouvelles fiches" });
    press("Importer 3 nouvelles fiches");
    await screen.findByText(/Pas de réponse/);
    press("Importer 3 nouvelles fiches");
    await screen.findByText("Importation terminée");
    expect(commit.mock.calls[0]?.[0].requestId).toBe(
      commit.mock.calls[1]?.[0].requestId,
    );
    expect(server.created).toHaveLength(3);
  });

  it("an empty or header-only file is refused before any upload", async () => {
    const server = memoryCrmImport();
    const preview = vi.fn(server.actions.preview);
    render(<ImportWizard actions={{ ...server.actions, preview }} />);
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(input, {
      target: { files: [new File(["Nom;Email\n"], "vide.csv")] },
    });
    await screen.findByText(/ne contient pas de lignes lisibles/);
    expect(preview).not.toHaveBeenCalled();
  });
});
