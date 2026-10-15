import type { RequestKey } from "@/features/agenda/client/request-id";
import {
  draftKeyFor,
  readDraftRaw,
  removeDraft,
  writeDraftRaw,
  type DraftScope,
} from "@/features/businesses/client/draft-scope";

import type { ServiceDraft, ServiceView } from "./service-form";

// Service drafts kept for the browser session, per identity (user and
// business, see draft-scope.ts). Never the source of truth: the list is.
//
// - The creation in progress: what was typed, the request id of the command
//   sent, and whether its answer was lost. Closing the form, or leaving and
//   coming back, never forgets an unconfirmed creation: its resend carries
//   the same request id, and the backend answers the service it created
//   instead of creating a second one.
// - An edit kept for later, per service: what was typed and the service
//   (version) it started from, so that a service changed since is compared
//   before anything is sent.

export type PendingCreation = {
  draft: ServiceDraft;
  /** The request id of the last command sent (null: nothing sent yet). */
  key: RequestKey | null;
  /** The last answer was lost: the creation may already exist. */
  unconfirmed: boolean;
};

export type EditDraft = { draft: ServiceDraft; base: ServiceView };

export const creationKey = (scope: DraftScope) =>
  draftKeyFor(scope, "service-create");

export const editKey = (scope: DraftScope, serviceId: string) =>
  draftKeyFor(scope, "service-edit", serviceId);

const DRAFT_FIELDS = ["name", "description", "duration", "price"] as const;

const isDraft = (value: unknown): value is ServiceDraft =>
  typeof value === "object" &&
  value !== null &&
  DRAFT_FIELDS.every(
    (field) => typeof (value as Record<string, unknown>)[field] === "string",
  );

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readPendingCreation(key: string): PendingCreation | null {
  const value = parse(readDraftRaw(key)) as Partial<PendingCreation> | null;
  return value && isDraft(value.draft)
    ? {
        draft: value.draft,
        key: value.key ?? null,
        unconfirmed: value.unconfirmed === true,
      }
    : null;
}

export function writePendingCreation(key: string, value: PendingCreation) {
  writeDraftRaw(key, JSON.stringify(value));
}

/** The raw stored value (a stable string snapshot for rendering). */
export const pendingCreationSnapshot = readDraftRaw;

export function readEditDraft(
  key: string,
  serviceId: string,
): EditDraft | null {
  const value = parse(readDraftRaw(key)) as Partial<EditDraft> | null;
  const base = value?.base;
  return value &&
    isDraft(value.draft) &&
    base?.id === serviceId &&
    typeof base.version === "number"
    ? { draft: value.draft, base }
    : null;
}

export function writeEditDraft(key: string, value: EditDraft) {
  writeDraftRaw(key, JSON.stringify(value));
}

export { removeDraft as clearServiceDraft };
