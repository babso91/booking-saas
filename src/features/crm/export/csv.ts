// The CSV of her client file (points 146 and 182): opened as is by a
// French spreadsheet (semicolons, UTF-8 with BOM), and safe to open: a cell
// a spreadsheet could run as a formula is kept as text (a leading quote).
// A phone number such as "+33 6 12 34 56 78" or a negative number runs
// nothing and stays as it is. Pure: no I/O.

import type { ExportRows } from "./model";

const BOM = "\uFEFF";
const SEPARATOR = ";";

const statusLabels: Record<string, string> = {
  upcoming: "À venir",
  past: "Passé",
  completed: "Terminé",
  cancelled: "Annulé",
  no_show: "Absente",
};

/** One cell: neutralized, then quoted when it needs to be. */
export function csvCell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  const formula =
    /^[=@\t\r]/.test(text) || /^[+-](?![\d\s().,/+-]*$)/.test(text);
  if (formula) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (cells: (string | number | null | undefined)[]) =>
  cells.map(csvCell).join(SEPARATOR);

/** "65,00": the price as a French spreadsheet reads a number. */
const amount = (cents: number | null) =>
  cents === null ? null : (cents / 100).toFixed(2).replace(".", ",");

export function exportCsv(file: ExportRows) {
  const lines =
    file.scope === "contacts"
      ? [
          line([
            "Prénom",
            "Nom",
            "E-mail",
            "Téléphone",
            "Fiche créée le",
            "Visites passées",
            "Dernière visite",
            "Prochain rendez-vous",
          ]),
          ...file.rows.map((row) =>
            line([
              row.firstName,
              row.lastName,
              row.email,
              row.phone,
              row.createdOn,
              row.pastVisits,
              row.lastVisitAt,
              row.nextVisitAt,
            ]),
          ),
        ]
      : [
          line([
            "Prénom",
            "Nom",
            "E-mail",
            "Téléphone",
            "Rendez-vous",
            "Prestation",
            "Durée (min)",
            `Prix (${file.currency})`,
            "Statut",
          ]),
          ...file.rows.map((row) =>
            line([
              row.firstName,
              row.lastName,
              row.email,
              row.phone,
              row.visitAt,
              row.service,
              row.durationMinutes,
              amount(row.priceCents),
              row.status ? (statusLabels[row.status] ?? row.status) : null,
            ]),
          ),
        ];
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** "clientes-atelier-nora-2026-11-23.csv". */
export function exportFileName(
  scope: ExportRows["scope"],
  slug: string,
  date: string,
) {
  const what = scope === "contacts" ? "clientes" : "clientes-et-visites";
  return `${what}-${slug}-${date}.csv`;
}
