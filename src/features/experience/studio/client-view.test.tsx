// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { showcaseOf } from "../catalog/model";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import { ClientView } from "./client-view";
import { FRAME_ESCAPE, FRAME_READY, FRAME_SHOW } from "./client-view-protocol";

// Higani points 122, 123: her page as her clients see it, phone or computer.

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const config = renderConfigOf(sampleSite("mila"));
const catalog = showcaseOf(sampleCatalog);

function renderView(onClose = vi.fn()) {
  render(
    <ClientView
      config={config}
      catalog={catalog}
      hours={null}
      reviews={null}
      what="Ton brouillon"
      onClose={onClose}
    />,
  );
  const frame = screen.getByTitle(/Ta page, sur/) as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  return { frame, post, onClose };
}

describe("ClientView", () => {
  it("opens on a phone's real width; a computer's on demand", () => {
    const { frame } = renderView();
    expect(frame.getAttribute("src")).toBe("/app/site/apercu");
    expect(frame.style.width).toBe("390px");
    expect(
      screen
        .getByRole("button", { name: "Téléphone" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Ordinateur" }));
    expect(frame.style.width).toBe("1280px");
    expect(screen.getByText(/rien n’est réservé/)).toBeTruthy();
  });

  it("answers its own frame only, with what the studio shows", () => {
    const { frame, post } = renderView();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: FRAME_READY },
          origin: "https://ailleurs.example",
          source: frame.contentWindow,
        }),
      );
    });
    expect(post).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: FRAME_READY },
          origin: window.location.origin,
          source: frame.contentWindow,
        }),
      );
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: FRAME_SHOW, config, catalog }),
      window.location.origin,
    );
  });

  it("Escape here or inside her page, or « Fermer », closes it", () => {
    const { frame, onClose } = renderView();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: FRAME_ESCAPE },
          origin: window.location.origin,
          source: frame.contentWindow,
        }),
      );
      // Not from her page: ignored.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: FRAME_ESCAPE },
          origin: window.location.origin,
          source: window,
        }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
