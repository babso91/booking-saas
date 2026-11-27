"use client";

import type { ReactNode, Ref } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { formatPrice } from "@/features/agenda/client/money";
import { durationLabel } from "@/features/services/client/service-form";

import type { Booking } from "../client/api";
import {
  calendarFile,
  googleCalendarHref,
  type CalendarEvent,
} from "../client/calendar-event";
import {
  dayLabel,
  wallDate,
  wallTime,
  zoneCity,
} from "../client/business-time";
import { directionsHref, telHref } from "@/features/experience/practical";
import { cn } from "@/lib/cn";

import {
  answerRows,
  Facts,
  linkAction,
  placeLine,
  StepHeading,
  statusLabel,
  type BookingPlace,
} from "./booking-parts";

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
  place,
  location = null,
  onAnother,
  headingRef,
}: {
  booking: Booking;
  /** The booked slot's wall clock, or null if the time changed since. */
  local: string | null;
  cancellationPolicy: string | null;
  /** Her published place and contact, when booked from her site. */
  place?: BookingPlace;
  /** Her general location, when she publishes no address. */
  location?: string | null;
  onAnother: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const confirmed = booking.status === "confirmed";
  const lieu = placeLine(place, location);
  const address = place?.address.trim();
  const instructions = place?.instructions.trim();
  const phone = place?.phone.trim();
  const email = place?.email.trim();
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
          // Where to go (Higani 77): her address with directions.
          ...(lieu
            ? [
                [
                  "Lieu",
                  <span key="lieu" className="flex flex-col gap-1">
                    <span className="wrap-anywhere">{lieu}</span>
                    {address ? (
                      <a
                        href={directionsHref(address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkAction}
                      >
                        Itinéraire
                        <span className="sr-only"> (nouvel onglet)</span>
                      </a>
                    ) : null}
                  </span>,
                ] as [string, ReactNode],
              ]
            : []),
          ["Prestation", booking.serviceName],
          // As booked: the answers and the totals the server recorded.
          ...answerRows(booking.options ?? [], booking.currency),
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

      {/* Her own calendar (point 79), for a time that still holds. */}
      {confirmed && local ? (
        <AddToCalendar
          event={{
            id: booking.appointmentId,
            title: `${booking.serviceName} · ${booking.businessName}`,
            startsAt: booking.startsAt,
            endsAt: booking.endsAt,
            location: lieu,
            details: [
              instructions ? `Avant de venir : ${instructions}` : "",
              phone ? `Contact : ${phone}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          }}
        />
      ) : null}

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

      {instructions ? (
        <div className="flex flex-col gap-1 text-[14px] text-ink-soft">
          <p className="font-medium text-ink">Avant de venir</p>
          <p className="whitespace-pre-line wrap-anywhere">{instructions}</p>
        </div>
      ) : null}
      {phone || email ? (
        <div className="flex flex-col gap-1 text-[14px] text-ink-soft">
          <p className="font-medium text-ink">Contact</p>
          {phone ? (
            <a href={telHref(phone)} className={`${linkAction} min-h-11`}>
              {phone}
            </a>
          ) : null}
          {email ? (
            <a
              href={`mailto:${email}`}
              className={`${linkAction} min-h-11 wrap-anywhere`}
            >
              {email}
            </a>
          ) : null}
        </div>
      ) : null}

      <Button variant="secondary" size="lg" fullWidth onClick={onAnother}>
        Prendre un autre rendez-vous
      </Button>
    </section>
  );
}

/**
 * Her appointment added to her own calendar (point 79): a calendar file,
 * opened by Apple's and Outlook's (and most others), or Google's own form.
 * Built here from the booking the server answered; nothing is sent.
 */
export function AddToCalendar({ event }: { event: CalendarEvent }) {
  const pill = cn(
    "inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-medium whitespace-nowrap transition-colors",
    buttonVariants.secondary,
  );

  function download() {
    const file = new Blob([calendarFile(event)], {
      type: "text/calendar;charset=utf-8",
    });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "rendez-vous.ics";
    document.body.append(link);
    link.click();
    link.remove();
    // Kept a moment: some browsers read it after the click returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <div
      role="group"
      aria-labelledby="add-to-calendar"
      className="flex flex-col gap-2"
    >
      <p id="add-to-calendar" className="text-[14px] font-medium text-ink">
        Ajouter à votre agenda
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={download} className={pill}>
          Apple, Outlook…
        </button>
        <a
          href={googleCalendarHref(event)}
          target="_blank"
          rel="noopener noreferrer"
          className={pill}
        >
          Google Agenda
          <span className="sr-only"> (nouvel onglet)</span>
        </a>
      </div>
    </div>
  );
}
