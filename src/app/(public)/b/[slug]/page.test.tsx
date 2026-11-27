import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";
import { sampleSiteConfig } from "@/features/sites/site-fixture";

const { data, sites, catalog } = vi.hoisted(() => ({
  data: { getPublicBusiness: vi.fn(), getPublicBusinessHours: vi.fn() },
  sites: { getPublishedSite: vi.fn() },
  catalog: { getPublicCatalog: vi.fn() },
}));
vi.mock("@/features/businesses/data/public-business", () => data);
vi.mock("@/features/sites/data/sites", () => sites);
vi.mock("@/features/catalog/data/catalog", () => catalog);
vi.mock("@/features/reviews/data", () => ({
  publicReviews: async () => ({ average: null, count: 0, reviews: [] }),
}));
vi.mock("@/features/availability/data/slots", () => ({
  getNextSlots: vi.fn().mockResolvedValue([]),
}));
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
  data.getPublicBusinessHours.mockReset();
  data.getPublicBusinessHours.mockResolvedValue([]);
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
    expect(data.getPublicBusinessHours).not.toHaveBeenCalled();
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
    const [booking, reviews] = page.props.children;
    expect(reviews.props).toMatchObject({
      slug: "studio-mila",
      initial: { count: 0, reviews: [] },
    });
    expect(booking.props).toMatchObject({
      business: { slug: "studio-mila" },
      catalog: emptyCatalog,
    });
    expect(booking.props).not.toHaveProperty("config");
    // Her hours serve her site's infos only: not read without one.
    expect(data.getPublicBusinessHours).not.toHaveBeenCalled();
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
    // Her usual hours, for her practical infos (read with her site only).
    const hours = [{ weekday: 1, startsAt: "09:00", endsAt: "19:00" }];
    data.getPublicBusinessHours.mockResolvedValue(hours);
    expect((await generateMetadata(params("studio-mila") as never)).title).toBe(
      "Studio Mila",
    );
    const page = await PublicBookingPage(params("studio-mila") as never);
    expect(page.props).toMatchObject({
      catalog: groups,
      // Her booking: the catalogue as the server projects it, options
      // included, never a list of services of its own.
      booking: { business: { slug: "studio-mila" }, catalog: read },
      hours,
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

  it("a direct link to a service opens its booking, on her site or her booking page (Higani 29)", async () => {
    const lash = {
      id: "3c9f2a1e-8b7d-4c3a-9f1e-2d4b6a8c0e1f",
      name: "Rehaussement de cils",
      description: null,
      durationMinutes: 60,
      priceCents: 6500,
      options: [],
    };
    catalog.getPublicCatalog.mockResolvedValue({
      currency: "EUR",
      groups: [{ category: null, services: [lash] }],
    });
    const linked = { prestation: "rehaussement-de-cils-3c9f2a1e" };
    const page = await PublicBookingPage(
      params("studio-mila", linked) as never,
    );
    expect(page.props.children[0].props.initialServiceId).toBe(lash.id);

    sites.getPublishedSite.mockResolvedValue({
      versionId: "v",
      number: 1,
      publishedAt: "2026-11-05T10:00:00.000Z",
      plan: "core",
      schemaVersion: 1,
      config: sampleSiteConfig(),
      unavailableAssets: [],
    });
    const site = await PublicBookingPage(
      params("studio-mila", linked) as never,
    );
    expect(site.props.openService).toBe(lash.id);
    // Gone, hidden or unknown: her page as it always opens.
    const plain = await PublicBookingPage(
      params("studio-mila", { prestation: "manucure-0badc0de" }) as never,
    );
    expect(plain.props.openService).toBeUndefined();
  });

  it("any other failure reading the site is not swallowed", async () => {
    sites.getPublishedSite.mockRejectedValue(new AppException("internal"));
    await expect(
      PublicBookingPage(params("studio-mila") as never),
    ).rejects.toThrow();
  });
});
