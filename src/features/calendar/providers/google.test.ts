import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { FakeGoogle } from "../../../../tests/support/fake-google";
import {
  createGoogleCalendarProvider,
  GOOGLE_SCOPES,
  toProviderEvent,
} from "./google";
import { DeadlineExceededError, type RetryPolicy } from "./http";

const fastRetry: RetryPolicy = {
  retries: 2,
  baseDelayMs: 1,
  maxDelayMs: 2,
  timeoutMs: 2000,
  sleep: async () => undefined,
};

const REDIRECT = "https://app.test/api/calendar/google/callback";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const account = { sub: "google-sub-1", email: "mila@example.test" };

let fake: FakeGoogle;
let provider: ReturnType<typeof createGoogleCalendarProvider>;

beforeEach(() => {
  fake = new FakeGoogle();
  provider = createGoogleCalendarProvider({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    fetch: fake.fetch,
    retry: fastRetry,
  });
});

async function connect() {
  const url = provider.authorizationUrl({
    state: "s",
    codeChallenge: challenge,
    redirectUri: REDIRECT,
  });
  const { code } = fake.authorize(account, url);
  return provider.exchangeCode({
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
  });
}

describe("Google OAuth", () => {
  it("asks for offline access, consent, PKCE S256 and the narrow scopes only", () => {
    const url = new URL(
      provider.authorizationUrl({
        state: "st",
        codeChallenge: challenge,
        redirectUri: REDIRECT,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: fake.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      ...GOOGLE_SCOPES,
    ]);
    expect(url.searchParams.get("scope")).not.toMatch(
      /auth\/calendar( |$)|calendar\.events( |$)/,
    );
  });

  it("exchanges the code with the verifier and reads the account from the id_token", async () => {
    const tokens = await connect();
    expect(tokens.account).toEqual({
      id: "google-sub-1",
      email: "mila@example.test",
    });
    expect(tokens.refreshToken).toMatch(/^rt-/);
    expect(tokens.scopes).toEqual(
      expect.arrayContaining([...provider.requiredScopes]),
    );
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a wrong verifier (PKCE) and an id_token for another client", async () => {
    const url = provider.authorizationUrl({
      state: "s",
      codeChallenge: challenge,
      redirectUri: REDIRECT,
    });
    const { code } = fake.authorize(account, url);
    await expect(
      provider.exchangeCode({
        code,
        codeVerifier: "w".repeat(64),
        redirectUri: REDIRECT,
      }),
    ).rejects.toMatchObject({ kind: "auth_revoked" });

    const other = createGoogleCalendarProvider({
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      fetch: async (input, init) => {
        const response = await fake.fetch(input, init);
        const body = await response.json();
        if (body.id_token) {
          const [h, , s] = (body.id_token as string).split(".");
          const payload = Buffer.from(
            JSON.stringify({
              iss: "https://accounts.google.com",
              aud: "someone-else",
              sub: "x",
            }),
          ).toString("base64url");
          body.id_token = `${h}.${payload}.${s}`;
        }
        return new Response(JSON.stringify(body), { status: response.status });
      },
      retry: fastRetry,
    });
    const second = fake.authorize(account, url);
    await expect(
      other.exchangeCode({
        code: second.code,
        codeVerifier: verifier,
        redirectUri: REDIRECT,
      }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("refreshes, and reports a revoked grant as auth_revoked", async () => {
    const tokens = await connect();
    const fresh = await provider.refreshAccessToken(tokens.refreshToken!);
    expect(fresh.accessToken).toMatch(/^at-/);

    fake.revokeAll();
    await expect(
      provider.refreshAccessToken(tokens.refreshToken!),
    ).rejects.toMatchObject({
      kind: "auth_revoked",
    });
  });

  it("revokes, treating an already revoked token as done", async () => {
    const tokens = await connect();
    await provider.revoke(tokens.refreshToken!);
    await provider.revoke(tokens.refreshToken!);
    expect(fake.revoked).toEqual([tokens.refreshToken, tokens.refreshToken]);
  });
});

describe("Google Calendar API", () => {
  it("lists every calendar across pages", async () => {
    fake.pageSize = 2;
    fake.setCalendars(account.sub, [
      {
        id: "mila@example.test",
        summary: "Personnel",
        timeZone: "Europe/Paris",
        primary: true,
      },
      { id: "work", summary: "Travail", timeZone: "Europe/Paris" },
      {
        id: "birthdays",
        summary: "Anniversaires",
        timeZone: "Europe/Paris",
        accessRole: "reader",
      },
    ]);
    const tokens = await connect();
    const calendars = await provider.listCalendars(tokens.accessToken);
    expect(
      calendars.map((calendar) => [
        calendar.name,
        calendar.primary,
        calendar.accessRole,
      ]),
    ).toEqual([
      ["Personnel", true, "owner"],
      ["Travail", false, "owner"],
      ["Anniversaires", false, "reader"],
    ]);
  });

  it("lists events page by page with the same parameters, then incrementally", async () => {
    fake.pageSize = 2;
    fake.setCalendars(account.sub, [
      { id: "work", summary: "Travail", timeZone: "Europe/Paris" },
    ]);
    for (let i = 1; i <= 5; i += 1) {
      fake.putEvent("work", {
        id: `e${i}`,
        summary: "Secret title",
        start: { dateTime: `2026-10-0${i}T14:00:00+02:00` },
        end: { dateTime: `2026-10-0${i}T15:00:00+02:00` },
      });
    }
    const tokens = await connect();
    const query = {
      kind: "full" as const,
      timeMin: "2026-09-30T00:00:00Z",
      timeMax: "2027-11-01T00:00:00Z",
    };

    const ids: string[] = [];
    let pageToken: string | null = null;
    let syncToken: string | null = null;
    do {
      const page = await provider.listEvents(
        tokens.accessToken,
        "work",
        query,
        pageToken,
      );
      ids.push(...page.events.map((event) => event.id));
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken ?? syncToken;
      expect(page.events.every((event) => !("summary" in event))).toBe(true);
    } while (pageToken);
    expect(ids).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(syncToken).toMatch(/^sync-/);

    const fullRequests = fake.requests.filter((request) =>
      request.url.pathname.endsWith("/events"),
    );
    for (const request of fullRequests) {
      expect(request.url.searchParams.get("singleEvents")).toBe("true");
      expect(request.url.searchParams.get("fields")).not.toContain("summary");
      expect(request.url.searchParams.get("timeMin")).toBe(query.timeMin);
    }

    fake.deleteEvent("work", "e2");
    const changes = await provider.listEvents(
      tokens.accessToken,
      "work",
      { kind: "incremental", syncToken: syncToken! },
      null,
    );
    expect(changes.events.map((event) => [event.id, event.status])).toEqual([
      ["e2", "cancelled"],
    ]);
    const last = fake.requests.at(-1)!.url;
    expect(last.searchParams.get("syncToken")).toBe(syncToken);
    expect(last.searchParams.has("timeMin")).toBe(false);
    expect(last.searchParams.has("timeMax")).toBe(false);

    fake.expireSyncTokens();
    await expect(
      provider.listEvents(
        tokens.accessToken,
        "work",
        { kind: "incremental", syncToken: syncToken! },
        null,
      ),
    ).rejects.toMatchObject({ kind: "gone", status: 410 });
  });

  it("classifies 401, 403 rate limits, retries 429/5xx and gives up", async () => {
    fake.setCalendars(account.sub, [
      { id: "work", summary: "Travail", timeZone: "UTC" },
    ]);
    const tokens = await connect();
    const query = {
      kind: "full" as const,
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2027-01-01T00:00:00Z",
    };
    const events = (url: URL) => url.pathname.endsWith("/events");

    await expect(
      provider.listEvents("bad-token", "work", query, null),
    ).rejects.toMatchObject({
      kind: "unauthorized",
    });

    fake.failNext(events, 403, 1, {
      error: { errors: [{ reason: "rateLimitExceeded" }] },
    });
    await expect(
      provider.listEvents(tokens.accessToken, "work", query, null),
    ).rejects.toMatchObject({
      kind: "rate_limited",
    });

    fake.failNext(events, 429, 2);
    await expect(
      provider.listEvents(tokens.accessToken, "work", query, null),
    ).resolves.toMatchObject({
      events: [],
    });

    fake.failNext(events, 503, 3);
    await expect(
      provider.listEvents(tokens.accessToken, "work", query, null),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("watches and stops a channel", async () => {
    fake.setCalendars(account.sub, [
      { id: "work", summary: "Travail", timeZone: "UTC" },
    ]);
    const tokens = await connect();
    const watched = await provider.watchEvents(tokens.accessToken, "work", {
      id: "6f1d4a1e-1111-4111-8111-111111111111",
      token: "channel-token",
      address: "https://app.test/hook",
    });
    expect(watched.resourceId).toBe("res-work");
    expect(watched.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await provider.stopChannel(tokens.accessToken, {
      id: "6f1d4a1e-1111-4111-8111-111111111111",
      resourceId: watched.resourceId,
    });
    expect(
      fake.channels.get("6f1d4a1e-1111-4111-8111-111111111111")?.stopped,
    ).toBe(true);
    // Already stopped or unknown: fine.
    await provider.stopChannel(tokens.accessToken, {
      id: "unknown",
      resourceId: "r",
    });
  });
});

describe("toProviderEvent", () => {
  it("keeps what blocking needs and nothing personal", () => {
    expect(
      toProviderEvent({
        id: "e",
        status: "confirmed",
        start: { dateTime: "2026-10-02T14:00:00+02:00" },
        end: { dateTime: "2026-10-02T15:00:00+02:00" },
        attendees: [
          { self: false, responseStatus: "accepted" },
          { self: true, responseStatus: "declined" },
        ],
      }),
    ).toEqual({
      id: "e",
      recurringEventId: null,
      status: "confirmed",
      start: { dateTime: "2026-10-02T14:00:00+02:00" },
      end: { dateTime: "2026-10-02T15:00:00+02:00" },
      transparency: null,
      eventType: null,
      declined: true,
      etag: null,
      updated: null,
    });
    expect(toProviderEvent({ status: "confirmed" })).toBeNull();
    expect(
      toProviderEvent({ id: "t", transparency: "transparent" })?.transparency,
    ).toBe("transparent");
  });
});

const timedBounds = {
  start: { dateTime: "2026-10-01T10:00:00Z" },
  end: { dateTime: "2026-10-01T11:00:00Z" },
};

describe("strict protocol", () => {
  async function token() {
    fake.setCalendars(account.sub, [
      { id: "cal", summary: "Travail", timeZone: "Europe/Paris" },
    ]);
    return (await connect()).accessToken;
  }
  const full = {
    kind: "full" as const,
    timeMin: "2026-01-01T00:00:00Z",
    timeMax: "2027-01-01T00:00:00Z",
  };
  const isEvents = (url: URL) => url.pathname.endsWith("/events");

  it.each([
    ["unparsable JSON", "<html>"],
    ["an array", []],
    ["an empty object", {}],
    ["items of the wrong type", { items: "x", nextSyncToken: "s" }],
    ["a last page without cursor", { items: [] }],
    ["both cursors", { items: [], nextPageToken: "p", nextSyncToken: "s" }],
    ["an empty cursor", { items: [], nextSyncToken: "" }],
    ["an item that is not an object", { items: [1], nextSyncToken: "s" }],
    [
      "an event without id",
      { items: [{ status: "confirmed" }], nextSyncToken: "s" },
    ],
    [
      "an event without bounds",
      { items: [{ id: "e", status: "confirmed" }], nextSyncToken: "s" },
    ],
    [
      "an event with a malformed date",
      {
        items: [
          { id: "e", start: { date: "2026-13" }, end: { date: "2026-10-02" } },
        ],
        nextSyncToken: "s",
      },
    ],
    [
      "an event with date and dateTime",
      {
        items: [
          {
            id: "e",
            start: { date: "2026-10-01", dateTime: "2026-10-01T10:00:00Z" },
            end: { date: "2026-10-02" },
          },
        ],
        nextSyncToken: "s",
      },
    ],
    [
      "an event mixing all-day and timed bounds",
      {
        items: [
          {
            id: "e",
            start: { date: "2026-10-01" },
            end: { dateTime: "2026-10-01T10:00:00Z" },
          },
        ],
        nextSyncToken: "s",
      },
    ],
    ...(
      [
        [
          "a date that does not exist",
          { start: { date: "2026-02-30" }, end: { date: "2026-03-01" } },
        ],
        [
          "an hour out of range",
          {
            start: { dateTime: "2026-10-01T24:30:00Z" },
            end: { dateTime: "2026-10-02T01:00:00Z" },
          },
        ],
        [
          "an offset out of range",
          {
            start: { dateTime: "2026-10-01T10:00:00+15:00" },
            end: { dateTime: "2026-10-01T11:00:00Z" },
          },
        ],
        [
          "a date-time with neither offset nor zone",
          {
            start: { dateTime: "2026-10-01T10:00:00" },
            end: { dateTime: "2026-10-01T11:00:00" },
          },
        ],
        [
          "attendee self as a string",
          {
            ...timedBounds,
            attendees: [{ self: "false", responseStatus: "declined" }],
          },
        ],
        [
          "attendee self as a number",
          {
            ...timedBounds,
            attendees: [{ self: 1, responseStatus: "declined" }],
          },
        ],
        [
          "an unknown response status",
          {
            ...timedBounds,
            attendees: [{ self: true, responseStatus: "maybe" }],
          },
        ],
        [
          "an attendee that is not an object",
          { ...timedBounds, attendees: ["x"] },
        ],
        ["an unknown status", { ...timedBounds, status: "maybe" }],
        ["an unknown transparency", { ...timedBounds, transparency: "clear" }],
        ["a non-string event type", { ...timedBounds, eventType: 3 }],
        ["a malformed updated", { ...timedBounds, updated: "yesterday" }],
        ["an empty recurringEventId", { ...timedBounds, recurringEventId: "" }],
      ] as [string, Record<string, unknown>][]
    ).map(
      ([name, fields]) =>
        [name, { items: [{ id: "e", ...fields }], nextSyncToken: "s" }] as [
          string,
          unknown,
        ],
    ),
  ])("refuses an events page with %s", async (_, body) => {
    const accessToken = await token();
    fake.failNext(isEvents, 200, 1, body);
    await expect(
      provider.listEvents(accessToken, "cal", full, null),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("accepts valid events: zoned local times, Apia's missing day, declined by the account", async () => {
    const accessToken = await token();
    fake.failNext(isEvents, 200, 1, {
      items: [
        {
          id: "local",
          start: { dateTime: "2026-10-01T10:00:00", timeZone: "Europe/Paris" },
          end: { dateTime: "2026-10-01T11:00:00", timeZone: "Europe/Paris" },
        },
        // Syntactically valid; PostgreSQL decides it occupies no time.
        {
          id: "apia",
          start: { date: "2011-12-30" },
          end: { date: "2011-12-31" },
        },
        {
          id: "declined",
          ...timedBounds,
          attendees: [
            { self: false, responseStatus: "accepted" },
            { self: true, responseStatus: "declined" },
          ],
        },
        {
          id: "other-declined",
          ...timedBounds,
          attendees: [{ self: false, responseStatus: "declined" }],
        },
      ],
      nextSyncToken: "s",
    });
    const page = await provider.listEvents(accessToken, "cal", full, null);
    expect(page.events.map((event) => [event.id, event.declined])).toEqual([
      ["local", false],
      ["apia", false],
      ["declined", true],
      ["other-declined", false],
    ]);
  });

  it("passes empty or inverted intervals on to PostgreSQL (bounds may be in different zones)", async () => {
    const accessToken = await token();
    fake.failNext(isEvents, 200, 1, {
      items: [
        {
          id: "ny-la",
          start: {
            dateTime: "2026-10-01T10:00:00",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-10-01T09:00:00",
            timeZone: "America/Los_Angeles",
          },
        },
        {
          id: "inverted",
          start: { dateTime: "2026-10-01T12:00:00+02:00" },
          end: { dateTime: "2026-10-01T09:30:00Z" },
        },
        {
          id: "empty",
          start: { date: "2026-10-02" },
          end: { date: "2026-10-02" },
        },
      ],
      nextSyncToken: "s",
    });
    const page = await provider.listEvents(accessToken, "cal", full, null);
    expect(page.events.map((event) => event.id)).toEqual([
      "ny-la",
      "inverted",
      "empty",
    ]);
  });

  it("accepts a cancelled event reduced to its id, and an empty last page", async () => {
    const accessToken = await token();
    fake.failNext(isEvents, 200, 1, {
      items: [{ id: "gone", status: "cancelled" }],
      nextSyncToken: "s",
      timeZone: "Europe/Paris",
    });
    const page = await provider.listEvents(accessToken, "cal", full, null);
    expect(page).toMatchObject({
      events: [{ id: "gone", status: "cancelled" }],
      nextPageToken: null,
      nextSyncToken: "s",
      timezone: "Europe/Paris",
    });
    const empty = await provider.listEvents(accessToken, "cal", full, null);
    expect(empty).toMatchObject({
      events: [],
      nextSyncToken: expect.any(String),
    });
  });

  it.each([
    ["an empty object", {}, 1],
    ["no calendar", { items: [] }, 1],
    ["an item without id", { items: [{ summary: "x" }] }, 1],
    [
      "more pages than read",
      { items: [{ id: "c" }], nextPageToken: "more" },
      4,
    ],
  ])("refuses a calendar list with %s", async (_, body, times) => {
    const accessToken = await token();
    fake.failNext(
      (url) => url.pathname.endsWith("/calendarList"),
      200,
      times,
      body,
    );
    await expect(provider.listCalendars(accessToken)).rejects.toMatchObject({
      kind: "protocol",
    });
  });

  it("refuses a successful token answer that is not JSON", async () => {
    await token();
    fake.failNext((url) => url.pathname === "/token", 200, 1, "oops");
    await expect(provider.refreshAccessToken("rt")).rejects.toMatchObject({
      kind: "protocol",
    });
  });
});

describe("id_token claims", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it.each([
    ["expired", { exp: now() - 3600 }],
    ["without exp", { exp: undefined }],
    ["issued in the future", { iat: now() + 3600 }],
    ["for another audience", { aud: "other.apps.googleusercontent.com" }],
    [
      "for another authorized party",
      { azp: "other.apps.googleusercontent.com" },
    ],
    ["from another issuer", { iss: "https://evil.test" }],
    ["without subject", { sub: "" }],
    ["with a non-string email", { email: 42 }],
    ["with an empty audience list", { aud: [] }],
    [
      "with another audience next to ours",
      { aud: ["other.apps.googleusercontent.com", "CLIENT"] },
    ],
  ] as [string, Record<string, unknown>][])(
    "refuses an id_token %s",
    async (_, claims) => {
      fake.idTokenClaims = Array.isArray(claims.aud)
        ? {
            ...claims,
            aud: (claims.aud as string[]).map((value) =>
              value === "CLIENT" ? fake.clientId : value,
            ),
          }
        : claims;
      await expect(connect()).rejects.toMatchObject({ kind: "bad_request" });
    },
  );

  it("refuses another audience next to ours, even with azp = our client", async () => {
    fake.idTokenClaims = {
      aud: [fake.clientId, "other.apps.googleusercontent.com"],
      azp: fake.clientId,
    };
    await expect(connect()).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("accepts aud = our client as a string or a one-element list, with or without azp", async () => {
    for (const claims of [
      { aud: fake.clientId },
      { aud: fake.clientId, azp: fake.clientId },
      { aud: [fake.clientId] },
    ]) {
      fake.idTokenClaims = claims;
      await expect(connect()).resolves.toMatchObject({
        account: { id: account.sub },
      });
    }
  });

  it("accepts a one-element audience list and a little clock skew", async () => {
    fake.idTokenClaims = {
      aud: [fake.clientId],
      exp: now() - 60,
      azp: fake.clientId,
    };
    await expect(connect()).resolves.toMatchObject({
      account: { id: account.sub },
    });
  });
});

describe("Google outbound (calendar.app.created)", () => {
  async function writer() {
    const url = provider.writeAuthorizationUrl({
      state: "w",
      codeChallenge: challenge,
      redirectUri: REDIRECT,
      loginHint: account.sub,
    });
    const { code } = fake.authorize(account, url);
    return provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
  }

  const event = (id: string) => ({
    id,
    summary: "Léa — Coupe",
    startsAt: "2026-10-14T14:00:00+00:00",
    endsAt: "2026-10-14T15:00:00+00:00",
    privateProperties: { origin: "booking-saas", appointmentId: "a" },
  });

  it("asks for the write scope only, for the connected account", () => {
    const url = new URL(
      provider.writeAuthorizationUrl({
        state: "w",
        codeChallenge: challenge,
        redirectUri: REDIRECT,
        loginHint: account.sub,
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "openid https://www.googleapis.com/auth/calendar.app.created",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      include_granted_scopes: "true",
      login_hint: account.sub,
      access_type: "offline",
      code_challenge_method: "S256",
    });
  });

  it("creates a calendar without retrying (a lost answer is recovered by its marker)", async () => {
    fake.setCalendars(account.sub, [
      { id: account.email, summary: "Moi", timeZone: "UTC", primary: true },
    ]);
    const tokens = await writer();
    fake.failNext((url) => url.pathname === "/calendar/v3/calendars", 503, 1);
    await expect(
      provider.createCalendar(tokens.accessToken, {
        summary: "Rendez-vous — Studio",
        description:
          "booking-saas:0b9c5a3e-1f2a-4c3d-9e8f-123456789abc:1a2b3c4d-1f2a-4c3d-9e8f-123456789abc",
        timeZone: "Europe/Paris",
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(fake.count((url) => url.pathname === "/calendar/v3/calendars")).toBe(
      1,
    );

    const { id } = await provider.createCalendar(tokens.accessToken, {
      summary: "Rendez-vous — Studio",
      description:
        "booking-saas:0b9c5a3e-1f2a-4c3d-9e8f-123456789abc:1a2b3c4d-1f2a-4c3d-9e8f-123456789abc",
      timeZone: "Europe/Paris",
    });
    const listed = await provider.listCalendars(tokens.accessToken);
    expect(listed.find((calendar) => calendar.id === id)).toMatchObject({
      bookingMarker: "0b9c5a3e-1f2a-4c3d-9e8f-123456789abc",
      bookingNonce: "1a2b3c4d-1f2a-4c3d-9e8f-123456789abc",
    });
    expect(
      listed.find((calendar) => calendar.id === account.email)?.bookingMarker,
    ).toBeNull();
    expect(await provider.calendarExists(tokens.accessToken, id)).toBe(true);
    fake.deleteCalendar(id);
    expect(await provider.calendarExists(tokens.accessToken, id)).toBe(false);
  });

  it("inserts with a deterministic base32hex id, 409 on a second insert, update restores, delete is idempotent", async () => {
    fake.setCalendars(account.sub, [
      { id: account.email, summary: "Moi", timeZone: "UTC", primary: true },
    ]);
    const tokens = await writer();
    const { id: calendarId } = await provider.createCalendar(
      tokens.accessToken,
      { summary: "R", description: "d", timeZone: "UTC" },
    );
    const id = "bk0123456789abcdef0123456789abcdef";
    await provider.insertEvent(tokens.accessToken, calendarId, event(id));
    await expect(
      provider.insertEvent(tokens.accessToken, calendarId, event(id)),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(await provider.deleteEvent(tokens.accessToken, calendarId, id)).toBe(
      true,
    );
    expect(await provider.deleteEvent(tokens.accessToken, calendarId, id)).toBe(
      false,
    );
    await provider.restoreEvent(tokens.accessToken, calendarId, event(id));
    expect(fake.storedEvents(calendarId)).toMatchObject([
      { id, status: "confirmed", summary: "Léa — Coupe" },
    ]);
    const insert = fake.requests.find(
      (request) =>
        request.method === "POST" && request.url.pathname.endsWith("/events"),
    )!;
    expect(insert.url.searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.parse(insert.body)).toEqual({
      id,
      summary: "Léa — Coupe",
      start: { dateTime: "2026-10-14T14:00:00+00:00" },
      end: { dateTime: "2026-10-14T15:00:00+00:00" },
      status: "confirmed",
      transparency: "opaque",
      extendedProperties: {
        private: { origin: "booking-saas", appointmentId: "a" },
      },
    });
    // Never an id Google would refuse.
    await expect(
      provider.insertEvent(tokens.accessToken, calendarId, event("Bad-ID")),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it.each([
    ["rateLimitExceeded", "rate_limited"],
    ["userRateLimitExceeded", "rate_limited"],
    ["quotaExceeded", "rate_limited"],
    ["dailyLimitExceeded", "rate_limited"],
    ["insufficientPermissions", "forbidden"],
    ["forbiddenForNonOrganizer", "forbidden"],
  ])("403 %s is classified %s", async (reason, kind) => {
    fake.setCalendars(account.sub, [
      { id: account.email, summary: "Moi", timeZone: "UTC", primary: true },
    ]);
    const tokens = await writer();
    const { id: calendarId } = await provider.createCalendar(
      tokens.accessToken,
      { summary: "R", description: "d", timeZone: "UTC" },
    );
    fake.failNext((url) => url.pathname.endsWith("/events"), 403, 1, {
      error: { code: 403, errors: [{ reason }] },
    });
    await expect(
      provider.insertEvent(
        tokens.accessToken,
        calendarId,
        event("bk0123456789abcdef0123456789abcdef"),
      ),
    ).rejects.toMatchObject({ kind, status: 403 });
  });

  it("refuses writes to calendars the app did not create (403 forbidden)", async () => {
    fake.setCalendars(account.sub, [
      { id: account.email, summary: "Moi", timeZone: "UTC", primary: true },
    ]);
    const tokens = await writer();
    await expect(
      provider.insertEvent(
        tokens.accessToken,
        account.email,
        event("bk0123456789abcdef0123456789abcdef"),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("reconciliation listing and comparison", () => {
  const expected = {
    id: "bk00000000000000000000000000000001",
    summary: "Léa — Coupe",
    startsAt: "2026-10-14T14:00:00+00:00",
    endsAt: "2026-10-14T15:00:00+00:00",
    privateProperties: {
      origin: "booking-saas",
      appointmentId: "a1",
      revision: "3",
    },
  };
  const listed = {
    id: expected.id,
    status: "confirmed",
    summary: "Léa — Coupe",
    start: { dateTime: "2026-10-14T14:00:00Z" },
    end: { dateTime: "2026-10-14T15:00:00Z" },
    transparency: null,
    privateProperties: {
      origin: "booking-saas",
      appointmentId: "a1",
      revision: "1",
    },
  };

  it("lists every event (deleted included) with fixed parameters and the owned fields only; a sync token goes along, never a time bound", async () => {
    const tokens = await connect();
    fake.setCalendars(account.sub, [
      { id: "cal", summary: "Booking", timeZone: "UTC" },
    ]);
    fake.putEvent("cal", {
      id: expected.id,
      summary: "Léa — Coupe",
      start: { dateTime: expected.startsAt },
      end: { dateTime: expected.endsAt },
      extendedProperties: { private: { origin: "booking-saas" } },
    });
    fake.putEvent("cal", {
      id: "gone1",
      status: "cancelled",
      start: { dateTime: expected.startsAt },
      end: { dateTime: expected.endsAt },
    });
    const full = await provider.listOwnedEvents(
      tokens.accessToken,
      "cal",
      { kind: "full" },
      null,
    );
    expect(full.events.map((event) => [event.id, event.status])).toEqual([
      [expected.id, "confirmed"],
      ["gone1", "cancelled"],
    ]);
    expect(full.events[0]).toMatchObject({
      summary: "Léa — Coupe",
      privateProperties: { origin: "booking-saas" },
    });
    expect(full.nextSyncToken).toMatch(/^sync-/);
    const first = fake.requests.at(-1)!.url;
    expect(Object.fromEntries(first.searchParams)).toMatchObject({
      showDeleted: "true",
      maxResults: "250",
    });
    for (const absent of ["timeMin", "timeMax", "singleEvents", "orderBy"]) {
      expect(first.searchParams.has(absent)).toBe(false);
    }
    expect(first.searchParams.get("fields")).not.toMatch(
      /description|attendees/,
    );

    await provider.listOwnedEvents(
      tokens.accessToken,
      "cal",
      { kind: "incremental", syncToken: full.nextSyncToken! },
      null,
    );
    const next = fake.requests.at(-1)!.url;
    expect(next.searchParams.get("syncToken")).toBe(full.nextSyncToken);
    expect(next.searchParams.get("showDeleted")).toBe("true");
    expect(next.searchParams.get("fields")).toBe(
      first.searchParams.get("fields"),
    );

    fake.expireSyncTokens();
    await expect(
      provider.listOwnedEvents(
        tokens.accessToken,
        "cal",
        { kind: "incremental", syncToken: full.nextSyncToken! },
        null,
      ),
    ).rejects.toMatchObject({ kind: "gone" });
  });

  it.each([
    ["items not a list", { items: {}, nextSyncToken: "s" }],
    ["no cursor", { items: [] }],
    ["both cursors", { items: [], nextSyncToken: "s", nextPageToken: "p" }],
    ["an event without id", { items: [{}], nextSyncToken: "s" }],
    [
      "metadata of the wrong type",
      {
        items: [{ id: "x1234", extendedProperties: { private: { a: 1 } } }],
        nextSyncToken: "s",
      },
    ],
  ])("a malformed page fails as a whole (%s)", async (_label, body) => {
    const tokens = await connect();
    fake.setCalendars(account.sub, [
      { id: "cal", summary: "Booking", timeZone: "UTC" },
    ]);
    fake.failNext(() => true, 200, 1, body);
    await expect(
      provider.listOwnedEvents(
        tokens.accessToken,
        "cal",
        { kind: "full" },
        null,
      ),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("compares the owned fields only, instants as instants", () => {
    const differs = provider.ownedEventDiffers;
    expect(differs(expected, listed)).toBe(false);
    for (const same of [
      { start: { dateTime: "2026-10-14T16:00:00+02:00" } },
      { end: { dateTime: "2026-10-14T10:00:00.000-05:00" } },
      { transparency: "opaque" },
      { start: { dateTime: "2026-10-14T14:00:00Z", timeZone: "Asia/Tokyo" } },
    ]) {
      expect(differs(expected, { ...listed, ...same })).toBe(false);
    }
    for (const changed of [
      { status: "cancelled" },
      { status: "tentative" },
      { summary: "Autre" },
      { summary: null },
      { transparency: "transparent" },
      { start: { dateTime: "2026-10-14T14:01:00Z" } },
      { end: { dateTime: "2026-10-14T15:00:00" } },
      { start: { date: "2026-10-14" } },
      { start: null },
      { privateProperties: null },
      {
        privateProperties: { origin: "booking-saas", appointmentId: "other" },
      },
    ]) {
      expect(differs(expected, { ...listed, ...changed })).toBe(true);
    }
    // Must not exist: only a live event differs.
    expect(differs(null, { ...listed, status: "cancelled" })).toBe(false);
    expect(differs(null, listed)).toBe(true);
  });
});

describe("partial update and restoration", () => {
  const event = {
    id: "bk0123456789abcdef0123456789abcdef",
    summary: "Léa — Coupe",
    startsAt: "2026-10-14T14:00:00+00:00",
    endsAt: "2026-10-14T15:00:00+00:00",
    privateProperties: {
      origin: "booking-saas",
      appointmentId: "a",
      revision: "2",
    },
  };

  async function calendarWithEvent() {
    fake.setCalendars(account.sub, [
      { id: account.email, summary: "Moi", timeZone: "UTC", primary: true },
    ]);
    const url = provider.writeAuthorizationUrl({
      state: "w",
      codeChallenge: challenge,
      redirectUri: REDIRECT,
      loginHint: account.sub,
    });
    const { code } = fake.authorize(account, url);
    const tokens = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
    const { id: calendarId } = await provider.createCalendar(
      tokens.accessToken,
      { summary: "R", description: "d", timeZone: "UTC" },
    );
    await provider.insertEvent(tokens.accessToken, calendarId, event);
    return { token: tokens.accessToken, calendarId };
  }

  it("patches the managed fields only: no unmanaged key, all-day date removed, private keys merged", async () => {
    const { token, calendarId } = await calendarWithEvent();
    fake.editEvent(calendarId, event.id, {
      description: "Note",
      colorId: "4",
      start: { date: "2026-10-14" },
      extendedProperties: { private: { other: "x" } },
    });
    expect(
      await provider.patchEvent(token, calendarId, {
        ...event,
        summary: "Zoé — Coupe",
      }),
    ).toEqual({ status: "confirmed" });

    const request = fake.requests.at(-1)!;
    expect(request.method).toBe("PATCH");
    expect(request.url.searchParams.get("sendUpdates")).toBe("none");
    expect(request.url.searchParams.get("fields")).toBe("id,status");
    expect(JSON.parse(request.body)).toEqual({
      summary: "Zoé — Coupe",
      start: { dateTime: event.startsAt, date: null },
      end: { dateTime: event.endsAt, date: null },
      status: "confirmed",
      transparency: "opaque",
      extendedProperties: { private: event.privateProperties },
    });
    const [stored] = fake.storedEvents(calendarId);
    expect(stored).toMatchObject({
      summary: "Zoé — Coupe",
      description: "Note",
      colorId: "4",
      start: { dateTime: event.startsAt },
      extendedProperties: {
        private: { ...event.privateProperties, other: "x" },
      },
    });
    expect(stored!.start.date).toBeUndefined();
  });

  it("reports a deleted event it did not restore; restoreEvent rewrites the canonical event (PUT)", async () => {
    const { token, calendarId } = await calendarWithEvent();
    await provider.deleteEvent(token, calendarId, event.id);
    expect(await provider.patchEvent(token, calendarId, event)).toEqual({
      status: "cancelled",
    });
    fake.patchOnCancelled = "gone";
    await expect(
      provider.patchEvent(token, calendarId, event),
    ).rejects.toMatchObject({ kind: "gone" });
    await provider.restoreEvent(token, calendarId, event);
    expect(fake.requests.at(-1)!.method).toBe("PUT");
    expect(fake.storedEvents(calendarId)).toMatchObject([
      { id: event.id, status: "confirmed", summary: "Léa — Coupe" },
    ]);
    await expect(
      provider.patchEvent(token, calendarId, { ...event, id: "bkmissing00" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("a malformed patch answer is a protocol error", async () => {
    const { token, calendarId } = await calendarWithEvent();
    fake.failNext(() => true, 200, 1, { id: event.id });
    await expect(
      provider.patchEvent(token, calendarId, event),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("unmanaged fields never differ", () => {
    const listed = {
      id: event.id,
      status: "confirmed",
      summary: event.summary,
      start: { dateTime: event.startsAt },
      end: { dateTime: event.endsAt },
      transparency: null,
      privateProperties: { ...event.privateProperties, other: "y" },
    };
    expect(provider.ownedEventDiffers(event, listed)).toBe(false);
  });
});

describe("fake Google: a paginated listing is one coherent chain", () => {
  const timed = (id: string, hour: number) => ({
    id,
    summary: id,
    start: { dateTime: `2026-10-14T${String(hour).padStart(2, "0")}:00:00Z` },
    end: { dateTime: `2026-10-14T${String(hour + 1).padStart(2, "0")}:00:00Z` },
  });

  async function calendar() {
    const tokens = await connect();
    fake.setCalendars(account.sub, [
      { id: "cal", summary: "Booking", timeZone: "UTC" },
    ]);
    fake.putEvent("cal", timed("evta1", 9));
    fake.putEvent("cal", timed("evtb1", 10));
    fake.putEvent("cal", timed("evtc1", 11));
    fake.pageSize = 1;
    return tokens.accessToken;
  }

  /** Every page of a listing; `between` runs after the first page. */
  async function listAll(
    token: string,
    query: { kind: "full" } | { kind: "incremental"; syncToken: string },
    between: () => void = () => undefined,
  ) {
    const seen: { id: string; status: string; summary: string | null }[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await provider.listOwnedEvents(
        token,
        "cal",
        query,
        pageToken,
      );
      seen.push(
        ...result.events.map(({ id, status, summary }) => ({
          id,
          status,
          summary,
        })),
      );
      if (page === 0) between();
      if (result.nextSyncToken)
        return { seen, syncToken: result.nextSyncToken };
      pageToken = result.nextPageToken;
    }
    throw new Error("listing never ended");
  }

  it.each([
    [
      "created",
      () => fake.putEvent("cal", timed("evtd1", 12)),
      { id: "evtd1", status: "confirmed" },
    ],
    [
      "modified (already listed)",
      () => fake.editEvent("cal", "evta1", { summary: "changed" }),
      { id: "evta1", summary: "changed" },
    ],
    [
      "deleted (not listed yet)",
      () => fake.deleteEvent("cal", "evtc1"),
      { id: "evtc1", status: "cancelled" },
    ],
  ])(
    "full listing: an event %s between two pages is never lost — the next incremental listing returns it",
    async (_label, change, expected) => {
      const token = await calendar();
      const full = await listAll(token, { kind: "full" }, change);
      // The pages read one snapshot: every original event exactly once.
      expect(full.seen.map((event) => event.id)).toEqual([
        "evta1",
        "evtb1",
        "evtc1",
      ]);
      const next = await listAll(token, {
        kind: "incremental",
        syncToken: full.syncToken,
      });
      expect(next.seen).toEqual([expect.objectContaining(expected)]);
    },
  );

  it("incremental listing: a change between its pages comes in the following incremental listing", async () => {
    const token = await calendar();
    const full = await listAll(token, { kind: "full" });
    fake.editEvent("cal", "evta1", { summary: "a2" });
    fake.editEvent("cal", "evtb1", { summary: "b2" });
    const first = await listAll(
      token,
      { kind: "incremental", syncToken: full.syncToken },
      () => fake.editEvent("cal", "evtc1", { summary: "c2" }),
    );
    expect(first.seen.map((event) => event.summary)).toEqual(["a2", "b2"]);
    const second = await listAll(token, {
      kind: "incremental",
      syncToken: first.syncToken,
    });
    expect(second.seen.map((event) => event.summary)).toEqual(["c2"]);
    const third = await listAll(token, {
      kind: "incremental",
      syncToken: second.syncToken,
    });
    expect(third.seen).toEqual([]);
  });

  it("a page token belongs to its listing: an unknown one is refused", async () => {
    const token = await calendar();
    await expect(
      provider.listOwnedEvents(token, "cal", { kind: "full" }, "p999-1"),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });
});

describe("deadline cut while reading an answer", () => {
  it("a body cut by the call's own deadline is the deadline (DeadlineExceededError), not a protocol failure", async () => {
    const slow = createGoogleCalendarProvider({
      clientId: "c",
      clientSecret: "s",
      retry: { ...fastRetry, timeoutMs: 10_000 },
      fetch: async (_url, init) => {
        const signal = init!.signal!;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () =>
              controller.error(signal.reason),
            );
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    await expect(
      slow.listEvents(
        "token",
        "cal",
        { kind: "incremental", syncToken: "s1" },
        null,
        { deadline: Date.now() + 100 },
      ),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});
