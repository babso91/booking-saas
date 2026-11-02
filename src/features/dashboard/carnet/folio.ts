import { timeOf } from "@/features/agenda/client/dates";

import type { TodayModel } from "../client/today-model";

// What a printed planner says of a date and of a day: its week, its page, its
// sentence. Pure, on civil dates (YYYY-MM-DD, PostgreSQL's): never the
// browser's clock or time zone.

const DAY_MS = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

export const monthOf = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1]!;

/** ISO 8601: the week of its Thursday (28 Dec 2026 is week 53, 4 Jan 2027 week 1). */
export function isoWeek(date: string) {
  const day = utc(date);
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  const thursday = day + (3 - weekday) * DAY_MS;
  const firstOfYear = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - firstOfYear) / (7 * DAY_MS)) + 1;
}

/** Its page in the year's book: 1 January is page 1. */
export const pageOf = (date: string) =>
  Math.round((utc(date) - utc(`${date.slice(0, 4)}-01-01`)) / DAY_MS) + 1;

export const folioOf = (date: string) =>
  `Sem. ${isoWeek(date)} · p. ${pageOf(date)}`;

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

/** "Novembre" or, across two months, "Décembre – janvier". */
export function weekMonths(days: string[]) {
  const first = monthOf(days[0]!);
  const last = monthOf(days[days.length - 1]!);
  return capitalize(first === last ? first : `${first} – ${last}`);
}

/** "2 – 8 novembre 2026", "28 décembre 2026 – 3 janvier 2027". */
export function weekSpan(days: string[]) {
  const [first, last] = [days[0]!, days[days.length - 1]!];
  const day = (date: string) => Number(date.slice(8, 10));
  const [fromYear, toYear] = [first.slice(0, 4), last.slice(0, 4)];
  if (fromYear !== toYear)
    return `${day(first)} ${monthOf(first)} ${fromYear} – ${day(last)} ${monthOf(last)} ${toYear}`;
  if (monthOf(first) !== monthOf(last))
    return `${day(first)} ${monthOf(first)} – ${day(last)} ${monthOf(last)} ${toYear}`;
  return `${day(first)} – ${day(last)} ${monthOf(last)} ${toYear}`;
}

/** "14:05" as she would write it: "14 h 05", "9 h". */
export function frTime(time: string) {
  const [hours, minutes] = time.split(":");
  const hour = Number(hours);
  return minutes === "00" ? `${hour} h` : `${hour} h ${minutes}`;
}

const NUMBERS = [
  "Zéro",
  "Un",
  "Deux",
  "Trois",
  "Quatre",
  "Cinq",
  "Six",
  "Sept",
  "Huit",
  "Neuf",
  "Dix",
  "Onze",
  "Douze",
];
const lower = (count: number) =>
  count <= 12 ? NUMBERS[count]!.toLowerCase() : String(count);
const upper = (count: number) =>
  count <= 12 ? NUMBERS[count]! : String(count);

const firstName = (name: string) => name.split(" ")[0] ?? name;

export type LedePart = { text: string; marked?: boolean };

/**
 * The day, in one sentence, from what her agenda knows and nothing else: no
 * first visit, no money, no guess (a slot begun is said as a slot).
 */
export function ledeOf(model: TodayModel): LedePart[] {
  const { visits, counts, closure, closures, phase, currents, next } = model;
  if (visits.length === 0) {
    if (closure?.kind === "exceptional")
      return [
        { text: "Fermeture exceptionnelle" },
        ...(closure.reason ? [{ text: ` : ${closure.reason}` }] : []),
        { text: "." },
      ];
    if (closure) return [{ text: "Jour de fermeture. Repose-toi." }];
    return [
      {
        text: closures.length
          ? "Aucun rendez-vous, et une partie de ta journée est fermée."
          : "Aucun rendez-vous. Ta journée est libre.",
      },
    ];
  }

  const plural = counts.total > 1;
  const parts: LedePart[] = [{ text: `${upper(counts.total)} rendez‑vous` }];
  if (counts.online > 0) {
    parts.push({ text: ", dont " });
    parts.push({
      text: `${lower(counts.online)} pris en ligne`,
      marked: true,
    });
  }
  parts.push({ text: ". " });

  if (phase === "after") {
    parts.push({
      text: plural ? "Ils sont tous derrière toi." : "Il est derrière toi.",
    });
    return parts;
  }
  if (currents.length > 1)
    parts.push({ text: `${upper(currents.length)} créneaux en cours. ` });
  else if (currents[0])
    parts.push({
      text: `Créneau de ${firstName(currents[0].appointment.client.displayName)} en cours${
        currents[0].endsAfter
          ? ""
          : `, fin prévue à ${frTime(timeOf(currents[0].appointment.localEndsAt))}`
      }. `,
    });
  else if (next)
    parts.push({
      text: `Prochain : ${firstName(next.appointment.client.displayName)} à ${frTime(timeOf(next.appointment.localStartsAt))}. `,
    });

  const last = visits.reduce((a, b) => (b.end > a.end ? b : a));
  const end = frTime(timeOf(last.appointment.localEndsAt));
  parts.push({ text: `Tu finis ${last.endsAfter ? "demain " : ""}à ${end}.` });
  return parts;
}
