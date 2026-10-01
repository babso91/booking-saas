"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { getAgendaTodayAction } from "@/features/agenda/actions/agenda";
import { callAction } from "@/features/auth/client/call-action";

import { TodayTracker } from "./today-tracker";

/**
 * The business's date today for a screen that stays open: a TodayTracker
 * bound to the component's life. Mounting starts it, unmounting stops it
 * (nothing survives: timers, listeners, pending request), and a Strict Mode
 * remount starts it again like the first time.
 */
export function useCanonicalToday(
  /** The date PostgreSQL gave with the page. */
  seed: string,
  /** Changes on every tick of the screen's clock. */
  tick: number,
) {
  const [tracker] = useState(
    () =>
      new TodayTracker(seed, () => callAction(() => getAgendaTodayAction())),
  );
  const shown = useSyncExternalStore(
    tracker.subscribe,
    tracker.snapshot,
    tracker.snapshot,
  );

  useEffect(() => {
    tracker.start();
    return () => tracker.stop();
  }, [tracker]);

  // Fallback for a delayed timer, and the retry after a failure.
  useEffect(() => {
    tracker.check();
  }, [tracker, tick]);

  return {
    /** Last date PostgreSQL called today (display only). */
    date: shown.date,
    /** False while that date may be over and no new answer came yet. */
    certain: shown.certain,
    /** Asks PostgreSQL for today: before any action that depends on it. */
    validate: tracker.validate,
    begin: tracker.begin,
    observe: tracker.observe,
  };
}
