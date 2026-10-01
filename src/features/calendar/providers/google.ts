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
// Writing appointments to a chosen calendar (next PR) will add
// calendar.events.owned through incremental authorization
// (include_granted_scopes), not requested before it is used.
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
// list. A malformed answer must never look like "no events" (the final sweep
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
const CALENDAR_FIELDS =
  "items(id,summary,summaryOverride,timeZone,primary,accessRole),nextPageToken";

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** An event bound: a date (all-day) or a date-time, never both or neither. */
function validBound(value: unknown) {
  if (!isRecord(value)) return null;
  const date = value.date;
  const dateTime = value.dateTime;
  const timeZone = value.timeZone;
  if (timeZone !== undefined && typeof timeZone !== "string") return null;
  if (date !== undefined && dateTime === undefined) {
    return typeof date === "string" && DATE.test(date) ? "date" : null;
  }
  if (dateTime !== undefined && date === undefined) {
    return typeof dateTime === "string" && DATE_TIME.test(dateTime)
      ? "dateTime"
      : null;
  }
  return null;
}

/** Validates one listed event (a protocol error for the whole page). */
function parseEvent(item: unknown): ProviderEvent {
  if (!isRecord(item) || !nonEmptyString(item.id)) {
    throw protocolError("Event without id");
  }
  if (item.status !== undefined && typeof item.status !== "string") {
    throw protocolError("Malformed event");
  }
  // A cancelled event may come back as its id only.
  if (item.status !== "cancelled") {
    const start = validBound(item.start);
    const end = validBound(item.end);
    if (!start || start !== end) throw protocolError("Malformed event bounds");
  }
  if (
    item.attendees !== undefined &&
    !(Array.isArray(item.attendees) && item.attendees.every(isRecord))
  ) {
    throw protocolError("Malformed event attendees");
  }
  return toProviderEvent(item as GoogleEvent)!;
}

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
  if (status === 404)
    return new CalendarProviderError("not_found", status, "not_found");
  if (
    status === 403 &&
    (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")
  ) {
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
        (attendee) => attendee.self && attendee.responseStatus === "declined",
      ),
    ),
    etag: event.etag ?? null,
    updated: event.updated ?? null,
  };
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
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        !audience.includes(options.clientId) ||
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
