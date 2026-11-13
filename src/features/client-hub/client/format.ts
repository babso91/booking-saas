import { formatPrice } from "@/features/agenda/client/money";
import type {
  ClientHubAppointmentDto,
  ClientHubIssuedRewardDto,
  ClientHubLedgerEntryDto,
} from "@/features/client-hub/types";

// Words, dates and numbers of the customer's hub. Instants come in UTC
// (ISO 8601) and are read in the BUSINESS time zone, where the appointment
// takes place: formatting only, nothing is computed from them.

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = formats.get(key);
  if (!found) {
    try {
      found = new Intl.DateTimeFormat("fr-FR", { ...options, timeZone });
    } catch {
      // An unknown zone: UTC rather than the device's zone, said nowhere
      // as local time (businesses always carry a valid IANA zone).
      found = new Intl.DateTimeFormat("fr-FR", { ...options, timeZone: "UTC" });
    }
    formats.set(key, found);
  }
  return found;
}

const trimDot = (value: string) => value.replace(/\.$/, "");

/** The civil date (`YYYY-MM-DD`) of an instant in `timeZone`. */
export function civilDate(iso: string, timeZone: string) {
  const parts = Object.fromEntries(
    format(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** « 10:30 » */
export const timeOf = (iso: string, timeZone: string) =>
  format(timeZone, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );

/** « mardi 4 novembre » (with the year when it is not this year). */
export function longDay(iso: string, timeZone: string, now = new Date()) {
  const sameYear =
    civilDate(iso, timeZone).slice(0, 4) ===
    civilDate(now.toISOString(), timeZone).slice(0, 4);
  return format(timeZone, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(iso));
}

/** « 4 nov. 2026 » */
export const shortDate = (iso: string, timeZone: string) =>
  format(timeZone, { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(iso),
  );

/** Date box parts: « mar. », « 4 », « nov. ». */
export function dateParts(iso: string, timeZone: string) {
  const at = new Date(iso);
  return {
    weekday: trimDot(format(timeZone, { weekday: "short" }).format(at)),
    day: format(timeZone, { day: "numeric" }).format(at),
    month: trimDot(format(timeZone, { month: "short" }).format(at)),
  };
}

/** « novembre 2026 » (month headings of a list). */
export const monthHeading = (iso: string, timeZone: string) =>
  format(timeZone, { month: "long", year: "numeric" }).format(new Date(iso));

const DAY = 86_400_000;

/** Whole civil days from today to the appointment's day, at the business. */
export function daysUntil(iso: string, timeZone: string, now = new Date()) {
  const target = Date.parse(`${civilDate(iso, timeZone)}T00:00:00Z`);
  const today = Date.parse(
    `${civilDate(now.toISOString(), timeZone)}T00:00:00Z`,
  );
  return Math.round((target - today) / DAY);
}

/** « Aujourd’hui », « Demain », « Dans 5 jours », or null beyond a month. */
export function relativeDay(iso: string, timeZone: string, now = new Date()) {
  const days = daysUntil(iso, timeZone, now);
  if (days === 0) return "Aujourd’hui";
  if (days === 1) return "Demain";
  if (days > 1 && days <= 30) return `Dans ${days} jours`;
  return null;
}

/** « 1 h 15 », « 45 min », « 2 h ». */
export function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0
    ? `${hours} h`
    : `${hours} h ${String(rest).padStart(2, "0")}`;
}

export const appointmentStatus: Record<
  ClientHubAppointmentDto["status"],
  { label: string; tone: "accent" | "success" | "muted" | "danger" }
> = {
  confirmed: { label: "Confirmé", tone: "accent" },
  completed: { label: "Terminé", tone: "success" },
  cancelled: { label: "Annulé", tone: "muted" },
  no_show: { label: "Non honoré", tone: "danger" },
};

/** « 120 points », « 1 point », « −10 points » (a real minus sign). */
export function points(value: number) {
  const size = Math.abs(value);
  return `${value < 0 ? "−" : ""}${size.toLocaleString("fr-FR")} point${size > 1 ? "s" : ""}`;
}

/** « +10 », « −100 » */
export const signedPoints = (value: number) =>
  `${value < 0 ? "−" : "+"}${Math.abs(value).toLocaleString("fr-FR")}`;

/**
 * What a movement of points is, in the customer's words. Built from the
 * type and the names the contract gives, never from any text typed by the
 * professional (the reason of an adjustment is not exposed, by design).
 */
export function ledgerTitle(entry: ClientHubLedgerEntryDto) {
  switch (entry.type) {
    case "appointment_completed":
      return entry.serviceName ? `Visite · ${entry.serviceName}` : "Visite";
    case "reward_redeemed":
      return entry.rewardName
        ? `Récompense · ${entry.rewardName}`
        : "Récompense";
    case "manual_adjustment":
      return entry.pointsDelta >= 0 ? "Points offerts" : "Points retirés";
    case "correction":
      return entry.rewardName
        ? `Récompense annulée · ${entry.rewardName}`
        : "Correction";
  }
}

/** What a reward gives: « 15,00 € de remise », « 10 % de remise », « Prestation offerte : Soin des cils ». */
export function rewardValue(reward: {
  rewardType: ClientHubIssuedRewardDto["rewardType"];
  rewardValue: number | null;
  currency: string | null;
  serviceName: string | null;
}) {
  switch (reward.rewardType) {
    case "fixed_discount":
      return reward.rewardValue === null
        ? "Remise"
        : `${formatPrice(reward.rewardValue, reward.currency ?? "EUR")} de remise`;
    case "percentage_discount":
      return reward.rewardValue === null
        ? "Remise"
        : `${reward.rewardValue} % de remise`;
    case "free_service":
      return reward.serviceName
        ? `Prestation offerte : ${reward.serviceName}`
        : "Prestation offerte";
  }
}

export const issuedStatus: Record<
  ClientHubIssuedRewardDto["status"],
  { label: string; tone: "accent" | "success" | "muted" }
> = {
  issued: { label: "À utiliser", tone: "accent" },
  fulfilled: { label: "Utilisée", tone: "success" },
  cancelled: { label: "Annulée", tone: "muted" },
};

/** First letter of a name, for a monogram. */
export const initial = (value: string) =>
  value.trim().charAt(0).toLocaleUpperCase("fr-FR") || "·";
