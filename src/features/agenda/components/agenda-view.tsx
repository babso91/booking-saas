"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "@/components/ui/button";
import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import {
  getAgendaAction,
  getAgendaAppointmentAction,
  listAgendaServicesAction,
} from "@/features/agenda/actions/agenda";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import type { BusinessTodayDto } from "@/lib/time/business-time";

import {
  dayNumber,
  formatFullDate,
  formatWeekdayShort,
  periodLabel,
  shiftAnchor,
  startOfWeek,
  visibleRange,
  type AgendaView as View,
} from "../client/dates";
import { agendaRequestRange, restrictToDays } from "../client/layout";
import { useCanonicalToday } from "../client/use-canonical-today";
import { zoneOf } from "../client/zone";
import { AgendaError, TextAction } from "./agenda-error";
import { AppointmentDetails } from "./appointment-details";
import { AppointmentForm, type ServicesState } from "./appointment-form";
import { BlockForm } from "./block-form";
import { TimeGrid } from "./time-grid";

type Panel =
  | { kind: "appointment"; appointment: AgendaAppointmentDto }
  | { kind: "editAppointment"; appointment: AgendaAppointmentDto }
  | { kind: "createAppointment"; date: string; time: string }
  | { kind: "block"; block: AgendaBlockDto }
  | { kind: "createBlock"; date: string; time: string };

type Loaded = { key: string; data: AgendaDto };
type Failed = { key: string; error: UiError };
/** An action that needed today's date and could not get it. */
type TodayFailure = { error: UiError; retry: () => void };

