import { createHash, randomUUID } from "node:crypto";

// In-memory Google (OAuth 2.0 + Calendar API v3) for tests: authorization
// codes with PKCE, refresh/revoke, calendarList and events.list with
// pagination, sync tokens and 410, injected failures, watch/stop channels.
// A paginated listing (full or incremental) is one coherent chain, as
// Google's sync protocol guarantees: its first request takes a snapshot and
// a change watermark, its page tokens read that snapshot (never an offset
// into the collection as it is now), and its final sync token is the
// watermark, so every change made while the pages were read shows up in
// the next incremental listing.
// Outbound: incremental authorization (scopes granted per account, kept by
// include_granted_scopes), calendars.insert/get (app-created calendars,
// calendar.app.created required), events insert/update/delete with custom
// ids (409 on an existing id, cancelled events kept and restorable),
// events.patch with Google's merge semantics (fields not sent unchanged,
// nested objects merged, null removes, arrays replaced), and answers lost
// after the request was applied.
// Only the behaviour the adapter relies on is modelled.

/** The position of a page token in its listing (tests). */
export function pageOffsetOf(url: URL) {
  const token = url.searchParams.get("pageToken");
  const match = token ? /^p\d+-(\d+)$/.exec(token) : null;
  return match ? Number(match[1]) : null;
}

export const WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";

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
  extendedProperties?: { private?: Record<string, string> };
  // Fields only the professional sets (never written by Booking).
  description?: string;
  location?: string;
  colorId?: string;
  reminders?: unknown;
};

type StoredEvent = FakeEvent & { etag: string; updated: string; seq: number };

type Account = { sub: string; email: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Google's patch semantics on a JSON resource. */
function mergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isObject(value) && isObject(result[key])) {
      result[key] = mergePatch(result[key], value);
    } else if (isObject(value)) {
      result[key] = mergePatch({}, value);
    } else result[key] = value;
  }
  return result;
}

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

