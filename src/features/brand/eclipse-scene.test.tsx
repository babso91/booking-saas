// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import HomePage from "@/app/page";

import { EclipseScene } from "./eclipse-scene";

afterEach(cleanup);

describe("EclipseScene (Higani « Éclipse lunaire »)", () => {
  it("is decoration only: hidden from assistive technologies", () => {
    const { container } = render(<EclipseScene />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("draws the same scene on the server and in the browser (fixed seed)", () => {
    expect(renderToString(<EclipseScene />)).toBe(
      renderToString(<EclipseScene />),
    );
  });

  it("rains petals and flowers cut from the brand's paintings, three resting on the water", () => {
    const { container } = render(<EclipseScene />);
    const sources = [...container.querySelectorAll("img")].map((img) =>
      img.getAttribute("src"),
    );
    // 44 falling, 7 at rest for reduced motion, 3 on the water.
    expect(sources).toHaveLength(44 + 7 + 3);
    expect(sources.filter((src) => src?.includes("/water-"))).toHaveLength(3);
    expect(sources.some((src) => src?.includes("/flower-"))).toBe(true);
    expect(
      [...container.querySelectorAll("img")].every(
        (img) => img.getAttribute("alt") === "",
      ),
    ).toBe(true);
  });
});

describe("HomePage", () => {
  it("says what Higani is, offers to sign in, and says joining is by invitation", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Ton lien. Ton univers. Tes rendez-vous.",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Se connecter" }).getAttribute("href"),
    ).toBe("/login");
    expect(
      screen
        .getByRole("link", { name: "Bêta privée, sur invitation" })
        .getAttribute("href"),
    ).toBe("/signup");
    // The developer screen it replaces is gone.
    expect(screen.queryByText(/Fondation technique/)).toBeNull();
  });
});
