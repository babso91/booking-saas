// Booking preferences expressed in human terms. Values map 1:1 to the
// `business_settings` columns and stay within their CHECK constraints.

export type Option<T> = { value: T; label: string; hint?: string };

// minimum_booking_notice_minutes (0–10080)
export const noticeOptions: Option<number>[] = [
  { value: 30, label: "30 min" },
  { value: 60, label: "1 h" },
  { value: 120, label: "2 h" },
  { value: 720, label: "12 h" },
  { value: 1440, label: "La veille" },
  { value: 2880, label: "2 jours" },
];

// maximum_booking_advance_days (1–365)
export const horizonOptions: Option<number>[] = [
  { value: 14, label: "2 semaines" },
  { value: 30, label: "1 mois" },
  { value: 60, label: "2 mois" },
  { value: 90, label: "3 mois" },
  { value: 180, label: "6 mois" },
];

// buffer_minutes (0–240)
export const bufferOptions: Option<number>[] = [
  { value: 0, label: "Aucune" },
  { value: 5, label: "5 min" },
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
];

export const defaultBookingSettings = {
  minimumBookingNoticeMinutes: 120,
  maximumBookingAdvanceDays: 90,
  bufferMinutes: 10,
} as const;

export const DEFAULT_TIMEZONE = "Europe/Paris";

// French-speaking markets first. The browser's zone is added when missing.
const timezoneLabels: Record<string, string> = {
  "Europe/Paris": "France métropolitaine",
  "Europe/Brussels": "Belgique",
  "Europe/Luxembourg": "Luxembourg",
  "Europe/Zurich": "Suisse",
  "Europe/Monaco": "Monaco",
  "America/Toronto": "Québec · Ontario",
  "America/Guadeloupe": "Guadeloupe",
  "America/Martinique": "Martinique",
  "America/Cayenne": "Guyane",
  "Indian/Reunion": "La Réunion",
  "Indian/Mayotte": "Mayotte",
  "Pacific/Noumea": "Nouvelle-Calédonie",
  "Pacific/Tahiti": "Polynésie française",
  "Africa/Casablanca": "Maroc",
  "Africa/Tunis": "Tunisie",
  "Africa/Algiers": "Algérie",
  "Africa/Dakar": "Sénégal",
  "Africa/Abidjan": "Côte d’Ivoire",
};

export function timezoneOptions(extra?: string): Option<string>[] {
  const zones = Object.keys(timezoneLabels);

  if (extra && !zones.includes(extra) && isValidTimezone(extra)) {
    zones.unshift(extra);
  }

  return zones.map((zone) => ({
    value: zone,
    label: timezoneLabels[zone] ?? zone.split("/").pop()!.replace(/_/g, " "),
  }));
}

export function isValidTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function detectTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimezone(zone) ? zone : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function formatLocalTime(zone: string, now = new Date()) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

export function formatNotice(minutes: number) {
  if (minutes === 0) return "jusqu’à la dernière minute";
  if (minutes < 60) return `jusqu’à ${minutes} min avant`;
  if (minutes === 1440) return "jusqu’à la veille";
  if (minutes % 1440 === 0) return `jusqu’à ${minutes / 1440} jours avant`;
  if (minutes % 60 === 0) return `jusqu’à ${minutes / 60} h avant`;
  return `jusqu’à ${Math.floor(minutes / 60)} h ${minutes % 60} avant`;
}

export function formatHorizon(days: number) {
  if (days % 30 === 0) return `${days / 30} mois à l’avance`;
  if (days % 7 === 0) {
    const weeks = days / 7;
    return `${weeks} semaine${weeks > 1 ? "s" : ""} à l’avance`;
  }
  return `${days} jours à l’avance`;
}

// One sentence the professional can read back to check her choices.
export function summarizeBookingSettings(settings: {
  minimumBookingNoticeMinutes: number;
  maximumBookingAdvanceDays: number;
  bufferMinutes: number;
}) {
  const buffer =
    settings.bufferMinutes === 0
      ? "sans pause entre deux rendez-vous"
      : `avec ${settings.bufferMinutes} min de pause entre deux rendez-vous`;

  return `Tes clientes pourront réserver ${formatHorizon(
    settings.maximumBookingAdvanceDays,
  )}, ${formatNotice(settings.minimumBookingNoticeMinutes)}, ${buffer}.`;
}
