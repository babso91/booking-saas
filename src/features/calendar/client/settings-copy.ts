import type {
  CalendarIntegrationStatusDto,
  ConnectedCalendarDto,
} from "@/features/calendar/data/connection";
import type { CalendarOutboundStatusDto } from "@/features/calendar/data/outbound";
import { errorCopy } from "@/features/auth/client/error-copy";

import { describeSyncStatus } from "./sync-status-copy";

// Screen copy of the Google Calendar settings (tu voice, as the rest of the
// professional UI). Every backend union is mapped exhaustively: a new value
// added to a DTO fails the type check here instead of showing nothing.
// Nothing technical reaches the screen: no provider id, scope, generation,
// counter or raw error code.

function unreachable(value: never): never {
  throw new Error(`Unhandled calendar state: ${String(value)}`);
}

/**
 * How the dedicated calendar is named on screen. Its real name in Google is
 * fixed when Booking creates it (and may be found again later): no DTO gives
 * it, so the screen never pretends to know it.
 */
export const BOOKING_CALENDAR_LABEL = "Calendrier de rendez-vous Booking";

// ---------------------------------------------------------------------------
// Booking → Google (outbound)
// ---------------------------------------------------------------------------

export type OutboundCta =
  "enable" | "authorize_write" | "reconnect" | "reactivate" | "retry";

export type OutboundView = {
  /** Visual tone; never "error": Booking keeps working whatever happens. */
  tone: "idle" | "progress" | "active" | "delayed" | "action";
  title: string;
  body: string;
  note?: string;
  primary?: { cta: OutboundCta; label: string };
  secondary?: { cta: OutboundCta; label: string };
  /** Show the dedicated calendar Booking manages. */
  showCalendar: boolean;
};

export function outboundView(
  status: Pick<
    CalendarOutboundStatusDto,
    "health" | "state" | "actionRequired" | "reason" | "writeAuthorized"
  >,
): OutboundView {
  const reactivate = {
    cta: "reactivate",
    label: "Réactiver la synchronisation",
  } as const;

  switch (status.health) {
    case "disabled":
      if (status.actionRequired === "enable_again") {
        return {
          tone: "action",
          title: "Nouveau compte Google connecté",
          body: "Ton calendrier Booking se trouvait dans un autre compte Google. Réactive l’ajout des rendez-vous pour créer un nouveau calendrier dans ce compte et y remettre tes rendez-vous déjà synchronisés. Rien n’a été perdu dans Booking.",
          primary: { cta: "enable", label: "Réactiver" },
          showCalendar: false,
        };
      }
      return {
        tone: "idle",
        title: "Ajoute automatiquement tes rendez-vous à Google Calendar",
        body: "Booking créera dans Google un calendrier séparé, réservé à tes rendez-vous. Tes autres calendriers Google ne seront pas modifiés.",
        note: status.writeAuthorized
          ? undefined
          : "Google te demandera une autorisation supplémentaire.",
        primary: { cta: "enable", label: "Activer la synchronisation" },
        showCalendar: false,
      };

    case "pending":
      if (status.state === "creating") {
        return {
          tone: "progress",
          title: "Préparation de ton calendrier Google…",
          body: "Booking prépare ton calendrier de rendez-vous. Cela peut prendre quelques instants : tes rendez-vous y seront ajoutés automatiquement.",
          showCalendar: false,
        };
      }
      return {
        tone: "progress",
        title: "Synchronisation en cours",
        body: "Tes derniers rendez-vous sont en cours d’envoi vers Google Calendar.",
        showCalendar: true,
      };

    case "healthy":
      return {
        tone: "active",
        title: "Synchronisation active",
        body: "Tes nouveaux rendez-vous et leurs modifications sont automatiquement envoyés vers Google Calendar.",
        note: "Booking reste la référence de tes rendez-vous.",
        showCalendar: true,
      };

    case "retrying":
      return {
        tone: "delayed",
        title: "Synchronisation temporairement retardée",
        body: "Tes rendez-vous sont bien enregistrés dans Booking. Google Calendar sera mis à jour automatiquement.",
        secondary: { cta: "retry", label: "Réessayer maintenant" },
        showCalendar: true,
      };

    case "action_required":
      switch (status.actionRequired) {
        case "authorize_write":
          return {
            tone: "action",
            title: "Autorisation nécessaire",
            body: "Google demande une autorisation supplémentaire pour ajouter tes rendez-vous au calendrier créé par Booking.",
            primary: {
              cta: "authorize_write",
              label: "Autoriser l’ajout des rendez-vous",
            },
            showCalendar: false,
          };
        case "reconnect":
          return {
            tone: "action",
            title: "Reconnecte Google Calendar",
            body: "La connexion à Google doit être renouvelée pour reprendre la synchronisation. Tes rendez-vous restent enregistrés dans Booking.",
            primary: { cta: "reconnect", label: "Reconnecter Google" },
            showCalendar: false,
          };
        case "reactivate":
          return status.reason === "calendar_creation_uncertain"
            ? {
                tone: "action",
                title: "La configuration du calendrier doit être reprise",
                body: "Booking n’a pas pu confirmer la création de ton calendrier Google. Tes rendez-vous Booking sont intacts. Réactive la synchronisation pour reprendre la configuration.",
                primary: reactivate,
                showCalendar: false,
              }
            : {
                tone: "action",
                title: "Ton calendrier Booking a été supprimé",
                body: "Tes rendez-vous restent intacts dans Booking. Réactive la synchronisation pour créer un nouveau calendrier Google et y remettre tes rendez-vous déjà synchronisés.",
                primary: reactivate,
                showCalendar: false,
              };
        case "enable_again":
          return {
            tone: "action",
            title: "Nouveau compte Google connecté",
            body: "Réactive l’ajout des rendez-vous pour créer ton calendrier Booking dans ce compte. Rien n’a été perdu dans Booking.",
            primary: { cta: "enable", label: "Réactiver" },
            showCalendar: false,
          };
        case null:
          // Not produced by the backend; stay recoverable all the same.
          return {
            tone: "action",
            title: "Synchronisation en pause",
            body: "Tes rendez-vous restent enregistrés dans Booking. Réactive la synchronisation pour la reprendre.",
            primary: reactivate,
            showCalendar: false,
          };
        default:
          return unreachable(status.actionRequired);
      }

    default:
      return unreachable(status.health);
  }
}

