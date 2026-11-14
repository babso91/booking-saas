// Taking her client file out (R3-03, export). PROPOSED contract
// (docs/CRM_EXPORT_PROPOSAL.md): no server serves it yet. The screen takes
// its actions as a whole; only the design preview and the tests give it
// an in-memory server.
//
// An export is a private file prepared on request, for the owner only,
// available for a short time; every download checks her role and scope
// again, and is recorded without its content.

export type ExportScope = "contacts" | "contacts_and_visits";

export type ExportJobDto = {
  jobId: string;
  scope: ExportScope;
  status: "requested" | "ready" | "expired" | "revoked" | "failed";
  requestedAt: string;
  expiresAt: string | null;
  rowCount: number | null;
};

export type ExportResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type CrmExportActions = {
  list: () => Promise<ExportResult<ExportJobDto[]>>;
  request: (input: {
    scope: ExportScope;
    requestId: string;
  }) => Promise<ExportResult<ExportJobDto>>;
  /** A short-lived private link, asked only when she clicks. */
  download: (jobId: string) => Promise<ExportResult<{ url: string }>>;
  revoke: (jobId: string) => Promise<ExportResult<ExportJobDto>>;
};

export const exportErrors = {
  expired: "export_expired",
  permissionDenied: "permission_denied",
  inProgress: "export_in_progress",
} as const;

export const scopeLabels: Record<ExportScope, string> = {
  contacts: "Fiches clientes (nom, e-mail, téléphone, étiquettes)",
  contacts_and_visits: "Fiches clientes et historique des visites",
};
