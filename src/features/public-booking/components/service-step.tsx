"use client";

import type { Ref } from "react";

import { ChevronRightIcon } from "@/components/ui/icons";
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
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
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
              className="flex flex-col divide-y divide-line border-y border-line"
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
                      // A line of the salon's menu: name, then duration and price;
                      // the row answers the hand (art direction).
                      className="group -mx-3 flex w-[calc(100%+1.5rem)] min-w-0 cursor-pointer items-center gap-4 rounded-2xl px-3 py-4 text-left transition-[background-color,transform] duration-150 ease-soft hover:bg-sand/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:scale-[0.99] aria-pressed:bg-sand/70"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="text-[17px] font-semibold wrap-anywhere text-ink">
                          {item.name}
                        </span>
                        <span
                          id={`service-${item.id}-details`}
                          className="flex flex-col gap-1"
                        >
                          <span className="text-[14.5px] text-ink-soft tabular-nums">
                            {serviceFromLine(item)}
                          </span>
                          {item.description ? (
                            <span className="text-[14px] leading-snug wrap-anywhere whitespace-pre-line text-ink-muted">
                              {item.description}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <ChevronRightIcon
                        size={18}
                        aria-hidden="true"
                        className="shrink-0 text-ink-muted transition-transform duration-150 ease-soft group-hover:translate-x-0.5 group-hover:text-ink"
                      />
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
