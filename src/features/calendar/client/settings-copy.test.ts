import { describe, expect, it } from "vitest";

import type { ConnectedCalendarDto } from "@/features/calendar/data/connection";
import type { CalendarOutboundStatusDto } from "@/features/calendar/data/outbound";

import {
  blockingCandidates,
  calendarRowView,
  callbackNotice,
  connectionState,
  outboundView,
  type CallbackResult,
} from "./settings-copy";

type Outbound = Pick<
  CalendarOutboundStatusDto,
  "health" | "state" | "actionRequired" | "reason" | "writeAuthorized"
>;

// Every combination the backend can produce (toOutboundStatusDto), plus the
// ones its types allow.
const healths: Outbound["health"][] = [
  "disabled",
  "healthy",
  "pending",
  "retrying",
  "action_required",
];
const states: Outbound["state"][] = [
  "disabled",
  "creating",
  "active",
  "action_required",
];
const actions: Outbound["actionRequired"][] = [
  "authorize_write",
  "reconnect",
  "reactivate",
  "enable_again",
  null,
];
const reasons: Outbound["reason"][] = [
  "calendar_deleted",
  "calendar_creation_uncertain",
  "write_authorization_required",
  "account_changed",
  "reauth_required",
  null,
];
const everyOutbound: Outbound[] = healths.flatMap((health) =>
  states.flatMap((state) =>
    actions.flatMap((actionRequired) =>
      reasons.flatMap((reason) =>
        [true, false].map((writeAuthorized) => ({
          health,
          state,
          actionRequired,
          reason,
          writeAuthorized,
        })),
      ),
    ),
  ),
);

/** Words that must never reach a professional. */
const TECHNICAL =
  /calendar_|invalid_grant|_required|_uncertain|generation|provider|scope|token|oauth|outbound|inbound|mirror|retry count|\bid\b|http|rpc|error code/i;

const view = (status: Partial<Outbound>) =>
  outboundView(
    {
      health: "disabled",
      state: "disabled",
      actionRequired: null,
      reason: null,
      writeAuthorized: true,
      ...status,
    },
    "Studio Mila",
  );

describe("outboundView — Booking → Google", () => {
  it("maps every state the types allow to a recoverable screen, in plain words", () => {
    for (const status of everyOutbound) {
      const result = outboundView(status, "Studio Mila");
      const text = [result.title, result.body, result.note ?? ""].join(" ");
      expect(result.title.length, JSON.stringify(status)).toBeGreaterThan(0);
      expect(text, JSON.stringify(status)).not.toMatch(TECHNICAL);
      // Booking appointments are never presented as at risk.
      expect(text).not.toMatch(/perdu(?!\s+dans)|supprimés de Booking/i);
      if (status.health === "action_required") {
        expect(result.primary, JSON.stringify(status)).toBeDefined();
      }
    }
  });

  it("disabled: offers to enable, names the dedicated calendar, says other calendars are untouched", () => {
    const result = view({});
    expect(result.title).toBe(
      "Ajoute automatiquement tes rendez-vous à Google Calendar",
    );
    expect(result.body).toContain("« Rendez-vous — Studio Mila »");
    expect(result.body).toContain(
      "Tes autres calendriers Google ne seront pas modifiés",
    );
    expect(result.primary).toEqual({
      cta: "enable",
      label: "Activer la synchronisation",
    });
    expect(result.note).toBeUndefined();
    expect(view({ writeAuthorized: false }).note).toBe(
      "Google te demandera une autorisation supplémentaire.",
    );
  });

  it("account changed: enable again, nothing lost", () => {
    const result = view({
      actionRequired: "enable_again",
      reason: "account_changed",
    });
    expect(result.title).toBe("Nouveau compte Google connecté");
    expect(result.primary).toEqual({ cta: "enable", label: "Réactiver" });
    expect(result.body).toContain("Rien n’a été perdu dans Booking");
  });

  it("pending: preparing the calendar, or sending the latest changes — never a failure", () => {
    const preparing = view({ health: "pending", state: "creating" });
    expect(preparing).toMatchObject({
      tone: "progress",
      title: "Préparation de ton calendrier Google…",
      showCalendar: false,
    });
    expect(preparing.primary).toBeUndefined();
    expect(view({ health: "pending", state: "active" })).toMatchObject({
      tone: "progress",
      title: "Synchronisation en cours",
      showCalendar: true,
    });
  });

  it("healthy and retrying", () => {
    const healthy = view({ health: "healthy", state: "active" });
    expect(healthy).toMatchObject({
      tone: "active",
      title: "Synchronisation active",
      note: "Booking reste la référence de tes rendez-vous.",
      showCalendar: true,
    });
    expect(healthy.primary).toBeUndefined();
    const retrying = view({ health: "retrying", state: "active" });
    expect(retrying).toMatchObject({
      tone: "delayed",
      title: "Synchronisation temporairement retardée",
      secondary: { cta: "retry", label: "Réessayer maintenant" },
    });
    expect(retrying.body).toContain("bien enregistrés dans Booking");
  });

  it.each([
    [
      "authorize_write",
      "write_authorization_required",
      "Autorisation nécessaire",
      "authorize_write",
      "Autoriser l’ajout des rendez-vous",
    ],
    [
      "reconnect",
      "reauth_required",
      "Reconnecte Google Calendar",
      "reconnect",
      "Reconnecter Google",
    ],
    [
      "reactivate",
      "calendar_deleted",
      "Ton calendrier Booking a été supprimé",
      "reactivate",
      "Réactiver la synchronisation",
    ],
    [
      "reactivate",
      "calendar_creation_uncertain",
      "La configuration du calendrier doit être reprise",
      "reactivate",
      "Réactiver la synchronisation",
    ],
    [
      "enable_again",
      "account_changed",
      "Nouveau compte Google connecté",
      "enable",
      "Réactiver",
    ],
  ] as const)(
    "action required: %s (%s)",
    (actionRequired, reason, title, cta, label) => {
      const result = view({
        health: "action_required",
        state: "action_required",
        actionRequired,
        reason,
      });
      expect(result.title).toBe(title);
      expect(result.primary).toEqual({ cta, label });
      expect(result.tone).toBe("action");
    },
  );

  it("deleted calendar: appointments intact, a new calendar, already synced ones put back", () => {
    const body = view({
      health: "action_required",
      state: "action_required",
      actionRequired: "reactivate",
      reason: "calendar_deleted",
    }).body;
    expect(body).toContain("Tes rendez-vous restent intacts dans Booking");
    expect(body).toContain("créer un nouveau calendrier Google");
    expect(body).toContain("y remettre tes rendez-vous déjà synchronisés");
  });
});

