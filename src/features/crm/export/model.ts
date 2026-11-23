import { z } from "zod";

// Her client file taken out (points 146 and 182). The job shape is the one
// the export screen of PR #74 reads (ExportJobDto, CrmExportActions).
// Contract: docs/CRM_EXPORT_CONTRACT.md.

export const exportScopeSchema = z.enum(["contacts", "contacts_and_visits"]);
export type ExportScope = z.infer<typeof exportScopeSchema>;

export const exportJobSchema = z.object({
  jobId: z.uuid(),
  scope: exportScopeSchema,
  status: z.enum(["requested", "ready", "expired", "revoked", "failed"]),
  requestedAt: z.string(),
  expiresAt: z.string().nullable(),
  rowCount: z.number().int().nullable(),
});
export type ExportJobDto = z.infer<typeof exportJobSchema>;

const contact = {
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
};

export const exportRowsSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("contacts"),
    currency: z.string(),
    rows: z.array(
      z.object({
        ...contact,
        createdOn: z.string(),
        pastVisits: z.number().int(),
        lastVisitAt: z.string().nullable(),
        nextVisitAt: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    scope: z.literal("contacts_and_visits"),
    currency: z.string(),
    rows: z.array(
      z.object({
        ...contact,
        visitAt: z.string().nullable(),
        service: z.string().nullable(),
        durationMinutes: z.number().int().nullable(),
        priceCents: z.number().int().nullable(),
        status: z.string().nullable(),
      }),
    ),
  }),
]);
export type ExportRows = z.infer<typeof exportRowsSchema>;
