import { createHash, randomUUID } from "node:crypto";

// In-memory Google (OAuth 2.0 + Calendar API v3) for tests: authorization
// codes with PKCE, refresh/revoke, calendarList and events.list with
// pagination, sync tokens and 410, injected failures, watch/stop channels.
// Only the behaviour the adapter relies on is modelled.

export type FakeEvent = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  transparency?: "opaque" | "transparent";
  eventType?: string;
  recurringEventId?: string;
  attendees?: { self?: boolean; responseStatus?: string; email?: string }[];
  summary?: string;
};

type StoredEvent = FakeEvent & { etag: string; updated: string; seq: number };

type Account = { sub: string; email: string };

type Failure = {
  match: (url: URL) => boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
};

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function jwt(payload: Record<string, unknown>) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.`;
}

/** What the API returns for an event: no internal counter, no title (the
 * adapter asks for a field mask without it). */
function publicEvent(event: StoredEvent) {
  const copy: Partial<StoredEvent> = { ...event };
  delete copy.seq;
  delete copy.summary;
  return copy;
}

export class FakeGoogle {
  readonly clientId = CLIENT_ID;
  readonly clientSecret = CLIENT_SECRET;
  /** Events per page (Google: up to 250; small here to test pagination). */
  pageSize = 250;
  /** When false, token responses carry no refresh token (re-consent case). */
  sendRefreshToken = true;
  grantedScopes = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ];
  accessTokenLifetime = 3600;

  readonly requests: { method: string; url: URL; body: string }[] = [];
  readonly revoked: string[] = [];
  readonly channels = new Map<
    string,
    {
      calendarId: string;
      resourceId: string;
      token: string;
      address: string;
      stopped: boolean;
    }
  >();

  private seq = 0;
  private codes = new Map<
    string,
    { account: Account; challenge: string; redirectUri: string }
  >();
  private refreshTokens = new Map<string, Account & { revoked: boolean }>();
  private accessTokens = new Map<
    string,
    { account: Account; expiresAt: number }
  >();
  private calendars = new Map<
    string,
    {
      id: string;
      summary: string;
      timeZone: string;
      primary?: boolean;
      accessRole: string;
    }[]
  >();
  private events = new Map<string, Map<string, StoredEvent>>();
  private expiredSyncTokens = new Set<string>();
  private failures: Failure[] = [];

  /** The authorization step: Google redirects back with this code. */
  authorize(account: Account, authorizationUrl: string) {
    const url = new URL(authorizationUrl);
    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      account,
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
    });
    return { code, state: url.searchParams.get("state") ?? "" };
  }

  setCalendars(
    sub: string,
    calendars: {
      id: string;
      summary: string;
      timeZone: string;
      primary?: boolean;
      accessRole?: string;
    }[],
  ) {
    this.calendars.set(
      sub,
      calendars.map((calendar) => ({ accessRole: "owner", ...calendar })),
    );
    for (const calendar of calendars) {
      if (!this.events.has(calendar.id))
        this.events.set(calendar.id, new Map());
    }
  }

  /** Creates or replaces an event (a change for incremental sync). */
  putEvent(calendarId: string, event: FakeEvent) {
    this.seq += 1;
    const store = this.events.get(calendarId) ?? new Map<string, StoredEvent>();
    this.events.set(calendarId, store);
    store.set(event.id, {
      status: "confirmed",
      ...event,
      etag: `"${this.seq}"`,
      updated: new Date(Date.UTC(2026, 8, 1) + this.seq * 1000).toISOString(),
      seq: this.seq,
    });
  }

  /** Deletes an event: incremental syncs see it as cancelled. */
  deleteEvent(calendarId: string, eventId: string) {
    const existing = this.events.get(calendarId)?.get(eventId);
    if (!existing) return;
    this.putEvent(calendarId, { ...existing, status: "cancelled" });
  }

  /** Makes the given sync token (or every token issued so far) answer 410. */
  expireSyncTokens() {
    for (let seq = 0; seq <= this.seq; seq += 1)
      this.expiredSyncTokens.add(`sync-${seq}`);
  }

  revokeAll() {
    for (const value of this.refreshTokens.values()) value.revoked = true;
    this.accessTokens.clear();
  }

  expireAccessTokens() {
    for (const value of this.accessTokens.values()) value.expiresAt = 0;
  }

  failNext(
    match: (url: URL) => boolean,
    status: number,
    times = 1,
    body: unknown = {},
    headers: Record<string, string> = {},
  ) {
    this.failures.push({ match, status, times, body, headers });
  }

  count(predicate: (url: URL, method: string) => boolean) {
    return this.requests.filter((request) =>
      predicate(request.url, request.method),
    ).length;
  }

  private bearer(init?: RequestInit) {
    const header = new Headers(init?.headers).get("authorization") ?? "";
    const token = header.replace(/^Bearer /, "");
    const entry = this.accessTokens.get(token);
    return entry && entry.expiresAt > Date.now() ? entry.account : null;
  }

  private issueTokens(account: Account, withRefresh: boolean) {
    const accessToken = `at-${randomUUID()}`;
    this.accessTokens.set(accessToken, {
      account,
      expiresAt: Date.now() + this.accessTokenLifetime * 1000,
    });
    const body: Record<string, unknown> = {
      access_token: accessToken,
      expires_in: this.accessTokenLifetime,
      token_type: "Bearer",
      scope: this.grantedScopes.join(" "),
      id_token: jwt({
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        sub: account.sub,
        email: account.email,
      }),
    };
    if (withRefresh) {
      const refreshToken = `rt-${randomUUID()}`;
      this.refreshTokens.set(refreshToken, { ...account, revoked: false });
      body.refresh_token = refreshToken;
    }
    return body;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    const body = typeof init?.body === "string" ? init.body : "";
    const method = init?.method ?? "GET";
    this.requests.push({ method, url, body });

    const failure = this.failures.find(
      (item) => item.times > 0 && item.match(url),
    );
    if (failure) {
      failure.times -= 1;
      return json(failure.body ?? {}, failure.status, failure.headers);
    }

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      const form = new URLSearchParams(body);
      if (
        form.get("client_id") !== CLIENT_ID ||
        form.get("client_secret") !== CLIENT_SECRET
      ) {
        return json({ error: "invalid_client" }, 401);
      }
      if (form.get("grant_type") === "authorization_code") {
        const entry = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.redirectUri !== form.get("redirect_uri")
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json(this.issueTokens(entry.account, this.sendRefreshToken));
      }
      if (form.get("grant_type") === "refresh_token") {
        const entry = this.refreshTokens.get(form.get("refresh_token") ?? "");
        if (!entry || entry.revoked)
          return json({ error: "invalid_grant" }, 400);
        return json(this.issueTokens(entry, false));
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      const token = new URLSearchParams(body).get("token") ?? "";
      this.revoked.push(token);
      const entry = this.refreshTokens.get(token);
      if (!entry) return json({ error: "invalid_token" }, 400);
      entry.revoked = true;
      return json({});
    }

    if (url.host !== "www.googleapis.com")
      return json({ error: "not_found" }, 404);

    const account = this.bearer(init);
    if (!account)
      return json(
        { error: { code: 401, message: "Invalid Credentials" } },
        401,
      );

    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      const all = this.calendars.get(account.sub) ?? [];
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Math.min(this.pageSize, 250);
      const items = all.slice(offset, offset + size);
      return json({
        items,
        ...(offset + size < all.length
          ? { nextPageToken: String(offset + size) }
          : {}),
      });
    }

    if (url.pathname === "/calendar/v3/channels/stop" && method === "POST") {
      const { id } = JSON.parse(body) as { id: string };
      const channel = this.channels.get(id);
      if (!channel) return json({}, 404);
      channel.stopped = true;
      return new Response(null, { status: 204 });
    }

    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(\/watch)?$/.exec(
      url.pathname,
    );
    if (!match) return json({ error: "not_found" }, 404);
    const calendarId = decodeURIComponent(match[1]!);
    const owned = (this.calendars.get(account.sub) ?? []).some(
      (calendar) => calendar.id === calendarId,
    );
    if (!owned) return json({ error: { code: 404 } }, 404);

    if (match[2]) {
      const request = JSON.parse(body) as {
        id: string;
        token: string;
        address: string;
      };
      const resourceId = `res-${calendarId}`;
      this.channels.set(request.id, {
        calendarId,
        resourceId,
        token: request.token,
        address: request.address,
        stopped: false,
      });
      return json({
        kind: "api#channel",
        id: request.id,
        resourceId,
        expiration: String(Date.now() + 7 * 86_400_000),
      });
    }

    return this.listEvents(calendarId, url);
  };

  private listEvents(calendarId: string, url: URL) {
    const store = [...(this.events.get(calendarId)?.values() ?? [])].sort(
      (a, b) => a.seq - b.seq,
    );
    const syncToken = url.searchParams.get("syncToken");
    let items: StoredEvent[];

    if (syncToken) {
      if (
        this.expiredSyncTokens.has(syncToken) ||
        !/^sync-\d+$/.test(syncToken)
      ) {
        return json(
          { error: { code: 410, message: "Sync token is no longer valid" } },
          410,
        );
      }
      const since = Number(syncToken.slice(5));
      items = store.filter((event) => event.seq > since);
    } else {
      const timeMin = Date.parse(
        url.searchParams.get("timeMin") ?? "1970-01-01T00:00:00Z",
      );
      const timeMax = Date.parse(
        url.searchParams.get("timeMax") ?? "2999-01-01T00:00:00Z",
      );
      const bound = (value: { date?: string; dateTime?: string }) =>
        Date.parse(value.dateTime ?? `${value.date}T00:00:00Z`);
      items = store.filter(
        (event) =>
          event.status !== "cancelled" &&
          bound(event.end) > timeMin - 86_400_000 &&
          bound(event.start) < timeMax + 86_400_000,
      );
    }

    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const page = items.slice(offset, offset + this.pageSize);
    const last = offset + this.pageSize >= items.length;
    return json({
      timeZone: this.calendarsById(calendarId)?.timeZone ?? "UTC",
      items: page.map(publicEvent),
      ...(last
        ? { nextSyncToken: `sync-${this.seq}` }
        : { nextPageToken: String(offset + this.pageSize) }),
    });
  }

  private calendarsById(calendarId: string) {
    for (const list of this.calendars.values()) {
      const found = list.find((calendar) => calendar.id === calendarId);
      if (found) return found;
    }
    return null;
  }
}
