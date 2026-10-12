import { z } from "zod";

import { clientContactFields } from "@/features/crm/schemas/contact";

// Inputs of customer management and private notes. No business identifier
// is accepted: the tenant comes from the session (runBusinessAction). A
// request id, generated once per form by the UI, makes a creation
// idempotent; a version, as last read, guards every edit and deletion.

export const MAX_NOTES_PAGE = 100;
/** Characters of one note (as PostgreSQL counts them, at most). */
export const MAX_NOTE_LENGTH = 5000;

const versionSchema = z.number().int().min(1).max(2_147_483_647);

export const createClientSchema = z.object({
  ...clientContactFields,
  requestId: z.uuid(),
});

export type CreateClientInput = z.output<typeof createClientSchema>;

/** The whole identity and contact: an absent optional field is removed. */
export const updateClientSchema = z.object({
  clientId: z.uuid(),
  expectedVersion: versionSchema,
  ...clientContactFields,
});

export type UpdateClientInput = z.output<typeof updateClientSchema>;

/**
 * Unicode NFC, then trimmed (line breaks inside are kept), as the database
 * does.
 */
const noteContentSchema = z
  .string()
  .transform((value) => value.normalize("NFC").trim())
  .pipe(
    z
      .string()
      .min(1, "La note est vide.")
      .max(MAX_NOTE_LENGTH, `Note limitée à ${MAX_NOTE_LENGTH} caractères.`),
  );

export const listClientNotesSchema = z.object({
  clientId: z.uuid(),
  limit: z.number().int().min(1).max(MAX_NOTES_PAGE).default(20),
  cursor: z.string().min(1).max(1024).nullish(),
});

export type ListClientNotesInput = z.output<typeof listClientNotesSchema>;

export const createClientNoteSchema = z.object({
  clientId: z.uuid(),
  content: noteContentSchema,
  requestId: z.uuid(),
});

export type CreateClientNoteInput = z.output<typeof createClientNoteSchema>;

export const updateClientNoteSchema = z.object({
  clientId: z.uuid(),
  noteId: z.uuid(),
  expectedVersion: versionSchema,
  content: noteContentSchema,
});

export type UpdateClientNoteInput = z.output<typeof updateClientNoteSchema>;

export const deleteClientNoteSchema = z.object({
  clientId: z.uuid(),
  noteId: z.uuid(),
  expectedVersion: versionSchema,
});

export type DeleteClientNoteInput = z.output<typeof deleteClientNoteSchema>;
