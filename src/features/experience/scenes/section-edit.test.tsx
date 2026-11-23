// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { showcaseOf } from "../catalog/model";
import { EngineProvider, type EngineEdit } from "../engine/engine";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import { SectionEdit } from "./section-edit";

// Higani point 120: each section of her preview leads to where it is edited.

function renderChip(
  kind: Parameters<typeof SectionEdit>[0]["kind"],
  edit?: Partial<EngineEdit>,
  infoSections?: { id: string; title: string; text: string }[],
) {
  return render(
    <EngineProvider
      value={{
        config: { ...renderConfigOf(sampleSite("mila")), infoSections },
        photos: () => "",
        catalog: showcaseOf(sampleCatalog),
        book: () => {},
        ...(edit
          ? {
              edit: {
                photo: () => {},
                selected: null,
                service: () => {},
                selectedService: null,
                ...edit,
              },
            }
          : {}),
      }}
    >
      <SectionEdit kind={kind} />
    </EngineProvider>,
  );
}

describe("SectionEdit", () => {
  it.each([
    ["services", "Modifier tes prestations"],
    ["practical", "Modifier tes infos pratiques"],
    ["intro", "Modifier ta présentation"],
    ["work", "Modifier tes réalisations"],
  ] as const)("%s: « Modifier » opens where it is edited", (kind, name) => {
    const section = vi.fn();
    renderChip(kind, { section });
    fireEvent.click(screen.getByRole("button", { name }));
    expect(section).toHaveBeenCalledWith(kind);
  });

  it("an informative section (point 16): « Modifier ta section « title » » opens Sections with its key", () => {
    const section = vi.fn();
    renderChip("info:avant", { section }, [
      { id: "avant", title: "Avant votre rendez-vous", text: "Texte" },
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Modifier ta section « Avant votre rendez-vous »",
      }),
    );
    expect(section).toHaveBeenCalledWith("info:avant");
  });

  it("an untitled section says « sans titre »; an unknown one has no chip", () => {
    renderChip("info:a", { section: vi.fn() }, [
      { id: "a", title: "  ", text: "" },
    ]);
    expect(
      screen.getByRole("button", {
        name: "Modifier ta section « sans titre »",
      }),
    ).toBeTruthy();
    const { container } = renderChip("info:zzz", { section: vi.fn() }, []);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("not on her reviews, not on her public site", () => {
    const { container, unmount } = renderChip("reviews", { section: vi.fn() });
    expect(container.innerHTML).toBe("");
    unmount();
    expect(renderChip("services").container.innerHTML).toBe("");
  });
});
