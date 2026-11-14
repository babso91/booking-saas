"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  getMyPreferencesAction,
  importDeviceAppearanceAction,
  saveMyPreferencesAction,
} from "@/features/preferences/actions/preferences";
import {
  PreferenceDriver,
  type SyncStatus,
} from "@/features/preferences/client/preference-driver";
import {
  preferenceAmbiances,
  renderableAppearance,
  type AppearancePreferences,
  type PreferenceAmbiance,
} from "@/features/preferences/model";
import type { AreaPreferences } from "@/features/preferences/server/area-preferences";

import {
  APPEARANCE_COOKIE,
  appearanceCss,
  DELIVERED_STYLES,
  type Appearance,
} from "../appearance";
import type { StyleId } from "../palettes";
import { AccountNotice } from "./account-notice";

// Her appearance, applied to the professional area. The server renders it
// from her account (the layout reads it), so the first paint is hers on every
// device; the CSS is generated from validated values only. <html> carries it
// too while she is in the area, for what is rendered on <body> (sheets,
// dialogs), and lets go when she leaves it.
//
// Her account decides and PreferenceDriver keeps this page in step with it
// (docs/MEMBER_PREFERENCES_CONTRACT.md § 6). A style received from elsewhere
// waits for her: see the driver. AppearanceProvider, without an account, is
// for the previews: choices live in the page only.

type AppearanceContext = {
  appearance: Appearance;
  /** Applies at once; the fields she did not touch stay what they are. */
  change: (patch: Partial<Appearance>) => void;
  /** Where her choices stand; null where nothing is kept (previews). */
  sync: SyncStatus | null;
  /** A choice made on this page reached her account. */
  savedHere: boolean;
  retry: () => void;
};

const Context = createContext<AppearanceContext | null>(null);

/** Nothing can be typed there, and the server draws it in her account's style. */
const TODAY = "/app/today";

function AppearanceFrame({
  value,
  children,
}: {
  value: AppearanceContext;
  children: ReactNode;
}) {
  const { appearance } = value;
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

/** The previews: a fictional business, nothing kept. */
export function AppearanceProvider({
  initial,
  children,
}: {
  initial: Appearance;
  children: ReactNode;
}) {
  const [appearance, setAppearance] = useState(initial);
  const change = useCallback(
    (patch: Partial<Appearance>) =>
      setAppearance((current) => ({ ...current, ...patch })),
    [],
  );
  const value = useMemo(
    () => ({
      appearance,
      change,
      sync: null,
      savedHere: false,
      retry: () => undefined,
    }),
    [appearance, change],
  );
  return <AppearanceFrame value={value}>{children}</AppearanceFrame>;
}

/** Forgets the old device's look: asked once, the answer is hers. */
function forgetDeviceAppearance() {
  document.cookie = `${APPEARANCE_COOKIE}=; Path=/app; Max-Age=0; SameSite=Lax`;
}

/** The professional area, for her account. */
export function AccountAppearanceProvider({
  area,
  children,
}: {
  area: AreaPreferences;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [driver] = useState(
    () =>
      new PreferenceDriver(
        area,
        {
          read: () => getMyPreferencesAction(),
          save: (input) => saveMyPreferencesAction(input),
          importDevice: (input) => importDeviceAppearanceAction(input),
        },
        {
          refresh: () => router.refresh(),
          isHidden: () => document.visibilityState === "hidden",
        },
      ),
  );
  const view = useSyncExternalStore(
    driver.subscribe,
    driver.getView,
    driver.getView,
  );
  const [offerSettled, setOfferSettled] = useState(false);

  // Before paint: an account change never shows the other account's look.
  useLayoutEffect(() => driver.receiveArea(area), [driver, area]);

  useEffect(() => {
    driver.start();
    const onReturn = () => {
      if (document.visibilityState !== "hidden") driver.returned();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      driver.stop();
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [driver]);

  const waiting = view.status !== "idle" && view.status !== "unavailable";
  useEffect(() => {
    if (!waiting) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [waiting]);

  const appearance = useMemo<Appearance>(
    () => renderableAppearance(view.appearance, DELIVERED_STYLES),
    [view.appearance],
  );

  const received = view.receivedStyle
    ? renderableAppearance(
        { ...view.appearance, style: view.receivedStyle },
        DELIVERED_STYLES,
      ).style
    : appearance.style;
  const receivedWaits = received !== appearance.style;

  // Before paint: the next page is already in her account's style.
  useLayoutEffect(() => driver.applyReceivedStyle(), [driver, pathname]);
  useLayoutEffect(() => {
    if (receivedWaits && pathname === TODAY) driver.applyReceivedStyle();
  }, [driver, pathname, receivedWaits]);

  // Her account moved to Classique from elsewhere: « Aujourd’hui » is not
  // one of its pages (the server redirects there too).
  const leaveToday = pathname === TODAY && appearance.style === "classique";
  useEffect(() => {
    if (leaveToday) router.replace("/app");
  }, [leaveToday, router]);

  const value = useMemo<AppearanceContext>(
    () => ({
      appearance,
      change: (patch) => driver.change(keepable(patch)),
      sync: view.status,
      savedHere: view.savedHere,
      retry: () => driver.retry(),
    }),
    [appearance, driver, view.status, view.savedHere],
  );

  const offer =
    !offerSettled && !view.accountHasPreferences
      ? area.deviceAppearanceOffer
      : null;

  return (
    <AppearanceFrame value={value}>
      {children}
      <AccountNotice
        status={view.status}
        offer={offer}
        received={receivedWaits ? (received as StyleId) : null}
        onApply={() => driver.applyReceivedStyle()}
        importing={view.importing}
        onKeep={async () => {
          if (offer && (await driver.importDevice(offer))) {
            forgetDeviceAppearance();
            setOfferSettled(true);
          }
        }}
        onDecline={() => {
          forgetDeviceAppearance();
          setOfferSettled(true);
        }}
        onRetry={() => driver.retry()}
      />
    </AppearanceFrame>
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

/**
 * Only what her account can keep is sent: an ambiance the database does not
 * accept yet (a colour trio before its migration) is left out, never saved
 * and then refused.
 */
function keepable(patch: Partial<Appearance>): Partial<AppearancePreferences> {
  const { ambiance, ...rest } = patch;
  if (ambiance === undefined) return rest;
  return (preferenceAmbiances as readonly string[]).includes(ambiance)
    ? { ...rest, ambiance: ambiance as PreferenceAmbiance }
    : rest;
}
