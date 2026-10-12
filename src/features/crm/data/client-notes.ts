import "server-only";

import { z } from "zod";

import { writeException } from "@/features/crm/data/client-management";
import {
  decodeNotesCursor,
  encodeNotesCursor,
} from "@/features/crm/data/cursor";
import type { CrmContext } from "@/features/crm/data/directory";
import { businessInstants } from "@/features/crm/data/instants";
import type {
  CreateClientNoteInput,
  DeleteClientNoteInput,
  ListClientNotesInput,
  UpdateClientNoteInput,
} from "@/features/crm/schemas/client-management";
import type {
  ClientNoteDto,
  ClientNotesPageDto,
  CreateClientNoteResultDto,
  DeleteClientNoteResultDto,
  UpdateClientNoteResultDto,
} from "@/features/crm/types";
import { AppException, appErrorMessages } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Private dated notes about a customer (public.client_notes), under the
// user's session (RLS: members of the business only). Every write is one
// SQL function call (public.crm_*_client_note): idempotent creation, edits
// and deletions guarded by the version the professional read. Not part of
// the relationship timeline yet (docs/CRM_CLIENT_MANAGEMENT.md).

const instant = z.string();

const noteSchema = z.object({
  id: z.uuid(),
  content: z.string(),
  version: z.number().int().min(1),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: instant,
  updatedAt: instant,
});

const pageSchema = z.object({
  legacyNotes: z.string().nullable(),
  notes: z.array(noteSchema),
});

type NoteRow = z.output<typeof noteSchema>;

function toNote(
  clientId: string,
  row: NoteRow,
  at: Awaited<ReturnType<typeof businessInstants>>["at"],
): ClientNoteDto {
  return {
    id: row.id,
    clientId,
    content: row.content,
    version: row.version,
    edited: row.version > 1,
    createdAt: at(row.createdAt),
    updatedAt: at(row.updatedAt),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

/** One page of a customer's notes, newest first. */
export async function listClientNotes(
  client: AppSupabaseClient,
  context: CrmContext,
  input: ListClientNotesInput,
): Promise<ClientNotesPageDto> {
  const before = input.cursor
    ? decodeNotesCursor(input.cursor, input.clientId)
    : null;

  const { data, error } = await client.rpc("crm_list_client_notes", {
    p_business_id: context.businessId,
    p_client_id: input.clientId,
    p_limit: input.limit,
    p_before_at: before?.at,
    p_before_id: before?.id,
  });

  if (error) throw databaseException(error);

  const parsed = pageSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppException("internal", { cause: parsed.error });
  }
  const rows = parsed.data.notes.slice(0, input.limit);
  const time = await businessInstants(
    client,
    context.businessId,
    rows.flatMap((row) => [row.createdAt, row.updatedAt]),
  );
  const last = rows.at(-1);

  return {
    timezone: time.timezone,
    legacyNotes: parsed.data.legacyNotes?.trim()
      ? parsed.data.legacyNotes
      : null,
    notes: rows.map((row) => toNote(input.clientId, row, time.at)),
    nextCursor:
      parsed.data.notes.length > input.limit && last
        ? encodeNotesCursor({
            clientId: input.clientId,
            // As returned by PostgreSQL (microseconds kept): the next page
            // starts strictly after this exact note.
            at: last.createdAt,
            id: last.id,
          })
        : null,
  };
}

/** One note of one customer of the session's business. */
async function getClientNote(
  client: AppSupabaseClient,
  context: CrmContext,
  clientId: string,
  noteId: string,
): Promise<ClientNoteDto> {
  const { data, error } = await client
    .from("client_notes")
    .select(
      "id, content, version, created_by, updated_by, created_at, updated_at",
    )
    .eq("id", noteId)
    .eq("business_id", context.businessId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) throw databaseException(error);
  if (!data) throw new AppException("note_not_found");

  const time = await businessInstants(client, context.businessId, [
    data.created_at,
    data.updated_at,
  ]);
  return toNote(
    clientId,
    {
      id: data.id,
      content: data.content,
      version: data.version,
      createdBy: data.created_by,
      updatedBy: data.updated_by,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
    time.at,
  );
}

export async function createClientNote(
  client: AppSupabaseClient,
  context: CrmContext,
  input: CreateClientNoteInput,
): Promise<CreateClientNoteResultDto> {
  const { data, error } = await client
    .rpc("crm_create_client_note", {
      p_business_id: context.businessId,
      p_client_id: input.clientId,
      p_content: input.content,
      p_request_id: input.requestId,
    })
    .single();

  if (error) throw writeException(error);
  // This request was processed before and its note deleted since: it is
  // never written again.
  if (data.status === "deleted") throw noteDeleted();

  try {
    return {
      note: await getClientNote(client, context, input.clientId, data.note_id),
      created: data.status === "created",
    };
  } catch (error) {
    // A replay answered just before a concurrent deletion committed.
    if (error instanceof AppException && error.code === "note_not_found") {
      throw noteDeleted();
    }
    throw error;
  }
}

function noteDeleted() {
  return new AppException("note_deleted", {
    fieldErrors: { requestId: [appErrorMessages.note_deleted] },
  });
}

export async function updateClientNote(
  client: AppSupabaseClient,
  context: CrmContext,
  input: UpdateClientNoteInput,
): Promise<UpdateClientNoteResultDto> {
  const { data, error } = await client
    .rpc("crm_update_client_note", {
      p_business_id: context.businessId,
      p_client_id: input.clientId,
      p_note_id: input.noteId,
      p_expected_version: input.expectedVersion,
      p_content: input.content,
    })
    .single();

  if (error) throw databaseException(error);

  return {
    note: await getClientNote(client, context, input.clientId, data.note_id),
    changed: data.status === "updated",
  };
}

export async function deleteClientNote(
  client: AppSupabaseClient,
  context: CrmContext,
  input: DeleteClientNoteInput,
): Promise<DeleteClientNoteResultDto> {
  const { data, error } = await client
    .rpc("crm_delete_client_note", {
      p_business_id: context.businessId,
      p_client_id: input.clientId,
      p_note_id: input.noteId,
      p_expected_version: input.expectedVersion,
    })
    .single();

  if (error) throw databaseException(error);

  return { noteId: input.noteId, deleted: data.status === "deleted" };
}
