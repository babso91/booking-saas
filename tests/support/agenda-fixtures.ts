import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import type { AgendaServicesDto } from "@/features/agenda/data/lookups";
import { addDaysToLocalDate, zonedLocalToUtc } from "@/lib/time/zoned";

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

export function appointment(
  overrides: Partial<AgendaAppointmentDto> & { local?: string } = {},
): AgendaAppointmentDto {
  const { local = "2026-09-29T10:00", ...rest } = overrides;
  const duration = rest.durationMinutes ?? 75;
  const startsAt = rest.startsAt ?? iso(local);
  const endsAt =
    rest.endsAt ??
    new Date(Date.parse(startsAt) + duration * 60_000).toISOString();
  const endLocal =
    rest.localEndsAt ??
    `${local.slice(0, 11)}${new Date(Date.parse(`${local}:00Z`) + duration * 60_000).toISOString().slice(11, 16)}`;
  return {
    id: uuid(),
    version: 1,
    status: "confirmed",
    startsAt,
    endsAt,
    localStartsAt: local,
    localEndsAt: endLocal,
    startOccurrence: null,
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

export function block(overrides: Partial<AgendaBlockDto> = {}): AgendaBlockDto {
  const localStartsAt = overrides.localStartsAt ?? "2026-09-30T12:30";
  const localEndsAt = overrides.localEndsAt ?? "2026-09-30T15:00";
  return {
    id: uuid(),
    version: 1,
    kind: "blocked",
    startsAt: iso(localStartsAt),
    endsAt: iso(localEndsAt),
    localStartsAt,
    localEndsAt,
    startOccurrence: null,
    endOccurrence: null,
    reason: "Formation",
    ...overrides,
  };
}

export function agenda(
  startDate: string,
  endDate: string,
  items: {
    appointments?: AgendaAppointmentDto[];
    blocks?: AgendaBlockDto[];
  } = {},
): AgendaDto {
  const days = [];
  for (
    let date = startDate;
    date <= endDate;
    date = addDaysToLocalDate(date, 1)
  ) {
    days.push({
      date,
      weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
      openRanges: [
        {
          startsAt: iso(`${date}T09:00`),
          endsAt: iso(`${date}T19:00`),
          localStartsAt: `${date}T09:00`,
          localEndsAt: `${date}T19:00`,
        },
      ],
    });
  }
  return {
    timezone: TZ,
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
