"use client";

import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, Ref } from "react";

import { Button } from "@/components/ui/button";
import { formatPrice } from "@/features/agenda/client/money";
import { durationLabel } from "@/features/services/client/service-form";

import type { Booking } from "../client/api";
import { wallDate, wallTime, zoneCity } from "../client/business-time";
import { statusLabel } from "./booking-parts";

/**
 * The booking as the backend answered it (authoritative), drawn as a ticket
 * the client keeps: one hero datum (the time), the service, a perforation
 * and a stub (duration, price). Nothing here is taken from the form, and no
 * email is promised: none is sent yet, this screen is the confirmation.
 *
 * Date and time are the wall clock of the booked slot as the availability
 * gave it (`local`), never a conversion of `startsAt` in the browser. When
 * the booking is no longer at that slot (a replay after the business moved
 * it), no time is shown: the business has the new one.
 *
 * The notches are cut out of the paper with a mask (not painted in a
 * background colour), so the ticket sits on any universe's ground; the
 * shadow is a drop-shadow on the wrapper, which follows the cut shape.
 */

const dayFormat = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

function longDay(date: string) {
  // Intl writes « 1 novembre »; French writes « 1er novembre ».
  return dayFormat
    .format(new Date(`${date}T12:00:00.000Z`))
    .replace(/ 1 /, " 1er ");
}

const hour = (clock: string) => clock.replace(":", "h");

function endClock(local: string, minutes: number) {
  const [h, m] = wallTime(local).split(":").map(Number) as [number, number];
  const total = (h * 60 + m + minutes) % (24 * 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

const NOTCH = "12px";
const cut = (edge: "top" | "bottom"): CSSProperties => {
  const y = edge === "top" ? "0" : "100%";
  const hole = (x: string) =>
    `radial-gradient(circle ${NOTCH} at ${x} ${y}, transparent 97%, #000 100%)`;
  const mask = `${hole("0")} left / 51% 100% no-repeat, ${hole("100%")} right / 51% 100% no-repeat`;
  return { mask, WebkitMask: mask };
};

const spring = { type: "spring", stiffness: 260, damping: 26 } as const;

export function BookingConfirmation({
  booking,
  local,
  cancellationPolicy,
  onAnother,
  headingRef,
}: {
  booking: Booking;
  /** The booked slot's wall clock, or null if the time changed since. */
  local: string | null;
  cancellationPolicy: string | null;
  onAnother: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const still = useReducedMotion();
  const confirmed = booking.status === "confirmed";
  const enter = (delay: number, y: number) =>
    still
      ? {}
      : {
          initial: { opacity: 0, y },
          animate: { opacity: 1, y: 0 },
          transition: { ...spring, delay },
        };

  return (
    <section
      aria-labelledby="booking-done"
      className="mx-auto flex w-full max-w-[26rem] flex-col gap-6"
    >
      <h2
        id="booking-done"
        ref={headingRef}
        tabIndex={-1}
        className="sr-only scroll-mt-6"
      >
        {confirmed ? "Rendez-vous confirmé" : "Réservation retrouvée"}
      </h2>

      <motion.div
        {...enter(0, 28)}
        className="drop-shadow-[0_18px_28px_rgb(var(--shadow-rgb)/0.16)]"
      >
        <div
          style={cut("bottom")}
          className="flex flex-col gap-5 rounded-t-3xl bg-paper-raised px-6 pt-6 pb-7"
        >
          <div className="flex items-center justify-between gap-4 text-[12px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
            <span className="min-w-0 truncate">{booking.businessName}</span>
            <span
              className={
                confirmed ? "shrink-0 text-ink" : "shrink-0 text-warning-strong"
              }
            >
              {confirmed ? "Confirmé" : statusLabel(booking.status)}
            </span>
          </div>

          {local ? (
            <div className="flex flex-col">
              <span className="text-[17px] font-medium text-ink-soft first-letter:uppercase">
                {longDay(wallDate(local))}
              </span>
              <motion.span
                {...enter(0.12, 10)}
                className="text-[76px] leading-[0.95] font-bold tracking-[-0.03em] text-ink tabular-nums"
              >
                {hour(wallTime(local))}
              </motion.span>
              <span className="mt-1 text-[14px] text-ink-muted tabular-nums">
                jusqu’à {hour(endClock(local, booking.durationMinutes))} · heure
                de {zoneCity(booking.timezone)}
              </span>
            </div>
          ) : (
            <p className="text-[17px] leading-snug font-medium text-pretty text-ink">
              L’horaire a été modifié depuis par {booking.businessName} :
              contactez l’établissement pour le connaître.
            </p>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-[20px] leading-tight font-semibold text-balance text-ink">
              {booking.serviceName}
            </span>
            {(booking.options ?? []).map((option) => (
              <span
                key={`${option.optionId}:${option.choiceId}`}
                className="text-[14px] text-ink-soft"
              >
                {option.question} :{" "}
                <span className="text-ink">{option.label}</span>
              </span>
            ))}
          </div>
        </div>

        <div
          style={cut("top")}
          className="relative rounded-b-3xl bg-paper-raised"
        >
          <span
            aria-hidden
            className="absolute inset-x-6 top-0 border-t-2 border-dotted border-line-strong"
          />
          <motion.div
            {...enter(0.28, -8)}
            className="flex items-end justify-between gap-4 px-6 pt-6 pb-6"
          >
            <span className="flex flex-col">
              <span className="text-[12px] text-ink-muted">Durée</span>
              <span className="text-[17px] font-semibold text-ink tabular-nums">
                {durationLabel(booking.durationMinutes)}
              </span>
            </span>
            <span className="flex flex-col items-end gap-1">
              <span className="text-[12px] text-ink-muted">Prix</span>
              <span className="rounded-full bg-mark px-3 py-1 text-[17px] font-semibold text-on-mark tabular-nums">
                {formatPrice(booking.priceCents, booking.currency)}
              </span>
            </span>
          </motion.div>
        </div>
      </motion.div>

      <motion.div {...enter(0.4, 8)} className="flex flex-col gap-3 px-1">
        {confirmed ? (
          <p className="text-[15px] leading-relaxed text-pretty text-ink-soft">
            {booking.replayed
              ? "Déjà enregistrée : c’est le même rendez-vous, rien n’a été réservé en double. "
              : "Gardez cet écran, c’est votre confirmation. "}
            Pour modifier ou annuler, contactez {booking.businessName}.
          </p>
        ) : (
          <div className="flex flex-col gap-1 text-[15px] leading-relaxed text-pretty text-ink-soft">
            <strong className="font-semibold text-ink">
              Cette réservation a changé depuis
            </strong>
            <p>
              Elle avait bien été enregistrée, puis modifiée : elle est
              actuellement « {statusLabel(booking.status).toLowerCase()} ». Pour
              toute question, contactez {booking.businessName}.
            </p>
          </div>
        )}
        {cancellationPolicy ? (
          <details className="text-[14px] text-ink-soft">
            <summary className="w-fit cursor-pointer font-semibold text-ink underline decoration-line-strong underline-offset-4">
              Conditions d’annulation
            </summary>
            <p className="mt-2 whitespace-pre-line wrap-anywhere">
              {cancellationPolicy}
            </p>
          </details>
        ) : null}
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          className="mt-2"
          onClick={onAnother}
        >
          Prendre un autre rendez-vous
        </Button>
      </motion.div>
    </section>
  );
}
