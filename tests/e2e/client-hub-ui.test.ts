import { describe, expect, inject, it } from "vitest";

// The customer's hub pages, served by `next start` (the production build)
// with the production defaults: no trusted ingress, no email delivery. The
// pages are shells (the session cookie is scoped to /api/client-hub), and
// the sign-in honestly reports that codes cannot be sent: no bypass.

const APP = inject("e2e").appUrl;
const BUSINESS = "11111111-1111-4111-8111-111111111111";

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
        /client_hub_session/,
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
      headers: { cookie: `client_hub_session=${"a".repeat(64)}` },
    });
    const html = await response.text();
    expect(html).not.toMatch(/Solde :|Bonjour [A-Z]/);
  });

  it("a read with an unknown session is refused without deleting any cookie (a late refusal must never erase a newer session)", async () => {
    for (const path of [
      "/api/client-hub/me",
      `/api/client-hub/businesses/${BUSINESS}/loyalty`,
    ]) {
      const response = await fetch(new URL(path, APP), {
        headers: { cookie: `client_hub_session=${"c".repeat(64)}` },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toEqual([]);
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
