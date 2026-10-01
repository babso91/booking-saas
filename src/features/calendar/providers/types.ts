// Provider-neutral contract of an external calendar adapter. The domain
// (sync engine, connection lifecycle) only knows these types; each provider
// (Google Calendar today, Microsoft or CalDAV later) implements them.

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

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** Scopes the integration cannot work without. */
  readonly requiredScopes: readonly string[];

  authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderTokens>;
  refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date }>;
  revoke(token: string): Promise<void>;

  listCalendars(accessToken: string): Promise<ProviderCalendar[]>;
  listEvents(
    accessToken: string,
    calendarId: string,
    query: EventQuery,
    pageToken: string | null,
  ): Promise<ProviderEventPage>;

  watchEvents(
    accessToken: string,
    calendarId: string,
    channel: { id: string; token: string; address: string },
  ): Promise<{ resourceId: string; expiresAt: Date }>;
  stopChannel(accessToken: string, channel: ProviderChannel): Promise<void>;
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
  | "forbidden"
  | "bad_request";

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
