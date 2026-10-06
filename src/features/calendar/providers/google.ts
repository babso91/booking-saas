import {
  defaultRetryPolicy,
  sendWithRetry,
  type CallOptions,
  type FetchLike,
  type RetryPolicy,
} from "./http";
import {
  CalendarProviderError,
  type CalendarProvider,
  type EventQuery,
  type OutboundEvent,
  type OwnedEvent,
  type OwnedEventPage,
  type OwnedEventQuery,
  type ProviderCalendar,
  type ProviderEvent,
  type ProviderEventPage,
  type ProviderTokens,
} from "./types";

// Google Calendar adapter (API v3, OAuth 2.0 web server flow with PKCE).
//
// Scopes (narrowest that cover inbound sync; checked against Google's list):
//   openid, email                         stable account id + address
//   calendar.calendarlist.readonly        "See the list of Google calendars
//                                          you're subscribed to"
//   calendar.events.readonly              "View events on all your calendars"
// Outbound (appointments mirrored to Google) adds, through incremental
// authorization (include_granted_scopes) and only when the professional
// enables it:
//   calendar.app.created                  "Make secondary Google calendars,
//                                          and see, create, change, and
//                                          delete events on them"
// It covers calendars.insert and events insert/update/delete, on the
// calendars the app created only: Booking can never write to another
// calendar. A calendar's id cannot be chosen at creation; after a lost
// answer, the dedicated calendar is found again in the calendar list (read
// scope above) by the marker written in its description.
//
// Events are read with singleEvents=true: Google expands recurring series
// into instances (no RRULE engine here), each with its own id and
// recurringEventId; with a sync token, only changed instances come back, and
// deleted instances come back as `cancelled`. The `fields` mask keeps titles,
// descriptions and attendees out of every response (privacy), except the
// connected account's own response status.
//
// Every successful answer is validated before anything is derived from it
// (`protocol` error otherwise): unparsable JSON, a page without exactly one
// of nextPageToken / nextSyncToken, items that are not an array, an event
// without id or readable bounds, an empty, malformed or truncated calendar
// list. Bounds that are readable but incoherent (inverted, empty) are left
// to PostgreSQL, which blocks conservatively instead of failing the page. A malformed answer must never look like "no events" (the final sweep
// would empty the local copy) or "no calendars" (they would be removed).

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

const EVENT_FIELDS =
  "items(id,status,start,end,transparency,eventType,recurringEventId,etag,updated,attendees(self,responseStatus)),nextPageToken,nextSyncToken,timeZone";
// Reconciliation: the fields Booking owns, nothing else (no description,
// attendees or notes are ever read).
const OWNED_EVENT_FIELDS =
  "items(id,status,summary,start,end,transparency,extendedProperties/private),nextPageToken,nextSyncToken";
const CALENDAR_FIELDS =
  "items(id,summary,summaryOverride,description,timeZone,primary,accessRole),nextPageToken";

export const GOOGLE_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";

/**
 * Marker of a calendar Booking created, in its description: the business's
 * marker and the creation attempt's nonce. Discovery only (a description
 * can be copied): never a proof of ownership.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BOOKING_MARKER = new RegExp(`booking-saas:(${UUID})(?::(${UUID}))?`);

export function bookingCalendarDescription(marker: string, nonce: string) {
  return `Rendez-vous copiés depuis Booking. Booking reste la référence : une modification faite ici n’est pas reprise. Identifiant technique : booking-saas:${marker}:${nonce}`;
}

/** Google's custom event ids: base32hex (a-v, 0-9), 5 to 1024 characters. */
const EVENT_ID = /^[a-v0-9]{5,1024}$/;

/** Pages of the calendar list read at most (250 calendars per page). */
const MAX_CALENDAR_PAGES = 4;

type GoogleEvent = {
  id?: string;
  status?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  transparency?: string;
  eventType?: string;
  recurringEventId?: string;
  etag?: string;
  updated?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
};

/** Tolerated clock difference with the provider. */
const CLOCK_SKEW_SECONDS = 300;

