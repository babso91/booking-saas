import {
  locationsErrors,
  type LocationsBookingActions,
  type LocationsResult,
  type PublicLocationDto,
  type PublicStaffDto,
  type SlotDto,
} from "./contract";

// An in-memory server of the PROPOSED contract, for the preview and the
// tests only: two places, two people, slots per person, a slot taken
// meanwhile, a replayed request id. No booking is ever made.

const fail = (code: string): LocationsResult<never> => ({
  ok: false,
  error: { code },
});

export const sampleLocations: PublicLocationDto[] = [
  {
    id: "l-paris",
    name: "Atelier Oberkampf",
    address: "12 rue Oberkampf, Paris 11e",
  },
  {
    id: "l-montreuil",
    name: "Studio Montreuil",
    address: "4 place Jean-Jaurès, Montreuil",
  },
];

export const sampleStaff: PublicStaffDto[] = [
  {
    id: "p-maelys",
    displayName: "Maëlys",
    locationIds: ["l-paris", "l-montreuil"],
  },
  { id: "p-ines", displayName: "Inès", locationIds: ["l-paris"] },
];

/** Paris in November: UTC+1. */
const slot = (day: string, time: string, locationId: string): SlotDto => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const utc = new Date(`${day}T00:00:00.000Z`);
  utc.setUTCHours(h - 1, m);
  return { startsAt: utc.toISOString(), offsetMinutes: 60, locationId };
};

export function memoryLocationsBooking(
  options: {
    delayMs?: number;
    locations?: PublicLocationDto[];
    staff?: PublicStaffDto[];
    /** Slots per person and place: "staffId@locationId" → [day, time][]. */
    open?: Record<string, [string, string][]>;
  } = {},
) {
  const locations = options.locations ?? sampleLocations;
  const staff = options.staff ?? sampleStaff;
  const open = options.open ?? {
    "p-maelys@l-paris": [
      ["2026-11-17", "10:00"],
      ["2026-11-17", "14:30"],
      ["2026-11-18", "09:30"],
    ],
    "p-ines@l-paris": [
      ["2026-11-17", "10:00"],
      ["2026-11-17", "11:00"],
      ["2026-11-19", "16:00"],
    ],
    "p-maelys@l-montreuil": [["2026-11-20", "15:00"]],
  };
  const taken = new Set<string>();
  const answered = new Map<
    string,
    LocationsResult<{
      holdId: string;
      expiresAt: string;
      staffDisplayName: string | null;
    }>
  >();
  let revision = 1;
  let holds = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  function slotsFor(locationId: string, staffIds: string[]) {
    const all = new Map<string, SlotDto>();
    for (const staffId of staffIds)
      for (const [day, time] of open[`${staffId}@${locationId}`] ?? []) {
        const item = slot(day, time, locationId);
        if (!taken.has(`${staffId}@${item.startsAt}`))
          all.set(item.startsAt, item);
      }
    return [...all.values()].sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    );
  }
  const staffAt = (locationId: string) =>
    staff
      .filter((person) => person.locationIds.includes(locationId))
      .map((p) => p.id);

  const actions: LocationsBookingActions = {
    async setup() {
      await pause();
      return { ok: true, data: { locations, staff } };
    },
    async availability({ locationId, staffPreference }) {
      await pause();
      if (!locations.some((l) => l.id === locationId))
        return fail(locationsErrors.locationUnavailable);
      const ids =
        staffPreference.kind === "staff"
          ? [staffPreference.staffId]
          : staffAt(locationId);
      return {
        ok: true,
        data: {
          slots: slotsFor(locationId, ids),
          scheduleRevision: `rev-${revision}`,
        },
      };
    },
    async hold(input) {
      await pause();
      const earlier = answered.get(input.requestId);
      if (earlier) return earlier;
      if (input.scheduleRevision !== `rev-${revision}`)
        return fail(locationsErrors.configurationChanged);
      const candidates =
        input.staffPreference.kind === "staff"
          ? [input.staffPreference.staffId]
          : staffAt(input.locationId);
      // A named person is never replaced: only she is tried.
      const free = candidates.find((staffId) =>
        slotsFor(input.locationId, [staffId]).some(
          (s) => s.startsAt === input.startsAt,
        ),
      );
      if (!free) return fail(locationsErrors.slotUnavailable);
      taken.add(`${free}@${input.startsAt}`);
      const result = {
        ok: true as const,
        data: {
          holdId: `hold-${(holds += 1)}`,
          expiresAt: new Date(
            Date.parse(input.startsAt) - 60 * 60_000,
          ).toISOString(),
          staffDisplayName:
            input.staffPreference.kind === "staff"
              ? (staff.find((p) => p.id === free)?.displayName ?? null)
              : null,
        },
      };
      answered.set(input.requestId, result);
      return result;
    },
  };
  return {
    actions,
    /** Someone books this person at this instant meanwhile. */
    take(staffId: string, startsAt: string) {
      taken.add(`${staffId}@${startsAt}`);
    },
    /** Her hours change: earlier availability is stale. */
    reconfigure() {
      revision += 1;
    },
    get holds() {
      return holds;
    },
  };
}
