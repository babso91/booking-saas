import type { UiResult } from "@/features/auth/client/call-action";

// The technical sheet of a visit, her client's preferences and tags.
// PROPOSED contract (docs/CRM_VISIT_NOTES_PROPOSAL.md): no server serves it
// yet. The screens take these actions as a whole, so a design preview or a
// test gives them an in-memory server, and the real app shows nothing of
// this until Cloud provides the real ones.
//
// Nothing here is specific to a trade: the fields of a sheet are hers
// (a length, a shade, a mix, a pressure), defined per business.

export type FieldKind = "text" | "number" | "choice";

/** A field she defined for her sheets. */
export type FieldDefinitionDto = {
  id: string;
  label: string;
  kind: FieldKind;
  /** Shown after a number ("mm", "ml"); null: none. */
  unit: string | null;
  /** The answers of a "choice" field, in her order. */
  choices: string[];
};

/** A value as it was written: its field's label and unit are kept with it. */
export type FieldValueDto = {
  fieldId: string;
  label: string;
  value: string;
  unit: string | null;
};

/** A product used, as typed: it moves no stock. */
export type ProductDto = { name: string; quantity: string; unit: string };

export type NoteState =
  /** Editable, by version. */
  | "draft"
  /** The current sheet of the visit: never edited, only corrected. */
  | "recorded"
  /** Replaced by a correction; kept in the history. */
  | "superseded";

export type TechnicalNoteDto = {
  id: string;
  version: number;
  state: NoteState;
  /** The service of the visit, as it was named then. */
  serviceName: string;
  fieldValues: FieldValueDto[];
  products: ProductDto[];
  recordedAt: string | null;
  /** The recorded sheet this one corrects; null: a first sheet. */
  supersedesId: string | null;
  correctionReason: string | null;
};

export type TagDto = {
  id: string;
  label: string;
  /** Still shown on her history; no longer offered. */
  archived: boolean;
};

/** Everything to prepare one visit, read at once. */
export type VisitPreparationDto = {
  appointmentId: string;
  clientId: string;
  clientName: string;
  serviceName: string;
  startsAt: string;
  timezone: string;
  /** What she always wants to remember about this client. */
  preferences: { version: number; text: string };
  /** The last recorded sheet of an earlier visit, to start from. */
  lastRecord: (TechnicalNoteDto & { visitStartsAt: string }) | null;
  /** This visit's sheet: a draft, the recorded one, or none yet. */
  current: TechnicalNoteDto | null;
  /** The fields a sheet of this service may hold, in her order. */
  allowedFields: FieldDefinitionDto[];
  /** Her tags, archived ones included (to read the client's). */
  tags: TagDto[];
  clientTagIds: string[];
};

export type SaveDraftInput = {
  requestId: string;
  appointmentId: string;
  /** The draft's version she edited; 0: no sheet yet. */
  expectedVersion: number;
  fieldValues: { fieldId: string; value: string }[];
  products: ProductDto[];
  /** A correction of the recorded sheet: the sheet it will replace. */
  supersedesId?: string | null;
};

export type RecordInput = {
  requestId: string;
  noteId: string;
  expectedVersion: number;
  /** Required when the draft corrects a recorded sheet. */
  correctionReason?: string;
};

export type VisitNotesActions = {
  preparation: (
    appointmentId: string,
  ) => Promise<UiResult<VisitPreparationDto>>;
  /** Creates or updates the visit's draft; answers the draft as saved. */
  saveDraft: (input: SaveDraftInput) => Promise<UiResult<TechnicalNoteDto>>;
  /** Makes a draft the visit's sheet; answers it as recorded. */
  record: (input: RecordInput) => Promise<UiResult<TechnicalNoteDto>>;
  setTag: (input: {
    requestId: string;
    clientId: string;
    tagId: string;
    attached: boolean;
  }) => Promise<UiResult<{ clientId: string; tagIds: string[] }>>;
};

/** Refusals of the proposed contract the screens handle by name. */
export const visitNoteErrors = {
  stale: "stale_technical_note",
  clientChanged: "visit_client_changed",
  fieldNotAllowed: "field_not_allowed",
} as const;