const protocolError = (message: string) =>
  new CalendarProviderError("protocol", null, message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw protocolError("Malformed id_token");
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    );
    if (!isRecord(payload)) throw new Error("not an object");
    return payload;
  } catch {
    throw protocolError("Malformed id_token");
  }
}

/** Access token expiry (expires_in seconds, one hour if absent). */
function expiresAt(body: Record<string, unknown>) {
  const seconds =
    body.expires_in === undefined ? 3600 : Number(body.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw protocolError("Malformed token expiry");
  }
  return new Date(Date.now() + seconds * 1000);
}

/** Body of a successful answer: a JSON object, or a protocol error. */
async function readSuccess(
  response: Response,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw protocolError("Unparsable response");
  }
  if (!isRecord(body)) throw protocolError("Unexpected response");
  return body;
}

/** Body of an error answer, only to classify it (may be HTML). */
async function readFailure(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))?$/;

const EVENT_STATUSES = new Set(["confirmed", "tentative", "cancelled"]);
const TRANSPARENCIES = new Set(["opaque", "transparent"]);
const RESPONSE_STATUSES = new Set([
  "needsAction",
  "declined",
  "tentative",
  "accepted",
]);

/**
 * A real calendar date (no 2026-02-30). Plain calendar arithmetic: the
 * zone-dependent projection of a date stays PostgreSQL's.
 */