// Re-renders every 30 s so "now" (the line on the grid) stays true.
function subscribeClock(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const clockBucket = () => Math.floor(Date.now() / 30_000);

const DEFAULT_TIME = "09:00";

/**
 * Professional agenda. Desktop and tablet (≥ 768 px) read one week, phones
 * one day: exactly the range on screen, in one aggregated request.
 * Writes are never applied optimistically: the server's answer updates the
 * open panel and the visible range is reloaded.
 *
 * "Today" is always PostgreSQL's date for the business (useCanonicalToday):
 * once the day it gave has ended, anything that depends on today — the
 * Aujourd’hui button, the default day of a new appointment or block — asks
 * again first, and reports an error rather than guessing a date.
 */
export function AgendaView({
  today: initialToday,
  slug,
}: {
  /** The business's date today and the instant it ends, from PostgreSQL. */
  today: BusinessTodayDto;
  slug: string;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const view: View = wide ? "week" : "day";
  const clock = useSyncExternalStore(subscribeClock, clockBucket, () => 0);

  const canonical = useCanonicalToday(
    initialToday,
    clock ? clock * 30_000 : null,
  );

  const [anchor, setAnchor] = useState(initialToday.date);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [services, setServices] = useState<ServicesState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [todayFailure, setTodayFailure] = useState<TodayFailure | null>(null);
  // The action waiting for today's date, if any (see withToday).
  const [awaitingToday, setAwaitingToday] = useState<number | null>(null);
  const intent = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const range = visibleRange(view, anchor);
  const key = `${range.startDate}:${range.endDate}:${includeCancelled}:${reloadToken}`;
  const rangeKey = `${range.startDate}:${range.endDate}:${includeCancelled}`;

  useEffect(() => {
    if (wide === null) return;
    let active = true;
    const observation = canonical.begin();
    callAction(() =>
      getAgendaAction({ ...agendaRequestRange(range.days), includeCancelled }),
    ).then((result) => {
      if (!active) return;
      if (result.ok) {
        canonical.observe(observation, result.data);
        setLoaded({ key, data: restrictToDays(result.data, range.days) });
      } else setFailed({ key, error: result.error });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the inputs
  }, [key, wide]);

  // Data of the visible range only (a previous range is never shown on new dates).
  const data = loaded && loaded.key.startsWith(rangeKey) ? loaded.data : null;
  const error = failed?.key === key ? failed.error : null;
  const loading = loaded?.key !== key && !error;
  const empty =
    data !== null && data.appointments.length === 0 && data.blocks.length === 0;

  // The business zone as PostgreSQL sent it with the last agenda read: day
  // bounds and UTC offsets. Kept while the next range loads (open panels).
  const zone = useMemo(() => (loaded ? zoneOf(loaded.data) : null), [loaded]);
  // Today as PostgreSQL gave it, or null once that day has ended and the
  // new date is not known yet: nothing is shown as today meanwhile.
  const today = canonical.fresh ? canonical.date : null;

  // What an action started before an answer must see when the answer comes.
  const latest = useRef({ view, anchor, days: range.days, data });
  useEffect(() => {
    latest.current = { view, anchor, days: range.days, data };
  });

  const reload = () => setReloadToken((token) => token + 1);

  /** Any explicit navigation: an action still waiting for today is dropped. */
  function navigate(date: string) {
    intent.current += 1;
    setAwaitingToday(null);
    setTodayFailure(null);
    setAnchor(date);
  }

  /**
   * Runs `run` with the business's date today. Immediate while the known
   * date is still valid; otherwise PostgreSQL is asked first. If that fails,
   * the action is not run with a guessed date: an error offers to retry.
   */
  function withToday(run: (today: string) => void) {
    const id = (intent.current += 1);
    setTodayFailure(null);
    const known = canonical.current();
    if (known) {
      setAwaitingToday(null);
      run(known);
      return;
    }
    setAwaitingToday(id);
    void canonical.refresh().then((result) => {
      // Unmounted, or replaced by a later action or navigation.
      if (!alive.current || id !== intent.current) return;
      setAwaitingToday(null);
      if (result.ok) run(result.data);
      else {
        setTodayFailure({ error: result.error, retry: () => withToday(run) });
      }
    });
  }

  function ensureServices() {
    if (services?.status === "ready" || services?.status === "loading") return;
    setServices({ status: "loading" });
    callAction(() => listAgendaServicesAction()).then((result) =>
      setServices(
        result.ok
          ? { status: "ready", data: result.data }
          : { status: "error", error: result.error },
      ),
    );
  }

  /**
   * Default day of a new appointment or block: always inside the period on
   * screen — the selected day, today when visible, otherwise the first
   * visible working day.
   */
  function withDefaultDate(open: (date: string) => void) {
    // One day on screen: that day, whatever today is.
    if (latest.current.view === "day") {
      open(latest.current.anchor);
      return;
    }
    withToday((today) => {
      const { view, anchor, days, data } = latest.current;
      if (view === "day") return open(anchor);
      if (days.includes(today)) return open(today);
      open(
        data?.workingHours.days.find((day) => day.openRanges.length > 0)
          ?.date ?? days[0]!,
      );
    });
  }

  function openCreateBlock(date?: string, time = DEFAULT_TIME) {
    const open = (day: string) =>
      setPanel({ kind: "createBlock", date: day, time });
    if (date) open(date);
    else withDefaultDate(open);
  }

  function openCreateAppointment(date?: string, time = DEFAULT_TIME) {
    ensureServices();
    const open = (day: string) =>
      setPanel({ kind: "createAppointment", date: day, time });
    if (date) open(date);
    else withDefaultDate(open);
  }

  function openEdit(appointment: AgendaAppointmentDto) {
    ensureServices();
    setPanel({ kind: "editAppointment", appointment });
  }

  function showAppointment(appointment: AgendaAppointmentDto) {
    setPanel({ kind: "appointment", appointment });
    const date = appointment.localStartsAt.slice(0, 10);
    if (date < range.startDate || date > range.endDate) navigate(date);
    reload();
  }

  async function refreshAppointment(
    appointment: AgendaAppointmentDto,
    editing: boolean,
  ) {
    const result = await callAction(() =>
      getAgendaAppointmentAction({ appointmentId: appointment.id }),
    );
    if (!result.ok) return result.error;
    setPanel({
      kind: editing ? "editAppointment" : "appointment",
      appointment: result.data,
    });
    reload();
    return null;
  }

  // After stale_block, reload the whole visible range: the block may have
  // been moved to another day meanwhile. Absent from the range is not proof
  // of deletion, so the message says what is known.
  async function refreshBlock(block: AgendaBlockDto) {
    const observation = canonical.begin();
    const result = await callAction(() =>
      getAgendaAction({ ...agendaRequestRange(range.days), includeCancelled }),
    );
    if (!result.ok) return result.error;
    canonical.observe(observation, result.data);
    const data = restrictToDays(result.data, range.days);
    setLoaded({ key, data });
    const fresh = data.blocks.find((item) => item.id === block.id);
    if (fresh) {
      setPanel({ kind: "block", block: fresh });
    } else {
      setPanel(null);
      setNotice(
        "Ce créneau bloqué n’apparaît plus dans la période affichée : il a pu être déplacé ou supprimé depuis un autre appareil.",
      );
    }
    return null;
  }

  if (wide === null) return <AgendaSkeleton />;

  const title =
    panel?.kind === "createAppointment"
      ? "Nouveau rendez-vous"
      : panel?.kind === "editAppointment"
        ? "Modifier le rendez-vous"
        : panel?.kind === "appointment"
          ? "Rendez-vous"
          : panel?.kind === "createBlock"
            ? "Bloquer un créneau"
            : panel?.kind === "block"
              ? panel.block.kind === "closed"
                ? "Fermeture"
                : "Créneau bloqué"
              : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-line bg-paper px-4 pt-3 pb-3 sm:px-6 lg:px-8 lg:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1
              className="truncate font-display text-[28px] leading-none text-ink sm:text-[34px]"
              aria-live="polite"
            >
              {periodLabel(view, range)}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <IconButton
              label={view === "week" ? "Semaine précédente" : "Jour précédent"}
              onClick={() => navigate(shiftAnchor(view, anchor, -1))}
            >
              <ChevronLeftIcon size={19} />
            </IconButton>
            <Button
              variant="secondary"
              size="md"
              onClick={() => withToday(navigate)}
              disabled={today !== null && range.days.includes(today)}
              className="h-10 px-3.5"
            >
              Aujourd’hui
            </Button>
            <IconButton
              label={view === "week" ? "Semaine suivante" : "Jour suivant"}
              onClick={() => navigate(shiftAnchor(view, anchor, 1))}
            >
              <ChevronRightIcon size={19} />
            </IconButton>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Button
              variant="secondary"
              size="md"
              icon={<BanIcon size={17} />}
              onClick={() => openCreateBlock()}
            >
              Bloquer un créneau
            </Button>
            <Button
              size="md"
              icon={<PlusIcon size={17} />}
              onClick={() => openCreateAppointment()}
            >
              Nouveau rendez-vous
            </Button>
          </div>
        </div>

        {view === "day" ? (
          <DayStrip anchor={anchor} today={today} onSelect={navigate} />
        ) : null}

        <label className="flex w-fit cursor-pointer items-center gap-2 text-[13.5px] text-ink-soft">
          <input
            type="checkbox"
            checked={includeCancelled}
            onChange={(event) => setIncludeCancelled(event.target.checked)}
            className="size-4 accent-[var(--ink)]"
          />
          Afficher les rendez-vous annulés
        </label>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading || awaitingToday !== null ? (
          <div
            className="absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-sand"
            role="progressbar"
            aria-label="Chargement de l’agenda"
          >
            <span className="block h-full w-1/3 animate-progress bg-accent" />
          </div>
        ) : null}

        {notice ? (
          <div className="p-4 pb-0 sm:px-6 lg:px-8">
            <Notice
              tone="info"
              action={
                <TextAction onClick={() => setNotice(null)}>Compris</TextAction>
              }
            >
              {notice}
            </Notice>
          </div>
        ) : null}

        {todayFailure ? (
          <div className="p-4 pb-0 sm:px-6 lg:px-8">
            <AgendaError
              error={todayFailure.error}
              subject="agenda"
              action={
                todayFailure.error.code === "network" ||
                todayFailure.error.code === "internal" ? (
                  <TextAction onClick={todayFailure.retry}>
                    Réessayer
                  </TextAction>
                ) : undefined
              }
            />
          </div>
        ) : null}

        {error ? (
          <div className="p-4 sm:px-6 lg:px-8">
            <AgendaError
              error={error}
              subject="agenda"
              action={
                error.code === "network" || error.code === "internal" ? (
                  <TextAction onClick={reload}>Réessayer</TextAction>
                ) : undefined
              }
            />
          </div>
        ) : null}

        <TimeGrid
          days={range.days}
          data={data}
          today={today}
          nowMs={clock ? clock * 30_000 : null}
          hourHeight={view === "day" ? 64 : 56}
          onOpenAppointment={(appointment) =>
            setPanel({ kind: "appointment", appointment })
          }
          onOpenBlock={(block) => setPanel({ kind: "block", block })}
          onCreateAt={(date, time) => openCreateAppointment(date, time)}
        />

        {empty && !loading ? (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6">
            <div className="pointer-events-auto flex max-w-sm animate-rise flex-col items-center gap-3 rounded-3xl border border-line bg-paper-raised/95 px-6 py-7 text-center shadow-[0_24px_60px_-34px_rgba(35,28,24,0.45)]">
              <p className="font-display text-[28px] leading-tight text-ink">
                {view === "week"
                  ? "Ta semaine est encore libre."
                  : "Ta journée est encore libre."}
              </p>
              <p className="text-[14.5px] text-ink-soft">
                Ajoute un rendez-vous ou partage ton lien : tes clientes
                réservent elles-mêmes.
              </p>
              <Button
                size="md"
                icon={<PlusIcon size={17} />}
                onClick={() => openCreateAppointment()}
              >
                Ajouter un rendez-vous
              </Button>
              <a
                href={`/b/${slug}`}
                target="_blank"
                rel="noreferrer"
                className="text-[13.5px] text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink"
              >
                {bookingHost()}/b/{slug}
              </a>
            </div>
          </div>
        ) : null}
      </div>

      {/* Phone actions, within thumb reach */}
      <div className="grid grid-cols-[1fr_auto] gap-2 border-t border-line bg-paper px-4 py-2.5 md:hidden">
        <Button
          size="md"
          icon={<PlusIcon size={17} />}
          onClick={() => openCreateAppointment()}
        >
          Nouveau rendez-vous
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => openCreateBlock()}
          aria-label="Bloquer un créneau"
        >
          <BanIcon size={18} />
          <span className="sr-only sm:not-sr-only">Bloquer</span>
        </Button>
      </div>

      <Sheet open={panel !== null} onClose={() => setPanel(null)} title={title}>
        {panel?.kind === "appointment" ? (
          <AppointmentDetails
            key={`${panel.appointment.id}:${panel.appointment.version}`}
            appointment={panel.appointment}
            zone={zone}
            onEdit={() => openEdit(panel.appointment)}
            onUpdated={showAppointment}
            onRefresh={() => refreshAppointment(panel.appointment, false)}
          />
        ) : null}
        {panel?.kind === "createAppointment" ||
        panel?.kind === "editAppointment" ? (
          <AppointmentForm
            key={
              panel.kind === "editAppointment"
                ? `${panel.appointment.id}:${panel.appointment.version}`
                : "create"
            }
            mode={
              panel.kind === "editAppointment"
                ? { kind: "edit", appointment: panel.appointment }
                : { kind: "create", date: panel.date, time: panel.time }
            }
            services={services ?? { status: "loading" }}
            zone={zone}
            onSaved={showAppointment}
            onCancel={() =>
              setPanel(
                panel.kind === "editAppointment"
                  ? { kind: "appointment", appointment: panel.appointment }
                  : null,
              )
            }
            onRefresh={
              panel.kind === "editAppointment"
                ? () => refreshAppointment(panel.appointment, true)
                : undefined
            }
          />
        ) : null}
        {panel?.kind === "createBlock" || panel?.kind === "block" ? (
          <BlockForm
            key={
              panel.kind === "block"
                ? `${panel.block.id}:${panel.block.version}`
                : "create"
            }
            mode={
              panel.kind === "block"
                ? { kind: "edit", block: panel.block }
                : { kind: "create", date: panel.date, time: panel.time }
            }
            zone={zone}
            onSaved={() => {
              setPanel(null);
              reload();
            }}
            onDeleted={() => {
              setPanel(null);
              reload();
            }}
            onCancel={() => setPanel(null)}
            onRefresh={
              panel.kind === "block"
                ? () => refreshBlock(panel.block)
                : undefined
            }
          />
        ) : null}
      </Sheet>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-paper-raised text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
    >
      {children}
    </button>
  );
}

/** Week of the selected day on phones: one tap to any day. */
function DayStrip({
  anchor,
  today,
  onSelect,
}: {
  anchor: string;
  today: string | null;
  onSelect: (date: string) => void;
}) {
  const { days } = visibleRange("week", startOfWeek(anchor));
  return (
    <div
      className="grid grid-cols-7 gap-1"
      role="group"
      aria-label="Jours de la semaine"
    >
      {days.map((date) => {
        const selected = date === anchor;
        return (
          <button
            key={date}
            type="button"
            onClick={() => onSelect(date)}
            aria-pressed={selected}
            aria-label={formatFullDate(date)}
            className={cn(
              "flex h-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-2xl text-[12px] transition-colors",
              selected
                ? "bg-ink text-paper-raised"
                : "text-ink-soft hover:bg-sand",
            )}
          >
            <span className="uppercase">{formatWeekdayShort(date)}</span>
            <span
              className={cn(
                "text-[16px] font-semibold tabular-nums",
                !selected && date === today && "text-accent",
              )}
            >
              {dayNumber(date)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AgendaSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-8" aria-busy="true">
      <span className="sr-only" role="status">
        Chargement de l’agenda…
      </span>
      <span className="h-8 w-56 animate-pulse rounded-xl bg-sand" />
      <span className="flex-1 animate-pulse rounded-3xl bg-sand/60" />
    </div>
  );
}
