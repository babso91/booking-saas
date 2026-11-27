"use client";

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { Notice } from "@/components/ui/notice";

import type { PublicCatalog } from "@/features/catalog/model";

import type { PublicBusiness } from "../client/api";
import { readPendingBooking } from "../client/pending-booking";
import { useBookingFlow, type BookingStep } from "../client/use-booking-flow";
import type { BookingFormat } from "../formats";
import { GuidedProgress } from "./guided-progress";
import { BookingConfirmation } from "./booking-confirmation";
import { ContactStep } from "./contact-step";
import { OptionsStep } from "./options-step";
import { PendingNotice } from "./pending-notice";
import { linkAction, type BookingPlace } from "./booking-parts";
import { ReviewStep } from "./review-step";
import { ServiceStep } from "./service-step";
import { carryFrom, carrying } from "@/components/ui/motion";

import styles from "./booking-motion.module.css";

const STEPS: readonly BookingStep[] = [
  "service",
  "options",
  "slot",
  "contact",
  "review",
  "done",
];
import { SlotStep, type CalendarPosition } from "./slot-step";

/**
 * The functional public booking page: the business, then the steps (with
 * "Options" for a service that has some) and the confirmation. Presentation only, over useBookingFlow (which holds
 * every booking rule), so another presentation can replace this one.
 */
export function PublicBooking({
  business,
  catalog,
  embedded = false,
  format = "classic",
  gallery,
  preview = false,
  initialServiceId,
  backRef,
  initialDate,
  place,
}: {
  backRef?: Ref<() => boolean>;
  business: PublicBusiness;
  format?: BookingFormat;
  gallery?: ReactNode;
  preview?: boolean;
  /** As get_public_catalog projects it: services, categories, options. */
  catalog: PublicCatalog;
  /**
   * Inside her mini-site's booking sheet: the steps only (the site already
   * says who she is), in a <div> rather than the page's <main>.
   */
  embedded?: boolean;
  /**
   * The service she tapped on her mini-site: opened at once, on its
   * options when it has some, else on its slots.
   */
  initialServiceId?: string;
  /** The day to open on: that service's next slot, shown on her site. */
  initialDate?: string;
  /** Her published place and contact ("Infos pratiques" of her site). */
  place?: BookingPlace;
}) {
  const flow = useBookingFlow({ business, catalog, preview, initialDate });
  // Each step slides in the way she travels: forward from the right, back
  // from the left (« où suis-je ? » answered by the motion itself).
  const [travel, setTravel] = useState({
    step: flow.step,
    back: false,
    carry: false,
  });
  if (travel.step !== flow.step)
    setTravel({
      step: flow.step,
      back: STEPS.indexOf(flow.step) < STEPS.indexOf(travel.step),
      carry: carrying(),
    });
  const initialView =
    format === "calendar"
      ? "month"
      : format === "chronological"
        ? "week"
        : "day";
  const [remembered, remember] = useState<
    (CalendarPosition & { serviceId: string | undefined }) | null
  >(null);
  const position: CalendarPosition =
    remembered && remembered.serviceId === flow.service?.id
      ? remembered
      : { view: initialView, anchor: flow.date, fromMonth: false };
  const setPosition = (next: CalendarPosition) =>
    remember({ ...next, serviceId: flow.service?.id });
  const heading = useRef<HTMLHeadingElement>(null);
  const opened = useRef(false);
  const onlyService =
    flow.services.length === 1 &&
    (format === "calendar" || format === "chronological");
  const asked = useRef(
    initialServiceId ?? (onlyService ? flow.services[0]?.id : undefined),
  );

  // Once, on arrival: the same action as a tap on that service. Its read
  // is aborted if the flow unmounts; a remount (React's development check,
  // a preserved subtree shown again) asks it again rather than waiting on
  // a read that will never answer.
  //
  // Her booking in progress in this tab (point 67) comes first when it is
  // the one she comes back to (no other service asked): taken back where
  // she was. Otherwise only her details are, and the asked service opens.
  // An unconfirmed request has its own way back (PendingNotice).
  useEffect(() => {
    const id = asked.current;
    const draftId = flow.draftServiceId;
    const whole =
      draftId !== null &&
      (initialServiceId ?? draftId) === draftId &&
      (preview || !readPendingBooking(business.slug));
    if (whole) flow.actions.resume(true);
    else {
      flow.actions.resume(false);
      if (id) flow.actions.chooseService(id);
    }
    asked.current = undefined;
    return () => {
      asked.current = id;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  useImperativeHandle(backRef, () => () => {
    if (flow.isSending) return true;
    if (flow.gone || flow.step === "service" || flow.step === "done")
      return false;
    if (flow.step === "slot" && position.fromMonth) {
      setPosition({ ...position, view: "month", fromMonth: false });
      return true;
    }
    if (flow.step === "review") flow.actions.goTo("contact");
    else if (flow.step === "contact") flow.actions.goTo("slot");
    else if (flow.step === "slot" && flow.service?.options.length)
      flow.actions.goTo("options");
    else if (onlyService || initialServiceId) return false;
    else {
      const key = `service:${flow.service?.id}`;
      carryFrom(key, document.querySelector(`[data-carry="${key}"]`));
      flow.actions.goTo("service");
    }
    return true;
  });

  // Each step change moves focus to its title (not on arrival).
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    const scroller = heading.current?.closest<HTMLElement>(
      "[data-booking-scroll]",
    );
    if (scroller) scroller.scrollTop = 0;
    else heading.current?.scrollIntoView?.({ block: "start" });
  }, [flow.step]);

  const Root = embedded ? "div" : "main";
  return (
    <Root
      data-booking-format={format}
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
          {format === "guided" && flow.step !== "done" ? (
            <GuidedProgress flow={flow} />
          ) : null}
          {flow.step !== "done" ? <PendingNotice flow={flow} /> : null}
          {flow.notice === "resumed" && flow.step !== "done" ? (
            <Notice
              tone="info"
              title="Votre réservation reprend là où vous l’aviez laissée"
              action={
                <button
                  type="button"
                  className={linkAction}
                  onClick={flow.actions.startOver}
                >
                  Recommencer
                </button>
              }
            >
              Rien n’est réservé tant que vous n’avez pas confirmé.
            </Notice>
          ) : null}
          <div className={styles.track}>
            <div
              key={flow.step}
              className={styles.step}
              data-back={travel.back || undefined}
              data-carry={travel.carry || undefined}
            >
              {flow.step === "service" ? (
                <ServiceStep
                  flow={flow}
                  headingRef={heading}
                  format={format}
                  gallery={gallery}
                />
              ) : flow.step === "options" ? (
                <OptionsStep flow={flow} headingRef={heading} />
              ) : flow.step === "slot" ? (
                <SlotStep
                  flow={flow}
                  headingRef={heading}
                  position={position}
                  onPosition={setPosition}
                  format={format}
                  place={place}
                />
              ) : flow.step === "contact" ? (
                <ContactStep flow={flow} headingRef={heading} />
              ) : flow.step === "review" ? (
                <ReviewStep
                  flow={flow}
                  headingRef={heading}
                  preview={preview}
                  place={place}
                />
              ) : flow.booking ? (
                <BookingConfirmation
                  booking={flow.booking}
                  local={flow.bookedLocal}
                  cancellationPolicy={business.cancellationPolicy}
                  place={place}
                  location={business.location}
                  onAnother={flow.actions.restart}
                  headingRef={heading}
                />
              ) : null}
            </div>
          </div>
        </>
      )}
    </Root>
  );
}
