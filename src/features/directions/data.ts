// Fictional day of a fictional professional, for the art-direction
// prototypes in /apercu/directions. Nothing here is read from or written to
// a database; names are invented. Payments are shown as a pro would record
// them by hand (cash or her own card terminal): a prototype, not a ledger.

export type Payment = { method: "card" | "cash"; amountCents: number };

export type Visit = {
  id: string;
  start: string; // "09:00", business time
  end: string;
  client: string;
  initials: string;
  service: string;
  priceCents: number;
  /** One short human note she wrote, if any. */
  note?: string;
  firstVisit?: boolean;
  /** Visits so far, for the loyalty card (10 = a reward). */
  visits?: number;
  bookedOnline?: boolean;
  payment?: Payment;
};

export type Pause = { id: string; start: string; end: string; label: string };

export const studio = {
  name: "Atelier Maëlys",
  owner: "Maëlys",
  monogram: "AM",
  trade: "Cils & regard",
  city: "Lyon 6e",
};

export const today = {
  iso: "2026-10-27",
  weekday: "mardi",
  day: 27,
  month: "octobre",
  monthShort: "oct.",
  year: 2026,
  now: "14:05",
  dayStart: "09:00",
  dayEnd: "19:00",
};

export const visits: Visit[] = [
  {
    id: "v1",
    start: "09:00",
    end: "10:45",
    client: "Inès Bouchard",
    initials: "IB",
    service: "Pose volume russe",
    priceCents: 9500,
    firstVisit: true,
    bookedOnline: true,
    payment: { method: "card", amountCents: 9500 },
  },
  {
    id: "v2",
    start: "11:00",
    end: "11:45",
    client: "Camille Roux",
    initials: "CR",
    service: "Rehaussement & teinture",
    priceCents: 6500,
    visits: 9,
    note: "Prochaine visite offerte",
    payment: { method: "cash", amountCents: 6500 },
  },
  {
    id: "v3",
    start: "13:30",
    end: "14:45",
    client: "Sarah Benali",
    initials: "SB",
    service: "Remplissage volume mixte",
    priceCents: 5500,
    visits: 4,
  },
  {
    id: "v4",
    start: "15:00",
    end: "16:15",
    client: "Léa Fontaine",
    initials: "LF",
    service: "Pose cil à cil",
    priceCents: 8000,
    note: "Colle sensible — yeux réactifs",
    visits: 2,
  },
  {
    id: "v5",
    start: "16:30",
    end: "17:15",
    client: "Nadia Haddad",
    initials: "NH",
    service: "Rehaussement de cils",
    priceCents: 6000,
    bookedOnline: true,
    firstVisit: true,
  },
  {
    id: "v6",
    start: "17:30",
    end: "18:30",
    client: "Julie Martin",
    initials: "JM",
    service: "Remplissage classique",
    priceCents: 5000,
    visits: 12,
  },
];

export const pauses: Pause[] = [
  { id: "p1", start: "12:00", end: "13:15", label: "Déjeuner" },
];

/** Small things worth knowing today, as she would say them. */
export const notes = [
  { id: "n1", text: "Nadia a réservé en ligne cette nuit, à 23 h 42." },
  { id: "n2", text: "Camille fête son anniversaire jeudi." },
  { id: "n3", text: "Plus que 4 flacons de colle sensible." },
];

/** The week, Monday first; minutes booked out of the open minutes. */
export const week = [
  { day: "lun.", date: 26, booked: 360, open: 540 },
  { day: "mar.", date: 27, booked: 435, open: 540, today: true },
  { day: "mer.", date: 28, booked: 480, open: 540 },
  { day: "jeu.", date: 29, booked: 240, open: 540 },
  { day: "ven.", date: 30, booked: 510, open: 540 },
  { day: "sam.", date: 31, booked: 300, open: 360 },
];

