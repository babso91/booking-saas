import type {
  AppointmentSummaryDto,
  AppointmentTimelineEvent,
  BusinessInstantDto,
  ClientProfileDto,
  ClientTimelinePageDto,
  DirectoryClientDto,
  DirectoryPageDto,
  EmailTimelineEvent,
  LoyaltyTimelineEvent,
} from "@/features/crm/types";

// CRM DTOs exactly as the Server Actions return them. Wall clocks are given
// directly (as PostgreSQL computes them); `at` is only an identity here.

let sequence = 0;
export const uuid = () => {
  sequence += 1;
  return `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
};

export const AS_OF = "2026-10-11T08:00:00.000000+00:00";
export const TZ = "Europe/Paris";

export function at(
  local: string,
  occurrence: BusinessInstantDto["occurrence"] = null,
): BusinessInstantDto {
  return { at: `${local}:00.000Z`, local, occurrence };
}

export function directoryClient(
  overrides: Partial<DirectoryClientDto> = {},
): DirectoryClientDto {
  const firstName = overrides.firstName ?? "Emma";
  const lastName =
    overrides.lastName === undefined ? "Laurent" : overrides.lastName;
  return {
    id: uuid(),
    displayName: [firstName, lastName].filter(Boolean).join(" "),
    firstName,
    lastName,
    email: "emma.laurent@exemple.fr",
    phone: "06 12 34 56 78",
    createdAt: at("2025-03-14T10:00"),
    completedCount: 12,
    lastCompletedVisitAt: at("2026-10-02T14:30"),
    upcomingCount: 2,
    nextAppointment: { id: uuid(), startsAt: at("2026-10-24T14:30") },
    ...overrides,
  };
}

export function directoryPage(
  clients: DirectoryClientDto[],
  overrides: Partial<DirectoryPageDto> = {},
): DirectoryPageDto {
  return {
    asOf: AS_OF,
    timezone: TZ,
    totalCount: clients.length,
    clients,
    nextCursor: null,
    ...overrides,
  };
}

export function appointmentSummary(
  overrides: Partial<AppointmentSummaryDto> & {
    start?: string;
    end?: string;
  } = {},
): AppointmentSummaryDto {
  const {
    start = "2026-10-24T14:30",
    end = "2026-10-24T15:45",
    ...rest
  } = overrides;
  return {
    id: uuid(),
    status: "confirmed",
    startsAt: at(start),
    endsAt: at(end),
    service: { id: uuid(), name: "Rehaussement de cils", durationMinutes: 75 },
    price: { amountCents: 6500, currency: "EUR" },
    ...rest,
  };
}

export const CLIENT_ID = "30000000-0000-4000-8000-00000000aaaa";

export function profile(
  overrides: {
    client?: Partial<ClientProfileDto["client"]>;
    overview?: Partial<ClientProfileDto["overview"]>;
    upcoming?: AppointmentSummaryDto[];
  } = {},
): ClientProfileDto {
  const upcoming = overrides.upcoming ?? [
    appointmentSummary(),
    appointmentSummary({
      start: "2026-11-21T10:00",
      end: "2026-11-21T11:00",
      service: {
        id: uuid(),
        name: "Remplissage cil à cil",
        durationMinutes: 60,
      },
      price: { amountCents: 5500, currency: "EUR" },
    }),
  ];
  return {
    asOf: AS_OF,
    timezone: TZ,
    client: {
      id: CLIENT_ID,
      displayName: "Emma Laurent",
      firstName: "Emma",
      lastName: "Laurent",
      email: "emma.laurent@exemple.fr",
      phone: "06 12 34 56 78",
      createdAt: at("2025-03-14T10:00"),
      updatedAt: "2026-09-01T08:00:00.000Z",
      ...overrides.client,
    },
    overview: {
      completedCount: 12,
      cancelledCount: 2,
      noShowCount: 1,
      pastConfirmedCount: 0,
      upcomingCount: upcoming.length,
      firstCompletedVisitAt: at("2025-03-21T10:00"),
      lastCompletedVisitAt: at("2026-10-02T14:30"),
      favoriteService: {
        serviceId: uuid(),
        currentName: "Remplissage cil à cil",
        active: true,
        completedCount: 7,
      },
      completedServiceValue: [
        { amountCents: 71200, currency: "EUR", appointmentCount: 12 },
      ],
      ...overrides.overview,
    },
    nextAppointment: upcoming[0] ?? null,
    upcoming,
  };
}

export function appointmentEvent(
  overrides: Partial<AppointmentTimelineEvent["appointment"]> & {
    start?: string;
    end?: string;
  } = {},
): AppointmentTimelineEvent {
  const {
    start = "2026-10-02T14:30",
    end = "2026-10-02T15:30",
    ...rest
  } = overrides;
  const id = rest.id ?? uuid();
  return {
    id: `appointment:${id}`,
    kind: "appointment",
    occurredAt: at(start),
    appointment: {
      ...appointmentSummary({ start, end }),
      id,
      status: "completed",
      service: {
        id: uuid(),
        name: "Remplissage cil à cil",
        durationMinutes: 60,
      },
      price: { amountCents: 5500, currency: "EUR" },
      source: "public",
      completedAt: null,
      cancellationReason: null,
      contact: {
        firstName: "Emma",
        lastName: "Laurent",
        email: "emma.laurent@exemple.fr",
        phone: "06 12 34 56 78",
      },
      ...rest,
    },
  };
}

export function loyaltyEvent(
  overrides: Partial<LoyaltyTimelineEvent["entry"]> & { local?: string } = {},
): LoyaltyTimelineEvent {
  const { local = "2026-10-02T15:31", ...rest } = overrides;
  const id = rest.id ?? uuid();
  return {
    id: `loyalty:${id}`,
    kind: "loyalty",
    occurredAt: at(local),
    entry: {
      id,
      type: "appointment_completed",
      pointsDelta: 10,
      reason: "Rendez-vous terminé",
      appointmentId: null,
      redemption: null,
      ...rest,
    },
  };
}

export function emailEvent(
  overrides: Partial<EmailTimelineEvent["email"]> & { local?: string } = {},
): EmailTimelineEvent {
  const { local = "2026-09-29T18:00", ...rest } = overrides;
  const id = rest.id ?? uuid();
  return {
    id: `email:${id}`,
    kind: "email",
    occurredAt: at(local),
    email: {
      id,
      type: "booking_confirmation",
      status: "scheduled",
      scheduledFor: at(local),
      sentAt: null,
      recipientEmail: "emma.laurent@exemple.fr",
      appointmentId: null,
      ...rest,
    },
  };
}

export function timelinePage(
  events: ClientTimelinePageDto["events"],
  nextCursor: string | null = null,
): ClientTimelinePageDto {
  return { asOf: AS_OF, timezone: TZ, events, nextCursor };
}
