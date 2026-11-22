// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SiteLink } from "@/features/sites/links";

import { showcaseOf } from "../catalog/model";
import type { Practical } from "../engine/config";
import { EngineProvider } from "../engine/engine";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import { emptyPractical } from "../practical";
import { ReachLinks } from "./reach-links";

// Higani points 3 and 4: her channels and her links, at the foot of her
// page and in her menu.

function renderReach(practical?: Practical, links?: SiteLink[]) {
  return render(
    <EngineProvider
      value={{
        config: {
          ...renderConfigOf(sampleSite("mila")),
          ...(practical ? { practical } : {}),
          ...(links ? { links } : {}),
        },
        photos: () => "",
        catalog: showcaseOf(sampleCatalog),
        book: () => {},
      }}
    >
      <ReachLinks />
    </EngineProvider>,
  );
}

describe("ReachLinks", () => {
  it("her channels, then her links, each leading where she said", () => {
    renderReach(
      {
        ...emptyPractical,
        phone: "04 78 00 00 00",
        whatsapp: "+33 6 12 34 56 78",
        email: "contact@mila.fr",
      },
      [
        { network: "instagram", url: "@studio.mila" },
        { network: "website", url: "à compléter" },
        { network: "website", url: "studio-mila.fr" },
      ],
    );
    const contact = within(screen.getByRole("list", { name: "Contact" }));
    expect(
      contact.getByRole("link", { name: "Appeler, 04 78 00 00 00" }),
    ).toHaveProperty("href", "tel:0478000000");
    const chat = contact.getByRole("link", {
      name: "WhatsApp, +33 6 12 34 56 78",
    });
    expect(chat.getAttribute("href")).toBe("https://wa.me/33612345678");
    expect(chat.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      contact
        .getByRole("link", { name: "Écrire, contact@mila.fr" })
        .getAttribute("href"),
    ).toBe("mailto:contact@mila.fr");

    const links = within(
      screen.getByRole("list", { name: "Réseaux et liens" }),
    );
    expect(
      links
        .getAllByRole("link")
        .map((link) => [
          link.textContent,
          link.getAttribute("href"),
          link.getAttribute("target"),
        ]),
    ).toEqual([
      ["Instagram", "https://www.instagram.com/studio.mila", "_blank"],
      ["Site web", "https://studio-mila.fr/", "_blank"],
    ]);
  });

  it("nothing at all when she filled in nothing (or nothing readable)", () => {
    const { container } = renderReach(emptyPractical, [
      { network: "website", url: "bientôt" },
    ]);
    expect(container.innerHTML).toBe("");
  });

  it("a version published before: nothing", () => {
    const { container } = renderReach();
    expect(container.innerHTML).toBe("");
  });
});
