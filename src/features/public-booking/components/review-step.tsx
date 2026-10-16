"use client";

import type { Ref } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { formatPrice } from "@/features/agenda/client/money";
import { durationLabel } from "@/features/services/client/service-form";

import {
  dayLabel,
  wallDate,
  wallTime,
  zoneCity,
} from "../client/business-time";
import { canonicalContact } from "../client/contact";
import type { BookingFlow } from "../client/use-booking-flow";
import { Facts, linkAction, StepHeading } from "./booking-parts";

/** Step 4: everything that will be booked, then the confirmation. */
export function ReviewStep({
  flow,
  headingRef,
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { business, service, slot, contact, submit, isSending, pending } = flow;
  if (!service || !slot) return null;
  const details = canonicalContact(contact);
  const failure = submit.status === "failed" ? submit.error : null;

  return (
    <section aria-labelledby="booking-review" className="flex flex-col gap-5">
      <div id="booking-review">
        <StepHeading step={4} total={4} headingRef={headingRef}>
          Vérifiez et confirmez
        </StepHeading>
      </div>

      <Facts
        rows={[
          ["Établissement", business.name],
          ["Prestation", service.name],
          [
            "Date",
            <span key="date" className="first-letter:uppercase">
              {dayLabel(wallDate(slot.localStartsAt), true)}
            </span>,
          ],
          [
            "Heure",
            `${wallTime(slot.localStartsAt)} (heure de ${zoneCity(business.timezone)})`,
          ],
          ["Durée", durationLabel(service.durationMinutes)],
          ["Prix", formatPrice(service.priceCents, service.currency)],
          [
            "Vos coordonnées",
            [
              [details.firstName, details.lastName].filter(Boolean).join(" "),
              details.email,
              details.phone,
            ]
              .filter(Boolean)
              .join(" · "),
          ],
        ]}
      />
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <button
          type="button"
          className={linkAction}
          disabled={isSending}
          onClick={() => flow.actions.goTo("slot")}
        >
          Changer de créneau
        </button>
        <button
          type="button"
          className={linkAction}
          disabled={isSending}
          onClick={() => flow.actions.goTo("contact")}
        >
          Modifier mes coordonnées
        </button>
      </div>

      {business.cancellationPolicy ? (
        <div className="flex flex-col gap-1 text-[14px] text-ink-soft">
          <p className="font-medium text-ink">Conditions d’annulation</p>
          <p className="whitespace-pre-line wrap-anywhere">
            {business.cancellationPolicy}
          </p>
        </div>
      ) : null}

      {failure && !pending ? <Failure flow={flow} code={failure.code} /> : null}

      <Button
        size="lg"
        fullWidth
        state={isSending ? "loading" : "idle"}
        loadingLabel="Réservation en cours…"
        disabled={flow.blockedByPending}
        onClick={flow.actions.confirm}
      >
        Confirmer la réservation
      </Button>
    </section>
  );
}

function Failure({ flow, code }: { flow: BookingFlow; code: string }) {
  switch (code) {
    case "rate_limited":
      return (
        <Notice tone="warning" title="Trop de demandes pour le moment">
          Votre réservation n’a pas été enregistrée. Merci de réessayer un peu
          plus tard ; vos informations sont conservées.
        </Notice>
      );
    case "idempotency_conflict":
      return (
        <Notice
          tone="warning"
          title="Demande déjà utilisée"
          action={
            <button
              type="button"
              className={linkAction}
              onClick={flow.actions.sendAsNew}
            >
              Envoyer comme nouvelle demande
            </button>
          }
        >
          Cette demande avait déjà servi pour une autre réservation : rien n’a
          été réservé avec ces informations. Vous pouvez l’envoyer comme une
          nouvelle demande.
        </Notice>
      );
    case "validation_error":
      return (
        <Notice
          tone="error"
          title="Réservation impossible"
          action={
            <button
              type="button"
              className={linkAction}
              onClick={() => flow.actions.goTo("slot")}
            >
              Choisir à nouveau le créneau
            </button>
          }
        >
          Certaines informations ont été refusées. Choisissez à nouveau votre
          créneau.
        </Notice>
      );
    default:
      return (
        <Notice tone="error" title="Réservation impossible">
          Elle n’a pas pu être enregistrée. Réessayez dans un instant.
        </Notice>
      );
  }
}
