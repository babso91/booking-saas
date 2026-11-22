// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { showcaseOf } from "../catalog/model";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import { FRAME_READY, FRAME_SHOW } from "./client-view-protocol";
import { SiteFrame } from "./site-frame";

// Higani points 122, 123: the frame shows only what her own studio sends.

// The page reveals its scenes on scroll: not observed in jsdom.
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const realParent = window.parent;
afterEach(() => {
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
});

describe("SiteFrame", () => {
  it("opened by itself: it says where it opens, nothing else", () => {
    render(<SiteFrame slug="studio-mila" fontClasses="" />);
    expect(screen.getByText(/s’ouvre depuis ton Studio/)).toBeTruthy();
  });

  it("in her studio: asks, then draws what her studio sends, from this site only", () => {
    const studio = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(window, "parent", {
      value: studio,
      configurable: true,
    });
    render(<SiteFrame slug="studio-mila" fontClasses="" />);
    expect(studio.postMessage).toHaveBeenCalledWith(
      { type: FRAME_READY },
      window.location.origin,
    );
    expect(screen.getByText("Chargement de ta page…")).toBeTruthy();
    const config = renderConfigOf(sampleSite("mila"));
    const show = {
      type: FRAME_SHOW,
      config: { ...config, brand: { ...config.brand, name: "Studio Inès" } },
      catalog: showcaseOf(sampleCatalog),
      hours: null,
      reviews: null,
    };
    // Another window, or another site: ignored.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: show,
          origin: window.location.origin,
          source: window,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: show,
          origin: "https://ailleurs.example",
          source: studio as unknown as MessageEventSource,
        }),
      );
    });
    expect(screen.getByText("Chargement de ta page…")).toBeTruthy();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: show,
          origin: window.location.origin,
          source: studio as unknown as MessageEventSource,
        }),
      );
    });
    expect(screen.getAllByText("Studio Inès").length).toBeGreaterThan(0);
    // Her clients' view: no edit marks.
    expect(screen.queryByRole("button", { name: /^Modifier/ })).toBeNull();
  });
});
