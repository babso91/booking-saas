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
