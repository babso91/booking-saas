import type { ConnectedCalendarDto } from "@/features/calendar/data/connection";

// Labels of a connected calendar's sync status, for the calendar settings
// screen (tu voice, as the rest of the professional UI). Only `synced` says
// the copy is complete and exact; `degraded` must never read as up to date.

type SyncStatus = ConnectedCalendarDto["syncStatus"];

export const syncStatusCopy: Record<
  SyncStatus,
  { label: string; detail?: string; healthy: boolean }
> = {
  pending: { label: "Activation en cours", healthy: false },
  syncing: { label: "Synchronisation en cours", healthy: false },
  synced: { label: "Synchronisé", healthy: true },
  degraded: {
    label: "Synchronisé avec une marge : fuseau horaire non reconnu",
    detail:
      "Les créneaux de ce calendrier sont bloqués avec une marge de sécurité tant que son fuseau horaire n’est pas reconnu.",
    healthy: false,
  },
  stale: { label: "Mise à jour en attente", healthy: false },
  error: { label: "Erreur de synchronisation", healthy: false },
  incomplete: {
    label: "Calendrier trop volumineux : synchronisation partielle",
    healthy: false,
  },
};

/** The label of a calendar's state; an untrusted zone always shows. */
export function describeSyncStatus(
  calendar: Pick<ConnectedCalendarDto, "syncStatus" | "timezoneTrusted">,
) {
  if (!calendar.timezoneTrusted) return syncStatusCopy.degraded;
  return syncStatusCopy[calendar.syncStatus];
}
