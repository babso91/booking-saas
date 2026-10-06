// Provider-neutral contract of an external calendar adapter. The domain
// (sync engine, connection lifecycle) only knows these types; each provider
// (Google Calendar today, Microsoft or CalDAV later) implements them.

import type { CallOptions } from "./http";

export type { CallOptions };

export type CalendarProviderId = "google";

export type ProviderAccount = {
  /** Stable account identifier at the provider (Google: OpenID `sub`). */
  id: string;
  email: string | null;
};

export type ProviderTokens = {
  accessToken: string;
  expiresAt: Date;
  /** Absent when the provider does not send a new one. */
  refreshToken: string | null;
  scopes: string[];
  account: ProviderAccount;
};

export type ProviderCalendar = {
  id: string;
  name: string;
  timezone: string | null;
  primary: boolean;
  accessRole: string | null;
  /**
   * Marker and creation nonce read from the description of a calendar
   * Booking may have created. Discovery only: a description can be copied,
   * so this never proves ownership nor excludes a calendar from blocking.
   */
  bookingMarker: string | null;
  bookingNonce: string | null;
};

/**
 * An appointment as mirrored to the provider: canonical UTC instants from
 * PostgreSQL, a minimal title, private metadata (no secret, no PII beyond
 * the title). Never attendees, never notes.
 */
export type OutboundEvent = {
  /** Deterministic provider event id. */
  id: string;
  summary: string;
  startsAt: string;
  endsAt: string;
  privateProperties: Record<string, string>;
};

/**
 * One event as the provider describes it, reduced to what blocking needs (no
 * title, description or attendees). Dates stay the provider's raw strings:
 * PostgreSQL, the calendar authority, turns them into instants.
 */
export type ProviderEvent = {
  id: string;
  recurringEventId: string | null;
  status: "confirmed" | "tentative" | "cancelled" | string;
  start: { date?: string; dateTime?: string; timeZone?: string } | null;
  end: { date?: string; dateTime?: string; timeZone?: string } | null;
  transparency: "opaque" | "transparent" | null;
  eventType: string | null;
  /** The connected account declined it: it does not occupy them. */
  declined: boolean;
  etag: string | null;
  updated: string | null;
};

export type ProviderEventPage = {
  events: ProviderEvent[];
  nextPageToken: string | null;
  /** Present on the last page only. */
  nextSyncToken: string | null;
  timezone: string | null;
};

export type EventQuery =
  | { kind: "full"; timeMin: string; timeMax: string }
  | { kind: "incremental"; syncToken: string };

export type ProviderChannel = { id: string; resourceId: string };

/**
 * One event of a calendar Booking writes to, as listed for reconciliation:
 * the fields Booking owns, raw (compared by the canonical serializer, never
 * trusted as authority). A deleted event comes back with status cancelled
 * and possibly nothing else.
 */
export type OwnedEvent = {
  id: string;
  status: string;
  summary: string | null;
  start: { date?: string; dateTime?: string; timeZone?: string } | null;
  end: { date?: string; dateTime?: string; timeZone?: string } | null;
  transparency: string | null;
  privateProperties: Record<string, string> | null;
};

export type OwnedEventPage = {
  events: OwnedEvent[];
  nextPageToken: string | null;
  /** Present on the last page only. */
  nextSyncToken: string | null;
};

