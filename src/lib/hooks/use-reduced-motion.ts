"use client";

import { useSyncExternalStore } from "react";

// Motion reduced: the system asks for it, or she chose "Aucune" animation in
// the professional area (data-motion="none" on <html>, appearance settings).

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", callback);
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion"],
  });
  return () => {
    media.removeEventListener("change", callback);
    observer.disconnect();
  };
}

export function useReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () =>
      window.matchMedia(QUERY).matches ||
      document.documentElement.getAttribute("data-motion") === "none",
    () => false,
  );
}
