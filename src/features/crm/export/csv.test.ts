import { describe, expect, it } from "vitest";

import { csvCell, exportCsv, exportFileName } from "./csv";

// Points 146 and 182: the CSV she opens in her spreadsheet.

describe("csvCell", () => {
  it("quotes what would break a line or a column", () => {
    expect(csvCell("Durand")).toBe("Durand");
    expect(csvCell("Durand; fille")).toBe('"Durand; fille"');
    expect(csvCell('Dite "Lou"')).toBe('"Dite ""Lou"""');
    expect(csvCell("deux\nlignes")).toBe('"deux\nlignes"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });

  it("keeps a formula as text, never run by the spreadsheet", () => {
    expect(csvCell('=HYPERLINK("http://x","clic")')).toBe(
      `"'=HYPERLINK(""http://x"",""clic"")"`,
    );
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("-2+3+cmd|x")).toBe("'-2+3+cmd|x");
    expect(csvCell("\tA1")).toBe("'\tA1");
  });

  it("leaves a phone number or a negative number as it is", () => {
    expect(csvCell("+33 6 12 34 56 78")).toBe("+33 6 12 34 56 78");
    expect(csvCell("+33 (0)6.12.34.56.78")).toBe("+33 (0)6.12.34.56.78");
    expect(csvCell("06 12 34 56 78")).toBe("06 12 34 56 78");
    expect(csvCell("-12,50")).toBe("-12,50");
  });
});

describe("exportCsv", () => {
  it("writes her records for a French spreadsheet", () => {
    const csv = exportCsv({
      scope: "contacts",
      currency: "EUR",
      rows: [
        {
          firstName: "Emma",
          lastName: "Durand",
          email: "emma@client.test",
          phone: "06 12 34 56 78",
          createdOn: "2026-10-01",
          pastVisits: 3,
          lastVisitAt: "2026-11-02 10:30",
          nextVisitAt: null,
        },
      ],
    });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual([
      "Prénom;Nom;E-mail;Téléphone;Fiche créée le;Visites passées;Dernière visite;Prochain rendez-vous",
      "Emma;Durand;emma@client.test;06 12 34 56 78;2026-10-01;3;2026-11-02 10:30;",
      "",
    ]);
  });

  it("writes one line per visit, prices in her currency, statuses in words", () => {
    const csv = exportCsv({
      scope: "contacts_and_visits",
      currency: "EUR",
      rows: [
        {
          firstName: "Emma",
          lastName: "Durand",
          email: null,
          phone: null,
          visitAt: "2026-11-02 10:30",
          service: "Coupe",
          durationMinutes: 45,
          priceCents: 6550,
          status: "completed",
        },
        {
          firstName: "Zoé",
          lastName: null,
          email: "zoe@client.test",
          phone: null,
          visitAt: null,
          service: null,
          durationMinutes: null,
          priceCents: null,
          status: null,
        },
      ],
    });
    expect(csv.slice(1).split("\r\n")).toEqual([
      "Prénom;Nom;E-mail;Téléphone;Rendez-vous;Prestation;Durée (min);Prix (EUR);Statut",
      "Emma;Durand;;;2026-11-02 10:30;Coupe;45;65,50;Terminé",
      "Zoé;;zoe@client.test;;;;;;",
      "",
    ]);
  });

  it("names the file after what it holds", () => {
    expect(exportFileName("contacts", "atelier-nora", "2026-11-23")).toBe(
      "clientes-atelier-nora-2026-11-23.csv",
    );
    expect(
      exportFileName("contacts_and_visits", "atelier-nora", "2026-11-23"),
    ).toBe("clientes-et-visites-atelier-nora-2026-11-23.csv");
  });
});
