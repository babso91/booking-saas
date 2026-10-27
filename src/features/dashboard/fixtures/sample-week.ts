import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

// A fictional week of a fictional studio, in the exact shape the agenda
// reads (AgendaDto), for previews (/apercu) and tests. Europe/Paris, week of
// Monday 26 October 2026 (after the autumn change: UTC+1 all week). Names
// are invented; nothing here is read from or written to a database.

export const SAMPLE_TODAY = "2026-10-27";

const OFFSET_H = 1;
const pad = (value: number) => String(value).padStart(2, "0");

/** Local `YYYY-MM-DD` + `HH:MM` (Paris, UTC+1) → UTC ISO instant. */
export function sampleInstant(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(
    Date.UTC(year!, month! - 1, day!, hours! - OFFSET_H, minutes!),
  ).toISOString();
}

const dates = Array.from(
  { length: 7 },
  (_, index) => `2026-10-${pad(26 + index)}`,
).map((date) => (date === "2026-10-32" ? "2026-11-01" : date));

/** Mon–Fri 9 h–19 h, Saturday 9 h–15 h, closed on Sunday. */
const opening = (date: string) =>
  date === "2026-11-01"
    ? []
    : [["09:00", date === "2026-10-31" ? "15:00" : "19:00"] as const];

type Entry = [
  date: string,
  start: string,
  end: string,
  client: string,
  service: string,
  priceCents: number,
  extra?: Partial<AgendaAppointmentDto>,
];

const entries: Entry[] = [
  ["2026-10-26", "09:30", "11:00", "Amel Kaci", "Pose volume", 9000],
  [
    "2026-10-26",
    "11:15",
    "12:00",
    "Lucie Perrin",
    "Rehaussement de cils",
    6000,
  ],
  ["2026-10-26", "14:00", "15:00", "Sofia Dias", "Remplissage", 5000],
  ["2026-10-26", "16:00", "17:15", "Chloé Vidal", "Pose cil à cil", 8000],
  [
    "2026-10-27",
    "09:00",
    "10:45",
    "Inès Bouchard",
    "Pose volume russe",
    9500,
    { source: "public", status: "completed" },
  ],
  [
    "2026-10-27",
    "11:00",
    "11:45",
    "Camille Roux",
    "Rehaussement & teinture",
    6500,
    { status: "completed" },
  ],
  [
    "2026-10-27",
    "13:30",
    "14:45",
    "Sarah Benali",
    "Remplissage volume mixte",
    5500,
  ],
  [
    "2026-10-27",
    "15:00",
    "16:15",
    "Léa Fontaine",
    "Pose cil à cil",
    8000,
    { internalNotes: "Colle sensible — yeux réactifs" },
  ],
  [
    "2026-10-27",
    "16:30",
    "17:15",
    "Nadia Haddad",
    "Rehaussement de cils",
    6000,
    {
      source: "public",
      internalNotes: "Première visite, vient de la part de Camille",
    },
  ],
  [
    "2026-10-27",
    "17:30",
    "18:30",
    "Julie Martin",
    "Remplissage classique",
    5000,
  ],
  ["2026-10-28", "09:00", "10:00", "Manon Lefèvre", "Remplissage", 5000],
  [
    "2026-10-28",
    "10:15",
    "12:00",
    "Yasmine Belkacem",
    "Volume russe",
    9500,
    { source: "public" },
  ],
  ["2026-10-28", "13:30", "14:15", "Emma Girard", "Rehaussement de cils", 6000],
  ["2026-10-28", "14:30", "16:00", "Clara Moreau", "Pose mixte", 8500],
  ["2026-10-28", "16:30", "18:00", "Zoé Robin", "Volume russe", 9500],
  ["2026-10-29", "10:00", "11:00", "Anaïs Thomas", "Remplissage", 5000],
  ["2026-10-29", "14:00", "15:15", "Rose Aubert", "Pose cil à cil", 8000],
  ["2026-10-30", "09:00", "10:45", "Jade Fournier", "Volume russe", 9500],
  ["2026-10-30", "11:00", "12:00", "Mila Chevalier", "Remplissage", 5000],
  ["2026-10-30", "13:30", "15:00", "Eva Nguyen", "Pose mixte", 8500],
  [
    "2026-10-30",
    "15:15",
    "16:00",
    "Alice Bernard",
    "Rehaussement de cils",
    6000,
  ],
  ["2026-10-30", "16:15", "17:30", "Louise Henry", "Pose cil à cil", 8000],
  [
    "2026-10-30",
    "17:45",
    "18:45",
    "Nina Ollivier",
    "Remplissage",
    5000,
    { source: "public" },
  ],
  ["2026-10-31", "09:30", "11:15", "Sarah Lemaire", "Volume russe", 9500],
  ["2026-10-31", "11:15", "12:00", "Inaya Mercier", "Remplissage", 5000],
];

