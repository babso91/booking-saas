import { describe, expect, inject, it } from "vitest";

// The customer's hub pages, served by `next start` (the production build)
// with the production defaults: no trusted ingress, no email delivery. The
// pages are shells (no page reads the session cookie), and
// the sign-in honestly reports that codes cannot be sent: no bypass.

const APP = inject("e2e").appUrl;
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_SESSION = "00000000-0000-4000-8000-000000000000";

const PAGES = [
  "/espace",
  "/espace/connexion",
  `/espace/${BUSINESS}/rendez-vous`,
  `/espace/${BUSINESS}/rendez-vous/22222222-2222-4222-8222-222222222222`,
  `/espace/${BUSINESS}/fidelite`,
];

describe("Client Hub pages (production build)", () => {
  it.each(PAGES)(
    "%s is served without any session, private data or cookie, and not indexed",
    async (path) => {
      const response = await fetch(new URL(path, APP), { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie") ?? "").not.toMatch(
        /client_hub/,
      );
      const html = await response.text();
      expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
      // Nothing is rendered on the server but the frame: no balance, no
      // appointment, no greeting by name.
      expect(html).not.toMatch(/Solde :|Bonjour [A-Z]/);
    },
  );

  it("a page does not accept a session cookie as a way to render data server-side", async () => {
    const response = await fetch(new URL("/espace", APP), {
      headers: {
        cookie: `__Host-client_hub_s_${UNKNOWN_SESSION}=${"a".repeat(64)}`,
      },
    });
    const html = await response.text();
    expect(html).not.toMatch(/Solde :|Bonjour [A-Z]/);
  });

  // A read carrying an unknown session cookie is refused for real: 401
  // client_hub_unauthenticated (never another failure taken for a refusal),
  // uncached, naming no account, and its only Set-Cookie deletes that very
  // cookie (a session cookie is named after its session: deleting it can
  // never erase another session).
  it("a read carrying an unknown session cookie: 401, uncached, deleting only that cookie", async () => {
    const name = `__Host-client_hub_s_${UNKNOWN_SESSION}`;
    for (const path of [
      "/api/client-hub/me",
      `/api/client-hub/businesses/${BUSINESS}/loyalty`,
    ]) {
      const response = await fetch(new URL(path, APP), {
        headers: { cookie: `${name}=${"c".repeat(64)}` },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "client_hub_unauthenticated" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-client-hub-account")).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([
        `${name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
      ]);
    }
  });

  it("the reads the pages make require the session cookie: 401, uncached", async () => {
    const response = await fetch(new URL("/api/client-hub/me", APP));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "client_hub_unauthenticated" },
    });
  });

  it("asking for a code without email delivery configured: the honest unavailable state the sign-in shows", async () => {
    const response = await fetch(new URL("/api/client-hub/session/code", APP), {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify({ email: "cliente@test.local" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "client_hub_unavailable" },
    });
  });
});