/** A complete listing of the calendar, or the changes since a sync token. */
export type OwnedEventQuery =
  { kind: "full" } | { kind: "incremental"; syncToken: string };

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** Scopes the integration cannot work without. */
  readonly requiredScopes: readonly string[];

  authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  /**
   * Incremental authorization of the write scope only, for the account
   * already connected (`loginHint`: its provider account id).
   */
  writeAuthorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint: string;
  }): string;
  /** The scope that lets Booking write to the calendars it creates. */
  readonly writeScope: string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderTokens>;
  refreshAccessToken(
    refreshToken: string,
    options?: CallOptions,
  ): Promise<{ accessToken: string; expiresAt: Date }>;
  revoke(token: string, options?: CallOptions): Promise<void>;

  /**
   * The complete calendar list. Fails (never a partial list) when the list
   * is malformed, empty or longer than what is read.
   */
  listCalendars(
    accessToken: string,
    options?: CallOptions,
  ): Promise<ProviderCalendar[]>;
  /**
   * One page of events, validated: exactly one of nextPageToken (more
   * pages) and nextSyncToken (last page); a malformed page fails.
   */
  listEvents(
    accessToken: string,
    calendarId: string,
    query: EventQuery,
    pageToken: string | null,
    options?: CallOptions,
  ): Promise<ProviderEventPage>;

  /**
   * One page of every event of a calendar Booking writes to (deleted ones
   * included), for reconciliation: no time bounds (a sync token admits
   * none), the same parameters on every request. A sync token no longer
   * valid fails with `gone`; a malformed page fails (`protocol`).
   */
  listOwnedEvents(
    accessToken: string,
    calendarId: string,
    query: OwnedEventQuery,
    pageToken: string | null,
    options?: CallOptions,
  ): Promise<OwnedEventPage>;

  /**
   * Whether a listed event differs from `expected` (null: it must not
   * exist) on the fields Booking owns, through the same serializer as the
   * writes. Remote metadata is compared, never trusted.
   */
  ownedEventDiffers(
    expected: OutboundEvent | null,
    remote: OwnedEvent,
  ): boolean;

  watchEvents(
    accessToken: string,
    calendarId: string,
    channel: { id: string; token: string; address: string },
    options?: CallOptions,
  ): Promise<{ resourceId: string; expiresAt: Date }>;
  stopChannel(
    accessToken: string,
    channel: ProviderChannel,
    options?: CallOptions,
  ): Promise<void>;

  /**
   * Creates a secondary calendar. Never retried here: a retry after a lost
   * answer could create a second one (the caller looks for the marker
   * first).
   */
  createCalendar(
    accessToken: string,
    calendar: { summary: string; description: string; timeZone: string },
    options?: CallOptions,
  ): Promise<{ id: string }>;
  /** False when the calendar no longer exists (deleted). */
  calendarExists(
    accessToken: string,
    calendarId: string,
    options?: CallOptions,
  ): Promise<boolean>;
  /** Inserts with the deterministic id (409 `conflict` if it exists). */
  insertEvent(
    accessToken: string,
    calendarId: string,
    event: OutboundEvent,
    options?: CallOptions,
  ): Promise<void>;
  /**
   * Writes the Booking-managed fields of an existing event only (partial
   * update): every field Booking does not own (description, location,
   * colour, reminders, other private properties) is left as it is. Returns
   * the event's status after the write: `cancelled` means the event is
   * deleted at the provider and was not restored by this write (the caller
   * then restores it). `not_found` when it never existed or is purged.
   */
  patchEvent(
    accessToken: string,
    calendarId: string,
    event: OutboundEvent,
    options?: CallOptions,
  ): Promise<{ status: string }>;
  /**
   * Restoration of a deleted (cancelled) event: the whole event is
   * rewritten as Booking's canonical event, confirmed, same id. Only for
   * that exceptional case (it removes every field Booking does not own),
   * and for the ownership probe's own event.
   */
  restoreEvent(
    accessToken: string,
    calendarId: string,
    event: OutboundEvent,
    options?: CallOptions,
  ): Promise<void>;
  /** Deletes the event; false when it was already gone (404/410). */
  deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    options?: CallOptions,
  ): Promise<boolean>;
}

export type ProviderErrorKind =
  /** Refresh token revoked or expired: the professional must reconnect. */
  | "auth_revoked"
  /** Access token rejected (401): refresh and retry once. */
  | "unauthorized"
  /** Sync cursor no longer valid (410): full sync. */
  | "gone"
  /** Too many requests, after the bounded retries. */
  | "rate_limited"
  /** 5xx, timeout or network failure, after the bounded retries. */
  | "unavailable"
  | "not_found"
  /** 409: the resource (event id) already exists. */
  | "conflict"
  | "forbidden"
  | "bad_request"
  /**
   * A successful answer that does not follow the provider's protocol
   * (unparsable JSON, missing or inconsistent fields): nothing of it is
   * applied, the local copy and the cursor are kept.
   */
  | "protocol";

export class CalendarProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "CalendarProviderError";
  }
}
