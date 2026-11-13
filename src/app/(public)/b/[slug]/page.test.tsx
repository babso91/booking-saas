import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";
import { sampleSiteConfig } from "@/features/sites/site-fixture";

const { data, sites, catalog } = vi.hoisted(() => ({
  data: { getPublicBusiness: vi.fn() },
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

const params = (slug: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve(search),
});
const notPublished = () =>
  Promise.reject(new AppException("site_not_published"));
const emptyCatalog = { currency: "EUR", groups: [] };

beforeEach(() => {
  data.getPublicBusiness.mockReset();
  sites.getPublishedSite.mockReset();
  catalog.getPublicCatalog.mockReset();
  data.getPublicBusiness.mockResolvedValue({
    slug: "studio-mila",
    name: "Studio Mila",
  });
  catalog.getPublicCatalog.mockResolvedValue(emptyCatalog);
  sites.getPublishedSite.mockImplementation(notPublished);
});

describe("/b/[slug]", () => {
  it("an unknown business is a 404 page, nothing else read", async () => {
    data.getPublicBusiness.mockResolvedValue(null);
    await expect(PublicBookingPage(params("inconnu") as never)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(catalog.getPublicCatalog).not.toHaveBeenCalled();
    expect(sites.getPublishedSite).not.toHaveBeenCalled();
  });

  it("an invalid address is a 404 page, nothing read", async () => {
    await expect(
      PublicBookingPage(params("../admin") as never),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(data.getPublicBusiness).not.toHaveBeenCalled();
  });

  it("without a published site: the booking page with her catalogue, as before", async () => {
    const metadata = await generateMetadata(params("studio-mila") as never);
    expect(metadata.title).toBe("Réserver chez Studio Mila");
    const page = await PublicBookingPage(params("studio-mila") as never);
    expect(page.props).toMatchObject({
      business: { slug: "studio-mila" },
      catalog: emptyCatalog,
    });
    expect(page.props).not.toHaveProperty("config");
  });

  it("with one: her published site, through her current plan, booking on the same catalogue", async () => {
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
    const read = { currency: "EUR", groups };
    catalog.getPublicCatalog.mockResolvedValue(read);
    expect((await generateMetadata(params("studio-mila") as never)).title).toBe(
      "Studio Mila",
    );
    const page = await PublicBookingPage(params("studio-mila") as never);
    expect(page.props).toMatchObject({
      catalog: groups,
      // Her booking: the catalogue as the server projects it, options
      // included, never a list of services of its own.
      booking: { business: { slug: "studio-mila" }, catalog: read },
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

  describe("a link to one service (?prestation=)", () => {
    const SERVICE = "30000000-0000-4000-8000-000000000001";
    const withService = {
      currency: "EUR",
      groups: [{ category: null, services: [{ id: SERVICE, name: "Pose" }] }],
    };

    it("bookable here: the booking opens on it, on her booking page as on her site", async () => {
      catalog.getPublicCatalog.mockResolvedValue(withService);
      const page = await PublicBookingPage(
        params("studio-mila", { prestation: SERVICE }) as never,
      );
      expect(page.props).toMatchObject({ initialServiceId: SERVICE });
      expect(page.props.linkedServiceGone).toBeUndefined();

      sites.getPublishedSite.mockResolvedValue({
        versionId: "v1",
        number: 1,
        publishedAt: "2026-11-05T10:00:00.000Z",
        plan: "core",
        config: sampleSiteConfig(),
      });
      const site = await PublicBookingPage(
        params("studio-mila", { prestation: SERVICE }) as never,
      );
      expect(site.props.arrival).toEqual({ serviceId: SERVICE });
    });

    it("removed, another business's or not an id: her catalogue, and it is said; nothing opens", async () => {
      catalog.getPublicCatalog.mockResolvedValue(withService);
      for (const prestation of [
        "30000000-0000-4000-8000-00000000dead",
        "../admin",
        "",
      ]) {
        const page = await PublicBookingPage(
          params("studio-mila", { prestation }) as never,
        );
        expect(page.props.initialServiceId).toBeUndefined();
        expect(page.props.linkedServiceGone).toBe(true);
      }
    });

    it("without the parameter: exactly as before", async () => {
      catalog.getPublicCatalog.mockResolvedValue(withService);
      const page = await PublicBookingPage(params("studio-mila") as never);
      expect(page.props.initialServiceId).toBeUndefined();
      expect(page.props.linkedServiceGone).toBeUndefined();
    });
  });

  it("any other failure reading the site is not swallowed", async () => {
    sites.getPublishedSite.mockRejectedValue(new AppException("internal"));
    await expect(
      PublicBookingPage(params("studio-mila") as never),
    ).rejects.toThrow();
  });
});