const calendar = (
  overrides: Partial<ConnectedCalendarDto> = {},
): ConnectedCalendarDto => ({
  id: "c1",
  name: "Perso",
  timezone: "Europe/Paris",
  primary: false,
  accessRole: "owner",
  selectable: true,
  timezoneTrusted: true,
  blocking: false,
  bookingCalendar: false,
  protecting: false,
  syncStatus: "pending",
  lastSyncedAt: null,
  lastError: null,
  ...overrides,
});

describe("Google → Booking", () => {
  it("never offers Booking's own calendar as a blocking calendar", () => {
    const list = [
      calendar({ id: "a" }),
      calendar({ id: "b", bookingCalendar: true, selectable: false }),
    ];
    expect(blockingCandidates(list).map((item) => item.id)).toEqual(["a"]);
  });

  it("not selected: selectable, or a plain reason why not", () => {
    expect(calendarRowView(calendar())).toEqual({ canEnable: true });
    expect(
      calendarRowView(
        calendar({ selectable: false, accessRole: "freeBusyReader" }),
      ),
    ).toMatchObject({ canEnable: false, note: { tone: "muted" } });
    expect(
      calendarRowView(calendar({ selectable: false, timezoneTrusted: false }))
        .note?.text,
    ).toMatch(/Fuseau horaire non reconnu/);
  });

  it("selected: activation until the first full sync, never 'protecting' before", () => {
    for (const syncStatus of [
      "pending",
      "syncing",
      "synced",
      "degraded",
      "stale",
      "error",
      "incomplete",
    ] as const) {
      expect(
        calendarRowView(
          calendar({ blocking: true, protecting: false, syncStatus }),
        ).note,
      ).toEqual({ tone: "progress", text: "Activation en cours…" });
    }
  });

  it.each([
    ["synced", "Bloque tes créneaux"],
    ["syncing", "Mise à jour en cours…"],
    ["degraded", "marge de sécurité"],
    ["stale", "continuent de bloquer tes créneaux"],
    ["error", "continuent de bloquer tes créneaux"],
    ["incomplete", "Ceux déjà lus bloquent tes créneaux"],
  ] as const)("protecting, %s: %s", (syncStatus, text) => {
    const note = calendarRowView(
      calendar({ blocking: true, protecting: true, syncStatus }),
    ).note!;
    expect(note.text).toContain(text);
    expect(note.text).not.toMatch(TECHNICAL);
    // Never suggests that slots could be open by mistake.
    expect(note.text).not.toMatch(/ouvert|risque|réservable/i);
  });

  it("a selected calendar can always be turned off, even when no longer selectable", () => {
    const view = calendarRowView(
      calendar({
        blocking: true,
        protecting: true,
        syncStatus: "degraded",
        selectable: false,
        timezoneTrusted: false,
      }),
    );
    expect(view.canEnable).toBe(false); // (turning off is always allowed)
    expect(view.note?.text).toMatch(/fuseau horaire/i);
  });

  it("connection to renew: a selected calendar reads as paused, never as up to date", () => {
    const view = calendarRowView(
      calendar({ blocking: true, protecting: true, syncStatus: "synced" }),
      true,
    );
    expect(view.note).toEqual({
      tone: "muted",
      text: "En pause : les événements déjà connus continuent de bloquer tes créneaux.",
    });
    expect(calendarRowView(calendar(), true)).toEqual({ canEnable: true });
  });

  it("connection states", () => {
    expect(connectionState({ connection: null })).toBe("not_connected");
    const connection = {
      id: "x",
      accountEmail: null,
      lastSyncedAt: null,
      lastError: null,
      version: 1,
    };
    expect(
      connectionState({
        connection: { ...connection, status: "disconnected" },
      }),
    ).toBe("not_connected");
    expect(
      connectionState({ connection: { ...connection, status: "active" } }),
    ).toBe("active");
    expect(
      connectionState({
        connection: { ...connection, status: "reauth_required" },
      }),
    ).toBe("reauth_required");
  });
});

describe("back from Google", () => {
  it("every callback result has a human message; anything else is ignored", () => {
    const results: CallbackResult[] = [
      "connected",
      "write_authorized",
      "account_mismatch",
      "denied",
      "invalid_state",
      "scope_missing",
      "provider_unavailable",
      "not_configured",
      "disconnect_in_progress",
      "error",
    ];
    for (const result of results) {
      const notice = callbackNotice(result)!;
      expect(notice.title.length).toBeGreaterThan(0);
      expect(`${notice.title} ${notice.message}`).not.toMatch(TECHNICAL);
    }
    expect(callbackNotice("toString")).toBeNull();
    expect(callbackNotice("<script>")).toBeNull();
    expect(callbackNotice(null)).toBeNull();
  });
});
