"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  AlertIcon,
  CalendarIcon,
  CalendarSyncIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  disableCalendarOutboundAction,
  disconnectGoogleCalendarAction,
  enableCalendarOutboundAction,
  getCalendarIntegrationStatusAction,
  getCalendarOutboundStatusAction,
  listConnectedCalendarsAction,
  reactivateCalendarOutboundAction,
  retryCalendarOutboundAction,
  startGoogleCalendarConnectAction,
  startGoogleCalendarWriteAuthorizationAction,
  updateBlockingCalendarsAction,
} from "@/features/calendar/actions/calendar";
import type {
  CalendarIntegrationStatusDto,
  ConnectedCalendarDto,
} from "@/features/calendar/data/connection";
import type { CalendarOutboundStatusDto } from "@/features/calendar/data/outbound";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/cn";

import { openGoogle } from "../client/navigate";
import {
  blockingCandidates,
  bookingCalendarName,
  calendarRowView,
  callbackNotice,
  connectionState,
  outboundView,
  type CalendarRowView,
  type OutboundCta,
  type OutboundView,
} from "../client/settings-copy";

const SETTINGS_PATH = "/app/settings/calendar";

/** Gentle re-reads while something settles server-side: no polling loop. */
const SETTLE_DELAYS = [3_000, 8_000, 20_000, 45_000, 90_000];
/** Coming back to the tab re-reads, at most this often. */
const WAKE_MIN_INTERVAL = 15_000;

type Busy =
  | "connect"
  | "reconnect"
  | "enable"
  | "reactivate"
  | "authorize_write"
  | "retry"
  | "disable"
  | "disconnect"
  | "refresh"
  | `calendar:${string}`;

type Failure = {
  where: "connection" | "availability" | "appointments";
  error: UiError;
};

/**
 * Google Calendar settings. Two separate functions under one connection:
 * calendars that block Booking availability (Google → Booking) and Booking
 * appointments copied to a calendar Booking creates (Booking → Google).
 * Their states are never merged into one badge. The server is the
 * authority: no optimistic transition, every action re-reads its answer.
 */