const minutesBetween = (start: string, end: string) => {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh! * 60 + em! - (sh! * 60 + sm!);
};

const appointments: AgendaAppointmentDto[] = entries.map(
  ([date, start, end, client, service, priceCents, extra], index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    version: 1,
    status: "confirmed",
    startsAt: sampleInstant(date, start),
    endsAt: sampleInstant(date, end),
    localStartsAt: `${date}T${start}`,
    localEndsAt: `${date}T${end}`,
    durationMinutes: minutesBetween(start, end),
    startOccurrence: null,
    bufferMinutes: 0,
    priceCents,
    currency: "EUR",
    service: { id: `service-${service}`, name: service },
    client: { id: `client-${index + 1}`, displayName: client },
    internalNotes: null,
    cancellationReason: null,
    source: "manual",
    createdAt: sampleInstant("2026-10-20", "10:00"),
    updatedAt: sampleInstant("2026-10-20", "10:00"),
    ...extra,
  }),
);

const blocks: AgendaBlockDto[] = dates
  .filter((date) => opening(date).length > 0 && date !== "2026-10-31")
  .map((date, index) => ({
    id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
    version: 1,
    kind: "blocked",
    startsAt: sampleInstant(date, "12:00"),
    endsAt: sampleInstant(date, "13:15"),
    localStartsAt: `${date}T12:00`,
    localEndsAt: `${date}T13:15`,
    startOccurrence: null,
    endOccurrence: null,
    reason: "Déjeuner",
  }));

const next = (date: string) =>
  date === "2026-10-31"
    ? "2026-11-01"
    : date === "2026-11-01"
      ? "2026-11-02"
      : `2026-10-${pad(Number(date.slice(8)) + 1)}`;

export const sampleWeek: AgendaDto = {
  timezone: "Europe/Paris",
  today: SAMPLE_TODAY,
  offsets: [
    {
      startsAt: sampleInstant("2026-10-26", "00:00"),
      endsAt: sampleInstant("2026-11-02", "00:00"),
      offsetSeconds: OFFSET_H * 3600,
    },
  ],
  range: {
    startDate: "2026-10-26",
    endDate: "2026-11-01",
    startsAt: sampleInstant("2026-10-26", "00:00"),
    endsAt: sampleInstant("2026-11-02", "00:00"),
  },
  appointments,
  blocks,
  workingHours: {
    weekly: [],
    days: dates.map((date) => ({
      date,
      weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
      startsAt: sampleInstant(date, "00:00"),
      endsAt: sampleInstant(next(date), "00:00"),
      openRanges: opening(date).map(([start, end]) => ({
        startsAt: sampleInstant(date, start),
        endsAt: sampleInstant(date, end),
        localStartsAt: `${date}T${start}`,
        localEndsAt: `${date}T${end}`,
      })),
    })),
  },
};

/** A moment of that Tuesday, as an instant (ms). */
export const sampleNow = (time: string) =>
  Date.parse(sampleInstant(SAMPLE_TODAY, time));

// ——— A heavy Tuesday, for the hard cases ———
// Fourteen visits, three overlapping at once, a 4-hour service starting
// before opening, one after closing, a cancelled one (never shown), two
// pauses, very long names, services and notes.

