"use client";

import type { Ref } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { formatPrice } from "@/features/agenda/client/money";
import { durationLabel } from "@/features/services/client/service-form";

import type { Booking } from "../client/api";
import {
  dayLabel,
  wallDate,
  wallTime,
  zoneCity,
} from "../client/business-time";
import { Facts, StepHeading, statusLabel } from "./booking-parts";

/**
 * The booking as the backend answered it (authoritative): nothing here is
 * taken from the form. No email is promised: none is sent yet, this screen
 * is the confirmation.
 *
 * Date and time are the wall clock of the booked slot as the availability
 * gave it (`local`), never a conversion of `startsAt` in the browser. When
 * the booking is no longer at that slot (a replay after the business moved
 * it), they are not shown: the business has the new time.
 */
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
  const confirmed = booking.status === "confirmed";
  return (
    <section aria-labelledby="booking-done" className="flex flex-col gap-5">
      <div id="booking-done">
        <StepHeading headingRef={headingRef}>
          {confirmed ? "Rendez-vous confirmé" : "Réservation retrouvée"}
        </StepHeading>
      </div>

      {confirmed ? (
        <Notice tone="success" title={`${booking.businessName} vous attend.`}>
          {booking.replayed
            ? "Cette réservation avait déjà été enregistrée : c’est le même rendez-vous, rien n’a été réservé en double."
            : "Votre rendez-vous est enregistré."}
        </Notice>
      ) : (
        <Notice tone="warning" title="Cette réservation a changé depuis">
          Elle avait bien été enregistrée, puis modifiée : elle est actuellement
          « {statusLabel(booking.status).toLowerCase()} ». Pour toute question,
          contactez {booking.businessName}.
        </Notice>
      )}

      <Facts
        rows={[
          ["Établissement", booking.businessName],
          ["Prestation", booking.serviceName],
          ...(local
            ? ([
                [
                  "Date",
                  <span key="date" className="first-letter:uppercase">
                    {dayLabel(wallDate(local), true)}
                  </span>,
                ],
                [
                  "Heure",
                  `${wallTime(local)} (heure de ${zoneCity(booking.timezone)})`,
                ],
              ] as [string, React.ReactNode][])
            : ([
                [
                  "Date et heure",
                  `Modifiées depuis par l’établissement : contactez ${booking.businessName}`,
                ],
              ] as [string, React.ReactNode][])),
          ["Durée", durationLabel(booking.durationMinutes)],
          ["Prix", formatPrice(booking.priceCents, booking.currency)],
          ["Statut", statusLabel(booking.status)],
        ]}
      />

      <p className="text-[14px] leading-snug text-ink-soft">
        Cet écran est votre confirmation : notez la date et l’heure. Pour
        modifier ou annuler, contactez directement {booking.businessName}.
      </p>
      {cancellationPolicy ? (
        <div className="flex flex-col gap-1 text-[14px] text-ink-soft">
          <p className="font-medium text-ink">Conditions d’annulation</p>
          <p className="whitespace-pre-line wrap-anywhere">
            {cancellationPolicy}
          </p>
        </div>
      ) : null}

      <Button variant="secondary" size="lg" fullWidth onClick={onAnother}>
        Prendre un autre rendez-vous
      </Button>
    </section>
  );
}