/** Rejects when the signal aborts (never resolves without one). */
function aborted(signal: AbortSignal | null | undefined) {
  return new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** What the API returns for an event: no internal counter; the title only
 * when the field mask asks for it (inbound's does not, reconciliation's
 * does). Google omits transparency when it is the default (opaque). */
function publicEvent(event: StoredEvent, fields: string | null = null) {
  const copy: Partial<StoredEvent> = { ...event };
  delete copy.seq;
  if (!fields?.includes("summary")) delete copy.summary;
  if (copy.transparency === "opaque") delete copy.transparency;
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
  /** Overrides of the id_token claims (e.g. an expired `exp`). */
  idTokenClaims: Record<string, unknown> = {};
  /** Called on every request before it is answered (concurrent changes). */
  readonly hooks: ((url: URL, method: string) => void | Promise<void>)[] = [];

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
  /**
   * What events.patch does to a deleted (cancelled) event, which Google's
   * reference does not specify: `keeps_cancelled` (the fields are merged,
   * the event stays deleted), `restores` (undeleted like by update), or
   * `gone` (410). The writer must converge in every case.
   */
  patchOnCancelled: "keeps_cancelled" | "restores" | "gone" = "keeps_cancelled";
  /** When true, the consent screen grants everything but the write scope. */
  denyWriteScope = false;
  /**
   * When true, calendars created from now on stay out of calendarList
   * (Google's list not up to date yet) until revealCalendars().
   */
  hideNewCalendars = false;
  private hidden = new Set<string>();
  private codes = new Map<
    string,
    {
      account: Account;
      challenge: string;
      redirectUri: string;
      scopes: string[];
    }
  >();
  /** Scopes granted per account beyond `grantedScopes` (incremental). */
  private extraScopes = new Map<string, Set<string>>();
  private refreshTokens = new Map<
    string,
    Account & { revoked: boolean; scopes: string[] }
  >();
  private accessTokens = new Map<
    string,
    { account: Account; expiresAt: number; scopes: string[] }
  >();
  private calendars = new Map<
    string,
    {
      id: string;
      summary: string;
      timeZone: string;
      primary?: boolean;
      accessRole: string;
      description?: string;
      appCreated?: boolean;
    }[]
  >();
  private lostAnswers: {
    match: (url: URL, method: string) => boolean;
    times: number;
  }[] = [];
  private events = new Map<string, Map<string, StoredEvent>>();
  private expiredSyncTokens = new Set<string>();
  /** Listings being paginated: snapshot and change watermark. */
  private listings = new Map<
    string,
    { items: StoredEvent[]; watermark: number }
  >();
  private listingSeq = 0;
  private failures: Failure[] = [];
  private holds: {
    match: (url: URL, method: string) => boolean;
    reached: () => void;
    released: Promise<void>;
  }[] = [];

  /**
   * Holds the next matching request: its answer is computed at once (the
   * provider's state at that time) but delivered only after `release()`, as
   * a slow network would. `reached` resolves when the request arrived.
   */
  hold(match: (url: URL, method: string) => boolean) {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.holds.push({ match, reached, released });
    return { reached: reachedPromise, release };
  }

  /**
   * The authorization step: Google redirects back with this code. The
   * requested scopes are granted to the account (all but the write scope
   * when `denyWriteScope`), on top of what it granted before.
   */
  authorize(account: Account, authorizationUrl: string) {
    const url = new URL(authorizationUrl);
    const code = `code-${randomUUID()}`;
    const requested = (url.searchParams.get("scope") ?? "")
      .split(" ")
      .filter(Boolean);
    this.codes.set(code, {
      account,
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      scopes: requested,
    });
    return { code, state: url.searchParams.get("state") ?? "" };
  }

  /**
   * Applies the next matching request(s) but loses the answer (a network
   * failure seen by the caller), as when a connection drops after Google
   * processed the request.
   */
  loseAnswer(match: (url: URL, method: string) => boolean, times = 1) {
    this.lostAnswers.push({ match, times });
  }

  revealCalendars() {
    this.hidden.clear();
  }

  /** The professional edits a calendar's description in Google. */
  setDescription(calendarId: string, description: string) {
    for (const list of this.calendars.values()) {
      for (const calendar of list) {
        if (calendar.id === calendarId) calendar.description = description;
      }
    }
  }

  /** Adds a calendar to an account's list (an earlier attempt's, say). */
  addCalendar(
    sub: string,
    calendar: {
      id: string;
      summary: string;
      timeZone: string;
      description?: string;
      appCreated?: boolean;
    },
  ) {
    const list = this.calendars.get(sub) ?? [];
    list.push({ accessRole: "owner", ...calendar });
    this.calendars.set(sub, list);
    if (!this.events.has(calendar.id)) this.events.set(calendar.id, new Map());
  }

  /** Calendars an account created through the app (outbound). */
  appCalendars(sub: string) {
    return (this.calendars.get(sub) ?? []).filter(
      (calendar) => calendar.appCreated,
    );
  }

  /** The professional deletes a calendar in Google. */
  deleteCalendar(calendarId: string) {
    for (const [sub, list] of this.calendars) {
      this.calendars.set(
        sub,
        list.filter((calendar) => calendar.id !== calendarId),
      );
    }
    this.events.delete(calendarId);
  }

  /** Events stored in a calendar (cancelled ones included). */
  storedEvents(calendarId: string) {
    return [...(this.events.get(calendarId)?.values() ?? [])].sort(
      (a, b) => a.seq - b.seq,
    );
  }

  /** Changes a calendar's time zone (as in Google's settings). */
  setTimeZone(calendarId: string, timeZone: string) {
    for (const list of this.calendars.values()) {
      for (const calendar of list) {
        if (calendar.id === calendarId) calendar.timeZone = timeZone;
      }
    }
  }

  setCalendars(
    sub: string,
    calendars: {
      id: string;
      summary: string;
      timeZone: string;
      primary?: boolean;
      accessRole?: string;
      description?: string;
      appCreated?: boolean;
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

  /**
   * The professional edits an event in Google (a change for incremental
   * sync): `change` is merged into the stored event.
   */
  editEvent(
    calendarId: string,
    eventId: string,
    change: Partial<FakeEvent> & Record<string, unknown>,
  ) {
    const existing = this.events.get(calendarId)?.get(eventId);
    if (!existing) throw new Error(`No event ${eventId}`);
    const event: Partial<StoredEvent> = { ...existing, ...change };
    delete event.etag;
    delete event.updated;
    delete event.seq;
    this.putEvent(calendarId, event as FakeEvent);
  }

  /**
   * An event Google no longer lists at all (a deleted event purged after a
   * while): only a full listing can notice its absence.
   */
  purgeEvent(calendarId: string, eventId: string) {
    this.events.get(calendarId)?.delete(eventId);
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
    return entry && entry.expiresAt > Date.now() ? entry : null;
  }

  /** Every scope the account granted to the app (include_granted_scopes). */
  private scopesOf(account: Account) {
    return [
      ...new Set([
        ...this.grantedScopes,
        ...(this.extraScopes.get(account.sub) ?? []),
      ]),
    ];
  }

  private issueTokens(
    account: Account,
    withRefresh: boolean,
    scopes = this.scopesOf(account),
  ) {
    const accessToken = `at-${randomUUID()}`;
    this.accessTokens.set(accessToken, {
      account,
      expiresAt: Date.now() + this.accessTokenLifetime * 1000,
      scopes,
    });
    const body: Record<string, unknown> = {
      access_token: accessToken,
      expires_in: this.accessTokenLifetime,
      token_type: "Bearer",
      scope: scopes.join(" "),
      id_token: jwt({
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        sub: account.sub,
        email: account.email,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...this.idTokenClaims,
      }),
    };
    if (withRefresh) {
      const refreshToken = `rt-${randomUUID()}`;
      this.refreshTokens.set(refreshToken, {
        ...account,
        revoked: false,
        scopes,
      });
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
    for (const hook of this.hooks) await hook(url, method);

    const response = await this.answer(url, method, body, init);
    const lost = this.lostAnswers.find(
      (item) => item.times > 0 && item.match(url, method),
    );
    if (lost) {
      lost.times -= 1;
      throw new TypeError("fetch failed (answer lost)");
    }
    const hold = this.holds.findIndex((item) => item.match(url, method));
    if (hold >= 0) {
      const [entry] = this.holds.splice(hold, 1);
      entry!.reached();
      // A held answer still honours the caller's timeout (deadline).
      await Promise.race([entry!.released, aborted(init?.signal)]);
    }
    return response;
  };

  private async answer(
    url: URL,
    method: string,
    body: string,
    init?: RequestInit,
  ): Promise<Response> {
    const failure = this.failures.find(
      (item) => item.times > 0 && item.match(url),
    );
    if (failure) {
      failure.times -= 1;
      if (typeof failure.body === "string") {
        // A raw body (e.g. not JSON at all).
        return new Response(failure.body, {
          status: failure.status,
          headers: failure.headers,
        });
      }
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
        if (entry.scopes.includes(WRITE_SCOPE) && !this.denyWriteScope) {
          const extra = this.extraScopes.get(entry.account.sub) ?? new Set();
          extra.add(WRITE_SCOPE);
          this.extraScopes.set(entry.account.sub, extra);
        }
        return json(this.issueTokens(entry.account, this.sendRefreshToken));
      }
      if (form.get("grant_type") === "refresh_token") {
        const entry = this.refreshTokens.get(form.get("refresh_token") ?? "");
        if (!entry || entry.revoked)
          return json({ error: "invalid_grant" }, 400);
        // Google: a refresh token grants what its authorization granted.
        return json(
          this.issueTokens(
            { sub: entry.sub, email: entry.email },
            false,
            entry.scopes,
          ),
        );
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

    const bearer = this.bearer(init);
    if (!bearer)
      return json(
        { error: { code: 401, message: "Invalid Credentials" } },
        401,
      );
    const account = bearer.account;

    const outbound = this.outbound(url, method, body, bearer);
    if (outbound) return outbound;

    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      const all = (this.calendars.get(account.sub) ?? []).filter(
        (calendar) => !this.hidden.has(calendar.id),
      );
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
  }

  /** Outbound endpoints (calendar.app.created), or null. */
  private outbound(
    url: URL,
    method: string,
    body: string,
    bearer: { account: Account; scopes: string[] },
  ): Response | null {
    const insufficient = () =>
      json(
        {
          error: {
            code: 403,
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
        403,
      );
    const canWrite = bearer.scopes.includes(WRITE_SCOPE);
    const list = this.calendars.get(bearer.account.sub) ?? [];

    if (url.pathname === "/calendar/v3/calendars" && method === "POST") {
      if (!canWrite) return insufficient();
      const request = JSON.parse(body) as {
        summary?: string;
        description?: string;
        timeZone?: string;
      };
      if (!request.summary) return json({ error: { code: 400 } }, 400);
      const id = `${randomUUID().replace(/-/g, "")}@group.calendar.google.com`;
      list.push({
        id,
        summary: request.summary,
        description: request.description,
        timeZone: request.timeZone ?? "UTC",
        accessRole: "owner",
        appCreated: true,
      });
      this.calendars.set(bearer.account.sub, list);
      this.events.set(id, new Map());
      if (this.hideNewCalendars) this.hidden.add(id);
      return json({ id, summary: request.summary });
    }

    const calendarMatch = /^\/calendar\/v3\/calendars\/([^/]+)$/.exec(
      url.pathname,
    );
    if (calendarMatch && method === "GET") {
      const id = decodeURIComponent(calendarMatch[1]!);
      const calendar = list.find((item) => item.id === id);
      if (!calendar) return json({ error: { code: 404 } }, 404);
      if (!calendar.appCreated && !canWrite) return insufficient();
      return json({ id });
    }

    const eventMatch =
      /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
    if (!eventMatch || (method === "GET" && !eventMatch[2])) return null;
    if (eventMatch[2] === "watch") return null;
    const calendarId = decodeURIComponent(eventMatch[1]!);
    const calendar = list.find((item) => item.id === calendarId);
    if (!calendar) return json({ error: { code: 404 } }, 404);
    // calendar.app.created: only the calendars the app created.
    if (!canWrite || !calendar.appCreated) return insufficient();
    const store = this.events.get(calendarId)!;

    if (method === "POST" && !eventMatch[2]) {
      const event = JSON.parse(body) as FakeEvent;
      if (!/^[a-v0-9]{5,1024}$/.test(event.id)) {
        return json({ error: { code: 400 } }, 400);
      }
      if (store.has(event.id)) {
        return json(
          { error: { code: 409, errors: [{ reason: "duplicate" }] } },
          409,
        );
      }
      this.putEvent(calendarId, { ...event, status: "confirmed" });
      return json({ id: event.id });
    }

    const eventId = decodeURIComponent(eventMatch[2]!);
    const existing = store.get(eventId);
    if (method === "PATCH") {
      if (!existing) return json({ error: { code: 404 } }, 404);
      if (existing.status === "cancelled" && this.patchOnCancelled === "gone") {
        return json({ error: { code: 410, message: "deleted" } }, 410);
      }
      const current: Partial<StoredEvent> = { ...existing };
      delete current.etag;
      delete current.updated;
      delete current.seq;
      const patch = JSON.parse(body) as Record<string, unknown>;
      const merged = mergePatch(
        current as Record<string, unknown>,
        patch,
      ) as FakeEvent;
      if (
        existing.status === "cancelled" &&
        this.patchOnCancelled === "keeps_cancelled"
      ) {
        merged.status = "cancelled";
      }
      this.putEvent(calendarId, { ...merged, id: eventId });
      const fields = url.searchParams.get("fields");
      const stored = store.get(eventId)!;
      return json(
        fields === "id,status"
          ? { id: eventId, status: stored.status }
          : publicEvent(stored, "summary"),
      );
    }
    if (method === "PUT") {
      if (!existing) return json({ error: { code: 404 } }, 404);
      const event = JSON.parse(body) as Omit<FakeEvent, "id">;
      // A cancelled event of the organizer's calendar is restored.
      this.putEvent(calendarId, {
        ...event,
        id: eventId,
        status: event.status ?? "confirmed",
      });
      return json({ id: eventId });
    }
    if (method === "DELETE") {
      if (!existing) return json({ error: { code: 404 } }, 404);
      if (existing.status === "cancelled") {
        return json({ error: { code: 410, message: "deleted" } }, 410);
      }
      this.putEvent(calendarId, { ...existing, status: "cancelled" });
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      if (!existing) return json({ error: { code: 404 } }, 404);
      return json(publicEvent(existing));
    }
    return null;
  }

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
      // showDeleted: a full listing includes deleted (cancelled) events.
      const showDeleted = url.searchParams.get("showDeleted") === "true";
      items = store.filter(
        (event) =>
          (showDeleted || event.status !== "cancelled") &&
          bound(event.end) > timeMin - 86_400_000 &&
          bound(event.start) < timeMax + 86_400_000,
      );
    }

    let listing: { items: StoredEvent[]; watermark: number } | undefined;
    let offset = 0;
    const pageToken = url.searchParams.get("pageToken");
    if (pageToken) {
      const match = /^p(\d+)-(\d+)$/.exec(pageToken);
      listing = match ? this.listings.get(match[1]!) : undefined;
      if (!match || !listing) {
        return json(
          { error: { code: 400, message: "Invalid page token" } },
          400,
        );
      }
      offset = Number(match[2]);
    } else {
      // The listing's snapshot: what changes from now on is after its
      // watermark, hence in the next incremental listing.
      listing = { items, watermark: this.seq };
      this.listingSeq += 1;
      this.listings.set(String(this.listingSeq), listing);
    }
    const id = pageToken
      ? /^p(\d+)-/.exec(pageToken)![1]
      : String(this.listingSeq);
    const page = listing.items.slice(offset, offset + this.pageSize);
    const last = offset + this.pageSize >= listing.items.length;
    return json({
      timeZone: this.calendarsById(calendarId)?.timeZone ?? "UTC",
      items: page.map((event) =>
        publicEvent(event, url.searchParams.get("fields")),
      ),
      ...(last
        ? { nextSyncToken: `sync-${listing.watermark}` }
        : { nextPageToken: `p${id}-${offset + this.pageSize}` }),
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
