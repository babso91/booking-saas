"use client";

import { Notice } from "@/components/ui/notice";

import { dayLabel, wallDate, wallTime } from "../client/business-time";
import type { BookingFlow } from "../client/use-booking-flow";
import { linkAction } from "./booking-parts";

/**
 * A booking request whose answer was never read (connection cut, page
 * left, reload): it may have booked. Offered back to be resent exactly
 * (same body, same request id: answered with the booking already made,
 * never a second one), or abandoned on purpose.
 */
export function PendingNotice({ flow }: { flow: BookingFlow }) {
  const { pending, services, business, blockedByPending } = flow;
  if (!pending) return null;
  const { command, localStartsAt } = pending;
  const serviceName =
    services.find((item) => item.id === command.serviceId)?.name ??
    "Prestation";
  return (
    <Notice
      tone="warning"
      title="Réservation non confirmée"
      action={
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <button
            type="button"
            className={linkAction}
            onClick={flow.actions.resendPending}
          >
            Renvoyer la même demande
          </button>
          <button
            type="button"
            className={linkAction}
            onClick={flow.actions.abandonPending}
          >
            L’abandonner
          </button>
        </div>
      }
    >
      <p>
        La réponse n’est pas arrivée : votre rendez-vous a peut-être été
        enregistré. Renvoyer la même demande ne crée jamais un second
        rendez-vous.
      </p>
      <p className="mt-1.5 font-semibold wrap-anywhere">
        {serviceName}, {dayLabel(wallDate(localStartsAt))} à{" "}
        {wallTime(localStartsAt)}, au nom de {command.firstName} (
        {command.email})
      </p>
      {blockedByPending ? (
        <p className="mt-1.5">
          Elle diffère de la réservation affichée : renvoyez-la ou abandonnez-la
          avant d’en confirmer une autre.
        </p>
      ) : null}
      <p className="mt-1.5">
        Si vous l’abandonnez et qu’elle avait abouti, le rendez-vous existe chez{" "}
        {business.name}.
      </p>
    </Notice>
  );
}
