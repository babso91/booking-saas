"use client";

import type { Ref } from "react";

import { Notice } from "@/components/ui/notice";

import type { BookingFlow } from "../client/use-booking-flow";
import { serviceFromLine, StepHeading } from "./booking-parts";

/**
 * Step 1: one of her services, as her catalogue shows them: her visible
 * categories in her order, each with its services, then those without a
 * category, without a heading. Only what the server returned.
 */
export function ServiceStep({
  flow,
  headingRef,
  linkedServiceGone = false,
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
  /** The link she followed named a service no longer bookable online. */
  linkedServiceGone?: boolean;
}) {
  const { services, notice, service, catalog } = flow;
  return (
    <section aria-labelledby="booking-service" className="flex flex-col gap-4">
      <div id="booking-service">
        <StepHeading
          step={flow.stepNumber("service")}
          total={flow.stepCount}
          headingRef={headingRef}
        >
          Choisissez une prestation
        </StepHeading>
      </div>

      {linkedServiceGone && notice === null ? (
        <Notice tone="info" title="Cette prestation n’est plus proposée">
          Le lien que vous avez suivi mène à une prestation qui n’est plus
          réservable en ligne. Voici les prestations proposées actuellement.
        </Notice>
      ) : null}

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
        catalog.groups.map((group) => (
          <div
            key={group.category?.id ?? "none"}
            className="flex flex-col gap-3"
          >
            {group.category ? (
              <h3 className="pt-2 font-display text-[22px] leading-tight wrap-anywhere text-ink">
                {group.category.name}
              </h3>
            ) : null}
            <ul
              className="flex flex-col gap-3"
              aria-label={group.category?.name ?? "Prestations"}
            >
              {group.services.map(({ id }) => {
                const item = services.find((entry) => entry.id === id)!;
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
                          {serviceFromLine(item)}
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
          </div>
        ))
      )}
    </section>
  );
}