export const takings = {
  /** Recorded by hand today. */
  today: { card: 9500, cash: 6500 },
  /** Still to collect for today's completed or ongoing visits. */
  toCollect: 5500,
  week: 61_500,
  month: 342_000,
};

export const minutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
};

export const euros = (cents: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

export const duration = (start: string, end: string) => {
  const total = minutes(end) - minutes(start);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}` : `${m} min`;
};

export const frTime = (time: string) =>
  time.replace(":", " h ").replace(" h 00", " h");

export type VisitState = "done" | "now" | "next" | "later";

export function stateOf(visit: Visit, now = today.now): VisitState {
  const n = minutes(now);
  if (minutes(visit.end) <= n) return "done";
  if (minutes(visit.start) <= n) return "now";
  const upcoming = visits.find((v) => minutes(v.start) > n);
  return upcoming?.id === visit.id ? "next" : "later";
}

export type Slot = {
  start: string;
  end: string;
  client: string;
  service: string;
};

/** Other days of the week, lighter: enough to read a week at a glance. */
export const weekSlots: Record<number, Slot[]> = {
  26: [
    { start: "09:30", end: "11:00", client: "Amel K.", service: "Pose volume" },
    {
      start: "11:15",
      end: "12:00",
      client: "Lucie P.",
      service: "Rehaussement",
    },
    {
      start: "14:00",
      end: "15:00",
      client: "Sofia D.",
      service: "Remplissage",
    },
    { start: "16:00", end: "17:15", client: "Chloé V.", service: "Cil à cil" },
  ],
  28: [
    {
      start: "09:00",
      end: "10:00",
      client: "Manon L.",
      service: "Remplissage",
    },
    {
      start: "10:15",
      end: "12:00",
      client: "Yasmine B.",
      service: "Volume russe",
    },
    {
      start: "13:30",
      end: "14:15",
      client: "Emma G.",
      service: "Rehaussement",
    },
    { start: "14:30", end: "16:00", client: "Clara M.", service: "Pose mixte" },
    { start: "16:30", end: "18:00", client: "Zoé R.", service: "Volume russe" },
  ],
  29: [
    {
      start: "10:00",
      end: "11:00",
      client: "Anaïs T.",
      service: "Remplissage",
    },
    { start: "14:00", end: "15:15", client: "Rose A.", service: "Cil à cil" },
    {
      start: "16:00",
      end: "16:45",
      client: "Lina S.",
      service: "Rehaussement",
    },
  ],
  30: [
    {
      start: "09:00",
      end: "10:45",
      client: "Jade F.",
      service: "Volume russe",
    },
    { start: "11:00", end: "12:00", client: "Mila C.", service: "Remplissage" },
    { start: "13:30", end: "15:00", client: "Eva N.", service: "Pose mixte" },
    {
      start: "15:15",
      end: "16:00",
      client: "Alice B.",
      service: "Rehaussement",
    },
    { start: "16:15", end: "17:30", client: "Louise H.", service: "Cil à cil" },
    { start: "17:45", end: "18:45", client: "Nina O.", service: "Remplissage" },
  ],
  31: [
    {
      start: "09:30",
      end: "11:15",
      client: "Sarah L.",
      service: "Volume russe",
    },
    {
      start: "11:15",
      end: "12:00",
      client: "Inaya M.",
      service: "Remplissage",
    },
    {
      start: "13:30",
      end: "14:30",
      client: "Romane D.",
      service: "Remplissage",
    },
  ],
};

export const weekDays = [
  { date: 26, weekday: "lundi" },
  { date: 27, weekday: "mardi" },
  { date: 28, weekday: "mercredi" },
  { date: 29, weekday: "jeudi" },
  { date: 30, weekday: "vendredi" },
  { date: 31, weekday: "samedi" },
];

export const slotsOf = (date: number): Slot[] =>
  date === today.day
    ? visits.map(({ start, end, client, service }) => ({
        start,
        end,
        client,
        service,
      }))
    : (weekSlots[date] ?? []);
