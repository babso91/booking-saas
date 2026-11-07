"use client";

import { useSyncExternalStore, type ReactNode, type Ref } from "react";

import { formatPrice } from "@/features/agenda/client/money";
import { durationLabel } from "@/features/services/client/service-form";

import { deviceTimeZone, zoneCity } from "../client/business-time";
import type { BookableService, SlotsState } from "../client/use-booking-flow";

// Small presentation pieces shared by the steps of the functional booking
// page. Visual only: every rule lives in useBookingFlow.

export const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

export const serviceLine = (
  durationMinutes: number,
  priceCents: number,
  currency: string,
) => `${durationLabel(durationMinutes)} · ${formatPrice(priceCents, currency)}`;

/** What an answer adds: "+15,00 € · +30 min", or "Inclus". */
export function choiceLine(
  choice: { priceDeltaCents: number; durationDeltaMinutes: number },
  currency: string,
) {
  const parts = [
    choice.priceDeltaCents > 0
      ? `+${formatPrice(choice.priceDeltaCents, currency)}`
      : null,
    choice.durationDeltaMinutes > 0
      ? `+${durationLabel(choice.durationDeltaMinutes)}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Inclus";
}

/**
 * A service in the list: its price and duration, "dès" when its required
 * groups can only add to them (their smallest answers). Read from her
 * catalogue for the list only; what is booked is always the server's quote.
 */
export function serviceFromLine(service: BookableService) {
  let price = service.priceCents;
  let minutes = service.durationMinutes;
  for (const option of service.options) {
    if (!option.required) continue;
    price += Math.min(...option.choices.map((item) => item.priceDeltaCents));
    minutes += Math.min(
      ...option.choices.map((item) => item.durationDeltaMinutes),
    );
  }
  const varies = service.options.some((option) =>
    option.choices.some(
      (item) => item.priceDeltaCents > 0 || item.durationDeltaMinutes > 0,
    ),
  );
  const line = serviceLine(minutes, price, service.currency);
  return varies ? `dès ${line}` : line;
}

/** The server's quote for her answers, or where it stands. */
export function QuoteLine({ slots }: { slots: SlotsState }) {
  if (slots.status === "ready")
    return (
      <p className="text-[17px] font-semibold text-ink tabular-nums">
        {serviceLine(
          slots.quote.durationMinutes,
          slots.quote.priceCents,
          slots.quote.currency,
        )}
      </p>
    );
  if (slots.status === "loading")
    return (
      <p role="status" className="text-[15px] text-ink-muted">
        Calcul du prix et de la durée…
      </p>
    );
  return <p className="text-[15px] text-ink-muted">—</p>;
}

/** The answers as the server priced them (a quote or a booking). */
export function answerRows(
  options: { question: string; label: string }[],
): [string, ReactNode][] {
  return options.map((option) => [option.question, option.label]);
}

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmé",
  cancelled: "Annulé",
  completed: "Terminé",
  no_show: "Absence notée",
};

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

/** A step title, focused when its step opens (keyboard and screen readers). */
export function StepHeading({
  step,
  total,
  children,
  headingRef,
}: {
  step?: number;
  total?: number;
  children: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="flex flex-col gap-1">
      {step && total ? (
        <p className="text-[13px] font-medium text-ink-muted">
          Étape {step} sur {total}
        </p>
      ) : null}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-[28px] leading-tight text-ink focus:outline-none sm:text-[32px]"
      >
        {children}
      </h2>
    </div>
  );
}

/** Label / value rows (recap, confirmation). */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-paper-raised">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
        >
          <dt className="text-[13.5px] text-ink-muted">{label}</dt>
          <dd className="min-w-0 text-[15px] font-medium wrap-anywhere text-ink sm:text-right">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const noSubscription = () => () => {};

/**
 * Says whose clock the times follow. When the customer's device is on
 * another zone, says so plainly: the times are the business's.
 */
export function TimeZoneNote({ timezone }: { timezone: string }) {
  // Read on the client only (the server has no idea of the device's zone).
  const device = useSyncExternalStore(
    noSubscription,
    deviceTimeZone,
    () => null,
  );
  const elsewhere = device !== null && device !== timezone;
  return (
    <p className="text-[13.5px] leading-snug text-ink-muted">
      Heures de l’établissement, heure de {zoneCity(timezone)} ({timezone}).
      {elsewhere
        ? " Votre appareil est réglé sur un autre fuseau horaire : les heures indiquées ici restent celles de l’établissement."
        : null}
    </p>
  );
}
