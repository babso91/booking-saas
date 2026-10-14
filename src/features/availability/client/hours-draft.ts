// The weekly opening hours as the professional edits them, and the complete
// schedule sent to replaceBusinessHoursAction. Times are wall-clock "HH:MM"
// of the business time zone, compared as minutes only: no Date, no browser
// time zone. The rules mirror src/features/availability/schemas/
// availability.ts (and public.replace_business_hours), the authority.

/** One range as read from listBusinessHoursAction. */
export type HourRange = { weekday: number; startsAt: string; endsAt: string };

export type DayDraft = {
  /** 0 = Sunday … 6 = Saturday, as stored. */
  weekday: number;
  open: boolean;
  ranges: { startsAt: string; endsAt: string }[];
};

/** Monday first, as a French week reads. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const WEEKDAY_LABELS: Record<number, string> = {
  0: "Dimanche",
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
  6: "Samedi",
};

/** The backend accepts at most 7 × 12 ranges. */
export const MAX_RANGES_PER_DAY = 12;

/** A range proposed when a day opens or a range is added. */
export const DEFAULT_RANGE = { startsAt: "09:00", endsAt: "18:00" };

export const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};

/** "HH:MM" for a number of minutes since midnight (24:00 at most). */
export const fromMinutes = (minutes: number) => {
  const bounded = Math.max(0, Math.min(24 * 60, minutes));
  return `${String(Math.trunc(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
};

/**
 * A range after the last one of a day (never overlapping it), the default
 * for an empty day, or null when the day is already full up to midnight.
 */
export function nextRange(
  ranges: { startsAt: string; endsAt: string }[],
): { startsAt: string; endsAt: string } | null {
  if (ranges.length === 0) return { ...DEFAULT_RANGE };
  const lastEnd = Math.max(...ranges.map((range) => toMinutes(range.endsAt)));
  if (lastEnd >= 24 * 60) return null;
  // An hour after the last range when it fits, right after it otherwise.
  const start = lastEnd + 60 <= 23 * 60 ? lastEnd + 60 : lastEnd;
  return {
    startsAt: fromMinutes(start),
    endsAt: fromMinutes(Math.min(start + 60, 24 * 60)),
  };
}

/** Choices every 15 minutes, 00:00 to 24:00 (closing at midnight). */
export const TIME_OPTIONS = Array.from({ length: 97 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.trunc(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

/** The choices for a select, keeping a stored value off the 15 min grid. */
export function timeOptions(current: string) {
  return TIME_OPTIONS.includes(current)
    ? TIME_OPTIONS
    : [...TIME_OPTIONS, current].sort((a, b) => toMinutes(a) - toMinutes(b));
}

/** The editable week, from the schedule read. */
export function weekFromHours(hours: HourRange[]): DayDraft[] {
  return WEEK_ORDER.map((weekday) => {
    const ranges = hours
      .filter((range) => range.weekday === weekday)
      .map(({ startsAt, endsAt }) => ({ startsAt, endsAt }))
      .sort((a, b) => toMinutes(a.startsAt) - toMinutes(b.startsAt));
    return { weekday, open: ranges.length > 0, ranges };
  });
}

/**
 * The complete schedule to send: every range of every open day. A closed
 * day sends no range (the backend replaces the whole week).
 */
export function hoursFromWeek(week: DayDraft[]): HourRange[] {
  return week.flatMap((day) =>
    day.open
      ? day.ranges.map((range) => ({ weekday: day.weekday, ...range }))
      : [],
  );
}

/** A comparable form of a schedule (order-independent). */
export function scheduleKey(hours: HourRange[]) {
  return hours
    .map((range) => `${range.weekday} ${range.startsAt}-${range.endsAt}`)
    .sort()
    .join("|");
}

export type DayErrors = Record<number, string>;

/**
 * Messages per weekday, before sending: each range ends after it starts,
 * ranges of a day do not overlap, an open day has a range.
 */
export function checkWeek(week: DayDraft[]): DayErrors {
  const errors: DayErrors = {};
  for (const day of week) {
    if (!day.open) continue;
    if (day.ranges.length === 0) {
      errors[day.weekday] = "Ajoute une plage ou ferme ce jour.";
      continue;
    }
    if (day.ranges.length > MAX_RANGES_PER_DAY) {
      errors[day.weekday] = `${MAX_RANGES_PER_DAY} plages au plus par jour.`;
      continue;
    }
    const spans = day.ranges.map((range) => ({
      start: toMinutes(range.startsAt),
      end: toMinutes(range.endsAt),
    }));
    if (spans.some((span) => span.start >= span.end)) {
      errors[day.weekday] = "Chaque plage doit finir après son début.";
      continue;
    }
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    if (
      sorted.some(
        (span, index) => index > 0 && span.start < sorted[index - 1]!.end,
      )
    ) {
      errors[day.weekday] = "Deux plages de ce jour se chevauchent.";
    }
  }
  return errors;
}

/** Weekdays named in a refused write (`hours.<index>`), or none. */
export function serverDayErrors(
  sent: HourRange[],
  fieldErrors?: Record<string, string[]>,
): DayErrors {
  const errors: DayErrors = {};
  for (const key of Object.keys(fieldErrors ?? {})) {
    const match = /^hours\.(\d+)/.exec(key);
    const range = match ? sent[Number(match[1])] : undefined;
    if (range) {
      errors[range.weekday] =
        "Cette plage a été refusée : vérifie ses horaires et ceux du même jour.";
    }
  }
  return errors;
}

/** "9 h – 18 h", "9 h 30 – 12 h 30". */
export function rangeLabel(range: { startsAt: string; endsAt: string }) {
  const label = (time: string) => {
    const [hours, minutes] = time.split(":") as [string, string];
    return minutes === "00"
      ? `${Number(hours)} h`
      : `${Number(hours)} h ${minutes}`;
  };
  return `${label(range.startsAt)} – ${label(range.endsAt)}`;
}
