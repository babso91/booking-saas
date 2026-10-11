// Contract of the CRM relationship read model (professionals only).
// Documented in docs/CRM_RELATIONSHIP_READ_MODEL.md; the UI uses these types
// as returned by the Server Actions of src/features/crm/actions/crm.ts.

import type { LocalTimeOccurrence } from "@/lib/time/business-time";

/**
 * An instant, with its wall clock in the business time zone read from
 * PostgreSQL (public.business_time): the UI never converts dates itself.
 */
export type BusinessInstantDto = {
  /** UTC ISO 8601. */
  at: string;
  /** Wall clock `YYYY-MM-DDTHH:MM` in the business time zone. */
  local: string;
  /** `first` / `second` in a repeated autumn hour, otherwise null. */
  occurrence: LocalTimeOccurrence | null;
};

export type AppointmentStatus =
  "confirmed" | "completed" | "cancelled" | "no_show";

/** An amount in minor units (cents) of one currency. */
export type MoneyDto = { amountCents: number; currency: string };

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

export const CLIENT_SORTS = [
  "name",
  "newest",
  "last_visit",
  "next_appointment",
  "most_visits",
] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

export const CLIENT_FILTERS = [
  "all",
  "upcoming",
  "no_upcoming",
  "visited",
  "never_visited",
] as const;
export type ClientFilter = (typeof CLIENT_FILTERS)[number];

export type DirectoryClientDto = {
  id: string;
  /** "First Last" from the current record. */
  displayName: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  createdAt: BusinessInstantDto;
  /** Appointments with status `completed`. */
  completedCount: number;
  /** Start of the latest completed appointment, null if none. */
  lastCompletedVisitAt: BusinessInstantDto | null;
  /** Confirmed appointments starting after `asOf`. */
  upcomingCount: number;
  /** The earliest of those (start, then id), null if none. */
  nextAppointment: { id: string; startsAt: BusinessInstantDto } | null;
};

export type DirectoryPageDto = {
  /** Reference instant of every metric of this page (and of its cursor). */
  asOf: string;
  timezone: string;
  /** Customers of this business matching the search and filter. */
  totalCount: number;
  clients: DirectoryClientDto[];
  /** Pass it back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type AppointmentSummaryDto = {
  id: string;
  status: AppointmentStatus;
  startsAt: BusinessInstantDto;
  endsAt: BusinessInstantDto;
  service: {
    id: string;
    /** Name recorded on the appointment (when booked or last re-serviced). */
    name: string;
    durationMinutes: number;
  };
  /** Price recorded on the appointment when booked: not a payment. */
  price: MoneyDto;
};

export type ClientProfileDto = {
  asOf: string;
  timezone: string;
  /** The current customer record (not a historical snapshot). */
  client: {
    id: string;
    displayName: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    createdAt: BusinessInstantDto;
    updatedAt: string;
  };
  overview: {
    completedCount: number;
    cancelledCount: number;
    noShowCount: number;
    /** Confirmed but already started at `asOf`: awaiting an outcome. */
    pastConfirmedCount: number;
    upcomingCount: number;
    firstCompletedVisitAt: BusinessInstantDto | null;
    lastCompletedVisitAt: BusinessInstantDto | null;
    /** Most completed visits; ties: most recent visit, then service id. */
    favoriteService: {
      serviceId: string;
      /** The service's current name (it may have been renamed). */
      currentName: string | null;
      active: boolean | null;
      completedCount: number;
    } | null;
    /**
     * Per currency, the prices recorded on completed appointments (agreed at
     * booking) and how many: the value of the services delivered, never an
     * amount paid. Empty when there is no completed appointment.
     */
    completedServiceValue: (MoneyDto & { appointmentCount: number })[];
  };
  /** First of `upcoming`, null when there is none. */
  nextAppointment: AppointmentSummaryDto | null;
  /** The next upcoming appointments (at most 5); `upcomingCount` is the total. */
  upcoming: AppointmentSummaryDto[];
};

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

type TimelineEventBase = {
  /** Stable identity: `<kind>:<source id>`. */
  id: string;
  /** Position in the chronology (see each kind). */
  occurredAt: BusinessInstantDto;
};

/** An appointment, dated by its start. */
export type AppointmentTimelineEvent = TimelineEventBase & {
  kind: "appointment";
  appointment: AppointmentSummaryDto & {
    /** `public`: booked on the public page; `manual`: by a professional. */
    source: "public" | "manual";
    /** When it was marked completed, if recorded (not the visit time). */
    completedAt: BusinessInstantDto | null;
    cancellationReason: string | null;
    /** The contact as submitted for this appointment (history). */
    contact: {
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
    };
  };
};

export type LoyaltyEntryType =
  | "appointment_completed"
  | "manual_adjustment"
  | "reward_redeemed"
  | "correction";

/** A loyalty ledger entry, dated by its creation. */
export type LoyaltyTimelineEvent = TimelineEventBase & {
  kind: "loyalty";
  entry: {
    id: string;
    type: LoyaltyEntryType;
    /** Points added (> 0) or removed (< 0) by this entry. */
    pointsDelta: number;
    reason: string;
    appointmentId: string | null;
    /** The reward redeemed with this entry, if any (same business fact). */
    redemption: {
      id: string;
      rewardId: string;
      /** The reward's current name. */
      rewardName: string | null;
      pointsSpent: number;
      redeemedAt: BusinessInstantDto;
    } | null;
  };
};

export type EmailType =
  | "booking_confirmation"
  | "appointment_reminder"
  | "appointment_changed"
  | "appointment_cancelled"
  | "points_earned"
  | "reward_unlocked"
  | "reactivation";

/**
 * Outbox state of an email. `scheduled`: recorded, not sent yet; `sent`:
 * handed to the provider. Delivery is not tracked.
 */
export type EmailStatus =
  "scheduled" | "sending" | "sent" | "failed" | "cancelled";

/** An email recorded for this customer, dated by when it was recorded. */
export type EmailTimelineEvent = TimelineEventBase & {
  kind: "email";
  email: {
    id: string;
    type: EmailType;
    status: EmailStatus;
    scheduledFor: BusinessInstantDto;
    sentAt: BusinessInstantDto | null;
    recipientEmail: string;
    appointmentId: string | null;
  };
};

export type ClientTimelineEvent =
  AppointmentTimelineEvent | LoyaltyTimelineEvent | EmailTimelineEvent;

export type ClientTimelineKind = ClientTimelineEvent["kind"];

export type ClientTimelinePageDto = {
  /** Upcoming appointments at this instant are not in the timeline. */
  asOf: string;
  timezone: string;
  /** Newest first. */
  events: ClientTimelineEvent[];
  nextCursor: string | null;
};
