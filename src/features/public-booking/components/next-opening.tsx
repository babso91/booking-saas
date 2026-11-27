"use client";

import { dayLabel, wallTime } from "../client/business-time";
import { useLate } from "@/components/ui/motion";

import { useNextOpening } from "../client/next-opening";
import type { BookingFlow } from "../client/use-booking-flow";
import { linkAction } from "./booking-parts";

/**
 * A day or a period without a slot (Higani point 60): it says so, then
 * offers her next real slot after it, or says up to when there is none.
 * If that search cannot be read, the next day stays one tap away.
 */
export function NextOpeningNote({
  flow,
  after,
  lead,
  onGo,
  fallbackDay,
}: {
  flow: BookingFlow;
  /** The last day shown: the search starts the day after. */
  after: string;
  /** What is empty, said first. */
  lead: string;
  /** Show that day (the step decides how). */
  onGo: (day: string) => void;
  fallbackDay?: string;
}) {
  const opening = useNextOpening(flow, after);
  // A quick search would only flash its hint: its place is kept instead.
  const slow = useLate(opening?.status === "searching");
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-line bg-paper-raised px-4 py-4">
      <p className="text-[14.5px] text-ink-soft">{lead}</p>
      <div aria-live="polite" className="flex flex-col items-start gap-2">
        {opening?.status === "searching" ? (
          slow ? (
            <p className="text-[14px] text-ink-muted">
              Recherche du prochain créneau…
            </p>
          ) : (
            <div className="min-h-11" />
          )
        ) : opening?.status === "found" ? (
          <button
            type="button"
            onClick={() => onGo(opening.day)}
            className="min-h-11 cursor-pointer rounded-xl border border-ink px-4 py-2 text-left text-[14.5px] font-semibold wrap-anywhere text-ink transition-colors hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Prochain créneau : {dayLabel(opening.day)} à{" "}
            {wallTime(opening.localStartsAt)}
          </button>
        ) : opening?.status === "none" ? (
          <>
            <p className="text-[14px] text-ink-soft">
              {opening.horizon
                ? `Les réservations en ligne sont ouvertes jusqu’au ${dayLabel(opening.until)} : aucun créneau d’ici là.`
                : `Aucun créneau en ligne d’ici le ${dayLabel(opening.until)}.`}
            </p>
            {flow.services.length > 1 ? (
              <button
                type="button"
                className={linkAction}
                onClick={() => flow.actions.goTo("service")}
              >
                Choisir une autre prestation
              </button>
            ) : null}
          </>
        ) : opening?.status === "error" && fallbackDay ? (
          <button
            type="button"
            className={linkAction}
            onClick={() => onGo(fallbackDay)}
          >
            Voir le {dayLabel(fallbackDay)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
