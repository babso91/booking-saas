"use client";

import type { Ref } from "react";

import { Notice } from "@/components/ui/notice";

import type { BookingFlow } from "../client/use-booking-flow";
import { serviceLine, StepHeading } from "./booking-parts";

/** Step 1: one of the business's active services (only those returned). */
export function ServiceStep({
  flow,
  headingRef,
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { services, notice, service } = flow;
  return (
    <section aria-labelledby="booking-service" className="flex flex-col gap-4">
      <div id="booking-service">
        <StepHeading step={1} total={4} headingRef={headingRef}>
          Choisissez une prestation
        </StepHeading>
      </div>

      {notice === "service_unavailable" ? (
        <Notice tone="warning" title="Prestation plus proposée">
          Elle n’est plus disponible à la réservation. Voici les prestations
          proposées actuellement ; vos coordonnées sont conservées.
        </Notice>
      ) : null}

      {services.length === 0 ? (
        <Notice tone="info" title="Aucune prestation en ligne">
          Cet établissement ne propose pas encore de prestation à réserver en
          ligne.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Prestations">
          {services.map((item) => {
            const selected = item.id === service?.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => flow.actions.chooseService(item.id)}
                  aria-pressed={selected}
                  aria-describedby={`service-${item.id}-details`}
                  className="flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-3xl border border-line bg-paper-raised px-4 py-4 text-left transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink sm:px-5"
                >
                  <span className="text-[17px] font-semibold wrap-anywhere text-ink">
                    {item.name}
                  </span>
                  <span
                    id={`service-${item.id}-details`}
                    className="flex flex-col gap-1"
                  >
                    <span className="text-[14.5px] text-ink-soft">
                      {serviceLine(
                        item.durationMinutes,
                        item.priceCents,
                        item.currency,
                      )}
                    </span>
                    {item.description ? (
                      <span className="text-[14px] leading-snug wrap-anywhere whitespace-pre-line text-ink-muted">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
