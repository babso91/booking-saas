// @vitest-environment jsdom
import {
  act,
  cleanup as cleanupRender,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CalendarIntegrationStatusDto,
  ConnectedCalendarDto,
} from "@/features/calendar/data/connection";
import type { CalendarOutboundStatusDto } from "@/features/calendar/data/outbound";

import { CalendarSettings } from "./calendar-settings";

const actions = {
  getCalendarIntegrationStatusAction: vi.fn(),
  getCalendarOutboundStatusAction: vi.fn(),
  startGoogleCalendarConnectAction: vi.fn(),
  listConnectedCalendarsAction: vi.fn(),
  updateBlockingCalendarsAction: vi.fn(),
  disconnectGoogleCalendarAction: vi.fn(),
  startGoogleCalendarWriteAuthorizationAction: vi.fn(),
  enableCalendarOutboundAction: vi.fn(),
  reactivateCalendarOutboundAction: vi.fn(),
  disableCalendarOutboundAction: vi.fn(),
  retryCalendarOutboundAction: vi.fn(),
};

vi.mock("@/features/calendar/actions/calendar", () =>
  Object.fromEntries(
    Object.keys({
      getCalendarIntegrationStatusAction: 0,
      getCalendarOutboundStatusAction: 0,
      startGoogleCalendarConnectAction: 0,
      listConnectedCalendarsAction: 0,
      updateBlockingCalendarsAction: 0,
      disconnectGoogleCalendarAction: 0,
      startGoogleCalendarWriteAuthorizationAction: 0,
      enableCalendarOutboundAction: 0,
      reactivateCalendarOutboundAction: 0,
      disableCalendarOutboundAction: 0,
      retryCalendarOutboundAction: 0,
      syncGoogleCalendarNowAction: 0,
      listCalendarConflictsAction: 0,
    }).map((name) => [
      name,
      (...args: unknown[]) =>
        (actions as Record<string, (...input: unknown[]) => unknown>)[name]?.(
          ...args,
        ),
    ]),
  ),
);
const openGoogle = vi.fn();
vi.mock("../client/navigate", () => ({
  openGoogle: (url: string) => openGoogle(url),
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string) => ({
  ok: false as const,
  error: { code, message: "backend text never shown" },
});
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?state=x";

// ---------------------------------------------------------------------------
// DTOs exactly as the Server Actions return them
// ---------------------------------------------------------------------------

const calendar = (
  overrides: Partial<ConnectedCalendarDto> = {},
): ConnectedCalendarDto => ({
  id: "00000000-0000-4000-8000-000000000001",
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

const PERSO = calendar({
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Camille (perso)",
  primary: true,
  blocking: true,
  protecting: true,
  syncStatus: "synced",
});
const SPORT = calendar({
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "Sport",
});
const SHARED = calendar({
  id: "00000000-0000-4000-8000-0000000000a3",
  name: "Salon (partagé)",
  accessRole: "freeBusyReader",
  selectable: false,
});
const BOOKING = calendar({
  id: "00000000-0000-4000-8000-0000000000b0",
  name: "Rendez-vous — Studio Mila",
  accessRole: "owner",
  selectable: false,
  bookingCalendar: true,
});

function connected(
  overrides: Partial<CalendarIntegrationStatusDto> = {},
  status: "active" | "reauth_required" = "active",
): CalendarIntegrationStatusDto {
  return {
    provider: "google",
    available: true,
    connection: {
      id: "00000000-0000-4000-8000-0000000000c1",
      status,
      accountEmail: "camille@gmail.com",
      lastSyncedAt: null,
      lastError: null,
      version: 3,
    },
    calendars: [PERSO, SPORT, SHARED, BOOKING],
    ...overrides,
  };
}

const notConnected: CalendarIntegrationStatusDto = {
  provider: "google",
  available: true,
  connection: null,
  calendars: [],
};

function outbound(
  overrides: Partial<CalendarOutboundStatusDto> = {},
): CalendarOutboundStatusDto {
  return {
    provider: "google",
    available: true,
    googleConnected: true,
    writeAuthorized: true,
    enabled: false,
    state: "disabled",
    health: "disabled",
    calendarCreated: false,
    actionRequired: null,
    reason: null,
    pendingCount: 0,
    errorCount: 0,
    lastError: null,
    ...overrides,
  };
}

const HEALTHY = outbound({
  enabled: true,
  state: "active",
  health: "healthy",
  calendarCreated: true,
});

// ---------------------------------------------------------------------------

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

async function renderSettings(
  inbound: CalendarIntegrationStatusDto,
  appointments: CalendarOutboundStatusDto,
  callbackResult: string | null = null,
) {
  actions.getCalendarIntegrationStatusAction.mockResolvedValue(ok(inbound));
  actions.getCalendarOutboundStatusAction.mockResolvedValue(ok(appointments));
  const view = render(<CalendarSettings callbackResult={callbackResult} />);
  await flush();
  return view;
}

const button = (name: string | RegExp) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const section = (name: RegExp) => within(screen.getByRole("region", { name }));
const availability = () => section(/Éviter les doubles réservations/);
const appointments = () => section(/Ajouter mes rendez-vous à Google Calendar/);
const switchFor = (name: string) =>
  availability().getByRole("switch", {
    name: new RegExp(name),
  }) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
  openGoogle.mockReset();
  window.history.replaceState(null, "", "/app/settings/calendar");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("not connected", () => {
  it("one simple card, and the existing OAuth flow", async () => {
    await renderSettings(notConnected, outbound({ googleConnected: false }));
    expect(
      screen.getByRole("heading", { name: "Connecte ton agenda Google" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /éviter les doubles réservations et retrouver tes rendez-vous Booking/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: /Éviter les doubles/ }),
    ).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();

    let answer!: (value: unknown) => void;
    actions.startGoogleCalendarConnectAction.mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );
    fireEvent.click(button("Connecter Google Calendar"));
    fireEvent.click(button(/Connecter Google Calendar|Ouverture/));
    expect(actions.startGoogleCalendarConnectAction).toHaveBeenCalledTimes(1);

    answer(ok({ authorizationUrl: GOOGLE_URL }));
    await flush();
    expect(openGoogle).toHaveBeenCalledWith(GOOGLE_URL);
  });

  it("integration not configured on the server: a calm card, no button", async () => {
    await renderSettings(
      { ...notConnected, available: false },
      outbound({ available: false, googleConnected: false }),
    );
    expect(
      screen.getByRole("heading", { name: "Bientôt disponible" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connecter/ })).toBeNull();
  });
});

describe("Google → Booking: blocking calendars", () => {
  it("lists the calendars to choose, without Booking's own calendar", async () => {
    await renderSettings(connected(), outbound());
    expect(screen.getByText("camille@gmail.com")).toBeTruthy();

    const rows = availability().getAllByRole("switch");
    expect(rows).toHaveLength(3);
    expect(availability().queryByText("Rendez-vous — Studio Mila")).toBeNull();

    expect(switchFor("Camille").checked).toBe(true);
    expect(availability().getByText("Bloque tes créneaux")).toBeTruthy();
    expect(availability().getByText("Principal")).toBeTruthy();
    expect(switchFor("Sport").checked).toBe(false);
    expect(switchFor("Sport").disabled).toBe(false);
    expect(switchFor("Salon").disabled).toBe(true);
    expect(
      availability().getByText(/Partage seulement tes disponibilités/),
    ).toBeTruthy();
  });

  it("selecting sends the complete set through the existing action; the server's answer is shown", async () => {
    await renderSettings(connected(), outbound());
    let answer!: (value: unknown) => void;
    actions.updateBlockingCalendarsAction.mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );

    fireEvent.click(switchFor("Sport"));
    expect(actions.updateBlockingCalendarsAction).toHaveBeenCalledWith({
      calendarIds: [PERSO.id, SPORT.id],
    });
    // One change at a time, no optimistic flip.
    expect(switchFor("Sport").checked).toBe(false);
    expect(switchFor("Camille").disabled).toBe(true);
    fireEvent.click(switchFor("Camille"));
    expect(actions.updateBlockingCalendarsAction).toHaveBeenCalledTimes(1);

    answer(
      ok([
        PERSO,
        { ...SPORT, blocking: true, protecting: false },
        SHARED,
        BOOKING,
      ]),
    );
    await flush();
    expect(switchFor("Sport").checked).toBe(true);
    expect(availability().getByText("Activation en cours…")).toBeTruthy();
    expect(switchFor("Camille").disabled).toBe(false);
  });

  it("deselecting removes only that calendar", async () => {
    await renderSettings(connected(), outbound());
    actions.updateBlockingCalendarsAction.mockResolvedValue(
      ok([
        { ...PERSO, blocking: false, protecting: false },
        SPORT,
        SHARED,
        BOOKING,
      ]),
    );
    fireEvent.click(switchFor("Camille"));
    expect(actions.updateBlockingCalendarsAction).toHaveBeenCalledWith({
      calendarIds: [],
    });
    await flush();
    expect(switchFor("Camille").checked).toBe(false);
  });

  it("a margin is explained without alarm; Booking's calendar is never sent as blocking", async () => {
    await renderSettings(
      connected({
        calendars: [
          { ...PERSO, syncStatus: "degraded", lastError: "approximate_events" },
          SPORT,
          { ...BOOKING, blocking: true },
        ],
      }),
      outbound(),
    );
    expect(availability().getByText(/marge de sécurité/)).toBeTruthy();
    actions.updateBlockingCalendarsAction.mockResolvedValue(ok([PERSO, SPORT]));
    fireEvent.click(switchFor("Sport"));
    expect(actions.updateBlockingCalendarsAction).toHaveBeenCalledWith({
      calendarIds: [PERSO.id, SPORT.id],
    });
  });

  it("refreshes the list from Google on demand", async () => {
    await renderSettings(connected(), outbound());
    actions.listConnectedCalendarsAction.mockResolvedValue(
      ok([
        PERSO,
        SPORT,
        SHARED,
        BOOKING,
        calendar({
          id: "00000000-0000-4000-8000-0000000000a4",
          name: "Nouveau",
        }),
      ]),
    );
    fireEvent.click(button("Actualiser la liste"));
    expect(actions.listConnectedCalendarsAction).toHaveBeenCalledWith({
      refresh: true,
    });
    await flush();
    expect(switchFor("Nouveau")).toBeTruthy();
  });

  it("connection to renew: reconnect offered, selection locked", async () => {
    await renderSettings(
      connected({}, "reauth_required"),
      outbound({
        enabled: true,
        state: "active",
        health: "action_required",
        actionRequired: "reconnect",
        reason: "reauth_required",
      }),
    );
    expect(screen.getByText("Connexion à renouveler")).toBeTruthy();
    expect(availability().queryByText("Bloque tes créneaux")).toBeNull();
    expect(availability().getAllByText(/En pause/).length).toBe(1);
    availability()
      .getAllByRole("switch")
      .forEach((item) =>
        expect((item as HTMLInputElement).disabled).toBe(true),
      );
    actions.startGoogleCalendarConnectAction.mockResolvedValue(
      ok({ authorizationUrl: GOOGLE_URL }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Reconnecter Google" })[0]!,
    );
    await flush();
    expect(openGoogle).toHaveBeenCalledWith(GOOGLE_URL);
  });
});

describe("Booking → Google: appointments", () => {
  it("disabled: enable; without the write scope yet, the incremental consent opens", async () => {
    await renderSettings(connected(), outbound({ writeAuthorized: false }));
    expect(
      appointments().getByText(
        "Ajoute automatiquement tes rendez-vous à Google Calendar",
      ),
    ).toBeTruthy();
    expect(
      appointments().getByText(
        /un calendrier séparé, réservé à tes rendez-vous/,
      ),
    ).toBeTruthy();
    expect(appointments().queryByRole("combobox")).toBeNull(); // no destination to choose
    actions.enableCalendarOutboundAction.mockResolvedValue(
      ok({
        status: outbound({ writeAuthorized: false }),
        authorizationUrl: GOOGLE_URL,
      }),
    );
    fireEvent.click(button("Activer la synchronisation"));
    await flush();
    expect(openGoogle).toHaveBeenCalledWith(GOOGLE_URL);
    expect(actions.startGoogleCalendarConnectAction).not.toHaveBeenCalled();
  });

  it("enable with the scope already granted: the server's status (pending) is shown, then re-read gently", async () => {
    await renderSettings(connected(), outbound());
    const creating = outbound({
      enabled: true,
      state: "creating",
      health: "pending",
    });
    actions.enableCalendarOutboundAction.mockResolvedValue(
      ok({ status: creating, authorizationUrl: null }),
    );
    actions.getCalendarOutboundStatusAction.mockResolvedValue(ok(creating));
    fireEvent.click(button("Activer la synchronisation"));
    await flush();
    expect(
      appointments().getByText("Préparation de ton calendrier Google…"),
    ).toBeTruthy();
    expect(openGoogle).not.toHaveBeenCalled();
    const reads = () =>
      actions.getCalendarOutboundStatusAction.mock.calls.length;
    const before = reads();

    actions.getCalendarOutboundStatusAction.mockResolvedValue(ok(HEALTHY));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads()).toBe(before + 1);
    expect(appointments().getByText("Synchronisation active")).toBeTruthy();
    // Settled: no more reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(reads()).toBe(before + 1);
  });

  it("pending never loops: at most a handful of reads, further and further apart", async () => {
    const creating = outbound({
      enabled: true,
      state: "creating",
      health: "pending",
    });
    await renderSettings(connected(), creating);
    for (let minute = 0; minute < 60; minute += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    // 3 s, 8 s, 20 s, 45 s, 90 s after the first read; then nothing.
    expect(actions.getCalendarOutboundStatusAction.mock.calls.length).toBe(
      1 + 5,
    );
  });

  it("write authorization required: a normal step, not an error", async () => {
    await renderSettings(
      connected(),
      outbound({
        enabled: true,
        state: "active",
        health: "action_required",
        actionRequired: "authorize_write",
        reason: "write_authorization_required",
        writeAuthorized: false,
      }),
    );
    expect(appointments().getByText("Autorisation nécessaire")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    actions.startGoogleCalendarWriteAuthorizationAction.mockResolvedValue(
      ok({ authorizationUrl: GOOGLE_URL }),
    );
    fireEvent.click(button("Autoriser l’ajout des rendez-vous"));
    await flush();
    expect(openGoogle).toHaveBeenCalledWith(GOOGLE_URL);
  });

  it("healthy: active, the dedicated calendar managed by Booking, nothing technical", async () => {
    await renderSettings(connected(), { ...HEALTHY, pendingCount: 0 });
    expect(appointments().getByText("Synchronisation active")).toBeTruthy();
    expect(
      appointments().getByText("Calendrier de rendez-vous Booking"),
    ).toBeTruthy();
    expect(appointments().getByText("Géré par Booking")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(
      /calendar_|generation|token|scope|00000000-|pendingCount|errorCount/,
    );
  });

  it("retrying: delayed, appointments safe, retry now through the action", async () => {
    await renderSettings(
      connected(),
      outbound({
        ...HEALTHY,
        health: "retrying",
        errorCount: 2,
        lastError: "provider_unavailable",
      }),
    );
    expect(
      appointments().getByText("Synchronisation temporairement retardée"),
    ).toBeTruthy();
    expect(
      appointments().getByText(/bien enregistrés dans Booking/),
    ).toBeTruthy();
    expect(screen.queryByText(/provider_unavailable|2 erreurs/)).toBeNull();
    actions.retryCalendarOutboundAction.mockResolvedValue(ok(HEALTHY));
    fireEvent.click(button("Réessayer maintenant"));
    await flush();
    expect(actions.retryCalendarOutboundAction).toHaveBeenCalledTimes(1);
    expect(appointments().getByText("Synchronisation active")).toBeTruthy();
  });

  it("action required — reconnect", async () => {
    await renderSettings(
      connected(),
      outbound({
        enabled: true,
        state: "active",
        health: "action_required",
        actionRequired: "reconnect",
        reason: "reauth_required",
      }),
    );
    expect(appointments().getByText("Reconnecte Google Calendar")).toBeTruthy();
    actions.startGoogleCalendarConnectAction.mockResolvedValue(
      ok({ authorizationUrl: GOOGLE_URL }),
    );
    fireEvent.click(
      appointments().getByRole("button", { name: "Reconnecter Google" }),
    );
    await flush();
    expect(openGoogle).toHaveBeenCalledWith(GOOGLE_URL);
  });

  it.each([
    ["calendar_deleted", "Ton calendrier Booking a été supprimé"],
    [
      "calendar_creation_uncertain",
      "La configuration du calendrier doit être reprise",
    ],
  ] as const)(
    "action required — reactivate (%s): explicit, never automatic",
    async (reason, title) => {
      await renderSettings(
        connected(),
        outbound({
          enabled: true,
          state: "action_required",
          health: "action_required",
          actionRequired: "reactivate",
          reason,
          calendarCreated: false,
        }),
      );
      expect(appointments().getByText(title)).toBeTruthy();
      expect(
        appointments().getByText(
          /rendez-vous Booking sont intacts|restent intacts dans Booking/,
        ),
      ).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(actions.reactivateCalendarOutboundAction).not.toHaveBeenCalled();

      const pending = outbound({
        enabled: true,
        state: "creating",
        health: "pending",
      });
      actions.reactivateCalendarOutboundAction.mockResolvedValue(
        ok({ status: pending, authorizationUrl: null }),
      );
      actions.getCalendarOutboundStatusAction.mockResolvedValue(ok(pending));
      fireEvent.click(button("Réactiver la synchronisation"));
      await flush();
      expect(actions.reactivateCalendarOutboundAction).toHaveBeenCalledTimes(1);
      expect(
        appointments().getByText("Préparation de ton calendrier Google…"),
      ).toBeTruthy();
    },
  );

  it("another Google account: enable again", async () => {
    await renderSettings(
      connected(),
      outbound({ actionRequired: "enable_again", reason: "account_changed" }),
    );
    expect(
      appointments().getByText("Nouveau compte Google connecté"),
    ).toBeTruthy();
    actions.enableCalendarOutboundAction.mockResolvedValue(
      ok({ status: HEALTHY, authorizationUrl: null }),
    );
    fireEvent.click(button("Réactiver"));
    await flush();
    expect(actions.enableCalendarOutboundAction).toHaveBeenCalledTimes(1);
  });

  it("inbound fine while outbound needs an action: two separate states, no global error", async () => {
    await renderSettings(
      connected(),
      outbound({
        enabled: true,
        state: "action_required",
        health: "action_required",
        actionRequired: "reactivate",
        reason: "calendar_deleted",
      }),
    );
    expect(screen.getByText("Google Calendar connecté")).toBeTruthy();
    expect(availability().getByText("Bloque tes créneaux")).toBeTruthy();
    expect(
      appointments().getByText("Ton calendrier Booking a été supprimé"),
    ).toBeTruthy();
    expect(screen.queryByText(/Google Calendar en erreur/)).toBeNull();
  });
});

describe("disable and disconnect", () => {
  it("disabling asks first, keeps Google → Booking, and is not a disconnection", async () => {
    await renderSettings(connected(), HEALTHY);
    fireEvent.click(button("Désactiver l’ajout des rendez-vous"));
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByText(/Tes rendez-vous resteront dans Booking/),
    ).toBeTruthy();
    expect(
      dialog.getByText(/continueront de bloquer tes disponibilités/),
    ).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: "Retour" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.disableCalendarOutboundAction).not.toHaveBeenCalled();

    fireEvent.click(button("Désactiver l’ajout des rendez-vous"));
    actions.disableCalendarOutboundAction.mockResolvedValue(ok(outbound()));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Désactiver",
      }),
    );
    await flush();
    expect(actions.disableCalendarOutboundAction).toHaveBeenCalledTimes(1);
    expect(actions.disconnectGoogleCalendarAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appointments().getByText("Activer la synchronisation")).toBeTruthy();
    expect(availability().getAllByRole("switch")).toHaveLength(3);
  });

  it("disconnecting asks first, with what it does and does not do", async () => {
    await renderSettings(connected(), HEALTHY);
    fireEvent.click(button("Déconnecter Google Calendar"));
    const dialog = within(
      screen.getByRole("dialog", { name: "Déconnecter Google Calendar ?" }),
    );
    expect(
      dialog.getByText(/ne bloqueront plus tes disponibilités/),
    ).toBeTruthy();
    expect(
      dialog.getByText(/n’enverra plus tes nouveaux changements/),
    ).toBeTruthy();
    expect(
      dialog.getByText(/Tes rendez-vous Booking restent intacts/),
    ).toBeTruthy();
    expect(dialog.getByText(/peuvent rester visibles/)).toBeTruthy();

    actions.disconnectGoogleCalendarAction.mockResolvedValue(
      ok({ disconnected: true }),
    );
    actions.getCalendarIntegrationStatusAction.mockResolvedValue(
      ok(notConnected),
    );
    actions.getCalendarOutboundStatusAction.mockResolvedValue(
      ok(outbound({ googleConnected: false })),
    );
    fireEvent.click(dialog.getByRole("button", { name: "Déconnecter" }));
    await flush();
    expect(actions.disconnectGoogleCalendarAction).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Connecte ton agenda Google" }),
    ).toBeTruthy();
  });
});

