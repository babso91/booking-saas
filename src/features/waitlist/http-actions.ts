import type {
  WaitlistActions,
  WaitlistOfferDto,
  WaitlistRequestDto,
  WaitlistResult,
} from "./contract";

// The waitlist's routes, from the browser (docs/WAITLIST_CONTRACT.md).
// An offer or a confirmation is authorized by the token of her link: it
// lives in the URL fragment (never sent with a page request nor in a
// referrer) and is passed here, to the API only, as a header or a body.

const TIMEOUT_MS = 15_000;

async function call<T>(
  url: string,
  init: RequestInit,
): Promise<WaitlistResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
        cache: "no-store",
        // The token must never travel in a referrer.
        referrerPolicy: "no-referrer",
      });
    } catch {
      return { ok: false, error: { code: "network" } };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: { code: "network" } };
    }
    const payload = body as { data?: T; error?: { code?: unknown } } | null;
    if (response.ok && payload?.data !== undefined)
      return { ok: true, data: payload.data };
    const code = payload?.error?.code;
    return {
      ok: false,
      error: { code: typeof code === "string" ? code : "internal" },
    };
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const offerUrl = (offerId: string) =>
  `/api/waitlist/offers/${encodeURIComponent(offerId)}`;

/** The actions of the screens, bound to the token of her link if any. */
export function httpWaitlistActions(token?: string): WaitlistActions {
  const auth: Record<string, string> = token
    ? { "x-waitlist-token": token }
    : {};
  return {
    join: (input) =>
      call<WaitlistRequestDto>("/api/waitlist/requests", json(input)),
    offer: (offerId) =>
      call<WaitlistOfferDto>(offerUrl(offerId), {
        method: "GET",
        headers: auth,
      }),
    claim: ({ offerId, ...command }) =>
      call<WaitlistOfferDto>(`${offerUrl(offerId)}/claim`, json(command, auth)),
  };
}

/** Confirms her request from the link of the email (double opt-in). */
export function confirmWaitlistRequest(token: string) {
  return call<WaitlistRequestDto>(
    "/api/waitlist/requests/confirm",
    json({ token }),
  );
}

/** The token in the fragment of her link (`#t=…`), or null. */
export function tokenFromFragment(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}