export function CalendarSettings({
  businessName,
  callbackResult,
}: {
  businessName: string;
  callbackResult: string | null;
}) {
  const router = useRouter();
  const [inbound, setInbound] = useState<CalendarIntegrationStatusDto | null>(
    null,
  );
  const [outbound, setOutbound] = useState<CalendarOutboundStatusDto | null>(
    null,
  );
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirm, setConfirm] = useState<"disable" | "disconnect" | null>(null);
  const [notice, setNotice] = useState(() => callbackNotice(callbackResult));
  const [settleStep, setSettleStep] = useState(0);

  const alive = useRef(true);
  const busyRef = useRef<Busy | null>(null);
  const lastLoad = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The result of the OAuth round trip is shown once: drop it from the URL.
  useEffect(() => {
    if (callbackResult) router.replace(SETTINGS_PATH, { scroll: false });
  }, [callbackResult, router]);

  const apply = useCallback(
    ([connection, appointments]: Awaited<ReturnType<typeof readStatuses>>) => {
      if (!alive.current) return;
      if (connection.ok) setInbound(connection.data);
      if (appointments.ok) setOutbound(appointments.data);
      setLoadError(
        !connection.ok
          ? connection.error
          : !appointments.ok
            ? appointments.error
            : null,
      );
    },
    [],
  );

  const load = useCallback(() => {
    lastLoad.current = Date.now();
    return readStatuses().then(apply);
  }, [apply]);

  useEffect(() => {
    lastLoad.current = Date.now();
    void readStatuses().then(apply);
  }, [apply]);

  // Something is on its way server-side (dedicated calendar being created,
  // a calendar's first sync): read again a few times, further and further
  // apart, then stop. Any new action starts the sequence again.
  const settling =
    outbound?.health === "pending" ||
    (inbound?.calendars ?? []).some(
      (calendar) =>
        calendar.blocking &&
        !calendar.bookingCalendar &&
        (!calendar.protecting ||
          calendar.syncStatus === "pending" ||
          calendar.syncStatus === "syncing"),
    );
  useEffect(() => {
    if (!settling || settleStep >= SETTLE_DELAYS.length) return;
    const timer = window.setTimeout(() => {
      setSettleStep((step) => step + 1);
      void load();
    }, SETTLE_DELAYS[settleStep]);
    return () => window.clearTimeout(timer);
  }, [settling, settleStep, load]);

  // Back on the tab (after a while in Google, for instance): read again.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastLoad.current < WAKE_MIN_INTERVAL) return;
      void load();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [load]);

  /**
   * Runs one server action at a time (double clicks and overlapping
   * transitions are refused). `navigates`: success leaves for Google, so the
   * button stays busy until the page changes.
   */
  async function run<T>(
    name: Busy,
    where: Failure["where"],
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void | "navigating" | Promise<void>,
  ) {
    if (busyRef.current) return;
    busyRef.current = name;
    setBusy(name);
    setFailure(null);
    setNotice(null);
    const result = await callAction(action);
    if (!alive.current) return;
    const outcome = result.ok ? await onSuccess(result.data) : undefined;
    if (!result.ok) setFailure({ where, error: result.error });
    if (outcome === "navigating") return;
    busyRef.current = null;
    setBusy(null);
  }

  const settleAgain = () => setSettleStep(0);

  const connect = (name: "connect" | "reconnect", where: Failure["where"]) =>
    run(
      name,
      where,
      () => startGoogleCalendarConnectAction(),
      (data) => {
        openGoogle(data.authorizationUrl);
        return "navigating";
      },
    );

  function enableLike(name: "enable" | "reactivate") {
    return run(
      name,
      "appointments",
      () =>
        name === "enable"
          ? enableCalendarOutboundAction()
          : reactivateCalendarOutboundAction(),
      (data) => {
        if (data.authorizationUrl) {
          openGoogle(data.authorizationUrl);
          return "navigating";
        }
        setOutbound(data.status);
        settleAgain();
      },
    );
  }

  function outboundAction(cta: OutboundCta) {
    switch (cta) {
      case "enable":
        return enableLike("enable");
      case "reactivate":
        return enableLike("reactivate");
      case "authorize_write":
        return run(
          "authorize_write",
          "appointments",
          () => startGoogleCalendarWriteAuthorizationAction(),
          (data) => {
            openGoogle(data.authorizationUrl);
            return "navigating";
          },
        );
      case "reconnect":
        return connect("reconnect", "appointments");
      case "retry":
        return run(
          "retry",
          "appointments",
          () => retryCalendarOutboundAction(),
          (data) => {
            setOutbound(data);
            settleAgain();
          },
        );
    }
  }

  function toggleCalendar(calendar: ConnectedCalendarDto, on: boolean) {
    if (!inbound) return;
    const ids = blockingCandidates(inbound.calendars)
      .filter((item) => item.blocking && item.id !== calendar.id)
      .map((item) => item.id);
    if (on) ids.push(calendar.id);
    return run(
      `calendar:${calendar.id}`,
      "availability",
      () => updateBlockingCalendarsAction({ calendarIds: ids }),
      (calendars) => {
        setInbound((value) => (value ? { ...value, calendars } : value));
        settleAgain();
      },
    );
  }

  const refreshList = () =>
    run(
      "refresh",
      "availability",
      () => listConnectedCalendarsAction({ refresh: true }),
      (calendars) => {
        setInbound((value) => (value ? { ...value, calendars } : value));
        settleAgain();
      },
    );

  const disable = () =>
    run(
      "disable",
      "appointments",
      () => disableCalendarOutboundAction(),
      (data) => {
        setOutbound(data);
        setConfirm(null);
      },
    );

  const disconnect = () =>
    run(
      "disconnect",
      "connection",
      () => disconnectGoogleCalendarAction(),
      async () => {
        setConfirm(null);
        await load();
      },
    );

  const errorFor = (where: Failure["where"]) =>
    failure?.where === where ? (
      <ActionError
        error={failure.error}
        reassure={where !== "availability"}
        onDismiss={() => setFailure(null)}
      />
    ) : null;

  const state = inbound ? connectionState(inbound) : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-5 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
            Google Calendar
          </h1>
          <p className="text-[15px] text-ink-soft">
            Synchronise tes disponibilités et tes rendez-vous avec Google
            Calendar.
          </p>
        </header>

        {notice ? (
          <Notice
            tone={notice.tone}
            title={notice.title}
            action={
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
              >
                Compris
              </button>
            }
          >
            {notice.message}
          </Notice>
        ) : null}

        {!inbound ? (
          loadError ? (
            <ActionError error={loadError} reassure retry={() => void load()} />
          ) : (
            <SettingsSkeleton />
          )
        ) : !inbound.available ? (
          <Card>
            <CardIcon tone="idle">
              <CalendarSyncIcon size={22} />
            </CardIcon>
            <h2 className="font-display text-[24px] leading-tight text-ink">
              Bientôt disponible
            </h2>
            <p className="text-[15px] text-ink-soft">
              La synchronisation avec Google Calendar n’est pas encore activée
              pour ton espace.
            </p>
          </Card>
        ) : state === "not_connected" ? (
          <Card>
            <CardIcon tone="idle">
              <CalendarSyncIcon size={22} />
            </CardIcon>
            <h2 className="font-display text-[26px] leading-tight text-ink">
              Connecte ton agenda Google
            </h2>
            <p className="text-[15px] text-ink-soft">
              Connecte Google Calendar pour éviter les doubles réservations et
              retrouver tes rendez-vous Booking dans ton agenda Google.
            </p>
            {errorFor("connection")}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:gap-4">
              <Button
                size="md"
                state={busy === "connect" ? "loading" : "idle"}
                loadingLabel="Ouverture de Google…"
                disabled={busy !== null && busy !== "connect"}
                onClick={() => void connect("connect", "connection")}
              >
                Connecter Google Calendar
              </Button>
              <p className="text-[13.5px] text-ink-muted">
                Ton calendrier personnel n’est jamais modifié.
              </p>
            </div>
          </Card>
        ) : (
          <>
            <ConnectionCard
              email={inbound.connection?.accountEmail ?? null}
              reauth={state === "reauth_required"}
              busy={busy}
              onReconnect={() => void connect("reconnect", "connection")}
              error={errorFor("connection")}
            />

            <AvailabilitySection
              calendars={blockingCandidates(inbound.calendars)}
              locked={state === "reauth_required"}
              busy={busy}
              onToggle={(calendar, on) => void toggleCalendar(calendar, on)}
              onRefresh={() => void refreshList()}
              error={errorFor("availability")}
            />

            <AppointmentsSection
              status={outbound}
              businessName={businessName}
              busy={busy}
              onAction={(cta) => void outboundAction(cta)}
              onDisable={() => setConfirm("disable")}
              onReload={() => void load()}
              error={errorFor("appointments")}
            />

            <section
              aria-label="Compte Google"
              className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-[13.5px] text-ink-muted">
                Booking n’a besoin d’aucune autre action de ta part : tout se
                met à jour automatiquement.
              </p>
              <button
                type="button"
                onClick={() => setConfirm("disconnect")}
                disabled={busy !== null}
                className="w-fit shrink-0 cursor-pointer text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                Déconnecter Google Calendar
              </button>
            </section>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm === "disable"}
        title="Désactiver l’ajout des rendez-vous ?"
        description="Tes rendez-vous resteront dans Booking. Les événements déjà présents dans Google Calendar peuvent rester visibles."
        confirmLabel="Désactiver"
        state={busy === "disable" ? "loading" : "idle"}
        onConfirm={() => void disable()}
        onCancel={() => setConfirm(null)}
      >
        <p className="text-[14px] text-ink-muted">
          Tes calendriers Google continueront de bloquer tes disponibilités.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "disconnect"}
        title="Déconnecter Google Calendar ?"
        confirmLabel="Déconnecter"
        state={busy === "disconnect" ? "loading" : "idle"}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirm(null)}
      >
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14.5px] text-ink-soft marker:text-ink-muted">
          <li>Tes calendriers Google ne bloqueront plus tes disponibilités.</li>
          <li>Booking n’enverra plus tes nouveaux changements vers Google.</li>
          <li>Tes rendez-vous Booking restent intacts.</li>
          <li>
            Des événements déjà ajoutés à Google Calendar peuvent rester
            visibles.
          </li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Both states, read together: connection + calendars, and appointments. */
