"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getAgendaTodayAction } from "@/features/agenda/actions/agenda";
import type { AgendaDto } from "@/features/agenda/data/agenda";
import { callAction, type UiResult } from "@/features/auth/client/call-action";
import type { BusinessTodayDto } from "@/lib/time/business-time";

import {
  freshUntil,
  isFresh,
  knownFrom,
  knownFromAgenda,
  retryDelay,
  type KnownToday,
} from "./today";

/** Margin after the boundary before asking, so PostgreSQL has passed it too. */
const BOUNDARY_MARGIN_MS = 250;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Longest wait for an answer: an action never hangs on a silent request. */
export const TODAY_TIMEOUT_MS = 10_000;

/**
 * The business's date today on a screen that stays open, always as
 * PostgreSQL resolved it (see ./today.ts).
 *
 * No polling: the date is asked again only once the instant it ends has
 * passed — when a timer set for that instant fires, when the tab becomes
 * visible or focused again (timers are suspended while a device sleeps),
 * on the screen's clock tick as a fallback, and right before an action that
 * depends on today (`current` / `refresh`). Agenda reads carry the date too
 * and are taken into account for free (`begin` / `observe`).
 *
 * One request at a time; answers are applied in the order they were asked,
 * never after unmount. A failure keeps the last date and marks it stale: it
 * is retried with a growing delay, never replaced by a local guess.
 */
export function useCanonicalToday(
  initial: BusinessTodayDto,
  /** The screen's clock (ms), null while rendering on the server. */
  clockMs: number | null,
) {
  const [known, setKnown] = useState<KnownToday>(() =>
    knownFrom(initial, null),
  );
  // Last timer or wake-up event, with its device instant: a re-render that
  // re-evaluates freshness without waiting for the clock tick. A new object
  // each time, so two events at the same instant still count as two.
  const [wake, setWake] = useState({ at: 0 });

  const knownRef = useRef(known);
  const sequence = useRef({ issued: 0, applied: 0 });
  const inflight = useRef<Promise<UiResult<string>> | null>(null);
  const failure = useRef({ count: 0, retryAt: 0 });
  const mounted = useRef(true);
  const deadline = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (deadline.current !== null) window.clearTimeout(deadline.current);
    };
  }, []);

  /** Applies an answer unless a more recent request was already applied. */
  const apply = useCallback((token: number, next: KnownToday | null) => {
    if (!next || !mounted.current || token <= sequence.current.applied) return;
    sequence.current.applied = token;
    knownRef.current = next;
    setKnown(next);
  }, []);

  /** Asks PostgreSQL for today; concurrent callers share one request. */
  const refresh = useCallback((): Promise<UiResult<string>> => {
    if (inflight.current) return inflight.current;
    const token = (sequence.current.issued += 1);
    const failed = () => {
      const count = failure.current.count + 1;
      failure.current = { count, retryAt: Date.now() + retryDelay(count) };
    };

    const answer = callAction(() => getAgendaTodayAction()).then(
      (result): UiResult<string> => {
        if (!result.ok) {
          failed();
          return result;
        }
        // Applied even after the deadline below: a late answer is still
        // PostgreSQL's, in its order.
        failure.current = { count: 0, retryAt: 0 };
        apply(token, knownFrom(result.data, Date.now()));
        // A more recent answer (an agenda read) may already be in place.
        return { ok: true, data: knownRef.current.date };
      },
    );
    const silent = new Promise<UiResult<string>>((resolve) => {
      deadline.current = window.setTimeout(() => {
        failed();
        resolve({ ok: false, error: { code: "network" } });
      }, TODAY_TIMEOUT_MS);
    });
    const timer = deadline.current;

    const request = Promise.race([answer, silent]).then((result) => {
      window.clearTimeout(timer!);
      if (deadline.current === timer) deadline.current = null;
      if (inflight.current === request) inflight.current = null;
      return result;
    });
    inflight.current = request;
    return request;
  }, [apply]);

  /** Today if the known date is still valid at this very instant, else null. */
  const current = useCallback(
    () =>
      isFresh(knownRef.current, Date.now()) ? knownRef.current.date : null,
    [],
  );

  /** Marks the start of an agenda read; pass the token to `observe`. */
  const begin = useCallback(() => (sequence.current.issued += 1), []);
  const observe = useCallback(
    (
      token: number,
      data: Pick<AgendaDto, "today"> & {
        workingHours: { days: { date: string; endsAt: string }[] };
      },
    ) => apply(token, knownFromAgenda(data, knownRef.current, Date.now())),
    [apply],
  );

  // A timer for the instant the known date ends.
  const boundary = freshUntil(known);
  useEffect(() => {
    const delay = boundary - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(
      () => setWake({ at: Date.now() }),
      Math.min(delay + BOUNDARY_MARGIN_MS, MAX_TIMEOUT_MS),
    );
    return () => window.clearTimeout(timer);
  }, [boundary]);

  // Timers do not run while a device sleeps and are throttled in background
  // tabs: look again whenever the screen comes back.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== "hidden") setWake({ at: Date.now() });
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, []);

  const now = clockMs === null ? null : Math.max(clockMs, wake.at);
  const fresh = now === null || isFresh(known, now);

  useEffect(() => {
    if (now === null || fresh) return;
    // Nobody is looking: wait for the tab to come back.
    if (document.visibilityState === "hidden") return;
    if (Date.now() < failure.current.retryAt) return;
    void refresh();
  }, [now, wake, fresh, refresh]);

  return {
    /** Last date PostgreSQL called today. */
    date: known.date,
    /** False once that date's end has passed and no new answer came yet. */
    fresh,
    current,
    refresh,
    begin,
    observe,
  };
}
