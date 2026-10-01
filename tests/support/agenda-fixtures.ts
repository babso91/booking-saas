import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import type { AgendaServicesDto } from "@/features/agenda/data/lookups";
import type { BusinessTodayDto } from "@/lib/time/business-time";
import {
  addDaysToLocalDate,
  resolveZonedLocal,
  utcToZonedLocal,
  zonedLocalToUtc,
  zonedOccurrenceOf,
} from "@/lib/time/zoned";

import { intlCalendar } from "./zone-fixture";

// Test data shaped exactly like the agenda contract's DTOs.

export const TZ = "Europe/Paris";
let sequence = 0;
const uuid = () => {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
};

export const SERVICE_A = "10000000-0000-4000-8000-00000000000a";
export const SERVICE_B = "10000000-0000-4000-8000-00000000000b";
export const CLIENT_A = "20000000-0000-4000-8000-00000000000a";

export const services: AgendaServicesDto = {
  services: [
    {
      id: SERVICE_A,
      name: "Rehaussement de cils",
      durationMinutes: 75,
      priceCents: 6500,
    },
    {
      id: SERVICE_B,
      name: "Pose cil à cil",
      durationMinutes: 120,
      priceCents: 11000,
    },
  ],
  bufferMinutes: 10,
  currency: "EUR",
};

const iso = (local: string) => zonedLocalToUtc(local, TZ).toISOString();

/**
 * Real UTC instant of a wall-clock time. An ambiguous time (repeated autumn
 * hour) must say which occurrence it means; a skipped one is refused.
 */
export function instantOf(
  local: string,
  occurrence?: "first" | "second",
  timeZone = TZ,
) {
  const resolved = resolveZonedLocal(local, timeZone);
  if (resolved.status === "nonexistent")
    throw new Error(`${local} does not exist in ${timeZone}`);
  if (resolved.status === "exact") return resolved.instant.toISOString();
  if (!occurrence)
    throw new Error(`${local} is ambiguous in ${timeZone}: pass an occurrence`);
  return resolved[occurrence].toISOString();
}

/** DTO fields of a real period, every local value derived from the instants. */
export function period(startsAt: string, endsAt: string, timeZone = TZ) {
  return {
    startsAt,
    endsAt,
    localStartsAt: utcToZonedLocal(startsAt, timeZone),
    localEndsAt: utcToZonedLocal(endsAt, timeZone),
    startOccurrence: zonedOccurrenceOf(startsAt, timeZone),
  };
}

export function appointment(
  overrides: Partial<AgendaAppointmentDto> & {
    local?: string;
    occurrence?: "first" | "second";
  } = {},
): AgendaAppointmentDto {
  const { local = "2026-09-29T10:00", occurrence, ...rest } = overrides;
  const duration = rest.durationMinutes ?? 75;
  const startsAt = rest.startsAt ?? instantOf(local, occurrence);
  const endsAt =
    rest.endsAt ??
    new Date(Date.parse(startsAt) + duration * 60_000).toISOString();
  return {
    id: uuid(),
    version: 1,
    status: "confirmed",
    ...period(startsAt, endsAt),
    durationMinutes: duration,
    bufferMinutes: 10,
    priceCents: 6500,
    currency: "EUR",
    service: { id: SERVICE_A, name: "Rehaussement de cils" },
    client: { id: CLIENT_A, displayName: "Camille Roux" },
    internalNotes: null,
    cancellationReason: null,
    source: "manual",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    ...rest,
  };
}

export function block(
  overrides: Partial<AgendaBlockDto> & {
    from?: string;
    to?: string;
    fromOccurrence?: "first" | "second";
    toOccurrence?: "first" | "second";
    timeZone?: string;
  } = {},
): AgendaBlockDto {
  const {
    from = "2026-09-30T12:30",
    to = "2026-09-30T15:00",
    fromOccurrence,
    toOccurrence,
    timeZone = TZ,
    ...rest
  } = overrides;
  const startsAt = rest.startsAt ?? instantOf(from, fromOccurrence, timeZone);
  const endsAt = rest.endsAt ?? instantOf(to, toOccurrence, timeZone);
  const real = period(startsAt, endsAt, timeZone);
  return {
    id: uuid(),
    version: 1,
    kind: "blocked",
    ...real,
    endOccurrence: zonedOccurrenceOf(endsAt, timeZone),
    reason: "Formation",
    ...rest,
  };
}

/**
 * What getAgendaTodayAction answers: PostgreSQL's date at `serverNow`, the
 * instant that date ends and the server instant of the answer. The server
 * clock is the test clock unless another one is given (a device whose clock
 * is wrong).
 */
export function businessToday(
  timeZone = TZ,
  serverNow: number = Date.now(),
): BusinessTodayDto {
  const date = utcToZonedLocal(new Date(serverNow), timeZone).slice(0, 10);
  return {
    date,
    endsAt: intlCalendar(timeZone, [date]).days[0]!.endsAt,
    now: new Date(serverNow).toISOString(),
  };
}

export function agenda(
  startDate: string,
  endDate: string,
  items: {
    appointments?: AgendaAppointmentDto[];
    blocks?: AgendaBlockDto[];
    timeZone?: string;
  } = {},
): AgendaDto {
  const timeZone = items.timeZone ?? TZ;
  const dates: string[] = [];
  for (
    let date = startDate;
    date <= endDate;
    date = addDaysToLocalDate(date, 1)
  ) {
    dates.push(date);
  }
  const calendar = intlCalendar(timeZone, dates);
  const days = calendar.days.map(({ date, startsAt, endsAt }) => ({
    date,
    startsAt,
    endsAt,
    weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
    openRanges: [
      {
        startsAt: iso(`${date}T09:00`),
        endsAt: iso(`${date}T19:00`),
        localStartsAt: `${date}T09:00`,
        localEndsAt: `${date}T19:00`,
      },
    ],
  }));
  return {
    timezone: timeZone,
    // PostgreSQL's date at read time (the test clock).
    today: utcToZonedLocal(new Date(), timeZone).slice(0, 10),
    offsets: calendar.offsets,
    range: {
      startDate,
      endDate,
      startsAt: iso(`${startDate}T00:00`),
      endsAt: iso(`${addDaysToLocalDate(endDate, 1)}T00:00`),
    },
    appointments: items.appointments ?? [],
    blocks: items.blocks ?? [],
    workingHours: { weekly: [], days },
  };
}
