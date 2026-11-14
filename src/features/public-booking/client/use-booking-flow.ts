"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "@/features/agenda/client/request-id";
import type {
  PublicCatalog,
  PublicCatalogService,
} from "@/features/catalog/model";

import {
  fetchAvailability,
  fetchPublicBusiness,
  postBooking,
  type Booking,
  type BookingCommand,
  type BookingError,
  type PublicBusiness,
  type Quote,
  type Slot,
} from "./api";
import { addDays, businessToday, wallDate } from "./business-time";
import {
  canonicalContact,
  checkContact,
  EMPTY_CONTACT,
  serverContactErrors,
  type Contact,
  type ContactField,
} from "./contact";
import {
  clearPendingBooking,
  parsePendingBooking,
  pendingBookingSnapshot,
  subscribePendingBooking,
  writePendingBooking,
  type PendingBooking,
} from "./pending-booking";

// The public booking journey, as state and actions only: no markup, no
// styles. Any presentation (today's functional page, a future branded
// mini-site) renders this state and calls these actions; the rules live
// here once:
//
// - Only what the backend returns is offered: active services, and the
//   real slots of one civil day in the business time zone. Nothing bookable
//   is computed in the browser. A read that is no longer the latest (another
//   day or service chosen meanwhile) is dropped.
// - One request id per booking content (service, slot, contact). Resending
//   the same content reuses it, so a retry after a lost answer is answered
//   with the booking already made (`replayed`), never a second one; changed
//   content gets a new one. The request is kept for the tab from the moment
//   it is sent until its answer is read (pending-booking.ts): an answer lost
//   on the way is offered back after a reload or the back button, and
//   resent exactly.
// - While an earlier request is unconfirmed, a booking with other content
//   waits until the customer resends or abandons it: two bookings never
//   result from a doubt.
// - idempotency_conflict is never retried with a new id automatically: a
//   new request is the customer's explicit choice.
// - Success is only shown from the backend's answer, which is authoritative.
// - Options (docs/CATALOG_CONTRACT.md § 8, § 10): her catalogue is shown as
//   the server projects it (get_public_catalog). A required group starts on
//   its first answer (the server never picks one), an optional one on none.
//   Every change of answers reads the slots again, with the quote they are
//   for: price and duration are always the server's, never added up here.
//   Every booking sends the quote she saw (expected*), with or without
//   options: if the server comes to another, nothing is booked
//   (quote_changed) and the new quote is shown before she confirms again.
//   An answer for a choice she has left since (another service, answer or
//   day) never applies.

export type BookingStep =
  "service" | "options" | "slot" | "contact" | "review" | "done";

/** A service of her catalogue, with the catalogue's currency. */
export type BookableService = PublicCatalogService & { currency: string };

export type SlotsState =
  | { status: "idle" }
  | { status: "loading"; date: string }
  | { status: "ready"; date: string; slots: Slot[]; quote: Quote }
  | { status: "error"; date: string; error: BookingError };

/** Her answer to each group of the chosen service (null: none). */
export type Answers = Record<string, string | null>;

export type SubmitState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "failed"; error: BookingError };

/** Why the journey came back to an earlier step. */
export type FlowNotice =
  | "slot_unavailable"
  | "service_unavailable"
  /** An answer was withdrawn or a group became required: chosen again. */
  | "options_changed"
  /** The price or duration changed since it was shown: shown again. */
  | "quote_changed"
  | null;

/** Answers that say for sure nothing was booked by this request. */
const DEFINITE = new Set<BookingError["code"]>([
  "slot_unavailable",
  "service_not_found",
  "business_not_found",
  "validation_error",
  "rate_limited",
  // Refused by the ingress guard before anything is written.
  "booking_unavailable",
  "idempotency_conflict",
  "options_required",
  "option_choice_unavailable",
  "quote_changed",
]);

/** Every service of the catalogue, in its order. */
export const servicesOf = (catalog: PublicCatalog): BookableService[] =>
  catalog.groups.flatMap((group) =>
    group.services.map((service) => ({
      ...service,
      currency: catalog.currency,
    })),
  );

/**
 * Her answers for this service: those still valid kept; a required group
 * without one starts on its first answer, an optional one on none.
 */
