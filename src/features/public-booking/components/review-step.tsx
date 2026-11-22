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
import {
  answerRows,
  conditionRows,
  ConditionsList,
  Facts,
  linkAction,
  placeLine,
  StepHeading,
  type BookingPlace,
  whatsLeft,
} from "./booking-parts";

/** Step 4: everything that will be booked, then the confirmation. */
export function ReviewStep({
  flow,
  headingRef,
  preview = false,
  place,
}: {
  preview?: boolean;
  /** Her published place, when booking from her site. */
  place?: BookingPlace;
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const {
    business,
    service,
    slot,
    slotQuote: quote,
    contact,
    submit,
    isSending,
    pending,
    notice,
  } = flow;
  if (!service || !slot || !quote) return null;
  const details = canonicalContact(contact);
  const lieu = placeLine(place, business.location);
  const conditions = conditionRows(business.cancellationPolicy, place);
  const failure = submit.status === "failed" ? submit.error : null;

  return (
    <section aria-labelledby="booking-review" className="flex flex-col gap-5">
      <div id="booking-review">
        <StepHeading
          step={flow.stepNumber("review")}
          total={flow.stepCount}
          left={whatsLeft(flow.stepsAfter("review"))}
          headingRef={headingRef}
        >
          Vérifiez et confirmez
        </StepHeading>
      </div>

      {notice === "quote_changed" ? (
        <Notice tone="warning" title="Le prix ou la durée a changé">
          L’établissement vient de modifier cette prestation : rien n’a été
          réservé. Voici le prix et la durée à jour ; confirmez à nouveau si
          cela vous convient.
        </Notice>
      ) : null}

      <Facts
        rows={[
          ["Établissement", business.name],
          // Where, before she commits (Higani 56, 69).
          ...(lieu ? [["Lieu", lieu] as [string, string]] : []),
          ["Prestation", quote.serviceName],
          ...answerRows(quote.options, quote.currency),
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
          // The server's quote: what is booked, and sent as expected.
          ["Durée", durationLabel(quote.durationMinutes)],
          ["Prix", formatPrice(quote.priceCents, quote.currency)],
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
        {service.options.length > 0 ? (
          <button
            type="button"
            className={linkAction}
            disabled={isSending}
            onClick={() => flow.actions.goTo("options")}
          >
            Changer les options
          </button>
        ) : null}
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

      {conditions.length ? (
        <section
          aria-labelledby="booking-conditions"
          className="flex flex-col gap-3 rounded-2xl border border-line bg-paper-raised px-4 py-4"
        >
          <h3
            id="booking-conditions"
            className="text-[15px] font-semibold text-ink"
          >
            À savoir avant de confirmer
          </h3>
          <ConditionsList conditions={conditions} />
        </section>
      ) : null}

      {failure && !pending ? <Failure flow={flow} code={failure.code} /> : null}
      {/* Higani point 70: chosen, being sent, booked: never confused. */}
      {preview ? null : (
        <p
          role="status"
          className={
            isSending
              ? "text-[14px] font-medium text-ink"
              : "text-[14px] text-ink-soft"
          }
        >
          {isSending
            ? "Envoi de votre réservation… Restez sur cette page, la réponse arrive."
            : "Ce créneau n’est pas encore réservé : il le sera quand vous confirmerez."}
        </p>
      )}

      <Button
        size="lg"
        fullWidth
        state={isSending ? "loading" : "idle"}
        loadingLabel="Réservation en cours…"
        disabled={preview || flow.blockedByPending}
        onClick={flow.actions.confirm}
      >
        {preview
          ? "Confirmation désactivée dans l’aperçu"
          : "Confirmer la réservation"}
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