const LONG_NOTE =
  "Allergie au latex et à la colle classique : n’utiliser que la colle sensible.\nPrévenir 10 minutes avant si retard, elle vient avec sa fille.\nA demandé un devis pour une pose mariage le 14 juin, à rappeler après le rendez-vous.";

const busyEntries: Entry[] = [
  [
    "2026-10-27",
    "08:00",
    "12:00",
    "Marie-Charlotte de La Rochefoucauld-Montbazon",
    "Pose volume russe 4D avec dépose complète, soin kératine et teinture des sourcils",
    24000,
    { status: "completed" },
  ],
  [
    "2026-10-27",
    "09:00",
    "09:45",
    "Lina Saïdi",
    "Rehaussement de cils",
    6000,
    { status: "completed" },
  ],
  [
    "2026-10-27",
    "09:30",
    "10:15",
    "Zoé Petit",
    "Remplissage",
    5000,
    { status: "no_show" },
  ],
  [
    "2026-10-27",
    "10:30",
    "11:00",
    "Annulée Exemple",
    "Remplissage",
    5000,
    { status: "cancelled" },
  ],
  [
    "2026-10-27",
    "13:00",
    "14:30",
    "Sarah Benali",
    "Remplissage volume mixte",
    5500,
  ],
  [
    "2026-10-27",
    "13:45",
    "14:15",
    "Aïcha Diallo",
    "Teinture des cils",
    3000,
    { internalNotes: "Peau réactive" },
  ],
  [
    "2026-10-27",
    "14:30",
    "15:00",
    "Jeanne-Marie Vasseur-Lemoine",
    "Rehaussement de cils et teinture",
    7000,
    { internalNotes: LONG_NOTE, source: "public" },
  ],
  ["2026-10-27", "15:00", "15:30", "Emma Girard", "Remplissage", 5000],
  [
    "2026-10-27",
    "16:00",
    "16:30",
    "Lou Martin",
    "Remplissage",
    5000,
    { source: "public" },
  ],
  ["2026-10-27", "16:30", "17:00", "Inès Roy", "Rehaussement de cils", 6000],
  ["2026-10-27", "17:00", "17:30", "Nour Haddad", "Teinture des cils", 3000],
  ["2026-10-27", "17:30", "18:00", "Clara Moreau", "Remplissage", 5000],
  ["2026-10-27", "18:00", "19:30", "Rose Aubert", "Pose cil à cil", 8000],
  [
    "2026-10-27",
    "19:30",
    "20:30",
    "Nina Ollivier",
    "Pose mixte",
    8500,
    { internalNotes: "Après la fermeture, à sa demande" },
  ],
];

export const sampleBusyWeek: AgendaDto = {
  ...sampleWeek,
  appointments: [
    ...sampleWeek.appointments.filter(
      (appointment) => !appointment.localStartsAt.startsWith(SAMPLE_TODAY),
    ),
    ...busyEntries.map(
      ([date, start, end, client, service, priceCents, extra], index) => ({
        ...appointments[0]!,
        id: `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
        status: "confirmed" as const,
        startsAt: sampleInstant(date, start),
        endsAt: sampleInstant(date, end),
        localStartsAt: `${date}T${start}`,
        localEndsAt: `${date}T${end}`,
        durationMinutes: minutesBetween(start, end),
        priceCents,
        service: { id: `service-${service}`, name: service },
        client: { id: `busy-${index + 1}`, displayName: client },
        internalNotes: null,
        source: "manual" as const,
        ...extra,
      }),
    ),
  ],
  blocks: [
    ...sampleWeek.blocks,
    {
      ...sampleWeek.blocks[0]!,
      id: "00000000-0000-4000-b000-000000000001",
      startsAt: sampleInstant(SAMPLE_TODAY, "15:30"),
      endsAt: sampleInstant(SAMPLE_TODAY, "16:00"),
      localStartsAt: `${SAMPLE_TODAY}T15:30`,
      localEndsAt: `${SAMPLE_TODAY}T16:00`,
      reason: "Rendez-vous à la banque, ne rien caler",
    },
  ],
};
