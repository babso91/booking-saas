import { afterEach, vi } from "vitest";

// Shared setup for component tests (files marked `@vitest-environment jsdom`).
// Node-environment tests load it too, hence the guard.
if (typeof window !== "undefined") {
  const { cleanup } = await import("@testing-library/react");

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  // jsdom lacks these browser APIs. Reduced motion is reported as enabled so
  // step transitions resolve immediately in tests.
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.animate =
    vi.fn() as unknown as typeof Element.prototype.animate;
  // No real network in component tests: the transport probe of callAction
  // sees an unreachable server unless a test stubs fetch itself.
  globalThis.fetch = vi.fn(() =>
    Promise.reject(new TypeError("No network in tests")),
  ) as unknown as typeof fetch;
}
