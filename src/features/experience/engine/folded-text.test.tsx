// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FoldedText, foldsAt } from "./folded-text";

// Higani point 18: a long text shows its first lines, the rest at hand.

describe("foldsAt", () => {
  it("a short text does not fold", () => {
    expect(foldsAt("Venez à l'heure.", 4, 40)).toBe(false);
  });

  it("a long text folds", () => {
    expect(foldsAt("x".repeat(400), 4, 40)).toBe(true);
  });

  it("each of her line breaks starts a line", () => {
    expect(foldsAt(Array(8).fill("Oui.").join("\n"), 4, 40)).toBe(true);
    expect(foldsAt(Array(4).fill("Oui.").join("\n"), 4, 40)).toBe(false);
  });

  it("one line of slack: a toggle that would reveal one line is not worth it", () => {
    // 5 lines for 4 shown: not folded; 6 lines: folded.
    expect(foldsAt("x".repeat(200), 4, 40)).toBe(false);
    expect(foldsAt("x".repeat(201), 4, 40)).toBe(true);
  });

  it("ignores surrounding whitespace, counts a blank line as a line", () => {
    expect(foldsAt("\n\n  Court  \n\n", 4, 40)).toBe(false);
    expect(foldsAt("a\n\n\n\n\nb", 4, 40)).toBe(true);
  });
});

describe("FoldedText", () => {
  const text = `${"Une phrase assez longue pour la place. ".repeat(12)}\nFin.`;

  it("folds a long text, keeps all of it in the page, and toggles", () => {
    const { container } = render(
      <FoldedText text={text} lines={4} perLine={40} />,
    );
    const paragraph = container.querySelector("p")!;
    expect(paragraph.textContent).toBe(text);
    expect(paragraph.className).toContain("line-clamp-4");
    expect(paragraph.className).toContain("whitespace-pre-line");

    const more = screen.getByRole("button", { name: "Lire la suite" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(paragraph.id);

    fireEvent.click(more);
    const less = screen.getByRole("button", { name: "Réduire" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    expect(paragraph.className).not.toContain("line-clamp");
    expect(paragraph.textContent).toBe(text);

    fireEvent.click(less);
    expect(
      screen
        .getByRole("button", { name: "Lire la suite" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(paragraph.className).toContain("line-clamp-4");
  });

  it("a short text has no toggle and no clamp", () => {
    const { container } = render(
      <FoldedText text="Venez à l'heure." lines={4} perLine={40} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("p")!.className).not.toContain("line-clamp");
  });

  it("uses the clamp of the lines asked, and `long` overrides the length", () => {
    const { container, rerender } = render(
      <FoldedText text="Court." lines={6} long />,
    );
    expect(container.querySelector("p")!.className).toContain("line-clamp-6");
    expect(screen.getByRole("button", { name: "Lire la suite" })).toBeTruthy();
    rerender(<FoldedText text={"x ".repeat(500)} lines={3} long={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sets children in place of the text when given", () => {
    const { container } = render(
      <FoldedText text="Brut" lines={3}>
        <em>Composé</em>
      </FoldedText>,
    );
    expect(container.querySelector("p em")?.textContent).toBe("Composé");
  });
});
