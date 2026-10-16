"use client";

import { useSyncExternalStore, type ReactNode, type Ref } from "react";

import { formatPrice } from "@/features/agenda/client/money";
import { durationLabel } from "@/features/services/client/service-form";

import { deviceTimeZone, zoneCity } from "../client/business-time";

// Small presentation pieces shared by the steps of the functional booking
// page. Visual only: every rule lives in useBookingFlow.

export const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

export const serviceLine = (
  durationMinutes: number,
  priceCents: number,
  currency: string,
) => `${durationLabel(durationMinutes)} · ${formatPrice(priceCents, currency)}`;

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
