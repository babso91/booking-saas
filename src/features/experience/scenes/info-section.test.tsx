// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { showcaseOf } from "../catalog/model";
import type { InfoSection as Info } from "../engine/config";
import { EngineProvider, type EngineEdit } from "../engine/engine";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import { InfoSection } from "./info-section";

// Higani point 16: one of her informative sections, in her page.

function renderInfo(info: Info, edit?: boolean) {
  const editing: EngineEdit | undefined = edit
    ? {
        photo: () => {},
        selected: null,
        service: () => {},
        selectedService: null,
      }
    : undefined;
  return render(
    <EngineProvider
      value={{
        config: renderConfigOf(sampleSite("mila")),
        photos: () => "",
        catalog: showcaseOf(sampleCatalog),
        book: () => {},
        ...(editing ? { edit: editing } : {}),
      }}
    >
      <InfoSection info={info} index={4} />
    </EngineProvider>,
  );
}

describe("InfoSection", () => {
  it("shows her title and her text, numbered", () => {
    const { container } = renderInfo({
      id: "avant",
      title: "Avant votre rendez-vous",
      text: "Venez les ongles nus.",
    });
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Avant votre rendez-vous",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Venez les ongles nus.")).toBeTruthy();
    expect(container.textContent).toContain("(04)");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps her line breaks", () => {
    const { container } = renderInfo({
      id: "a",
      title: "Déroulé",
      text: "Accueil.\nSoin.\nPaiement.",
    });
    const paragraph = container.querySelector("p.whitespace-pre-line")!;
    expect(paragraph.textContent).toBe("Accueil.\nSoin.\nPaiement.");
  });

  it("folds a long text behind « Lire la suite », whole in the page", () => {
    const text = "Une longue explication pleine de détails. ".repeat(20).trim();
    const { container } = renderInfo({ id: "a", title: "FAQ", text });
    const paragraph = container.querySelector("p.whitespace-pre-line")!;
    expect(paragraph.className).toContain("line-clamp-6");
    expect(paragraph.textContent).toBe(text);
    expect(
      screen
        .getByRole("button", { name: "Lire la suite" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("in her studio, an untitled, empty section says what it lacks", () => {
    renderInfo({ id: "a", title: " ", text: "" }, true);
    expect(
      screen.getByRole("heading", { level: 2, name: "Section sans titre" }),
    ).toBeTruthy();
    expect(screen.getByText(/Écris son texte dans Sections/)).toBeTruthy();
  });

  it("on her public site, nothing is invented for an empty one", () => {
    const { container } = renderInfo({ id: "a", title: "", text: "" });
    expect(container.textContent).not.toContain("Section sans titre");
    expect(container.textContent).not.toContain("Écris son texte");
  });
});