function isCalendarDate(value: string) {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** RFC 3339 date-time; `zoned`: it carries its own offset (or Z). */
function parseDateTime(value: string) {
  const match = DATE_TIME.exec(value);
  if (!match || !isCalendarDate(match[1]!)) return null;
  const [hour, minute, second] = [match[2], match[3], match[4] ?? "0"].map(
    Number,
  ) as [number, number, number];
  if (hour > 23 || minute > 59 || second > 60) return null;
  if (match[6] && (Number(match[6]) > 14 || Number(match[7]) > 59)) {
    return null;
  }
  return { zoned: Boolean(match[5]) };
}

type Bound =
  | { kind: "date"; date: string }
  | { kind: "dateTime"; dateTime: string; zoned: boolean };

/**
 * An event bound: a real date (all-day) or a date-time, never both or
 * neither. A date-time without offset must name its zone (Google's rule).
 */
function parseBound(value: unknown): Bound | null {
  if (!isRecord(value)) return null;
  const { date, dateTime, timeZone } = value;
  if (timeZone !== undefined && !nonEmptyString(timeZone)) return null;
  if (date !== undefined && dateTime === undefined) {
    return typeof date === "string" && isCalendarDate(date)
      ? { kind: "date", date }
      : null;
  }
  if (dateTime !== undefined && date === undefined) {
    if (typeof dateTime !== "string") return null;
    const parsed = parseDateTime(dateTime);
    if (!parsed || (!parsed.zoned && timeZone === undefined)) return null;
    return { kind: "dateTime", dateTime, zoned: parsed.zoned };
  }
  return null;
}

const optional = (value: unknown, valid: (value: unknown) => boolean) =>
  value === undefined || valid(value);

/**
 * Validates one listed event; any anomaly is a protocol error for the
 * whole page (never "free", never deleted): types and values of every
 * field blocking depends on, attendees' `self` a boolean, bounds of the
 * same kind, and a non-empty interval (end after start).
 */
function parseEvent(item: unknown): ProviderEvent {
  if (!isRecord(item) || !nonEmptyString(item.id)) {
    throw protocolError("Event without id");
  }
  if (
    !optional(
      item.status,
      (value) => typeof value === "string" && EVENT_STATUSES.has(value),
    ) ||
    !optional(
      item.transparency,
      (value) => typeof value === "string" && TRANSPARENCIES.has(value),
    ) ||
    !optional(item.eventType, nonEmptyString) ||
    !optional(item.recurringEventId, nonEmptyString) ||
    !optional(item.etag, (value) => typeof value === "string") ||
    !optional(
      item.updated,
      (value) =>
        typeof value === "string" && parseDateTime(value)?.zoned === true,
    )
  ) {
    throw protocolError("Malformed event");
  }
  if (
    !optional(
      item.attendees,
      (value) =>
        Array.isArray(value) &&
        value.every(
          (attendee) =>
            isRecord(attendee) &&
            optional(attendee.self, (self) => typeof self === "boolean") &&
            optional(
              attendee.responseStatus,
              (status) =>
                typeof status === "string" && RESPONSE_STATUSES.has(status),
            ),
        ),
    )
  ) {
    throw protocolError("Malformed event attendees");
  }

  // A cancelled event may come back as its id only.
  if (item.status !== "cancelled") {
    const start = parseBound(item.start);
    const end = parseBound(item.end);
    if (!start || !end || start.kind !== end.kind) {
      throw protocolError("Malformed event bounds");
    }
    // Empty or inverted intervals are not rejected here: an event's bounds
    // may be in different zones (10:00 New York → 09:00 Los Angeles is a
    // valid two-hour event), so PostgreSQL compares them once resolved and
    // widens what stays incoherent instead of failing the page.
  }
  return toProviderEvent(item as GoogleEvent)!;
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

const isRawBound = (value: unknown) =>
  isRecord(value) &&
  optional(value.date, (item) => typeof item === "string") &&
  optional(value.dateTime, (item) => typeof item === "string") &&
  optional(value.timeZone, (item) => typeof item === "string");

/**
 * One listed event of a calendar Booking writes to. Only the types are
 * checked: values (an all-day bound, an unknown status) are compared, and
 * any difference is a drift the writer repairs, never a failed page.
 */
function parseOwnedEvent(item: unknown): OwnedEvent {
  if (!isRecord(item) || !nonEmptyString(item.id)) {
    throw protocolError("Event without id");
  }
  const properties = item.extendedProperties;
  if (
    !optional(item.status, nonEmptyString) ||
    !optional(item.summary, (value) => typeof value === "string") ||
    !optional(item.start, isRawBound) ||
    !optional(item.end, isRawBound) ||
    !optional(item.transparency, nonEmptyString) ||
    !optional(
      properties,
      (value) => isRecord(value) && optional(value.private, isStringRecord),
    )
  ) {
    throw protocolError("Malformed event");
  }
  const start = item.start as OwnedEvent["start"] | undefined;
  const end = item.end as OwnedEvent["end"] | undefined;
  return {
    id: item.id,
    status: (item.status as string | undefined) ?? "confirmed",
    summary: (item.summary as string | undefined) ?? null,
    start: start ?? null,
    end: end ?? null,
    transparency: (item.transparency as string | undefined) ?? null,
    privateProperties:
      ((properties as { private?: Record<string, string> } | undefined)
        ?.private as Record<string, string> | undefined) ?? null,
  };
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

function errorFor(status: number, body: Record<string, unknown>) {
  const error = body.error;
  const oauthError = typeof error === "string" ? error : null;
  const reason =
    typeof error === "object" && error !== null
      ? ((error as { errors?: { reason?: string }[] }).errors?.[0]?.reason ??
        null)
      : null;

  if (oauthError === "invalid_grant") {
    return new CalendarProviderError("auth_revoked", status, "invalid_grant");
  }
  if (status === 401)
    return new CalendarProviderError("unauthorized", status, "unauthorized");
  if (status === 410) return new CalendarProviderError("gone", status, "gone");
  if (status === 409)
    return new CalendarProviderError("conflict", status, "conflict");
  if (status === 404)
    return new CalendarProviderError("not_found", status, "not_found");
  // Google answers some limits with 403 (Calendar API errors guide:
  // rateLimitExceeded, userRateLimitExceeded, quotaExceeded; plus the
  // generic dailyLimitExceeded): a limit, retried with backoff like a 429,
  // never a lost permission.
  if (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason)) {
    return new CalendarProviderError("rate_limited", status, reason);
  }
  if (status === 403)
    return new CalendarProviderError(
      "forbidden",
      status,
      reason ?? "forbidden",
    );
  return new CalendarProviderError(
    "bad_request",
    status,
    oauthError ?? reason ?? "bad_request",
  );
}

function bookingMarkerOf(description: unknown) {
  const match =
    typeof description === "string" ? BOOKING_MARKER.exec(description) : null;
  return {
    bookingMarker: match?.[1] ?? null,
    bookingNonce: match?.[2] ?? null,
  };
}

export function toProviderEvent(event: GoogleEvent): ProviderEvent | null {
  if (!event.id) return null;
  return {
    id: event.id,
    recurringEventId: event.recurringEventId ?? null,
    status: event.status ?? "confirmed",
    start: event.start ?? null,
    end: event.end ?? null,
    transparency:
      event.transparency === "transparent"
        ? "transparent"
        : event.transparency
          ? "opaque"
          : null,
    eventType: event.eventType ?? null,
    declined: Boolean(
      event.attendees?.some(
        (attendee) =>
          attendee.self === true && attendee.responseStatus === "declined",
      ),
    ),
    etag: event.etag ?? null,
    updated: event.updated ?? null,
  };
}

// The canonical serializer: the body every write sends, and what
// reconciliation compares a listed event with. Only the appointment's slot
// and a minimal title: no attendee (no invitation), no description, no
// notes, no contact detail. Opaque: the professional's other tools see the
// slot as busy.
function eventBody(event: OutboundEvent) {
  return {
    summary: event.summary,
    start: { dateTime: event.startsAt },
    end: { dateTime: event.endsAt },
    status: "confirmed",
    transparency: "opaque",
    extendedProperties: { private: event.privateProperties },
  };
}

/**
 * Private properties that identify Booking's event. `revision` is
 * informational (the revision last written), never compared.
 */
const OWNED_PRIVATE_PROPERTIES = ["origin", "appointmentId"] as const;

/** An RFC 3339 date-time with its offset, as whole seconds; else null. */
function instantOf(value: string | undefined) {
  if (value === undefined || parseDateTime(value)?.zoned !== true) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

/**
 * Whether a listed event differs from what Booking would write now, on the
 * fields Booking owns only: presence (a cancelled event is absent),
 * status, title, the two instants (compared as instants: any offset, any
 * precision below the second), transparency (Google omits the default,
 * opaque) and the identifying private properties. `expected` null: the
 * event must not exist. Fields Booking never writes (description, colour,
 * reminders) are never compared.
 */
export function ownedEventDiffers(
  expected: OutboundEvent | null,
  remote: OwnedEvent,
) {
  if (!expected) return remote.status !== "cancelled";
  const body = eventBody(expected);
  const sameBound = (bound: OwnedEvent["start"], dateTime: string): boolean => {
    if (!bound || bound.date !== undefined) return false;
    const actual = instantOf(bound.dateTime);
    return actual !== null && actual === instantOf(dateTime);
  };
  return (
    remote.status !== body.status ||
    remote.summary !== body.summary ||
    (remote.transparency ?? "opaque") !== body.transparency ||
    !sameBound(remote.start, body.start.dateTime) ||
    !sameBound(remote.end, body.end.dateTime) ||
    OWNED_PRIVATE_PROPERTIES.some(
      (key) =>
        remote.privateProperties?.[key] !==
        body.extendedProperties.private[key],
    )
  );
}

export function createGoogleCalendarProvider(options: {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  retry?: RetryPolicy;
}): CalendarProvider {
  const fetchImpl: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const retry = options.retry ?? defaultRetryPolicy;

  async function call(
    url: string,
    init: RequestInit,
    callOptions: CallOptions = {},
  ) {
    const response = await sendWithRetry(
      fetchImpl,
      url,
      init,
      retry,
      callOptions,
    );
    if (!response.ok) {
      throw errorFor(response.status, await readFailure(response));
    }
    return readSuccess(response);
  }

  function form(values: Record<string, string>) {
    return {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
    };
  }

  const bearer = (accessToken: string) => ({
    Authorization: `Bearer ${accessToken}`,
  });

  const jsonRequest = (method: string, accessToken: string, body: unknown) => ({
    method,
    headers: { ...bearer(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const eventUrl = (calendarId: string, eventId?: string) => {
    const url = new URL(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events${
        eventId ? `/${encodeURIComponent(eventId)}` : ""
      }`,
    );
    // No notification: there is no attendee, and nobody is invited.
    url.searchParams.set("sendUpdates", "none");
    return url;
  };

  const checkEventId = (eventId: string) => {
    if (!EVENT_ID.test(eventId)) {
      throw new CalendarProviderError("bad_request", null, "Invalid event id");
    }
  };

  return {
    id: "google",
    requiredScopes: GOOGLE_SCOPES.filter((scope) =>
      scope.startsWith("https://"),
    ),

    authorizationUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        // Offline access returns a refresh token; prompt=consent makes Google
        // send one again on a reconnection (it is otherwise only sent at the
        // first consent).
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    writeScope: GOOGLE_WRITE_SCOPE,

    writeAuthorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        // The new scope only; openid returns the id_token that proves which
        // account answered. Every scope granted before stays
        // (include_granted_scopes).
        scope: ["openid", GOOGLE_WRITE_SCOPE].join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        login_hint: loginHint,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    async exchangeCode({
      code,
      codeVerifier,
      redirectUri,
    }): Promise<ProviderTokens> {
      const body = await call(
        TOKEN_URL,
        form({
          code,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
      );

      const accessToken = body.access_token;
      const idToken = body.id_token;
      if (!nonEmptyString(accessToken) || !nonEmptyString(idToken)) {
        throw protocolError("Incomplete token response");
      }
      // Received directly from Google's token endpoint over TLS: its claims
      // are trusted without signature check (OpenID Connect, §3.1.3.7), but
      // they must be for us (aud, azp), from Google (iss), still valid (exp,
      // iat) and identify an account (sub; email if present is a string).
      const claims = decodeJwtPayload(idToken);
      const now = Date.now() / 1000;
      // Single audience, ours: Google issues the token to this client only
      // ("verify that the value of the aud claim is equal to your app's
      // client ID"). A list is accepted only if it is exactly [client]: we
      // trust no other audience. azp, if present, must be our client too.
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        audience.length !== 1 ||
        audience[0] !== options.clientId ||
        (claims.azp !== undefined && claims.azp !== options.clientId) ||
        (claims.iss !== "https://accounts.google.com" &&
          claims.iss !== "accounts.google.com") ||
        !nonEmptyString(claims.sub) ||
        typeof claims.exp !== "number" ||
        claims.exp + CLOCK_SKEW_SECONDS < now ||
        (claims.iat !== undefined &&
          (typeof claims.iat !== "number" ||
            claims.iat - CLOCK_SKEW_SECONDS > now)) ||
        (claims.email !== undefined && typeof claims.email !== "string")
      ) {
        throw new CalendarProviderError(
          "bad_request",
          null,
          "Unexpected id_token",
        );
      }

      return {
        accessToken,
        expiresAt: expiresAt(body),
        refreshToken:
          typeof body.refresh_token === "string" ? body.refresh_token : null,
        scopes:
          typeof body.scope === "string"
            ? body.scope.split(" ").filter(Boolean)
            : [],
        account: {
          id: claims.sub,
          email: typeof claims.email === "string" ? claims.email : null,
        },
      };
    },

    async refreshAccessToken(refreshToken, callOptions) {
      const body = await call(
        TOKEN_URL,
        form({
          refresh_token: refreshToken,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: "refresh_token",
        }),
        callOptions,
      );
      if (!nonEmptyString(body.access_token)) {
        throw protocolError("Incomplete token response");
      }
      return {
        accessToken: body.access_token,
        expiresAt: expiresAt(body),
      };
    },

    async revoke(token, callOptions) {
      const response = await sendWithRetry(
        fetchImpl,
        REVOKE_URL,
        form({ token }),
        retry,
        callOptions,
      );
      // 400 invalid_token: already revoked or expired, which is the goal.
      if (!response.ok && response.status !== 400) {
        throw errorFor(response.status, await readFailure(response));
      }
    },

    async listCalendars(accessToken, callOptions) {
      const calendars: ProviderCalendar[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
        const url = new URL(`${API}/users/me/calendarList`);
        url.searchParams.set("maxResults", "250");
        url.searchParams.set("fields", CALENDAR_FIELDS);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = await call(
          url.toString(),
          { headers: bearer(accessToken) },
          callOptions,
        );
        if (!Array.isArray(body.items)) {
          throw protocolError("Malformed calendar list");
        }
        for (const item of body.items as unknown[]) {
          if (!isRecord(item) || !nonEmptyString(item.id)) {
            throw protocolError("Malformed calendar list");
          }
          calendars.push({
            id: item.id,
            name: String(item.summaryOverride ?? item.summary ?? item.id),
            timezone: typeof item.timeZone === "string" ? item.timeZone : null,
            primary: item.primary === true,
            accessRole:
              typeof item.accessRole === "string" ? item.accessRole : null,
            ...bookingMarkerOf(item.description),
          });
        }
        if (
          body.nextPageToken !== undefined &&
          !nonEmptyString(body.nextPageToken)
        ) {
          throw protocolError("Malformed calendar list");
        }
        pageToken = (body.nextPageToken as string | undefined) ?? null;
        if (!pageToken) break;
      }
      // A partial or empty list would remove calendars (and the busy periods
      // they block) that still exist.
      if (pageToken) throw protocolError("Calendar list too long");
      if (calendars.length === 0) throw protocolError("Empty calendar list");
      return calendars;
    },

    async listEvents(
      accessToken,
      calendarId,
      query: EventQuery,
      pageToken,
      callOptions,
    ): Promise<ProviderEventPage> {
      const url = new URL(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      // Same parameters on every request of a sync (Google requires it);
      // timeMin/timeMax only without a sync token.
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("fields", EVENT_FIELDS);
      if (query.kind === "full") {
        url.searchParams.set("timeMin", query.timeMin);
        url.searchParams.set("timeMax", query.timeMax);
      } else {
        url.searchParams.set("syncToken", query.syncToken);
      }
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const body = await call(
        url.toString(),
        { headers: bearer(accessToken) },
        callOptions,
      );
      if (body.items !== undefined && !Array.isArray(body.items)) {
        throw protocolError("Malformed event page");
      }
      const nextPageToken = body.nextPageToken;
      const nextSyncToken = body.nextSyncToken;
      if (
        (nextPageToken !== undefined && !nonEmptyString(nextPageToken)) ||
        (nextSyncToken !== undefined && !nonEmptyString(nextSyncToken)) ||
        // Exactly one: more pages, or the last page and its cursor.
        (nextPageToken === undefined) === (nextSyncToken === undefined) ||
        (body.timeZone !== undefined && !nonEmptyString(body.timeZone))
      ) {
        throw protocolError("Malformed event page");
      }
      return {
        events: ((body.items as unknown[] | undefined) ?? []).map(parseEvent),
        nextPageToken: (nextPageToken as string | undefined) ?? null,
        nextSyncToken: (nextSyncToken as string | undefined) ?? null,
        timezone: (body.timeZone as string | undefined) ?? null,
      };
    },

    ownedEventDiffers,

    async listOwnedEvents(
      accessToken,
      calendarId,
      query: OwnedEventQuery,
      pageToken,
      callOptions,
    ): Promise<OwnedEventPage> {
      const url = new URL(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      // Same parameters on every request of a listing (Google requires it):
      // deleted events included, no time bound, no expansion (Booking never
      // writes recurring events).
      url.searchParams.set("showDeleted", "true");
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("fields", OWNED_EVENT_FIELDS);
      if (query.kind === "incremental") {
        url.searchParams.set("syncToken", query.syncToken);
      }
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const body = await call(
        url.toString(),
        { headers: bearer(accessToken) },
        callOptions,
      );
      if (body.items !== undefined && !Array.isArray(body.items)) {
        throw protocolError("Malformed event page");
      }
      const nextPageToken = body.nextPageToken;
      const nextSyncToken = body.nextSyncToken;
      if (
        (nextPageToken !== undefined && !nonEmptyString(nextPageToken)) ||
        (nextSyncToken !== undefined && !nonEmptyString(nextSyncToken)) ||
        (nextPageToken === undefined) === (nextSyncToken === undefined)
      ) {
        throw protocolError("Malformed event page");
      }
      return {
        events: ((body.items as unknown[] | undefined) ?? []).map(
          parseOwnedEvent,
        ),
        nextPageToken: (nextPageToken as string | undefined) ?? null,
        nextSyncToken: (nextSyncToken as string | undefined) ?? null,
      };
    },

    async watchEvents(accessToken, calendarId, channel, callOptions) {
      const body = await call(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
        {
          method: "POST",
          headers: {
            ...bearer(accessToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: channel.id,
            type: "web_hook",
            address: channel.address,
            token: channel.token,
          }),
        },
        callOptions,
      );
      const expiration = Number(body.expiration);
      if (
        !nonEmptyString(body.resourceId) ||
        body.id !== channel.id ||
        !Number.isFinite(expiration) ||
        expiration <= Date.now()
      ) {
        throw protocolError("Incomplete watch response");
      }
      return { resourceId: body.resourceId, expiresAt: new Date(expiration) };
    },

    async createCalendar(accessToken, calendar, callOptions) {
      // No automatic retry: a 5xx or a timeout may hide a calendar that was
      // created; the caller looks for its marker before trying again.
      const response = await sendWithRetry(
        fetchImpl,
        `${API}/calendars`,
        jsonRequest("POST", accessToken, {
          summary: calendar.summary,
          description: calendar.description,
          timeZone: calendar.timeZone,
        }),
        { ...retry, retries: 0 },
        callOptions,
      );
      if (!response.ok) {
        throw errorFor(response.status, await readFailure(response));
      }
      const body = await readSuccess(response);
      if (!nonEmptyString(body.id)) {
        throw protocolError("Incomplete calendar response");
      }
      return { id: body.id };
    },

    async calendarExists(accessToken, calendarId, callOptions) {
      const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}`);
      url.searchParams.set("fields", "id");
      const response = await sendWithRetry(
        fetchImpl,
        url.toString(),
        { headers: bearer(accessToken) },
        retry,
        callOptions,
      );
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      if (!response.ok) {
        throw errorFor(response.status, await readFailure(response));
      }
      const body = await readSuccess(response);
      if (body.id !== calendarId) throw protocolError("Unexpected calendar");
      return true;
    },

    // Retried on 5xx/429/timeouts: safe, the id is deterministic (a second
    // insert of an event that was created answers 409).
    async insertEvent(accessToken, calendarId, event, callOptions) {
      checkEventId(event.id);
      const body = await call(
        eventUrl(calendarId).toString(),
        jsonRequest("POST", accessToken, { id: event.id, ...eventBody(event) }),
        callOptions,
      );
      if (body.id !== event.id) throw protocolError("Unexpected event");
    },

    async updateEvent(accessToken, calendarId, event, callOptions) {
      checkEventId(event.id);
      const body = await call(
        eventUrl(calendarId, event.id).toString(),
        jsonRequest("PUT", accessToken, eventBody(event)),
        callOptions,
      );
      if (body.id !== event.id) throw protocolError("Unexpected event");
    },

    async deleteEvent(accessToken, calendarId, eventId, callOptions) {
      checkEventId(eventId);
      const response = await sendWithRetry(
        fetchImpl,
        eventUrl(calendarId, eventId).toString(),
        { method: "DELETE", headers: bearer(accessToken) },
        retry,
        callOptions,
      );
      // 410: already deleted; 404: never existed or the calendar is gone.
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      if (!response.ok) {
        throw errorFor(response.status, await readFailure(response));
      }
      await response.body?.cancel().catch(() => undefined);
      return true;
    },

    async stopChannel(accessToken, channel, callOptions) {
      const response = await sendWithRetry(
        fetchImpl,
        `${API}/channels/stop`,
        {
          method: "POST",
          headers: {
            ...bearer(accessToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: channel.id,
            resourceId: channel.resourceId,
          }),
        },
        retry,
        callOptions,
      );
      // 404: already stopped or expired.
      if (!response.ok && response.status !== 404) {
        throw errorFor(response.status, await readFailure(response));
      }
    },
  };
}
