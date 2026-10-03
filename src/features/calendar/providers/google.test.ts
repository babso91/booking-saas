import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { FakeGoogle } from "../../../../tests/support/fake-google";
import {
  createGoogleCalendarProvider,
  GOOGLE_SCOPES,
  toProviderEvent,
} from "./google";
import type { RetryPolicy } from "./http";

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