describe("errors and the way back from Google", () => {
  it("a failed Server Action: short human message, no code, appointments reassured", async () => {
    await renderSettings(connected(), outbound());
    actions.enableCalendarOutboundAction.mockResolvedValue(
      fail("calendar_provider_unavailable"),
    );
    fireEvent.click(button("Activer la synchronisation"));
    await flush();
    const alert = within(appointments().getByRole("alert"));
    expect(alert.getByText("Google ne répond pas")).toBeTruthy();
    expect(
      alert.getByText(/Tes rendez-vous Booking ne sont pas affectés/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /calendar_provider_unavailable|backend text|503/,
    );
    // The button is usable again.
    expect(button("Activer la synchronisation").disabled).toBe(false);
  });

  it("a failed calendar change is reported in its own section", async () => {
    await renderSettings(connected(), HEALTHY);
    actions.updateBlockingCalendarsAction.mockResolvedValue(
      fail("calendar_not_selectable"),
    );
    fireEvent.click(switchFor("Sport"));
    await flush();
    expect(availability().getByRole("alert").textContent).toMatch(
      /ne peut pas bloquer tes créneaux/,
    );
    expect(appointments().queryByRole("alert")).toBeNull();
  });

  it("an expired session offers to sign in again", async () => {
    await renderSettings(connected(), HEALTHY);
    actions.retryCalendarOutboundAction.mockResolvedValue(
      fail("unauthenticated"),
    );
    actions.disableCalendarOutboundAction.mockResolvedValue(
      fail("unauthenticated"),
    );
    fireEvent.click(button("Désactiver l’ajout des rendez-vous"));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Désactiver",
      }),
    );
    await flush();
    expect(
      screen.getByRole("link", { name: "Me reconnecter" }).getAttribute("href"),
    ).toBe("/login");
  });

  it("loading failure: retry", async () => {
    actions.getCalendarIntegrationStatusAction.mockResolvedValue(
      fail("internal"),
    );
    actions.getCalendarOutboundStatusAction.mockResolvedValue(fail("internal"));
    render(<CalendarSettings callbackResult={null} />);
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();
    actions.getCalendarIntegrationStatusAction.mockResolvedValue(
      ok(notConnected),
    );
    actions.getCalendarOutboundStatusAction.mockResolvedValue(ok(outbound()));
    fireEvent.click(button("Réessayer"));
    await flush();
    expect(
      screen.getByRole("heading", { name: "Connecte ton agenda Google" }),
    ).toBeTruthy();
  });

  it("back from Google: the result is shown once; only its parameter leaves the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/app/settings/calendar?calendar=connected&keep=1#availability",
    );
    await renderSettings(connected(), HEALTHY, "connected");
    expect(screen.getByText("Google Calendar est connecté")).toBeTruthy();
    const { pathname, search, hash } = window.location;
    expect(`${pathname}${search}${hash}`).toBe(
      "/app/settings/calendar?keep=1#availability",
    );
    fireEvent.click(button("Compris"));
    expect(screen.queryByText("Google Calendar est connecté")).toBeNull();
  });

  it("an unknown result in the address shows nothing", async () => {
    await renderSettings(connected(), HEALTHY, "<b>hello</b>");
    expect(screen.queryByText(/hello/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Codex fix round 1
// ---------------------------------------------------------------------------

const TRAVAIL = calendar({
  id: "00000000-0000-4000-8000-0000000000a5",
  name: "Travail",
});
const ONLY_PERSO = connected({ calendars: [PERSO, SPORT, TRAVAIL, BOOKING] });
const on = (item: ConnectedCalendarDto) => ({
  ...item,
  blocking: true,
  protecting: true,
  syncStatus: "synced" as const,
});

/** A refresh read (back on the tab) whose answer the test releases. */
async function heldRefresh() {
  let release!: (value: unknown) => void;
  actions.getCalendarIntegrationStatusAction.mockReturnValueOnce(
    new Promise((resolve) => (release = resolve)),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000); // past the wake-up interval
  });
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  return release;
}

describe("a read never overwrites a more recent action or read", () => {
  it("Codex: read [Perso] → Sport ON confirmed → the read answers late → Travail ON sends [Perso, Sport, Travail]", async () => {
    await renderSettings(ONLY_PERSO, HEALTHY);
    const reads = actions.getCalendarIntegrationStatusAction.mock.calls.length;
    const lateRead = await heldRefresh(); // R1: started with only Perso
    expect(actions.getCalendarIntegrationStatusAction.mock.calls.length).toBe(
      reads + 1,
    );

    actions.updateBlockingCalendarsAction.mockResolvedValueOnce(
      ok([PERSO, on(SPORT), TRAVAIL, BOOKING]),
    );
    fireEvent.click(switchFor("Sport")); // M
    await flush();
    expect(switchFor("Sport").checked).toBe(true);

    lateRead(ok(ONLY_PERSO)); // R1 answers: [Perso]
    await flush();
    expect(switchFor("Sport").checked).toBe(true);

    actions.updateBlockingCalendarsAction.mockResolvedValueOnce(
      ok([PERSO, on(SPORT), on(TRAVAIL), BOOKING]),
    );
    fireEvent.click(switchFor("Travail"));
    expect(actions.updateBlockingCalendarsAction).toHaveBeenLastCalledWith({
      calendarIds: [PERSO.id, SPORT.id, TRAVAIL.id],
    });
    expect(actions.updateBlockingCalendarsAction).not.toHaveBeenCalledWith({
      calendarIds: [PERSO.id, TRAVAIL.id],
    });
  });

  it("a read sent while the action runs, answered after it, is ignored too", async () => {
    await renderSettings(ONLY_PERSO, HEALTHY);
    let confirm!: (value: unknown) => void;
    actions.updateBlockingCalendarsAction.mockReturnValueOnce(
      new Promise((resolve) => (confirm = resolve)),
    );
    fireEvent.click(switchFor("Sport"));
    const duringRead = await heldRefresh(); // sent during the action

    confirm(ok([PERSO, on(SPORT), TRAVAIL, BOOKING]));
    await flush();
    duringRead(ok(ONLY_PERSO)); // possibly served before the action committed
    await flush();
    expect(switchFor("Sport").checked).toBe(true);
  });

  it("an action that fails does not let an older read through either", async () => {
    await renderSettings(
      connected({ calendars: [PERSO, SPORT, BOOKING] }),
      HEALTHY,
    );
    const oldRead = await heldRefresh();
    actions.updateBlockingCalendarsAction.mockResolvedValueOnce(
      fail("calendar_provider_unavailable"),
    );
    fireEvent.click(switchFor("Sport"));
    await flush();
    oldRead(
      ok(connected({ calendars: [{ ...PERSO, blocking: false }, SPORT] })),
    );
    await flush();
    // The screen keeps what it had; the failure is reported.
    expect(switchFor("Camille").checked).toBe(true);
    expect(availability().getByRole("alert")).toBeTruthy();
  });

  it("read A, then read B; B answers first, A late: A never replaces B", async () => {
    await renderSettings(ONLY_PERSO, HEALTHY);
    const readA = await heldRefresh();
    const readB = await heldRefresh();

    readB(ok(connected({ calendars: [PERSO, on(SPORT), TRAVAIL, BOOKING] })));
    await flush();
    expect(switchFor("Sport").checked).toBe(true);

    readA(ok(ONLY_PERSO));
    await flush();
    expect(switchFor("Sport").checked).toBe(true);
  });
});

describe("a failure inside an open confirmation stays in the dialog", () => {
  it.each([
    [
      "disable",
      "Désactiver l’ajout des rendez-vous",
      "Désactiver",
      "disableCalendarOutboundAction",
    ],
    [
      "disconnect",
      "Déconnecter Google Calendar",
      "Déconnecter",
      "disconnectGoogleCalendarAction",
    ],
  ] as const)(
    "%s fails: the error and its actions are in the dialog, usable by keyboard",
    async (_label, open, confirmLabel, action) => {
      await renderSettings(connected(), HEALTHY);
      fireEvent.click(button(open));
      actions[action].mockResolvedValueOnce(
        fail("calendar_provider_unavailable"),
      );
      const dialog = screen.getByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: confirmLabel }),
      );
      await flush();

      // Still open, the error inside it, nothing behind the inert page.
      expect(screen.getByRole("dialog")).toBe(dialog);
      const alert = within(dialog).getByRole("alert");
      expect(alert.textContent).toMatch(/Google ne répond pas/);
      for (const element of screen.queryAllByRole("alert")) {
        expect(dialog.contains(element)).toBe(true);
        expect(element.closest("[inert]")).toBeNull();
      }

      // Retry and Retour reachable from the keyboard.
      const retry = within(dialog).getByRole("button", { name: confirmLabel });
      const back = within(dialog).getByRole("button", { name: "Retour" });
      for (const control of [retry, back]) {
        expect((control as HTMLButtonElement).disabled).toBe(false);
        control.focus();
        expect(document.activeElement).toBe(control);
      }

      // A retry that works closes the dialog.
      actions[action].mockResolvedValueOnce(
        action === "disableCalendarOutboundAction"
          ? ok(outbound())
          : ok({ disconnected: true }),
      );
      fireEvent.click(retry);
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("an expired session inside the dialog: the sign-in link is in the dialog, not behind it", async () => {
    await renderSettings(connected(), HEALTHY);
    fireEvent.click(button("Déconnecter Google Calendar"));
    actions.disconnectGoogleCalendarAction.mockResolvedValueOnce(
      fail("unauthenticated"),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Déconnecter" }),
    );
    await flush();
    const links = screen.getAllByRole("link", { name: "Me reconnecter" });
    expect(links).toHaveLength(1);
    expect(dialog.contains(links[0]!)).toBe(true);
    expect(links[0]!.closest("[inert]")).toBeNull();
  });
});

describe("a later read that fails keeps the last known state, with a warning", () => {
  it("stale but usable, retry, then the warning goes away", async () => {
    await renderSettings(connected(), HEALTHY);
    actions.getCalendarIntegrationStatusAction.mockResolvedValueOnce(
      fail("internal"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();

    expect(
      screen.getByText("Impossible d’actualiser Google Calendar"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Les informations affichées sont les dernières connues.",
      ),
    ).toBeTruthy();
    // The last known state is still there and usable.
    expect(appointments().getByText("Synchronisation active")).toBeTruthy();
    expect(switchFor("Camille").checked).toBe(true);
    expect(switchFor("Sport").disabled).toBe(false);

    actions.getCalendarIntegrationStatusAction.mockResolvedValue(
      ok(connected()),
    );
    fireEvent.click(button("Réessayer"));
    await flush();
    expect(
      screen.queryByText("Impossible d’actualiser Google Calendar"),
    ).toBeNull();
  });
});

describe("the dedicated calendar is not given a made-up name", () => {
  it("whatever the business is called now, no 'Rendez-vous — <name>' is shown", async () => {
    // Created as "Rendez-vous — Studio A"; the business is now "Studio B".
    await renderSettings(connected(), HEALTHY);
    expect(
      appointments().getByText("Calendrier de rendez-vous Booking"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Rendez-vous —/);
  });
});

describe("the 'nothing to do' promise follows the real state", () => {
  const PROMISE = /Booking n’a besoin d’aucune autre action de ta part/;
  const required = (
    actionRequired: CalendarOutboundStatusDto["actionRequired"],
  ) =>
    outbound({
      enabled: true,
      state: "action_required",
      health: "action_required",
      actionRequired,
      reason: null,
    });

  it("shown when everything is automatic (healthy, retrying)", async () => {
    await renderSettings(connected(), HEALTHY);
    expect(screen.getByText(PROMISE)).toBeTruthy();
    cleanupRender();
    await renderSettings(
      connected(),
      outbound({ ...HEALTHY, health: "retrying", errorCount: 1 }),
    );
    expect(screen.getByText(PROMISE)).toBeTruthy();
  });

  it.each(["reconnect", "reactivate", "authorize_write"] as const)(
    "never with %s",
    async (actionRequired) => {
      await renderSettings(connected(), required(actionRequired));
      expect(screen.queryByText(PROMISE)).toBeNull();
      // Disconnecting stays available.
      expect(button("Déconnecter Google Calendar")).toBeTruthy();
    },
  );

  it("never while the Google connection must be renewed", async () => {
    await renderSettings(connected({}, "reauth_required"), HEALTHY);
    expect(screen.queryByText(PROMISE)).toBeNull();
  });
});
