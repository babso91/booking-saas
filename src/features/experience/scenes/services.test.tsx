// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PublicCatalog } from "@/features/catalog/model";

import { showcaseOf } from "../catalog/model";
import type { ServicesVariant } from "../engine/config";
import { EngineProvider } from "../engine/engine";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import type { NextSlots } from "../next-slot";
import { Services } from "./services";

// Her services on her site, in the three compositions: two close services
// read together (Higani point 36) and a long catalogue searched (point 37).

const item = (id: string, name: string, description: string | null = null) => ({
  id,
  name,
  description,
  durationMinutes: 60,
  priceCents: 5000,
  options: [],
});

const long: PublicCatalog = {
  currency: "EUR",
  groups: [
    {
      category: { id: "cils", name: "Cils & regard" },
      services: [
        item("s1", "Volume russe", "Dense et léger, effet œil de biche."),
        item("s2", "Volume mixte", "Entre naturel et dense."),
        item("s3", "Rehaussement", "Courbés et teintés."),
      ],
    },
    {
      category: { id: "ongles", name: "Ongles" },
      services: [
        item("s4", "Pose gel"),
        item("s5", "Semi-permanent mains"),
        item("s6", "Dépose"),
      ],
    },
    {
      category: null,
      services: [
        item("s7", "Restructuration sourcils"),
        item("s8", "Teinture sourcils"),
      ],
    },
  ],
};

function renderScene(
  variant: ServicesVariant,
  catalog = long,
  extra: { next?: NextSlots; today?: string } = {},
) {
  const book = vi.fn();
  render(
    <EngineProvider
      value={{
        config: renderConfigOf(sampleSite("mila")),
        photos: () => "",
        catalog: showcaseOf(catalog),
        book,
        ...extra,
      }}
    >
      <Services variant={variant} index={3} />
    </EngineProvider>,
  );
  return book;
}

function renderSceneAndReturn(
  variant: ServicesVariant,
  catalog: PublicCatalog,
) {
  return render(
    <EngineProvider
      value={{
        config: renderConfigOf(sampleSite("mila")),
        photos: () => "",
        catalog: showcaseOf(catalog),
        book: vi.fn(),
      }}
    >
      <Services variant={variant} index={3} />
    </EngineProvider>,
  );
}

const searchBox = () =>
  screen.getByRole("searchbox", { name: "Rechercher une prestation" });
const search = (value: string) =>
  fireEvent.change(searchBox(), { target: { value } });
const all = long.groups.flatMap((group) => group.services.map((s) => s.name));
/** Her services on the page, in the order shown. */
const shown = () =>
  all.filter((name) => screen.queryAllByText(name).length > 0);

describe("two close services, read together (point 36)", () => {
  it("price index: opening one no longer closes the other", () => {
    renderScene("index");
    const row = (name: string) =>
      screen.getByRole("button", { name: new RegExp(name) });
    fireEvent.click(row("Volume russe"));
    fireEvent.click(row("Volume mixte"));
    expect(row("Volume russe").getAttribute("aria-expanded")).toBe("true");
    expect(row("Volume mixte").getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText("Dense et léger, effet œil de biche."),
    ).toBeTruthy();
    expect(screen.getByText("Entre naturel et dense.")).toBeTruthy();
    // Closed again one by one, by her.
    fireEvent.click(row("Volume russe"));
    expect(row("Volume russe").getAttribute("aria-expanded")).toBe("false");
    expect(row("Volume mixte").getAttribute("aria-expanded")).toBe("true");
  });
});

describe.each(["index", "shelf", "tiles"] as const)(
  "a long catalogue, searched (point 37) — %s",
  (variant) => {
    it("finds by name or category, in her order; nothing found is said", () => {
      renderScene(variant);
      expect(shown()).toEqual(all);
      search("sourcils");
      expect(shown()).toEqual([
        "Restructuration sourcils",
        "Teinture sourcils",
      ]);
      expect(screen.getByText("2 prestations")).toBeTruthy();
      // Searching, the shortcuts to her categories step aside.
      expect(
        screen.queryByRole("navigation", { name: "Catégories" }),
      ).toBeNull();
      search("ongles");
      expect(shown()).toEqual(["Pose gel", "Semi-permanent mains", "Dépose"]);
      search("brushing");
      expect(shown()).toEqual([]);
      expect(
        screen.getByText("Aucune prestation ne correspond à « brushing »"),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Effacer la recherche" }),
      );
      expect(shown()).toEqual(all);
    });

    it("a short catalogue has no search field", () => {
      renderScene(variant, sampleCatalog);
      expect(
        screen.queryByRole("searchbox", { name: "Rechercher une prestation" }),
      ).toBeNull();
    });
  },
);

