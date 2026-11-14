// Booking across her places and people (M6-R02, client side). PROPOSED
// contract (docs/LOCATIONS_BOOKING_PROPOSAL.md): no server serves it yet.
// The flow takes its actions as a whole; only the design preview and the
// tests give it an in-memory server. The real public booking keeps its
// solo journey until Cloud provides this.
//
// A named person is a choice, never silently replaced; "first available"
// is an explicit choice too. Cabins stay internal: the client never sees
// them, the server allocates them.

export type PublicLocationDto = {
  id: string;
  name: string;
  address: string;
};

export type PublicStaffDto = {
  id: string;
  displayName: string;
  /** Where this person can be booked for the chosen service. */
  locationIds: string[];
};

export type StaffPreference =
  { kind: "any" } | { kind: "staff"; staffId: string };

export type SlotDto = {
  startsAt: string;
  /** The location's UTC offset at that instant, in minutes. */
  offsetMinutes: number;
  locationId: string;
};

export type LocationsResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type LocationsBookingActions = {
  setup: (serviceId: string) => Promise<
    LocationsResult<{
      locations: PublicLocationDto[];
      staff: PublicStaffDto[];
    }>
  >;
  availability: (input: {
    serviceId: string;
    locationId: string;
    staffPreference: StaffPreference;
  }) => Promise<
    LocationsResult<{ slots: SlotDto[]; scheduleRevision: string }>
  >;
  hold: (input: {
    serviceId: string;
    locationId: string;
    staffPreference: StaffPreference;
    startsAt: string;
    scheduleRevision: string;
    requestId: string;
  }) => Promise<
    LocationsResult<{
      holdId: string;
      expiresAt: string;
      /** Named only when the client chose that person. */
      staffDisplayName: string | null;
    }>
  >;
};

export const locationsErrors = {
  slotUnavailable: "slot_unavailable",
  configurationChanged: "configuration_changed",
  locationUnavailable: "location_unavailable",
} as const;

/** "10:30" as shown at the location. */
export const localClock = (slot: SlotDto) =>
  new Date(Date.parse(slot.startsAt) + slot.offsetMinutes * 60_000)
    .toISOString()
    .slice(11, 16);

/** "2026-11-17" as dated at the location. */
export const localDay = (slot: SlotDto) =>
  new Date(Date.parse(slot.startsAt) + slot.offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);

/** "mardi 17 novembre", "mardi 1er décembre". */
export const dayName = (day: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  })
    .format(new Date(`${day}T12:00:00.000Z`))
    .replace(/ 1 /, " 1er ");