function readStatuses() {
  return Promise.all([
    callAction(() => getCalendarIntegrationStatusAction()),
    callAction(() => getCalendarOutboundStatusAction()),
  ]);
}

function Card({
  children,
  className,
  ...props
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "flex animate-rise flex-col gap-3 rounded-3xl border border-line bg-paper-raised p-5 shadow-[0_18px_40px_-34px_rgba(35,28,24,0.45)] sm:p-6",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

const iconTones = {
  idle: "bg-sand text-ink-soft",
  progress: "bg-sand text-ink-soft",
  active: "bg-success-soft text-success",
  delayed: "bg-sand text-ink-soft",
  action: "bg-warning-soft text-[#6b4613]",
} as const;

function CardIcon({
  tone,
  children,
}: {
  tone: keyof typeof iconTones;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-2xl",
        iconTones[tone],
      )}
    >
      {children}
    </span>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[12px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
        {eyebrow}
      </p>
      <h2
        id={id}
        className="font-display text-[24px] leading-tight text-ink sm:text-[26px]"
      >
        {title}
      </h2>
      <div className="text-[15px] text-ink-soft">{children}</div>
    </div>
  );
}

function ConnectionCard({
  email,
  reauth,
  busy,
  onReconnect,
  error,
}: {
  email: string | null;
  reauth: boolean;
  busy: Busy | null;
  onReconnect: () => void;
  error: ReactNode;
}) {
  return (
    <Card aria-label="Connexion Google">
      <div className="flex items-center gap-3.5">
        <CardIcon tone={reauth ? "action" : "active"}>
          {reauth ? <AlertIcon size={20} /> : <CheckIcon size={20} />}
        </CardIcon>
        <div className="min-w-0">
          <p className="text-[15.5px] font-semibold text-ink">
            {reauth ? "Connexion à renouveler" : "Google Calendar connecté"}
          </p>
          {email ? (
            <p className="truncate text-[14px] text-ink-muted">{email}</p>
          ) : null}
        </div>
      </div>
      {reauth ? (
        <>
          <p className="text-[14.5px] text-ink-soft">
            Google demande de renouveler la connexion. En attendant, les
            événements déjà connus continuent de bloquer tes créneaux et tes
            rendez-vous restent enregistrés dans Booking.
          </p>
          <Button
            size="md"
            className="w-fit"
            state={busy === "reconnect" ? "loading" : "idle"}
            loadingLabel="Ouverture de Google…"
            disabled={busy !== null && busy !== "reconnect"}
            onClick={onReconnect}
          >
            Reconnecter Google
          </Button>
        </>
      ) : null}
      {error}
    </Card>
  );
}

const noteTones: Record<NonNullable<CalendarRowView["note"]>["tone"], string> =
  {
    muted: "text-ink-muted",
    progress: "text-ink-soft",
    active: "text-success",
    margin: "text-ink-soft",
  };

function AvailabilitySection({
  calendars,
  locked,
  busy,
  onToggle,
  onRefresh,
  error,
}: {
  calendars: ConnectedCalendarDto[];
  locked: boolean;
  busy: Busy | null;
  onToggle: (calendar: ConnectedCalendarDto, on: boolean) => void;
  onRefresh: () => void;
  error: ReactNode;
}) {
  return (
    <Card aria-labelledby="calendar-availability">
      <SectionHeading
        id="calendar-availability"
        eyebrow="Disponibilités"
        title="Éviter les doubles réservations"
      >
        Choisis les calendriers Google dont les événements doivent bloquer tes
        créneaux Booking.
      </SectionHeading>

      {calendars.length === 0 ? (
        <p className="rounded-2xl bg-sand/60 px-4 py-3.5 text-[14.5px] text-ink-soft">
          Aucun calendrier à proposer pour l’instant.
        </p>
      ) : (
        <ul className="-mx-1 flex flex-col divide-y divide-line">
          {calendars.map((calendar) => {
            const view = calendarRowView(calendar, locked);
            const pending = busy === `calendar:${calendar.id}`;
            const noteId = `calendar-note-${calendar.id}`;
            const disabled =
              busy !== null ||
              locked ||
              (!calendar.blocking && !view.canEnable);
            return (
              <li key={calendar.id}>
                <label
                  className={cn(
                    "flex min-h-[4.25rem] items-center gap-4 rounded-2xl px-1 py-3",
                    disabled ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[15.5px] font-medium text-ink">
                        {calendar.name}
                      </span>
                      {calendar.primary ? (
                        <span className="shrink-0 rounded-full bg-sand px-2 py-0.5 text-[11.5px] font-medium text-ink-soft">
                          Principal
                        </span>
                      ) : null}
                    </span>
                    {view.note ? (
                      <span
                        id={noteId}
                        className={cn(
                          "text-[13.5px] leading-snug",
                          noteTones[view.note.tone],
                        )}
                      >
                        {view.note.text}
                      </span>
                    ) : null}
                  </span>
                  {pending ? (
                    <Spinner size={18} className="text-ink-muted" />
                  ) : null}
                  <Switch
                    checked={calendar.blocking}
                    disabled={disabled}
                    aria-describedby={view.note ? noteId : undefined}
                    aria-busy={pending || undefined}
                    onChange={(event) =>
                      onToggle(calendar, event.target.checked)
                    }
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {locked ? (
        <p className="text-[13.5px] text-ink-muted">
          Reconnecte Google pour modifier cette sélection.
        </p>
      ) : (
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy !== null}
          className="flex w-fit cursor-pointer items-center gap-2 text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "refresh" ? <Spinner size={14} /> : null}
          Actualiser la liste
        </button>
      )}
      {error}
    </Card>
  );
}

function OutboundIcon({ tone }: { tone: OutboundView["tone"] }) {
  switch (tone) {
    case "progress":
      return <Spinner size={20} />;
    case "active":
      return <CheckIcon size={20} />;
    case "delayed":
      return <ClockIcon size={20} />;
    case "action":
      return <InfoIcon size={20} />;
    case "idle":
      return <CalendarSyncIcon size={20} />;
  }
}

function AppointmentsSection({
  status,
  businessName,
  busy,
  onAction,
  onDisable,
  onReload,
  error,
}: {
  status: CalendarOutboundStatusDto | null;
  businessName: string;
  busy: Busy | null;
  onAction: (cta: OutboundCta) => void;
  onDisable: () => void;
  onReload: () => void;
  error: ReactNode;
}) {
  const view = status ? outboundView(status, businessName) : null;
  const busyFor = (cta: OutboundCta) =>
    busy === cta || (cta === "reconnect" && busy === "reconnect");

  return (
    <Card aria-labelledby="calendar-appointments">
      <SectionHeading
        id="calendar-appointments"
        eyebrow="Rendez-vous"
        title="Ajouter mes rendez-vous à Google Calendar"
      >
        <p>
          Booking crée automatiquement un calendrier dédié pour y ajouter tes
          rendez-vous.
        </p>
        <p className="mt-1 text-[14px] text-ink-muted">
          Ton calendrier personnel n’est jamais modifié.
        </p>
      </SectionHeading>

      {!status || !view ? (
        <Notice
          tone="offline"
          action={
            <button
              type="button"
              onClick={onReload}
              className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
            >
              Réessayer
            </button>
          }
        >
          L’état de la synchronisation n’a pas pu être chargé. Tes rendez-vous
          Booking ne sont pas affectés.
        </Notice>
      ) : (
        <div
          aria-live="polite"
          className="flex flex-col gap-4 rounded-2xl border border-line bg-paper p-4 sm:p-5"
        >
          <div className="flex items-start gap-3.5">
            <CardIcon tone={view.tone}>
              <OutboundIcon tone={view.tone} />
            </CardIcon>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-[16px] font-semibold text-ink">{view.title}</p>
              <p className="text-[14.5px] leading-relaxed text-ink-soft">
                {view.body}
              </p>
              {view.note ? (
                <p className="text-[13.5px] text-ink-muted">{view.note}</p>
              ) : null}
            </div>
          </div>

          {view.showCalendar ? (
            <div className="flex items-center gap-3 rounded-xl bg-paper-raised px-3.5 py-3 ring-1 ring-line">
              <CalendarIcon size={18} className="shrink-0 text-ink-soft" />
              <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">
                {bookingCalendarName(businessName)}
              </span>
              <span className="shrink-0 rounded-full bg-sand px-2 py-0.5 text-[11.5px] font-medium text-ink-soft">
                Géré par Booking
              </span>
            </div>
          ) : null}

          {view.primary || view.secondary ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {view.primary ? (
                <Button
                  size="md"
                  state={busyFor(view.primary.cta) ? "loading" : "idle"}
                  loadingLabel={
                    view.primary.cta === "retry"
                      ? "Nouvel essai…"
                      : "Un instant…"
                  }
                  disabled={busy !== null && !busyFor(view.primary.cta)}
                  onClick={() => onAction(view.primary!.cta)}
                >
                  {view.primary.label}
                </Button>
              ) : null}
              {view.secondary ? (
                <Button
                  variant="secondary"
                  size="md"
                  state={busyFor(view.secondary.cta) ? "loading" : "idle"}
                  loadingLabel="Nouvel essai…"
                  disabled={busy !== null && !busyFor(view.secondary.cta)}
                  onClick={() => onAction(view.secondary!.cta)}
                >
                  {view.secondary.label}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {status?.enabled ? (
        <button
          type="button"
          onClick={onDisable}
          disabled={busy !== null}
          className="w-fit cursor-pointer text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Désactiver l’ajout des rendez-vous
        </button>
      ) : null}
      {error}
    </Card>
  );
}

function ActionError({
  error,
  reassure,
  retry,
  onDismiss,
}: {
  error: UiError;
  /** Remind that Booking appointments are not affected. */
  reassure: boolean;
  retry?: () => void;
  onDismiss?: () => void;
}) {
  const copy = describeError(error);
  const actionClass =
    "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";
  return (
    <Notice
      tone={error.code === "network" ? "offline" : "error"}
      title={copy.title}
      action={
        error.code === "unauthenticated" ? (
          <Link href="/login" className={actionClass}>
            Me reconnecter
          </Link>
        ) : retry ? (
          <button type="button" onClick={retry} className={actionClass}>
            Réessayer
          </button>
        ) : onDismiss ? (
          <button type="button" onClick={onDismiss} className={actionClass}>
            Compris
          </button>
        ) : undefined
      }
    >
      {copy.message}
      {reassure && error.code !== "unauthenticated"
        ? " Tes rendez-vous Booking ne sont pas affectés."
        : null}
    </Notice>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <span className="sr-only" role="status">
        Chargement de Google Calendar…
      </span>
      <span className="h-24 animate-pulse rounded-3xl bg-sand/70" />
      <span className="h-64 animate-pulse rounded-3xl bg-sand/60" />
      <span className="h-52 animate-pulse rounded-3xl bg-sand/50" />
    </div>
  );
}
