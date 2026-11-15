import { z } from "zod";

// Inputs of the forms actions and Hub routes (docs/CLIENT_FORMS_CONTRACT.md).
// Only the envelope is checked here: PostgreSQL applies the template rules
// (private.form_check_draft) and the answer rules (client_hub_submit_form).

const draftVersion = z.number().int().min(1).max(2_147_483_647);

export const formDraftSchema = z.object({
  title: z.string().max(400),
  intro: z.string().max(4000),
  review: z.enum(["none", "professional"]),
  frequency: z.union([
    z.object({ kind: z.literal("every_appointment") }),
    z.object({
      kind: z.literal("reuse_completed_for_days"),
      days: z.number().int(),
    }),
  ]),
  fields: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
});

export const createTemplateSchema = z.object({
  requestId: z.uuid(),
  draft: formDraftSchema,
});

export const templateIdSchema = z.object({ templateId: z.uuid() });

export const saveDraftSchema = z.object({
  templateId: z.uuid(),
  expectedDraftVersion: draftVersion,
  requestId: z.uuid(),
  draft: formDraftSchema,
});

export const publishSchema = z.object({
  templateId: z.uuid(),
  expectedDraftVersion: draftVersion,
  requestId: z.uuid(),
});

export const visitSchema = z.object({ appointmentId: z.uuid() });

export const assignSchema = z.object({
  appointmentId: z.uuid(),
  templateVersionId: z.uuid(),
  requestId: z.uuid(),
});

export const assignmentChangeSchema = z.object({
  assignmentId: z.uuid(),
  expectedVersion: draftVersion,
  requestId: z.uuid(),
});

export const assignmentIdSchema = z.uuid();

export const submissionSchema = z.object({
  templateVersionId: z.uuid(),
  requestId: z.uuid(),
  answers: z
    .array(
      z.object({
        fieldId: z.string().min(1).max(64),
        value: z.union([z.string().max(2000), z.boolean()]),
        attestedText: z.string().max(4000).optional(),
      }),
    )
    .max(50),
});

export type CreateTemplateInput = z.output<typeof createTemplateSchema>;
export type SaveDraftInput = z.output<typeof saveDraftSchema>;
export type PublishInput = z.output<typeof publishSchema>;
export type AssignInput = z.output<typeof assignSchema>;
export type AssignmentChangeInput = z.output<typeof assignmentChangeSchema>;
export type SubmissionInput = z.output<typeof submissionSchema>;
