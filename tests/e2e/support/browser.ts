import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

import { HUB_URL } from "./hub-ingress";

// Real Chromium for the Client Hub: cookies are stored, sent and replaced
// by the browser itself from the responses' real Set-Cookie headers, never
// by the test. *.hub.test resolves to the local ingress; nothing goes
// through an HTTP proxy (the hub is local).

export async function launchBrowser(): Promise<Browser> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/_proxy$/i.test(name)) delete env[name];
  }
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      "--host-resolver-rules=MAP *.hub.test 127.0.0.1",
      "--no-proxy-server",
    ],
    env,
  });
}

/** One browser profile (one cookie jar shared by all its tabs). */
export async function newProfile(
  browser: Browser,
  options: { broadcastChannel?: boolean } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: HUB_URL,
  });
  if (options.broadcastChannel === false) {
    // The coordination between tabs is unavailable (old browser, blocked,
    // a frozen tab): correctness must not depend on it.
    await context.addInitScript(() => {
      // @ts-expect-error -- removed on purpose
      delete window.BroadcastChannel;
    });
  }
  return context;
}

export type Answer = {
  status: number;
  body: { data?: Record<string, unknown>; error?: { code: string } } | null;
  account: string | null;
};

/** A request made by the page itself (the browser's own fetch, cookies included). */
export function call(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  return page.evaluate(
    async ([method, path, body]) => {
      try {
        const response = await fetch(path as string, {
          method: method as string,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
          credentials: "same-origin",
          cache: "no-store",
        });
        return {
          status: response.status,
          body: await response.json().catch(() => null),
          account: response.headers.get("x-client-hub-account"),
        };
      } catch {
        return { status: 0, body: null, account: null };
      }
    },
    [method, path, body] as const,
  );
}

/** The code emailed to `address` (Mailpit). */
export async function codeFor(mailpitUrl: string, address: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const body = (await response.json()) as {
      messages?: { Subject: string }[];
    };
    const subject = body.messages?.[0]?.Subject;
    if (subject) return subject.slice(0, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No code was emailed to ${address}`);
}

/** Asks a code; the verification request, ready to be sent by `page`. */
export async function prepareSignIn(
  page: Page,
  mailpitUrl: string,
  address: string,
) {
  const asked = await call(page, "POST", "/api/client-hub/session/code", {
    email: address,
  });
  if (asked.status !== 202) {
    throw new Error(`Code request answered ${asked.status}`);
  }
  const code = await codeFor(mailpitUrl, address);
  const body = {
    challengeId: asked.body!.data!.challengeId,
    email: address,
    code,
  };
  return () => call(page, "POST", "/api/client-hub/session/verify", body);
}

export async function signIn(page: Page, mailpitUrl: string, address: string) {
  const verified = await (await prepareSignIn(page, mailpitUrl, address))();
  if (verified.status !== 200) {
    throw new Error(`Sign-in answered ${verified.status}`);
  }
  return verified;
}

/** A session cookie's name, before the session id (any prefix generation). */
const SESSION_NAME = /^(__Host-)?client_hub_s_/;

/** The session cookies Chromium holds, as it stores them. */
export async function sessionCookies(context: BrowserContext) {
  return (await context.cookies())
    .filter((cookie) => SESSION_NAME.test(cookie.name))
    .map((cookie) => ({
      session: cookie.name.replace(SESSION_NAME, ""),
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
}

/** Where the session id of a verify answer is: the cookie it added. */
export async function newestSession(context: BrowserContext, before: string[]) {
  const now = (await sessionCookies(context)).map((cookie) => cookie.session);
  return now.filter((session) => !before.includes(session));
}
