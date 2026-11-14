import {
  importErrors,
  type CrmImportActions,
  type ImportMapping,
  type ImportPreviewDto,
  type ImportResult,
  type ImportRowDto,
} from "./contract";
import { parseCsv } from "./csv";

// An in-memory server of the PROPOSED import contract, for the preview and
// the tests only. Her existing clients are fictional; nothing is written
// anywhere but this memory.

const fail = (code: string): ImportResult<never> => ({
  ok: false,
  error: { code },
});

/** The recipe's file: rows 2/3 same email, 4 shared phone, 5 "=" name, 6 created meanwhile. */
export const sampleCsv = [
  "Prénom;Nom;E-mail;Téléphone",
  "Lina;Martin;contact-a@example.test;0611111111",
  "Lina;Martin;Contact-A@Example.test;0611111111",
  "Sarah;Benali;;0622222222",
  "=Jeanne;Roux;jeanne@example.test;",
  "Inès;Dupont;ines@example.test;0633333333",
  "Nora;Petit;nora@example;",
  "Maya;Lopez;maya@example.test;",
].join("\n");

export function memoryCrmImport(
  options: {
    delayMs?: number;
    existingEmails?: string[];
    existingPhones?: string[];
    maxBytes?: number;
  } = {},
) {
  const emails = new Set(
    (options.existingEmails ?? ["maya@example.test"]).map((e) =>
      e.toLowerCase(),
    ),
  );
  const phones = new Set(options.existingPhones ?? ["0622222222"]);
  const jobs = new Map<
    string,
    {
      version: string;
      content: string;
      mapping: ImportMapping;
      rows: ImportRowDto[];
    }
  >();
  const receipts = new Map<
    string,
    ImportResult<{
      status: "completed" | "completed_with_errors";
      rows: ImportRowDto[];
    }>
  >();
  let count = 0;
  const created: string[] = [];
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  function evaluate(content: string, mapping: ImportMapping): ImportRowDto[] {
    const [, ...rows] = parseCsv(content);
    const column = (field: string) =>
      Number(
        Object.entries(mapping).find(([, value]) => value === field)?.[0] ?? -1,
      );
    const seen = new Set<string>();
    return rows.map((cells, index) => {
      const value = (field: string) =>
        column(field) >= 0 ? (cells[column(field)] ?? "").trim() : "";
      const email = value("email").toLowerCase();
      const phone = value("phone").replace(/\s/g, "");
      const displayName =
        [value("firstName"), value("lastName")].filter(Boolean).join(" ") ||
        "(sans nom)";
      const row = (
        state: ImportRowDto["state"],
        reason: ImportRowDto["reason"],
      ): ImportRowDto => ({
        rowNumber: index + 2,
        state,
        reason,
        displayName,
      });
      if (!email && !phone) return row("invalid", "missing_contact");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return row("invalid", "invalid_email");
      if (email) {
        if (seen.has(email)) return row("conflict", "duplicate_in_file");
        seen.add(email);
        if (emails.has(email)) return row("unchanged", "existing_contact");
        return row("create", null);
      }
      // A phone alone never merges and never grants anything.
      if (phones.has(phone)) return row("conflict", "shared_phone");
      return row("create", null);
    });
  }

  const actions: CrmImportActions = {
    async preview({ content, mapping }) {
      await pause();
      if (content.length > (options.maxBytes ?? 2_000_000))
        return fail(importErrors.fileTooLarge);
      if (parseCsv(content).length < 2) return fail(importErrors.unreadable);
      const jobId = `job-${(count += 1)}`;
      const version = `map-${count}`;
      const rows = evaluate(content, mapping);
      jobs.set(jobId, { version, content, mapping, rows });
      const data: ImportPreviewDto = { jobId, mappingVersion: version, rows };
      return { ok: true, data };
    },
    async commit({ jobId, mappingVersion, requestId }) {
      await pause();
      const earlier = receipts.get(requestId);
      if (earlier) return earlier;
      const job = jobs.get(jobId);
      if (!job || job.version !== mappingVersion)
        return fail(importErrors.versionConflict);
      // Every row read again now: a contact created meanwhile is a conflict.
      const rows = job.rows.map((row): ImportRowDto => {
        if (row.state !== "create") return row;
        const [, ...lines] = parseCsv(job.content);
        const cells = lines[row.rowNumber - 2] ?? [];
        const emailColumn = Number(
          Object.entries(job.mapping).find(([, v]) => v === "email")?.[0] ?? -1,
        );
        const email = (cells[emailColumn] ?? "").trim().toLowerCase();
        if (email && emails.has(email))
          return { ...row, state: "conflict", reason: "contact_changed" };
        if (email) emails.add(email);
        created.push(row.displayName);
        return row;
      });
      const result = {
        ok: true as const,
        data: {
          status: rows.some(
            (r) => r.state === "conflict" || r.state === "invalid",
          )
            ? ("completed_with_errors" as const)
            : ("completed" as const),
          rows,
        },
      };
      receipts.set(requestId, result);
      return result;
    },
  };
  return {
    actions,
    created,
    /** Someone books with this email meanwhile (tests and preview only). */
    addContact(email: string) {
      emails.add(email.toLowerCase());
    },
  };
}
