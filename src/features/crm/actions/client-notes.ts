"use server";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  createClientNote,
  deleteClientNote,
  listClientNotes,
  updateClientNote,
} from "@/features/crm/data/client-notes";
import {
  createClientNoteSchema,
  deleteClientNoteSchema,
  listClientNotesSchema,
  updateClientNoteSchema,
} from "@/features/crm/schemas/client-management";

// Official server interface of private customer notes (professionals of
// the business only). Every action resolves the business from the session
// (runBusinessAction), validates its input and returns an ActionResult with
// a stable error code. Contract: docs/CRM_CLIENT_MANAGEMENT.md.

/** One page of a customer's notes, newest first, and the legacy notes. */
export async function listClientNotesAction(input: unknown) {
  return runBusinessAction(
    listClientNotesSchema,
    input,
    ({ client, businessId }, data) =>
      listClientNotes(client, { businessId }, data),
  );
}

/** Writes a note. Idempotent by `requestId` (one per form). */
export async function createClientNoteAction(input: unknown) {
  return runBusinessAction(
    createClientNoteSchema,
    input,
    ({ client, businessId }, data) =>
      createClientNote(client, { businessId }, data),
  );
}

/** Replaces a note's content, based on `expectedVersion` (`stale_note`). */
export async function updateClientNoteAction(input: unknown) {
  return runBusinessAction(
    updateClientNoteSchema,
    input,
    ({ client, businessId }, data) =>
      updateClientNote(client, { businessId }, data),
  );
}

/**
 * Deletes a note, based on `expectedVersion` (`stale_note`). Deleting a
 * note that is not there (already deleted) answers `deleted: false`.
 */
export async function deleteClientNoteAction(input: unknown) {
  return runBusinessAction(
    deleteClientNoteSchema,
    input,
    ({ client, businessId }, data) =>
      deleteClientNote(client, { businessId }, data),
  );
}
