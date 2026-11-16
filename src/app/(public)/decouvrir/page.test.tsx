import { afterEach, describe, expect, it, vi } from "vitest";

import DiscoverPage from "./page";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const open = (invitation?: string) =>
  DiscoverPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(invitation ? { invitation } : {}),
  } as never);

afterEach(() => vi.unstubAllEnvs());

describe("/decouvrir", () => {
  it("does not exist where it is not switched on", async () => {
    vi.stubEnv("DISCOVERY_PREVIEW", "");
    vi.stubEnv("DASHBOARD_PREVIEW", "");
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("switched on: carries a well-formed invitation, nothing else", async () => {
    vi.stubEnv("DISCOVERY_PREVIEW", "1");
    expect((await open("inv_abc12345")).props.invitation).toBe("inv_abc12345");
    expect((await open('x"><script>')).props.invitation).toBeNull();
    expect((await open()).props.invitation).toBeNull();
  });
});
