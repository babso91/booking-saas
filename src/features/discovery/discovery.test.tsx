// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Discovery } from "./discovery";
import { readDraft, writeDraft } from "./keep";

// The discovery in the page, on the real software and the real provider:
// what she sees, what the device keeps, and what never leaves it.

vi.mock("next/navigation", async () => ({
  ...(await import("../../../tests/support/next-router")).nextNavigationMock,
  usePathname: () => "/decouvrir",
}));
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

const cookie = () => document.cookie;
const clearCookies = () => {
  document.cookie = "dash_appearance=; Max-Age=0; Path=/";
  document.cookie = "dash_appearance_origin=; Max-Age=0; Path=/";
};
const style = () => document.documentElement.getAttribute("data-style");

beforeEach(() => {
  // jsdom keeps Path=/app cookies away from "/": the page lives under /app
  // here, so what keep.ts writes can be read back.
  window.history.replaceState(null, "", "/app/decouvrir");
  window.localStorage.clear();
  clearCookies();
  window.matchMedia ??= (() => ({ matches: false })) as never;
});
afterEach(() => {
  cleanup();
  clearCookies();
});

async function explore(name = "Maison Iris") {
  const user = userEvent.setup();
  render(<Discovery invitation={null} />);
  await user.type(screen.getByLabelText("Le nom de ton salon"), name);
  await user.click(screen.getByRole("button", { name: /Voir ma journée/ }));
  return user;
}

describe("the opening", () => {
  it("asks her salon's name, the software waiting behind", () => {
    render(<Discovery invitation={null} />);
    expect(
      screen.getByRole("heading", { name: "Ton agenda devrait te ressembler" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Essayer les univers" }),
    ).toBeNull();
  });

  it("signing up directly is always one click away", () => {
    render(<Discovery invitation="inv_abc12345" />);
    expect(
      screen
        .getByRole("link", { name: "Créer mon compte" })
        .getAttribute("href"),
    ).toBe("/signup?invitation=inv_abc12345");
  });
});

describe("exploring", () => {
  it("shows the real software under her salon's name", async () => {
    await explore();
    expect(screen.getAllByText(/Maison Iris/i).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("region", { name: "Essayer les univers" }),
    ).toBeTruthy();
  });

  it("each universe changes the whole software, and is kept as a draft", async () => {
    const user = await explore();
    await user.click(screen.getByRole("radio", { name: /Écrin/ }));
    expect(style()).toBe("ecrin");
    await user.click(screen.getByRole("switch", { name: "Nuit" }));
    expect(readDraft()).toMatchObject({
      businessName: "Maison Iris",
      appearance: { style: "ecrin", mode: "dark" },
      chosen: false,
    });
  });

  it("a link of the software stays here and says why", async () => {
    const user = await explore();
    await user.click(screen.getByRole("radio", { name: /Carnet/ }));
    const link = screen.getAllByRole("link", { name: /Noter/ })[0]!;
    await user.click(link);
    expect(screen.getByRole("status").textContent).toContain("Crée ton compte");
  });

  it("nothing is kept for an account while she only explores", async () => {
    await explore();
    expect(cookie()).not.toContain("dash_appearance");
  });
});

describe("the choice", () => {
  it("keeps her universe for the account she is about to create", async () => {
    const user = await explore();
    await user.click(screen.getByRole("radio", { name: /Studio/ }));
    await user.click(screen.getByRole("button", { name: "C’est mon univers" }));
    expect(
      screen.getByRole("heading", { name: "Maison Iris, en Studio" }),
    ).toBeTruthy();
    expect(cookie()).toContain("dash_appearance=");
    expect(cookie()).toMatch(/dash_appearance=[^;]*studio/);
    expect(cookie()).toContain("dash_appearance_origin=discovery");
    expect(
      screen
        .getByRole("link", { name: /Créer mon espace/ })
        .getAttribute("href"),
    ).toBe("/signup");
    // Her clients' mini-site is not tied to it.
    expect(screen.getByText(/se choisit à part/)).toBeTruthy();
  });

  it("back to exploring: nothing is kept for an account any more", async () => {
    const user = await explore();
    await user.click(screen.getByRole("button", { name: "C’est mon univers" }));
    await user.click(
      screen.getByRole("button", { name: "Continuer à explorer" }),
    );
    expect(cookie()).not.toContain("dash_appearance");
    expect(readDraft()?.chosen).toBe(false);
  });

  it("the browser's back button goes back a moment, and forgets the choice", async () => {
    const user = await explore();
    await user.click(screen.getByRole("button", { name: "C’est mon univers" }));
    await act(async () => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { discovery: "exploring" } }),
      );
    });
    expect(screen.queryByRole("heading", { name: /en Classique/ })).toBeNull();
    expect(cookie()).not.toContain("dash_appearance");
  });
});

describe("coming back", () => {
  it("a reload or a closed tab finds her draft again", () => {
    writeDraft({
      businessName: "Atelier Lune",
      appearance: {
        style: "carnet",
        ambiance: "atelier",
        mode: "light",
        accent: null,
        motion: "standard",
      },
      chosen: false,
      savedAt: Date.now(),
    });
    render(<Discovery invitation={null} />);
    expect(screen.queryByLabelText("Le nom de ton salon")).toBeNull();
    expect(style()).toBe("carnet");
    expect(screen.getAllByText(/Atelier Lune/).length).toBeGreaterThan(0);
  });

  it("an old or broken draft is ignored", () => {
    window.localStorage.setItem(
      "booking:discovery",
      JSON.stringify({ businessName: "Vieux", savedAt: 0 }),
    );
    expect(readDraft()).toBeNull();
    window.localStorage.setItem("booking:discovery", "{nope");
    expect(readDraft()).toBeNull();
    window.localStorage.setItem(
      "booking:discovery",
      JSON.stringify({
        businessName: "x".repeat(200),
        appearance: { style: "inconnu", ambiance: "<script>" },
        savedAt: Date.now(),
      }),
    );
    const draft = readDraft()!;
    expect(draft.businessName).toHaveLength(80);
    expect(draft.appearance.style).toBe("classique");
  });
});
