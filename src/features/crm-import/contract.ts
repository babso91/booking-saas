// Bringing her client list in (R3-03, import). PROPOSED contract
// (docs/CRM_IMPORT_PROPOSAL.md): no server serves it yet. The wizard takes
// its actions as a whole; only the design preview and the tests give it an
// in-memory server.
//
// The preview writes nothing. Confirming imports by row: each row is read
// again at commit, a phone number alone never merges, a duplicate is a
// conflict to look at, never a silent merge.

import type { ImportField } from "./csv";

export type ImportMapping = Record<number, ImportField | null>;

export type RowState = "create" | "unchanged" | "conflict" | "invalid";

export type ImportRowDto = {
  /** The line in her file (header is 1). */
  rowNumber: number;
  state: RowState;
  /** Stable reason, for conflict and invalid rows. */
  reason:
    | "duplicate_in_file"
    | "existing_contact"
    | "shared_phone"
    | "missing_contact"
    | "invalid_email"
    | "contact_changed"
    | null;
  displayName: string;
};

export type ImportPreviewDto = {
  jobId: string;
  /** Changes when she changes the mapping: the commit must name it. */
  mappingVersion: string;
  rows: ImportRowDto[];
};

export type ImportResultDto = {
  status: "completed" | "completed_with_errors";
  rows: ImportRowDto[];
};

export type ImportResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type CrmImportActions = {
  preview: (input: {
    fileName: string;
    content: string;
    mapping: ImportMapping;
  }) => Promise<ImportResult<ImportPreviewDto>>;
  commit: (input: {
    jobId: string;
    mappingVersion: string;
    requestId: string;
  }) => Promise<ImportResult<ImportResultDto>>;
};

export const importErrors = {
  versionConflict: "import_version_conflict",
  fileTooLarge: "file_too_large",
  unreadable: "file_unreadable",
} as const;

export const reasonLabels: Record<
  NonNullable<ImportRowDto["reason"]>,
  string
> = {
  duplicate_in_file: "même e-mail qu’une ligne plus haut",
  existing_contact: "cette cliente existe déjà",
  shared_phone: "téléphone seul, déjà utilisé : à examiner",
  missing_contact: "ni e-mail ni téléphone",
  invalid_email: "e-mail invalide",
  contact_changed: "une fiche a été créée entre-temps : à examiner",
};

export const stateLabels: Record<RowState, string> = {
  create: "Nouvelle",
  unchanged: "Déjà là",
  conflict: "À examiner",
  invalid: "Ignorée",
};
