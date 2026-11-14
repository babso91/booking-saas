// The small CSV rules the import screen needs on its own: reading a file's
// header and rows to propose a column mapping, and writing a report she can
// download without any cell turning into a formula. The server parses the
// file again; nothing here decides what is imported.

/** RFC 4180-ish: quotes, doubled quotes, CRLF or LF, a leading BOM; ";" or ",". */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const separator =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

/** A cell a spreadsheet would run as a formula is written as text. */
export function neutralizeCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",;\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(rows: string[][]) {
  return `﻿${rows.map((row) => row.map(neutralizeCell).join(";")).join("\r\n")}\r\n`;
}

export type ImportField = "firstName" | "lastName" | "email" | "phone" | "tags";

export const fieldLabels: Record<ImportField, string> = {
  firstName: "Prénom",
  lastName: "Nom",
  email: "E-mail",
  phone: "Téléphone",
  tags: "Étiquettes",
};

/** A first guess from the header, which she checks and corrects. */
export function guessMapping(header: string[]) {
  const mapping: Record<number, ImportField | null> = {};
  const used = new Set<ImportField>();
  header.forEach((name, index) => {
    const key = name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .trim();
    const field: ImportField | null = /^(prenom|first ?name)$/.test(key)
      ? "firstName"
      : /^(nom|last ?name|nom de famille)$/.test(key)
        ? "lastName"
        : /mail/.test(key)
          ? "email"
          : /(tel|phone|mobile|portable)/.test(key)
            ? "phone"
            : /(tag|etiquette)/.test(key)
              ? "tags"
              : null;
    mapping[index] = field && !used.has(field) ? field : null;
    if (field) used.add(field);
  });
  return mapping;
}