export function answersFor(
  service: Pick<PublicCatalogService, "options">,
  kept: Answers = {},
): Answers {
  return Object.fromEntries(
    service.options.map((option) => {
      const previous = kept[option.id];
      const valid = option.choices.some((choice) => choice.id === previous);
      return [
        option.id,
        valid ? previous! : option.required ? option.choices[0]!.id : null,
      ];
    }),
  );
}

/** The answers as the server takes them: one id per answered group. */
export const choiceIdsOf = (
  service: Pick<PublicCatalogService, "options">,
  answers: Answers,
) =>
  service.options
    .map((option) => answers[option.id])
    .filter((id): id is string => typeof id === "string");

export function useBookingFlow({
  business,
  catalog: initialCatalog,
}: {
  business: PublicBusiness;
  /** As get_public_catalog projects it: the only source of what is offered. */
  catalog: PublicCatalog;
}) {
  const slug = business.slug;
  const [catalog, setCatalog] = useState(initialCatalog);
  const services = useMemo(() => servicesOf(catalog), [catalog]);
  const [step, setStep] = useState<BookingStep>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  // The business-local date by the server's clock; the device's only as a
  // fallback (a page rendered before the server answered it).
  const [today] = useState(
    () => business.today ?? businessToday(business.timezone),
  );
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<SlotsState>({ status: "idle" });
  const [slot, setSlot] = useState<Slot | null>(null);
  /** The quote shown with the chosen slot: what she agrees to. */
  const [slotQuote, setSlotQuote] = useState<Quote | null>(null);
  const [contact, setContact] = useState<Contact>(EMPTY_CONTACT);
  const [contactErrors, setContactErrors] = useState<
    Partial<Record<ContactField, string>>
  >({});
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });
  const [booking, setBooking] = useState<Booking | null>(null);
  /** The slot that was sent, with its wall clock (availability's). */
  const [bookedSlot, setBookedSlot] = useState<{
    startsAt: string;
    localStartsAt: string;
  } | null>(null);
  const [notice, setNotice] = useState<FlowNotice>(null);
  /** The business page no longer exists (or no longer takes bookings). */
  const [gone, setGone] = useState(false);

  const raw = useSyncExternalStore(
    subscribePendingBooking,
    () => pendingBookingSnapshot(slug),
    () => null,
  );
  const pending = useMemo(() => parsePendingBooking(slug, raw), [slug, raw]);

  const reads = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  /** The id of the last content sent (kept while the content is). */
  const lastKey = useRef<RequestKey | null>(null);
  /** Her answers as last rendered (read by answers that come back later). */
  const latestAnswers = useRef<Answers>({});
  useEffect(() => {
    latestAnswers.current = answers;
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current += 1;
      readAbort.current?.abort();
    };
  }, []);

  const service = services.find((item) => item.id === serviceId) ?? null;
  /** Civil days that can be asked for: today to the booking horizon. */
  const days = useMemo(
    () =>
      Array.from(
        { length: Math.max(1, business.maximumBookingAdvanceDays + 1) },
        (_, index) => addDays(today, index),
      ),
    [today, business.maximumBookingAdvanceDays],
  );

  const choiceIds = service ? choiceIdsOf(service, answers) : [];
  const hasOptions = (service?.options.length ?? 0) > 0;
  const command: BookingCommand | null =
    service && slot && slotQuote
      ? {
          slug,
          serviceId: service.id,
          startsAt: slot.startsAt,
          ...canonicalContact(contact),
          ...(hasOptions ? { optionChoiceIds: choiceIds } : {}),
          // What she accepted, always: with or without options, a price or
          // a duration that changed since is refused by the server
          // (quote_changed), never booked silently. A request already
          // pending from before is resent as it was (resendPending).
          expectedPriceCents: slotQuote.priceCents,
          expectedDurationMinutes: slotQuote.durationMinutes,
        }
      : null;
  const fingerprint = command ? fingerprintOf(command) : null;
  const isSending = submit.status === "sending";
  /** An earlier request is unconfirmed and differs from the booking shown. */
  const blockedByPending =
    pending !== null &&
    !isSending &&
    fingerprint !== null &&
    pending.key.fingerprint !== fingerprint;

  /**
   * The slots of a day for these answers, with their quote. `then`: what
   * to do with that answer once it is the latest (a refused quote).
   */
  function loadSlots(
    forService: string,
    forDate: string,
    forChoices: string[],
    then?: (slots: Slot[], quote: Quote) => void,
  ) {
    const read = (reads.current += 1);
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setSlots({ status: "loading", date: forDate });
    void fetchAvailability(
      slug,
      forService,
      forDate,
      forChoices,
      controller.signal,
    ).then((result) => {
      // Only the latest read applies (another day, service or answer since).
      if (!alive.current || read !== reads.current) return;
      if (result.ok) {
        setSlots({
          status: "ready",
          date: forDate,
          slots: result.data.slots,
          quote: result.data.quote,
        });
        then?.(result.data.slots, result.data.quote);
      } else if (result.error.code === "service_not_found") {
        serviceGone();
      } else if (result.error.code === "business_not_found") {
        setGone(true);
      } else if (
        result.error.code === "options_required" ||
        result.error.code === "option_choice_unavailable"
      ) {
        optionsChanged(forService);
      } else {
        setSlots({ status: "error", date: forDate, error: result.error });
      }
    });
  }

  /** The chosen service is no longer offered: the list is read again. */
  function serviceGone() {
    reads.current += 1;
    readAbort.current?.abort();
    setServiceId(null);
    setAnswers({});
    setSlot(null);
    setSlotQuote(null);
    setSlots({ status: "idle" });
    setNotice("service_unavailable");
    setStep("service");
    void fetchPublicBusiness(slug).then((result) => {
      if (!alive.current) return;
      if (result.ok) setCatalog(result.data.catalog);
      else if (result.error.code === "business_not_found") setGone(true);
    });
  }

  /**
   * Its options changed since they were read (an answer withdrawn, a group
   * now required): the catalogue is read again, her still valid answers
   * kept, and she chooses again. Nothing is picked for her silently: the
   * step shows what changed before she goes on.
   */
  function optionsChanged(forService: string) {
    const read = (reads.current += 1);
    readAbort.current?.abort();
    setSlot(null);
    setSlotQuote(null);
    setSlots({ status: "idle" });
    setNotice("options_changed");
    setStep("options");
    void fetchPublicBusiness(slug).then((result) => {
      if (!alive.current) return;
      if (!result.ok) {
        if (result.error.code === "business_not_found") setGone(true);
        return;
      }
      // She chose another service, answer or day meanwhile: this late
      // answer is for a choice she left, and must not replace its quote.
      if (read !== reads.current) return;
      setCatalog(result.data.catalog);
      const fresh = servicesOf(result.data.catalog).find(
        (item) => item.id === forService,
      );
      if (!fresh) return serviceGone();
      // Her answers as they are when the catalogue comes back.
      const next = answersFor(fresh, latestAnswers.current);
      setAnswers(next);
      loadSlots(forService, date, choiceIdsOf(fresh, next));
    });
  }

  function chooseService(id: string) {
    const chosen = services.find((item) => item.id === id);
    if (sending.current || !chosen) return;
    const next = answersFor(chosen);
    setServiceId(id);
    setAnswers(next);
    setSlot(null);
    setSlotQuote(null);
    setNotice(null);
    setStep(chosen.options.length > 0 ? "options" : "slot");
    loadSlots(id, date, choiceIdsOf(chosen, next));
  }

  /** Her answer to one group (null: none, for an optional one). */
  function chooseAnswer(optionId: string, choiceId: string | null) {
    if (sending.current || !service) return;
    const option = service.options.find((item) => item.id === optionId);
    if (!option) return;
    if (choiceId === null && option.required) return;
    if (choiceId && !option.choices.some((choice) => choice.id === choiceId))
      return;
    const next = { ...answers, [optionId]: choiceId };
    setAnswers(next);
    setSlot(null);
    setSlotQuote(null);
    setNotice(null);
    // The duration changes with the answers: the slots too.
    loadSlots(service.id, date, choiceIdsOf(service, next));
  }

  /** On to the slots, once the quote of these answers is known. */
  function submitOptions() {
    if (sending.current || !service || slots.status !== "ready") return;
    setNotice(null);
    setStep("slot");
  }

  function chooseDate(next: string) {
    if (sending.current || !service || !days.includes(next)) return;
    setDate(next);
    setSlot(null);
    setSlotQuote(null);
    loadSlots(service.id, next, choiceIds);
  }

  function refreshSlots() {
    if (service) loadSlots(service.id, date, choiceIds);
  }

  function chooseSlot(next: Slot) {
    if (sending.current || slots.status !== "ready") return;
    setSlot(next);
    setSlotQuote(slots.quote);
    setNotice(null);
    setStep("contact");
  }

  function changeContact(field: ContactField, value: string) {
    // Locked while sending: what is sent is what was reviewed.
    if (sending.current) return;
    setContact((current) => ({ ...current, [field]: value }));
    setContactErrors((current) => ({ ...current, [field]: undefined }));
  }

  /** Whether the details are valid (then on to the review). */
  function submitContact(): boolean {
    if (sending.current) return false;
    const errors = checkContact(contact);
    setContactErrors(errors);
    if (Object.keys(errors).length > 0) return false;
    setSubmit({ status: "idle" });
    setStep("review");
    return true;
  }

  /** Back to an earlier step (never while a booking is being sent). */
  function goTo(target: Exclude<BookingStep, "done">) {
    if (sending.current) return;
    if ((target === "slot" || target === "options") && !service) return;
    if (target === "options" && !hasOptions) return;
    if ((target === "contact" || target === "review") && !slot) return;
    setStep(target);
    if (target === "slot" || target === "options") refreshSlots();
  }

  /** Books what was reviewed (or resends the same unconfirmed request). */
  function confirm() {
    if (!command || !fingerprint) return;
    if (pending && pending.key.fingerprint !== fingerprint) return;
    if (pending) void send(pending);
    else
      void send({
        command,
        key: requestKeyFor(lastKey.current, fingerprint),
        localStartsAt: slot!.localStartsAt,
      });
  }

  /** Resends the unconfirmed request exactly (same body, same id). */
  function resendPending() {
    if (pending) void send(pending);
  }

  /** Forgets the unconfirmed request, on the customer's explicit choice. */
  function abandonPending() {
    if (sending.current) return;
    clearPendingBooking(slug);
    lastKey.current = null;
    setSubmit({ status: "idle" });
  }

  /** After idempotency_conflict: a new request, by explicit choice only. */
  function sendAsNew() {
    if (!command || !fingerprint || !slot || pending) return;
    void send({
      command,
      key: { fingerprint, id: crypto.randomUUID() },
      localStartsAt: slot.localStartsAt,
    });
  }

  /** Another booking from the confirmation (the details are kept). */
  function restart() {
    if (sending.current) return;
    lastKey.current = null;
    setBooking(null);
    setBookedSlot(null);
    setServiceId(null);
    setAnswers({});
    setSlot(null);
    setSlotQuote(null);
    setSlots({ status: "idle" });
    setSubmit({ status: "idle" });
    setNotice(null);
    setStep("service");
  }

  async function send(request: PendingBooking) {
    if (sending.current) return;
    const { command: sent, key } = request;
    sending.current = true;
    lastKey.current = key;
    // Kept until the answer is read: a lost one is offered back.
    writePendingBooking(slug, request);
    setSubmit({ status: "sending" });
    const result = await postBooking(sent, key.id);
    sending.current = false;
    // Left meanwhile: the request stays pending, offered back on return.
    if (!alive.current) return;

    if (result.ok) {
      clearPendingBooking(slug);
      lastKey.current = null;
      setBooking(result.data.booking);
      setBookedSlot({
        startsAt: sent.startsAt,
        localStartsAt: request.localStartsAt,
      });
      setSubmit({ status: "idle" });
      setStep("done");
      return;
    }

    const error = result.error;
    // Anything else may have booked: kept, to be resent with the same id.
    if (DEFINITE.has(error.code)) clearPendingBooking(slug);

    switch (error.code) {
      case "slot_unavailable": {
        // Back to the slots of that day, read again; details kept.
        const day = wallDate(request.localStartsAt);
        restoreContact(sent);
        restoreSelection(sent);
        setSlot(null);
        setSlotQuote(null);
        setDate(days.includes(day) ? day : date);
        setNotice("slot_unavailable");
        setSubmit({ status: "idle" });
        setStep("slot");
        loadSlots(
          sent.serviceId,
          days.includes(day) ? day : date,
          sent.optionChoiceIds ?? [],
        );
        return;
      }
      case "options_required":
      case "option_choice_unavailable":
        restoreContact(sent);
        restoreSelection(sent);
        setSubmit({ status: "idle" });
        optionsChanged(sent.serviceId);
        return;
      case "quote_changed": {
        // Read the quote again for the same answers and day. Same slot
        // still offered: the review shows the new price and duration
        // before she confirms again; otherwise she chooses another slot.
        const day = wallDate(request.localStartsAt);
        const onDay = days.includes(day) ? day : date;
        restoreContact(sent);
        restoreSelection(sent);
        setSubmit({ status: "idle" });
        setNotice("quote_changed");
        setSlot(null);
        setSlotQuote(null);
        setDate(onDay);
        setStep("slot");
        loadSlots(
          sent.serviceId,
          onDay,
          sent.optionChoiceIds ?? [],
          (fresh, quote) => {
            const same = fresh.find((item) => item.startsAt === sent.startsAt);
            if (!same) return;
            setSlot(same);
            setSlotQuote(quote);
            setStep("review");
          },
        );
        return;
      }
      case "service_not_found":
        restoreContact(sent);
        setSubmit({ status: "idle" });
        serviceGone();
        return;
      case "business_not_found":
        setGone(true);
        return;
      case "validation_error": {
        const errors = serverContactErrors(error.fieldErrors);
        if (Object.keys(errors).length > 0) {
          restoreContact(sent);
          setContactErrors(errors);
          setSubmit({ status: "idle" });
          setStep("contact");
          return;
        }
        setSubmit({ status: "failed", error });
        return;
      }
      default:
        setSubmit({ status: "failed", error });
    }
  }

  /**
   * The service and answers of a sent request back in the flow: after the
   * page was left and the request resent, nothing is chosen in this render
   * (Codex review of #50: a refusal then left her without a booking step).
   */
  function restoreSelection(sent: BookingCommand) {
    setServiceId(sent.serviceId);
    const sentService = services.find((item) => item.id === sent.serviceId);
    if (!sentService) return;
    const chosen = new Set(sent.optionChoiceIds ?? []);
    const kept: Answers = {};
    for (const option of sentService.options) {
      const choice = option.choices.find((item) => chosen.has(item.id));
      if (choice) kept[option.id] = choice.id;
    }
    const next = answersFor(sentService, kept);
    latestAnswers.current = next;
    setAnswers(next);
  }

  /** The details of a sent request back in the form (it is what was sent). */
  function restoreContact(sent: BookingCommand) {
    setContact({
      firstName: sent.firstName,
      lastName: sent.lastName ?? "",
      email: sent.email,
      phone: sent.phone ?? "",
    });
  }

  // Her steps: "options" only for a service that has some.
  const steps: Exclude<BookingStep, "done">[] = hasOptions
    ? ["service", "options", "slot", "contact", "review"]
    : ["service", "slot", "contact", "review"];

  return {
    business,
    catalog,
    services,
    step,
    /** Where a step is in her journey (1-based), and how many there are. */
    stepNumber: (of: Exclude<BookingStep, "done">) => steps.indexOf(of) + 1,
    stepCount: steps.length,
    service,
    answers,
    /** The quote of the chosen slot: what the review shows and sends. */
    slotQuote,
    today,
    days,
    date,
    slots,
    slot,
    contact,
    contactErrors,
    submit,
    isSending,
    booking,
    /**
     * The booked slot's wall clock, when the booking is still at the slot
     * that was sent (otherwise the business changed its time since).
     */
    bookedLocal:
      booking && bookedSlot?.startsAt === booking.startsAt
        ? bookedSlot.localStartsAt
        : null,
    notice,
    gone,
    /** An unconfirmed request of this page and tab, if any. */
    pending: isSending ? null : pending,
    blockedByPending,
    actions: {
      chooseService,
      chooseAnswer,
      submitOptions,
      chooseDate,
      refreshSlots,
      chooseSlot,
      changeContact,
      submitContact,
      goTo,
      confirm,
      resendPending,
      abandonPending,
      sendAsNew,
      restart,
    },
  };
}

export type BookingFlow = ReturnType<typeof useBookingFlow>;