// ---------------------------------------------------------------------------
// Google → Booking (inbound)
// ---------------------------------------------------------------------------

/** Calendars that can be offered as blocking: never Booking's own. */
export const blockingCandidates = (calendars: ConnectedCalendarDto[]) =>
  calendars.filter((calendar) => !calendar.bookingCalendar);

export type CalendarRowView = {
  /** The switch can be turned on (it can always be turned off). */
  canEnable: boolean;
  /** One short line under the name, or none. */
  note?: { text: string; tone: "muted" | "progress" | "active" | "margin" };
};

export function calendarRowView(
  calendar: Pick<
    ConnectedCalendarDto,
    | "selectable"
    | "accessRole"
    | "timezone"
    | "timezoneTrusted"
    | "blocking"
    | "protecting"
    | "syncStatus"
    | "lastError"
  >,
  /** The Google connection must be renewed: nothing syncs meanwhile. */
  paused = false,
): CalendarRowView {
  if (paused && calendar.blocking) {
    return {
      canEnable: false,
      note: {
        tone: "muted",
        text: "En pause : les événements déjà connus continuent de bloquer tes créneaux.",
      },
    };
  }
  if (!calendar.blocking) {
    if (calendar.selectable) return { canEnable: true };
    return {
      canEnable: false,
      note: {
        tone: "muted",
        text:
          calendar.accessRole === "freeBusyReader"
            ? "Partage seulement tes disponibilités : ne peut pas bloquer tes créneaux."
            : "Fuseau horaire non reconnu : ne peut pas être ajouté pour l’instant.",
      },
    };
  }

  // Never presented as protecting availability before its first full sync.
  if (!calendar.protecting) {
    return {
      canEnable: calendar.selectable,
      note: { tone: "progress", text: "Activation en cours…" },
    };
  }

  const known = "les événements déjà connus continuent de bloquer tes créneaux";
  switch (calendar.syncStatus) {
    case "synced":
      return {
        canEnable: true,
        note: { tone: "active", text: "Bloque tes créneaux" },
      };
    case "pending":
      return {
        canEnable: calendar.selectable,
        note: { tone: "progress", text: "Activation en cours…" },
      };
    case "syncing":
      return {
        canEnable: true,
        note: { tone: "progress", text: "Mise à jour en cours…" },
      };
    case "degraded":
      return {
        canEnable: calendar.selectable,
        note: {
          tone: "margin",
          text:
            describeSyncStatus(calendar).detail ??
            "Bloque tes créneaux avec une marge de sécurité.",
        },
      };
    case "stale":
      return {
        canEnable: calendar.selectable,
        note: { tone: "muted", text: `Mise à jour en attente : ${known}.` },
      };
    case "error":
      return {
        canEnable: calendar.selectable,
        note: {
          tone: "muted",
          text: `Dernière mise à jour impossible : ${known}. Nouvel essai automatique.`,
        },
      };
    case "incomplete":
      return {
        canEnable: calendar.selectable,
        note: {
          tone: "muted",
          text: "Calendrier très volumineux : seule une partie de ses événements est synchronisée. Ceux déjà lus bloquent tes créneaux.",
        },
      };
    default:
      return unreachable(calendar.syncStatus);
  }
}

