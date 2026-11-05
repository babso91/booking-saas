import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";
import { sampleSiteConfig } from "@/features/sites/site-fixture";

const { data, sites, catalog } = vi.hoisted(() => ({
  data: { getPublicBusiness: vi.fn(), listPublicServices: vi.fn() },
  sites: { getPublishedSite: vi.fn() },
  catalog: { getPublicCatalog: vi.fn() },
}));
vi.mock("@/features/businesses/data/public-business", () => data);
vi.mock("@/features/sites/data/sites", () => sites);
vi.mock("@/features/catalog/data/catalog", () => catalog);
// next/font runs at build time only.
vi.mock("@/features/experience/fonts", () => ({ siteFontClasses: "fonts" }));
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
const notPublished = () =>
  Promise.reject(new AppException("site_not_published"));

beforeEach(() => {
  data.getPublicBusiness.mockReset();
  data.listPublicServices.mockReset();
  sites.getPublishedSite.mockReset();
  catalog.getPublicCatalog.mockReset();
  data.getPublicBusiness.mockResolvedValue({
    slug: "studio-mila",
    name: "Studio Mila",
  });
  data.listPublicServices.mockResolvedValue([]);
  sites.getPublishedSite.mockImplementation(notPublished);
});

describe("/b/[slug]", () => {
  it("an unknown business is a 404 page, its services never read", async () => {
    data.getPublicBusiness.mockResolvedValue(null);
    await expect(PublicBookingPage(params("inconnu") as never)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(data.listPublicServices).not.toHaveBeenCalled();
    expect(sites.getPublishedSite).not.toHaveBeenCalled();
  });

  it("an invalid address is a 404 page, nothing read", async () => {
    await expect(
      PublicBookingPage(params("Not a slug!") as never),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(data.getPublicBusiness).not.toHaveBeenCalled();
  });

  it("without a published site: the booking page, as before", async () => {
    const metadata = await generateMetadata(params("studio-mila") as never);
    expect(metadata.title).toBe("Réserver chez Studio Mila");
    const page = await PublicBookingPage(params("studio-mila") as never);
    expect(page.props).toMatchObject({
      business: { slug: "studio-mila" },
      services: [],
    });
    expect(page.props).not.toHaveProperty("config");
    expect(catalog.getPublicCatalog).not.toHaveBeenCalled();
  });

  it("with one: her published site, through her current plan, revoked photos drawn without one", async () => {
    const config = sampleSiteConfig({
      content: {
        cover: { asset: "11111111-1111-4111-8111-111111111111" },
        works: [],
        portrait: {
          photo: { asset: "22222222-2222-4222-8222-222222222222" },
          name: "Mila",
          role: "Fondatrice",
          text: "",
        },
        focals: {},
      },
    });
    sites.getPublishedSite.mockResolvedValue({
      versionId: "v",
      number: 3,
      publishedAt: "2026-11-05T10:00:00.000Z",
      plan: "signature",
      schemaVersion: 1,
      config,
      unavailableAssets: ["22222222-2222-4222-8222-222222222222"],
    });
    const groups = [{ category: null, services: [] }];
    catalog.getPublicCatalog.mockResolvedValue({ currency: "EUR", groups });
    expect((await generateMetadata(params("studio-mila") as never)).title).toBe(
      "Studio Mila",
    );
    const page = await PublicBookingPage(params("studio-mila") as never);
    expect(page.props).toMatchObject({
      catalog: groups,
      photoBase: "/api/public/businesses/studio-mila/site/photos",
      fontClasses: "fonts",
      config: {
        universe: "mila",
        content: {
          cover: "11111111-1111-4111-8111-111111111111",
          // Revoked since publication: its place, without a photo.
          portrait: { photo: null },
        },
      },
    });
  });

  it("any other failure reading the site is not swallowed", async () => {
    sites.getPublishedSite.mockRejectedValue(new AppException("internal"));
    await expect(
      PublicBookingPage(params("studio-mila") as never),
    ).rejects.toThrow();
  });
});
