// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpWaitlistActions, tokenFromFragment } from "./http-actions";
import { WaitlistConfirmPage, WaitlistOfferLinkPage } from "./link-pages";

// The pages her emails link to, against a mocked fetch: the token is read
// from the fragment and travels to the API only, never in a page URL.

const TOKEN = "a".repeat(64);
const OFFER_ID = "60000000-0000-4000-8000-000000000001";

const answer = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("tokenFromFragment", () => {
  it("takes only a well-formed token from `#t=`", () => {
    expect(tokenFromFragment(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromFragment("#t=short")).toBeNull();
    expect(tokenFromFragment("")).toBeNull();
  });
});

describe("httpWaitlistActions", () => {
  it("sends the token as a header to the offer route, never in the URL", async () => {
    fetchMock.mockReturnValue(answer(404, { error: { code: "x" } }));
    await httpWaitlistActions(TOKEN).offer(OFFER_ID);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/waitlist/offers/${OFFER_ID}`);
    expect(String(url)).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["x-waitlist-token"]).toBe(
      TOKEN,
    );
    expect(init.referrerPolicy).toBe("no-referrer");
  });

  it("says a cut connection as `network`", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const result = await httpWaitlistActions().join({} as never);
    expect(result).toEqual({ ok: false, error: { code: "network" } });
  });
});

describe("WaitlistConfirmPage", () => {
  it("confirms with the fragment's token and says until when", async () => {
    window.history.replaceState(
      null,
      "",
      `/liste-attente/confirmer#t=${TOKEN}`,
    );
    fetchMock.mockReturnValue(
      answer(200, {
        data: {
          id: "r1",
          state: "active",
          activeUntil: "2026-11-29T18:00:00.000Z",
        },
      }),
    );
    render(<WaitlistConfirmPage />);
    expect(
      await screen.findByRole("heading", {
        name: "Vous êtes sur la liste d’attente",
      }),
    ).toBeTruthy();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(screen.getByText(/rien n’est mis de côté/)).toBeTruthy();
  });

  it("says an expired or used link plainly", async () => {
    window.history.replaceState(
      null,
      "",
      `/liste-attente/confirmer#t=${TOKEN}`,
    );
    fetchMock.mockReturnValue(
      answer(404, { error: { code: "waitlist_request_not_found" } }),
    );
    render(<WaitlistConfirmPage />);
    expect(await screen.findByText("Ce lien n’est plus valable")).toBeTruthy();
  });

  it("asks nothing without a token", () => {
    window.history.replaceState(null, "", "/liste-attente/confirmer");
    render(<WaitlistConfirmPage />);
    expect(screen.getByText("Ce lien est incomplet")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("WaitlistOfferLinkPage", () => {
  it("asks nothing without a token", () => {
    window.history.replaceState(null, "", `/liste-attente/offre/${OFFER_ID}`);
    render(<WaitlistOfferLinkPage offerId={OFFER_ID} />);
    expect(screen.getByText("Ce lien est incomplet")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the offer with the token of the link", async () => {
    window.history.replaceState(
      null,
      "",
      `/liste-attente/offre/${OFFER_ID}#t=${TOKEN}`,
    );
    fetchMock.mockReturnValue(
      answer(404, { error: { code: "waitlist_offer_not_found" } }),
    );
    render(<WaitlistOfferLinkPage offerId={OFFER_ID} />);
    expect(await screen.findByText("Offre introuvable")).toBeTruthy();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["x-waitlist-token"]).toBe(
      TOKEN,
    );
  });
});