export type ConnectionState = "not_connected" | "active" | "reauth_required";

/**
 * True only when nothing is waiting for the professional: Google connected
 * and usable, and no action required for the appointments. Derived from the
 * DTOs, never from what is displayed.
 */
export function nothingToDo(
  connection: ConnectionState,
  outbound: Pick<CalendarOutboundStatusDto, "health" | "actionRequired"> | null,
): boolean {
  if (connection !== "active" || !outbound) return false;
  if (outbound.actionRequired !== null) return false;
  switch (outbound.health) {
    case "healthy":
    case "pending":
    case "retrying":
    case "disabled":
      return true;
    case "action_required":
      return false;
    default:
      return unreachable(outbound.health);
  }
}

export function connectionState(
  status: Pick<CalendarIntegrationStatusDto, "connection">,
): ConnectionState {
  const connection = status.connection;
  if (!connection) return "not_connected";
  switch (connection.status) {
    case "disconnected":
      return "not_connected";
    case "active":
      return "active";
    case "reauth_required":
      return "reauth_required";
    default:
      return unreachable(connection.status);
  }
}

// ---------------------------------------------------------------------------
// Back from Google (?calendar=<result> set by the OAuth callback)
// ---------------------------------------------------------------------------

export type CallbackResult =
  | "connected"
  | "write_authorized"
  | "account_mismatch"
  | "denied"
  | "invalid_state"
  | "scope_missing"
  | "provider_unavailable"
  | "not_configured"
  | "disconnect_in_progress"
  | "error";

const callbackResults: Record<
  CallbackResult,
  {
    tone: "success" | "info" | "warning" | "error";
    title: string;
    message: string;
  }
> = {
  connected: {
    tone: "success",
    title: "Google Calendar est connecté",
    message:
      "Choisis maintenant les calendriers qui doivent bloquer tes créneaux.",
  },
  write_authorized: {
    tone: "success",
    title: "Autorisation accordée",
    message: "Booking prépare ton calendrier de rendez-vous dans Google.",
  },
  account_mismatch: { tone: "warning", ...errorCopy.calendar_account_mismatch },
  denied: {
    tone: "info",
    title: "Autorisation annulée",
    message: "Rien n’a été modifié. Tu peux recommencer quand tu veux.",
  },
  invalid_state: { tone: "warning", ...errorCopy.oauth_state_invalid },
  scope_missing: { tone: "warning", ...errorCopy.calendar_scope_missing },
  provider_unavailable: {
    tone: "warning",
    ...errorCopy.calendar_provider_unavailable,
  },
  not_configured: { tone: "warning", ...errorCopy.calendar_not_configured },
  disconnect_in_progress: {
    tone: "warning",
    ...errorCopy.calendar_disconnect_in_progress,
  },
  error: {
    tone: "error",
    title: "La connexion n’a pas abouti",
    message:
      "Réessaie dans quelques instants. Tes rendez-vous ne sont pas affectés.",
  },
};

/** The message for a callback result, or null for anything else in the URL. */
export function callbackNotice(result: string | undefined | null) {
  if (!result || !Object.hasOwn(callbackResults, result)) return null;
  return callbackResults[result as CallbackResult];
}