it("price index: her numbering stays while she searches", () => {
  renderScene("index");
  search("teinture");
  const row = screen.getByRole("button", { name: /Teinture sourcils/ });
  expect(within(row).getByText("08")).toBeTruthy();
});

it("shelf: a found service is booked as itself", () => {
  const book = renderScene("shelf");
  search("gel");
  const card = screen
    .getByRole("heading", { name: "Pose gel" })
    .closest("article")!;
  fireEvent.click(within(card as HTMLElement).getByRole("button"));
  expect(book).toHaveBeenCalledWith(expect.objectContaining({ id: "s4" }));
});

// Higani point 2: her next slot, by service, read with her page.
describe.each(["index", "shelf", "tiles"] as const)(
  "her next slot by service — %s",
  (variant) => {
    const next: NextSlots = {
      s2: {
        startsAt: "2026-11-23T09:00:00.000Z",
        endsAt: "2026-11-23T11:00:00.000Z",
        localStartsAt: "2026-11-23T10:00",
        localEndsAt: "2026-11-23T12:00",
      },
    };

    it("said for the service that has one, by her calendar; never invented", () => {
      renderScene(variant, long, { next, today: "2026-11-22" });
      // The price index says it once the service is open.
      if (variant === "index")
        fireEvent.click(screen.getByRole("button", { name: /Volume mixte/ }));
      expect(screen.getByText("Prochaine dispo · Demain à 10:00")).toBeTruthy();
      expect(screen.getAllByText(/Prochaine dispo/)).toHaveLength(1);
    });

    it("nothing said without a read (her studio, a failed read)", () => {
      renderScene(variant, long);
      if (variant === "index")
        fireEvent.click(screen.getByRole("button", { name: /Volume mixte/ }));
      expect(screen.queryByText(/Prochaine dispo/)).toBeNull();
    });
  },
);

// Higani point 33: her categories on a phone; those without one named.
describe.each(["index", "shelf", "tiles"] as const)(
  "her categories (point 33) — %s",
  (variant) => {
    it("shortcuts once her catalogue is long; « Autres prestations » named", () => {
      renderScene(variant);
      const nav = within(
        screen.getByRole("navigation", { name: "Catégories" }),
      );
      expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual([
        "Cils & regard",
        "Ongles",
        "Autres prestations",
      ]);
      expect(
        nav
          .getByRole("link", { name: "Autres prestations" })
          .getAttribute("href"),
      ).toBe("#categorie-autres");
      expect(
        screen.getByRole("heading", { name: /Autres prestations/ }),
      ).toBeTruthy();
    });

    it("all without a category: no heading invented", () => {
      renderScene(variant, {
        currency: "EUR",
        groups: [
          { category: null, services: long.groups.flatMap((g) => g.services) },
        ],
      });
      expect(screen.queryByText("Autres prestations")).toBeNull();
      expect(
        screen.queryByRole("navigation", { name: "Catégories" }),
      ).toBeNull();
    });
  },
);

// Higani point 35: a detailed description that does not weigh on her page.
describe("her descriptions (point 35)", () => {
  const detailed =
    "Inclus : dépose, soin et pose.\nRésultat : un regard ouvert six semaines.\nÀ prévoir : venir sans maquillage.\nRetouche conseillée à trois semaines.";
  const withDetailed: PublicCatalog = {
    currency: "EUR",
    groups: [
      { category: null, services: [item("d1", "Volume russe", detailed)] },
    ],
  };

  it("shelf: a few lines first, « Lire la suite » for the rest", () => {
    renderScene("shelf", withDetailed);
    const text = screen.getByText(/Inclus : dépose/);
    expect(text.className).toContain("line-clamp-5");
    expect(text.className).toContain("whitespace-pre-line");
    fireEvent.click(screen.getByRole("button", { name: "Lire la suite" }));
    expect(text.className).not.toContain("line-clamp-5");
    expect(screen.getByRole("button", { name: "Réduire" })).toBeTruthy();
  });

  it("tiles: a few lines (the whole tile books); index: in full, her line breaks kept", () => {
    const { unmount } = renderSceneAndReturn("tiles", withDetailed);
    expect(screen.getByText(/Inclus : dépose/).className).toContain(
      "line-clamp-4",
    );
    unmount();
    renderScene("index", withDetailed);
    fireEvent.click(screen.getByRole("button", { name: /Volume russe/ }));
    const text = screen.getByText(/Inclus : dépose/);
    expect(text.className).toContain("whitespace-pre-line");
    expect(text.className).not.toContain("line-clamp");
  });
});
