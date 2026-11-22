// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { SiteLink } from "@/features/sites/links";

import { LinksFields } from "./links-fields";

// Higani point 3: her links, edited in her studio's « Infos ».

let saved: SiteLink[] = [];
function Harness({ initial = [] }: { initial?: SiteLink[] }) {
  const [links, setLinks] = useState(initial);
  return (
    <LinksFields
      value={links}
      onChange={(next) => {
        saved = next;
        setLinks(next);
      }}
    />
  );
}

const add = () =>
  fireEvent.click(screen.getByRole("button", { name: "Ajouter un lien" }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("LinksFields", () => {
  it("adds a link, on the first network she has not used, and keeps what she types", () => {
    render(<Harness initial={[{ network: "instagram", url: "@mila" }]} />);
    add();
    expect(
      (screen.getByLabelText("Réseau du lien 2") as HTMLSelectElement).value,
    ).toBe("tiktok");
    type("Adresse du lien 2", "@mila.cils");
    expect(saved).toEqual([
      { network: "instagram", url: "@mila" },
      { network: "tiktok", url: "@mila.cils" },
    ]);
  });

  it("says when a link will not show, without refusing it", () => {
    render(<Harness />);
    add();
    fireEvent.change(screen.getByLabelText("Réseau du lien 1"), {
      target: { value: "website" },
    });
    type("Adresse du lien 1", "monsite");
    expect(
      screen.getByText("Lien non reconnu : il n’apparaîtra pas sur ton site."),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Adresse du lien 1").getAttribute("aria-invalid"),
    ).toBe("true");
    type("Adresse du lien 1", "monsite.fr");
    expect(screen.queryByText(/Lien non reconnu/)).toBeNull();
    expect(saved).toEqual([{ network: "website", url: "monsite.fr" }]);
  });

  it("« other » takes a name; a link is removed; eight at most", () => {
    render(<Harness />);
    add();
    fireEvent.change(screen.getByLabelText("Réseau du lien 1"), {
      target: { value: "other" },
    });
    type("Nom du lien 1", "Ma boutique");
    type("Adresse du lien 1", "boutique.fr");
    expect(saved).toEqual([
      { network: "other", url: "boutique.fr", label: "Ma boutique" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Retirer le lien 1" }));
    expect(saved).toEqual([]);
    for (let i = 0; i < 8; i += 1) add();
    expect(
      screen.queryByRole("button", { name: "Ajouter un lien" }),
    ).toBeNull();
    expect(saved).toHaveLength(8);
  });
});
