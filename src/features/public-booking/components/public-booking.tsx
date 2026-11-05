"use client";

import { useEffect, useRef } from "react";

import { Notice } from "@/components/ui/notice";

import type { PublicBusiness, PublicService } from "../client/api";
import { useBookingFlow } from "../client/use-booking-flow";
import { BookingConfirmation } from "./booking-confirmation";
import { ContactStep } from "./contact-step";
import { PendingNotice } from "./pending-notice";
import { ReviewStep } from "./review-step";
import { ServiceStep } from "./service-step";
import { SlotStep } from "./slot-step";

/**
 * The functional public booking page: the business, then the four steps
 * and the confirmation. Presentation only, over useBookingFlow (which holds
 * every booking rule), so another presentation can replace this one.
 */
export function PublicBooking({
  business,
  services,
  embedded = false,
  initialServiceId,
}: {
  business: PublicBusiness;
  services: PublicService[];
  /**
   * Inside her mini-site's booking sheet: the steps only (the site already
   * says who she is), in a <div> rather than the page's <main>.
   */
  embedded?: boolean;
  /** The service she tapped on her mini-site: its slots open at once. */
  initialServiceId?: string;
}) {
  const flow = useBookingFlow({ business, services });
  const heading = useRef<HTMLHeadingElement>(null);
  const opened = useRef(false);
  const asked = useRef(initialServiceId);

  // Once, on arrival: the same action as a tap on that service.
  useEffect(() => {
    if (!asked.current) return;
    flow.actions.chooseService(asked.current);
    asked.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  // Each step change moves focus to its title (not on arrival).
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [flow.step]);

  const Root = embedded ? "div" : "main";
  return (
    <Root
      className={
        embedded
          ? "flex w-full flex-col gap-7"
          : "mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-7 px-4 pt-8 pb-16 sm:px-6 sm:pt-12"
      }
    >
      {embedded ? null : (
        <header className="flex flex-col gap-2">
          <p className="text-[13px] font-medium tracking-wide text-ink-muted uppercase">
            Réservation en ligne
          </p>
          <h1 className="font-display text-[36px] leading-none wrap-anywhere text-ink sm:text-[44px]">
            {business.name}
          </h1>
          {business.location ? (
            <p className="text-[14.5px] wrap-anywhere text-ink-soft">
              {business.location}
            </p>
          ) : null}
          {business.description ? (
            <p className="text-[14.5px] leading-relaxed wrap-anywhere whitespace-pre-line text-ink-soft">
              {business.description}
            </p>
          ) : null}
        </header>
      )}

      {flow.gone ? (
        <Notice tone="warning" title="Réservation indisponible">
          Cette page de réservation n’est plus disponible. Contactez
          l’établissement directement.
        </Notice>
      ) : (
        <>
          {flow.step !== "done" ? <PendingNotice flow={flow} /> : null}
          {flow.step === "service" ? (
            <ServiceStep flow={flow} headingRef={heading} />
          ) : flow.step === "slot" ? (
            <SlotStep flow={flow} headingRef={heading} />
          ) : flow.step === "contact" ? (
            <ContactStep flow={flow} headingRef={heading} />
          ) : flow.step === "review" ? (
            <ReviewStep flow={flow} headingRef={heading} />
          ) : flow.booking ? (
            <BookingConfirmation
              booking={flow.booking}
              local={flow.bookedLocal}
              cancellationPolicy={business.cancellationPolicy}
              onAnother={flow.actions.restart}
              headingRef={heading}
            />
          ) : null}
        </>
      )}
    </Root>
  );
}
