// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

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

  it("rains petals, and keeps a few at rest for reduced motion", () => {
    const { container } = render(<EclipseScene />);
    const svgs = [...container.querySelectorAll("svg")];
    // One hidden definitions element, the scene's layers, 44 falling
    // petals and 7 resting ones, each drawn with the shared gradient.
    const leaves = svgs.filter((svg) =>
      svg.querySelector('path[fill="url(#eclipse-petal)"]'),
    );
    expect(leaves).toHaveLength(44 + 7);
    expect(container.querySelector("#eclipse-petal")).not.toBeNull();
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
