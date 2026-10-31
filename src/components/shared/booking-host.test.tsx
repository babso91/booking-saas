// @vitest-environment jsdom
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bookingHost } from "@/lib/brand";

import { BookingHost, BookingHostProvider } from "./booking-host";

afterEach(() => vi.unstubAllEnvs());

describe("BookingHost", () => {
  it("hydrates on the server's host when the browser's bundle has none", async () => {
    // The server, started with the variable.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reservation.example.test");
    const host = bookingHost();
    const tree = (
      <BookingHostProvider host={host}>
        <BookingHost />
        /b/studio
      </BookingHostProvider>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree);

    // The browser, built without it.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const mismatch = vi.fn();
    await act(async () => {
      hydrateRoot(container, tree, {
        onRecoverableError: mismatch,
      });
    });

    expect(mismatch).not.toHaveBeenCalled();
    expect(container.textContent).toBe("reservation.example.test/b/studio");
  });
});
