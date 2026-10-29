"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  APPEARANCE_COOKIE,
  appearanceCss,
  serializeAppearance,
  type Appearance,
} from "../appearance";

// Her appearance, applied to the professional area. The server renders it
// from her cookie (the layout reads it), so the first paint is hers; the
// CSS is generated from validated values only. <html> carries it too while
// she is in the area, for what is rendered on <body> (sheets, dialogs), and
// lets go when she leaves it.

type AppearanceContext = {
  appearance: Appearance;
  /** Applies at once and remembers it on this device. */
  setAppearance: (next: Appearance) => void;
};

const Context = createContext<AppearanceContext | null>(null);

/** One year, for /app only; presentation, never anything sensitive. */
function remember(value: Appearance) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${APPEARANCE_COOKIE}=${serializeAppearance(value)}; Path=/app; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function AppearanceProvider({
  initial,
  children,
}: {
  initial: Appearance;
  children: ReactNode;
}) {
  const [appearance, setState] = useState(initial);
  const css = useMemo(() => appearanceCss(appearance), [appearance]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-appearance", "");
    root.setAttribute("data-motion", appearance.motion);
    root.setAttribute("data-style", appearance.style);
    return () => {
      root.removeAttribute("data-appearance");
      root.removeAttribute("data-motion");
      root.removeAttribute("data-style");
    };
  }, [appearance.motion, appearance.style]);

  const setAppearance = useCallback((next: Appearance) => {
    setState(next);
    remember(next);
  }, []);

  const value = useMemo(
    () => ({ appearance, setAppearance }),
    [appearance, setAppearance],
  );

  return (
    <Context.Provider value={value}>
      <style>{css}</style>
      <div
        data-appearance=""
        data-motion={appearance.motion}
        data-style={appearance.style}
        className="contents"
      >
        {children}
      </div>
    </Context.Provider>
  );
}

/**
 * The style of her area, for the frames that change with it; "classique"
 * outside the area (a component rendered without the provider).
 */
export function useDashboardStyle() {
  return useContext(Context)?.appearance.style ?? "classique";
}

export function useAppearance() {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useAppearance must be used inside AppearanceProvider");
  }
  return context;
}
