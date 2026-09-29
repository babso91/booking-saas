// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { callAction } from "./call-action";

const failing = async () => {
  throw new TypeError("Failed to fetch");
};

describe("callAction transport failures on a private page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports an expired session when the page now redirects (proxy → /login)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ type: "opaqueredirect", status: 0 });
    vi.stubGlobal("fetch", fetchMock);

    expect(await callAction(failing)).toEqual({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      window.location.pathname,
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  });

  it("reports a network error when the page still answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ type: "basic", status: 200 }),
    );
    expect(await callAction(failing)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("reports a network error when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await callAction(failing)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });
});
