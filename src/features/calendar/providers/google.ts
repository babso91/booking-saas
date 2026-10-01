import {
  defaultRetryPolicy,
  sendWithRetry,
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

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part)
    throw new CalendarProviderError("bad_request", null, "Malformed id_token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
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

  async function call(url: string, init: RequestInit) {
    const response = await sendWithRetry(fetchImpl, url, init, retry);
    const body = await readJson(response);
    if (!response.ok) throw errorFor(response.status, body);
    return body;
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
      if (typeof accessToken !== "string" || typeof idToken !== "string") {
        throw new CalendarProviderError(
          "bad_request",
          null,
          "Incomplete token response",
        );
      }
      // Received directly from Google's token endpoint over TLS: its claims
      // are trusted without signature check (OpenID Connect, §3.1.3.7), but
      // the audience and issuer must be ours and Google's.
      const claims = decodeJwtPayload(idToken);
      if (
        claims.aud !== options.clientId ||
        (claims.iss !== "https://accounts.google.com" &&
          claims.iss !== "accounts.google.com") ||
        typeof claims.sub !== "string"
      ) {
        throw new CalendarProviderError(
          "bad_request",
          null,
          "Unexpected id_token",
        );
      }

      return {
        accessToken,
        expiresAt: new Date(
          Date.now() + Number(body.expires_in ?? 3600) * 1000,
        ),
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

    async refreshAccessToken(refreshToken) {
      const body = await call(
        TOKEN_URL,
        form({
          refresh_token: refreshToken,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: "refresh_token",
        }),
      );
      if (typeof body.access_token !== "string") {
        throw new CalendarProviderError(
          "bad_request",
          null,
          "Incomplete token response",
        );
      }
      return {
        accessToken: body.access_token,
        expiresAt: new Date(
          Date.now() + Number(body.expires_in ?? 3600) * 1000,
        ),
      };
    },

    async revoke(token) {
      const response = await sendWithRetry(
        fetchImpl,
        REVOKE_URL,
        form({ token }),
        retry,
      );
      // 400 invalid_token: already revoked or expired, which is the goal.
      if (!response.ok && response.status !== 400) {
        throw errorFor(response.status, await readJson(response));
      }
    },

    async listCalendars(accessToken) {
      const calendars: ProviderCalendar[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
        const url = new URL(`${API}/users/me/calendarList`);
        url.searchParams.set("maxResults", "250");
        url.searchParams.set("fields", CALENDAR_FIELDS);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = await call(url.toString(), {
          headers: bearer(accessToken),
        });
        for (const item of (body.items as
          Record<string, unknown>[] | undefined) ?? []) {
          if (typeof item.id !== "string") continue;
          calendars.push({
            id: item.id,
            name: String(item.summaryOverride ?? item.summary ?? item.id),
            timezone: typeof item.timeZone === "string" ? item.timeZone : null,
            primary: item.primary === true,
            accessRole:
              typeof item.accessRole === "string" ? item.accessRole : null,
          });
        }
        pageToken =
          typeof body.nextPageToken === "string" ? body.nextPageToken : null;
        if (!pageToken) break;
      }
      return calendars;
    },

    async listEvents(
      accessToken,
      calendarId,
      query: EventQuery,
      pageToken,
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

      const body = await call(url.toString(), { headers: bearer(accessToken) });
      return {
        events: ((body.items as GoogleEvent[] | undefined) ?? [])
          .map(toProviderEvent)
          .filter((event): event is ProviderEvent => event !== null),
        nextPageToken:
          typeof body.nextPageToken === "string" ? body.nextPageToken : null,
        nextSyncToken:
          typeof body.nextSyncToken === "string" ? body.nextSyncToken : null,
        timezone: typeof body.timeZone === "string" ? body.timeZone : null,
      };
    },

    async watchEvents(accessToken, calendarId, channel) {
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
      );
      if (typeof body.resourceId !== "string") {
        throw new CalendarProviderError(
          "bad_request",
          null,
          "Incomplete watch response",
        );
      }
      return {
        resourceId: body.resourceId,
        expiresAt: new Date(Number(body.expiration ?? Date.now() + 86_400_000)),
      };
    },

    async stopChannel(accessToken, channel) {
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
      );
      // 404: already stopped or expired.
      if (!response.ok && response.status !== 404) {
        throw errorFor(response.status, await readJson(response));
      }
    },
  };
}
