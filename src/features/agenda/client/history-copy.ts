import type {
  AppointmentChange,
  AppointmentHistoryEntry,
} from "@/features/agenda/data/history";

import { formatDuration } from "./dates";
import { formatPrice } from "./money";

// Wording of the appointment history (point 100). Wall clocks come from the
// server, in the business's time zone: formatted here as calendar values.

const statusLabel = {
  confirmed: "Confirmé",
  completed: "Terminé",
  cancelled: "Annulé",
  no_show: "Absente",
} as const;

const dayLong = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const dayShort = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const calendarDay = (wallClock: string) =>
  new Date(`${wallClock.slice(0, 10)}T00:00:00Z`);
const time = (wallClock: string) => wallClock.slice(11, 16);
/** "samedi 6 décembre à 10:00". */
const when = (wallClock: string) =>
  `${dayLong.format(calendarDay(wallClock))} à ${time(wallClock)}`;

/** "22 nov. 2026, 14:05": when the change was made. */
export function changedAtLabel(
  entry: Pick<AppointmentHistoryEntry, "localAt">,
) {
  return `${dayShort.format(calendarDay(entry.localAt))}, ${time(entry.localAt)}`;
}

export function actorLabel(actor: AppointmentHistoryEntry["actor"]) {
  if (actor.kind === "member") {
    return actor.isYou ? "Toi" : (actor.name ?? "Un membre de l’équipe");
  }
  return actor.kind === "client" ? "La cliente" : "Higani";
}

const price = (cents: number | null, currency: string | null) =>
  cents === null || !currency ? "—" : formatPrice(cents, currency);

export function describeChange(
  change: AppointmentChange,
  actor: AppointmentHistoryEntry["actor"],
): string {
  switch (change.type) {
    case "created": {
      const head =
        actor.kind === "client" ? "Réservé en ligne" : "Rendez-vous créé";
      const series = change.inSeries ? " (rendez-vous répété)" : "";
      if (!change.localStartsAt || !change.localEndsAt) return head + series;
      const service = change.serviceName ? ` · ${change.serviceName}` : "";
      return `${head}${series} : ${when(change.localStartsAt)} – ${time(change.localEndsAt)}${service}`;
    }
    case "moved": {
      const from = change.from.localStartsAt;
      const to = change.to.localStartsAt;
      return from.slice(0, 10) === to.slice(0, 10)
        ? `Déplacé de ${time(from)} à ${time(to)}, ${dayLong.format(calendarDay(to))}`
        : `Déplacé du ${when(from)} au ${when(to)}`;
    }
    case "duration":
      return `Durée : ${formatDuration(change.fromMinutes)} → ${formatDuration(change.toMinutes)}`;
    case "service":
      return `Prestation : ${change.from ?? "—"} → ${change.to ?? "—"}`;
    case "options":
      return "Options modifiées";
    case "price":
      return `Prix : ${price(change.fromCents, change.fromCurrency)} → ${price(change.toCents, change.toCurrency)}`;
    case "client":
      return `Cliente : ${change.fromName ?? "une autre cliente"} → ${change.toName ?? "une autre cliente"}`;
    case "staff":
      return `Avec : ${change.fromName ?? "personne en particulier"} → ${change.toName ?? "personne en particulier"}`;
    case "status":
      return `Statut : ${statusLabel[change.from]} → ${statusLabel[change.to]}`;
    case "notes":
      return "Note interne modifiée";
    case "untracked":
      return "Modifié avant l’arrivée de l’historique (détail non enregistré)";
  }
}
