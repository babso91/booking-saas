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

import {
  fetchAvailability,
  fetchPublicBusiness,
  postBooking,
  type Booking,
  type BookingCommand,
  type BookingError,
  type PublicBusiness,
  type PublicService,
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

export type BookingStep = "service" | "slot" | "contact" | "review" | "done";

export type SlotsState =
  | { status: "idle" }
  | { status: "loading"; date: string }
  | { status: "ready"; date: string; slots: Slot[] }
  | { status: "error"; date: string; error: BookingError };

export type SubmitState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "failed"; error: BookingError };

/** Why the journey came back to an earlier step. */
export type FlowNotice = "slot_unavailable" | "service_unavailable" | null;

/** Answers that say for sure nothing was booked by this request. */
const DEFINITE = new Set<BookingError["code"]>([
  "slot_unavailable",
  "service_not_found",
  "business_not_found",
  "validation_error",
  "rate_limited",
  "idempotency_conflict",
]);

export function useBookingFlow({
  business,
  services: initialServices,
}: {
  business: PublicBusiness;
  services: PublicService[];
}) {
  const slug = business.slug;
  const [services, setServices] = useState(initialServices);
  const [step, setStep] = useState<BookingStep>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  // The business-local date by the server's clock; the device's only as a
  // fallback (a page rendered before the server answered it).
  const [today] = useState(
    () => business.today ?? businessToday(business.timezone),
  );
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<SlotsState>({ status: "idle" });
  const [slot, setSlot] = useState<Slot | null>(null);
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

  const command: BookingCommand | null =
    service && slot
      ? {
          slug,
          serviceId: service.id,
          startsAt: slot.startsAt,
          ...canonicalContact(contact),
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

  function loadSlots(forService: string, forDate: string) {
    const read = (reads.current += 1);
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setSlots({ status: "loading", date: forDate });
    void fetchAvailability(slug, forService, forDate, controller.signal).then(
      (result) => {
        // Only the latest read applies (another day or service since).
        if (!alive.current || read !== reads.current) return;
        if (result.ok) {
          setSlots({
            status: "ready",
            date: forDate,
            slots: result.data.slots,
          });
        } else if (result.error.code === "service_not_found") {
          serviceGone();
        } else if (result.error.code === "business_not_found") {
          setGone(true);
        } else {
          setSlots({ status: "error", date: forDate, error: result.error });
        }
      },
    );
  }

  /** The chosen service is no longer offered: the list is read again. */
  function serviceGone() {
    reads.current += 1;
    readAbort.current?.abort();
    setServiceId(null);
    setSlot(null);
    setSlots({ status: "idle" });
    setNotice("service_unavailable");
    setStep("service");
    void fetchPublicBusiness(slug).then((result) => {
      if (!alive.current) return;
      if (result.ok) setServices(result.data.services);
      else if (result.error.code === "business_not_found") setGone(true);
    });
  }

  function chooseService(id: string) {
    if (sending.current || !services.some((item) => item.id === id)) return;
    setServiceId(id);
    setSlot(null);
    setNotice(null);
    setStep("slot");
    loadSlots(id, date);
  }

  function chooseDate(next: string) {
    if (sending.current || !serviceId || !days.includes(next)) return;
    setDate(next);
    setSlot(null);
    loadSlots(serviceId, next);
  }

  function refreshSlots() {
    if (serviceId) loadSlots(serviceId, date);
  }

  function chooseSlot(next: Slot) {
    if (sending.current) return;
    setSlot(next);
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
    if (target === "slot" && !serviceId) return;
    if ((target === "contact" || target === "review") && !slot) return;
    setStep(target);
    if (target === "slot") refreshSlots();
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
    setSlot(null);
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
        setServiceId(sent.serviceId);
        setSlot(null);
        setDate(days.includes(day) ? day : date);
        setNotice("slot_unavailable");
        setSubmit({ status: "idle" });
        setStep("slot");
        loadSlots(sent.serviceId, days.includes(day) ? day : date);
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

  /** The details of a sent request back in the form (it is what was sent). */
  function restoreContact(sent: BookingCommand) {
    setContact({
      firstName: sent.firstName,
      lastName: sent.lastName ?? "",
      email: sent.email,
      phone: sent.phone ?? "",
    });
  }

  return {
    business,
    services,
    step,
    service,
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
