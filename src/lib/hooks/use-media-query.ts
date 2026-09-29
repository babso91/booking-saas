"use client";

import { useSyncExternalStore } from "react";

/**
 * Reactive media query. Returns `null` during server rendering and hydration
 * so callers can render a neutral placeholder instead of guessing a layout.
 */
export function useMediaQuery(query: string): boolean | null {
  return useSyncExternalStore(
    (callback) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => window.matchMedia(query).matches,
    () => null,
  );
}
