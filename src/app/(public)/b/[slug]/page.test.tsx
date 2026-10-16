import { beforeEach, describe, expect, it, vi } from "vitest";

const { data } = vi.hoisted(() => ({
  data: { getPublicBusiness: vi.fn(), listPublicServices: vi.fn() },
}));
vi.mock("@/features/businesses/data/public-business", () => data);
vi.mock("@/lib/supabase/public", () => ({
  createPublicSupabaseClient: () => ({}),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import PublicBookingPage, { generateMetadata } from "./page";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  data.getPublicBusiness.mockReset();
  data.listPublicServices.mockReset();
});

describe("/b/[slug]", () => {
  it("an unknown business is a 404 page, its services never read", async () => {
    data.getPublicBusiness.mockResolvedValue(null);
    await expect(PublicBookingPage(params("inconnu") as never)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(data.listPublicServices).not.toHaveBeenCalled();
  });

  it("an invalid address is a 404 page, nothing read", async () => {
    await expect(
      PublicBookingPage(params("Not a slug!") as never),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(data.getPublicBusiness).not.toHaveBeenCalled();
  });

  it("a known business: its public profile and active services, read once for the page and its title", async () => {
    data.getPublicBusiness.mockResolvedValue({
      slug: "studio-mila",
      name: "Studio Mila",
    });
    data.listPublicServices.mockResolvedValue([]);
    const metadata = await generateMetadata(params("studio-mila") as never);
    expect(metadata.title).toBe("Réserver chez Studio Mila");
    const page = await PublicBookingPage(params("studio-mila") as never);
    expect(page.props).toMatchObject({
      business: { slug: "studio-mila" },
      services: [],
    });
  });
});
