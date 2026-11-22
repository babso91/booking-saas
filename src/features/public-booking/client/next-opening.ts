import { useEffect, useState } from "react";

import { fetchAvailabilityCalendar } from "./api";
import { addDays } from "./business-time";
import { choiceIdsOf, type BookingFlow } from "./use-booking-flow";

// Higani point 60: a day or a period without a slot is not a dead end. The
// booking looks for her next real slot after it, through the same public
// read as her calendar (her hours, closures, notice, horizon, the options
// chosen), and offers to go there. Nothing is guessed: no read, no offer.

/** A range read spans at most 31 days (the availability route). */
export const WINDOW_DAYS = 31;
/** How far a search goes (about four months) before saying so. */
export const MAX_WINDOWS = 4;

export type SearchWindow = { from: string; through: string };

/** The ranges to read after `after`, in order, up to her last bookable day. */
export function windowsAfter(
  after: string,
  last: string,
  size = WINDOW_DAYS,
  max = MAX_WINDOWS,
): SearchWindow[] {
  const windows: SearchWindow[] = [];
  let from = addDays(after, 1);
  while (from <= last && windows.length < max) {
    const end = addDays(from, size - 1);
    const through = end < last ? end : last;
    windows.push({ from, through });
    from = addDays(through, 1);
  }
  return windows;
}

export type NextOpening =
  | { status: "searching" }
  | { status: "found"; day: string; localStartsAt: string }
  /** Nothing up to `until`; `horizon`: that is her last bookable day. */
  | { status: "none"; until: string; horizon: boolean }
  | { status: "error" };

/**
 * Her next slot after `after` for the service and options chosen, or null
 * when there is nothing to look for (no day given, no service).
 */
export function useNextOpening(
  flow: BookingFlow,
  after: string | null,
): NextOpening | null {
  const { slug } = flow.business;
  const serviceId = flow.service?.id;
  const choices = flow.service
    ? choiceIdsOf(flow.service, flow.answers).join(",")
    : "";
  const last = flow.days.at(-1);
  const key =
    after && serviceId && last
      ? `${slug}:${serviceId}:${choices}:${after}:${last}`
      : null;
  const [read, setRead] = useState<{
    key: string;
    opening: NextOpening;
  } | null>(null);

  useEffect(() => {
    if (!key || !after || !serviceId || !last) return;
    const controller = new AbortController();
    const settle = (opening: NextOpening) => {
      if (!controller.signal.aborted) setRead({ key, opening });
    };
    void (async () => {
      const windows = windowsAfter(after, last);
      for (const window of windows) {
        const result = await fetchAvailabilityCalendar(
          slug,
          serviceId,
          window.from,
          window.through,
          choices ? choices.split(",") : [],
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.ok) return settle({ status: "error" });
        const open = result.data.days
          .filter((day) => day.slots.length > 0)
          .sort((a, b) => a.date.localeCompare(b.date))[0];
        if (open)
          return settle({
            status: "found",
            day: open.date,
            localStartsAt: open.slots
              .map((slot) => slot.localStartsAt)
              .sort()[0]!,
          });
      }
      const until = windows.at(-1)?.through ?? last;
      settle({ status: "none", until, horizon: until >= last });
    })();
    return () => controller.abort();
  }, [key, after, last, slug, serviceId, choices]);

  if (!key) return null;
  return read?.key === key ? read.opening : { status: "searching" };
}
