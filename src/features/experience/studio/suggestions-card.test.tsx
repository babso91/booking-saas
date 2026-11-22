// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Suggestion } from "./suggestions";
import { SuggestionsCard } from "./suggestions-card";

const suggestions: Suggestion[] = [
  {
    id: "cover",
    title: "Choisis une photo de couverture",
    why: "C’est la première image que voient tes clientes.",
    to: { tab: "photos" },
  },
  {
    id: "hours",
    title: "Renseigne tes horaires",
    why: "Ils font apparaître tes créneaux en ligne.",
    to: { href: "/app/settings/hours", label: "Mes horaires" },
  },
];

describe("SuggestionsCard (point 124)", () => {
  it("folded to one line with its count; opened, each idea leads where it is filled", () => {
    const onTab = vi.fn();
    render(
      <SuggestionsCard
        suggestions={suggestions}
        onTab={onTab}
        onLeave={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: "Pour une page plus utile · 2 idées",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Choisis une photo de couverture")).toBeNull();
    fireEvent.click(toggle);
    expect(
      screen.getByText(
        "Rien n’est obligatoire : ta page se publie telle quelle.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Compléter : Choisis une photo de couverture",
      }),
    );
    expect(onTab).toHaveBeenCalledWith("photos");
    expect(
      screen.getByRole("link", { name: "Mes horaires" }).getAttribute("href"),
    ).toBe("/app/settings/hours");
  });

  it("nothing missing: nothing shown", () => {
    const { container } = render(
      <SuggestionsCard suggestions={[]} onTab={() => {}} onLeave={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
