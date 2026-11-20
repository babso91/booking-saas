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
import { useDashboardStyle } from "@/features/appearance/components/appearance-provider";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  StudioAgenda,
  type StudioView,
} from "@/features/dashboard/agenda/studio-agenda";
import { CarnetAgenda } from "@/features/dashboard/carnet/carnet-agenda";
import { EcrinAgenda } from "@/features/dashboard/ecrin/ecrin-agenda";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { addDaysToLocalDate } from "@/lib/time/local-date";

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
import {
  agendaRangeWithBuffers,
  agendaRequestRange,
  restrictToDays,
} from "../client/layout";
import { useCanonicalToday } from "../client/use-canonical-today";
import { zoneOf } from "../client/zone";
import { AgendaError, TextAction } from "./agenda-error";
import { saveAgendaFormatAction } from "../actions/format";
import {
  agendaFormats,
  agendaFormatNames,
  type AgendaFormat,
} from "../formats";
import { AgendaOverview } from "./agenda-overview";
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

/** A read refused because of who asks, not because of what is asked. */
const IDENTITY_LOST = new Set<UiError["code"]>([
  "unauthenticated",
  "no_business",
  "forbidden",
]);

/**
 * Professional agenda. Desktop and tablet (≥ 768 px) read one week, phones
 * one day: exactly the range on screen, in one aggregated request. In the
 * Studio style, a computer can also show one day; the Studio presentation
 * (StudioAgenda) is driven by this same controller — same reading, same
 * "today", same panels and actions.
 * Writes are never applied optimistically: the server's answer updates the
 * open panel and the visible range is reloaded.
 *
 * "Today" is always PostgreSQL's date for the business (useCanonicalToday).
 * Anything that depends on it — the Aujourd’hui button, the default day of
 * a new appointment or block in the week view — asks PostgreSQL first and
 * reports an error rather than guessing a date; the date kept on screen is
 * only used for display (highlight, "now" line).
 */
export function AgendaView({
  today: initialToday,
  initialDate,
  initialAppointmentId,
  initialCreate,
  formatSettings,
}: {
  formatSettings?: {
    membershipId: string;
    preferred: AgendaFormat;
    slug: string;
  };
  /** Day to open on (a link from a customer profile); today otherwise. */
  initialDate?: string;
  /**
   * Appointment to open once the first range is read (a link from
   * "Aujourd’hui"): its details panel, exactly as a tap on the grid opens
   * it. Ignored if that range does not hold it.
   */
  initialAppointmentId?: string;
  /** A link asked for a new appointment: the form opens, once. */
  initialCreate?: boolean;
  /** The business's date today, from PostgreSQL. */
  today: string;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const style = useDashboardStyle();
  // Studio, Écrin and Carnet: other presentations of this same controller, where a
  // computer can also show one day.
  const designed = style !== "classique";
  const [studioView, setStudioView] = useState<StudioView>("week");
  const [preferred, setPreferred] = useState<AgendaFormat>(
    formatSettings?.preferred ?? "classic",
  );
  const [savingFormat, setSavingFormat] = useState(false);
  const savingFormatRef = useRef(false);
  const [formatError, setFormatError] = useState(false);
  const format = formatSettings ? preferred : "classic";

  async function changeFormat(next: AgendaFormat) {
    if (!formatSettings || savingFormatRef.current || next === format) return;
    savingFormatRef.current = true;
    setSavingFormat(true);
    setFormatError(false);
    const result = await callAction(() =>
      saveAgendaFormatAction({
        membershipId: formatSettings.membershipId,
        format: next,
      }),
    );
    savingFormatRef.current = false;
    if (!alive.current) return;
    setSavingFormat(false);
    if (result.ok) {
      supersede();
      setPreferred(result.data);
      setOverrideView(null);
    } else setFormatError(true);
  }

  const [overrideView, setOverrideView] = useState<View | null>(null);
  const view: View =
    overrideView ??
    (format === "visual"
      ? "month"
      : format === "availability"
        ? "week"
        : format === "salon"
          ? "day"
          : wide
            ? designed
              ? studioView
              : "week"
            : "day");
  const clock = useSyncExternalStore(subscribeClock, clockBucket, () => 0);

  const canonical = useCanonicalToday(initialToday, clock);

  const [anchor, setAnchor] = useState(initialDate ?? initialToday);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [panel, setPanelState] = useState<Panel | null>(null);
  const [services, setServices] = useState<ServicesState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [todayFailure, setTodayFailure] = useState<TodayFailure | null>(null);
  // The action waiting for today's date, if any (see withToday).
  const [awaitingToday, setAwaitingToday] = useState<number | null>(null);
  const intent = useRef(0);
  const alive = useRef(true);
  // Opened once, from the first answer that comes back, and only if she has
  // not done anything else meanwhile (see supersede).
  const pendingAppointment = useRef(initialAppointmentId ?? null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const range = visibleRange(view, anchor);
  const key = `${range.startDate}:${range.endDate}:${includeCancelled}:${reloadToken}`;
  const rangeKey = `${range.startDate}:${range.endDate}:${includeCancelled}`;

  // A buffer from the day before can occupy part of a free interval.
  const buffers =
    format !== "classic" ||
    designed ||
    view === "month" ||
    (view === "week" && !wide);
  const readRange = (days: string[]) =>
    buffers ? agendaRangeWithBuffers(days) : agendaRequestRange(days);

  useEffect(() => {
    if (wide === null) return;
    let active = true;
    const observation = canonical.begin();
    callAction(() =>
      getAgendaAction({ ...readRange(range.days), includeCancelled }),
    ).then((result) => {
      if (!active) return;
      if (result.ok) {
        canonical.observe(observation, result.data);
        const data = restrictToDays(result.data, range.days, {
          buffers,
        });
        setLoaded({ key, data });
        const wanted = pendingAppointment.current;
        pendingAppointment.current = null;
        const found = wanted
          ? data.appointments.find((item) => item.id === wanted)
          : undefined;
        // Never over a panel she has opened meanwhile (a draft is kept).
        if (found)
          setPanelState(
            (open) => open ?? { kind: "appointment", appointment: found },
          );
      } else setFailed({ key, error: result.error });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the inputs
  }, [key, wide, buffers]);

  const error = failed?.key === key ? failed.error : null;
  // Refused for want of a session or a membership: this session no longer
  // vouches for whom the range was read. Nothing read before stays on screen,
  // not even an open panel, until the area is rendered for whoever it is now
  // (AppShell starts it again from nothing).
  const refused = error !== null && IDENTITY_LOST.has(error.code);
  // Data of the visible range only (a previous range is never shown on new dates).
  const data =
    !refused && loaded && loaded.key.startsWith(rangeKey) ? loaded.data : null;
  const shown = refused ? null : panel;
  const loading = loaded?.key !== key && !error;
  const empty =
    data !== null && data.appointments.length === 0 && data.blocks.length === 0;

  // The business zone as PostgreSQL sent it with the last agenda read: day
  // bounds and UTC offsets. Kept while the next range loads (open panels).
  const zone = useMemo(() => (loaded ? zoneOf(loaded.data) : null), [loaded]);
  // For display only: today as PostgreSQL gave it, or null while that day
  // may be over and the new date is not known yet (nothing is shown as today
  // meanwhile).
  const today = canonical.certain ? canonical.date : null;

  // What an action started before an answer must see when the answer comes.
  const latest = useRef({ view, anchor, days: range.days, data });
  useEffect(() => {
    latest.current = { view, anchor, days: range.days, data };
  });

  const reload = () => setReloadToken((token) => token + 1);

  /**
   * A newer interaction takes over: an action still waiting for today's
   * date must not run when its answer arrives (it would replace what the
   * user has opened or typed since), nor report its failure.
   */
  function supersede() {
    intent.current += 1;
    // Her intention changed: the appointment a link asked to open is no
    // longer what she wants on screen.
    pendingAppointment.current = null;
    setAwaitingToday(null);
    setTodayFailure(null);
  }

  /** Every change of the panel is such an interaction: open, switch, close. */
  function setPanel(next: Panel | null) {
    supersede();
    setPanelState(next);
  }

  /** So is any navigation. */
  function navigate(date: string) {
    supersede();
    setAnchor(date);
  }

  /**
   * Runs `run` with the business's date today, asked to PostgreSQL right
   * now: the date kept on screen is never trusted for an action, whatever
   * the device clock says. If the question fails, the action is not run
   * with a guessed date: an error offers to retry. If the user does
   * something else meanwhile, the action is dropped.
   */
  function withToday(run: (today: string) => void) {
    supersede();
    const id = intent.current;
    setAwaitingToday(id);
    void canonical.validate().then((result) => {
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
      getAgendaAction({ ...readRange(range.days), includeCancelled }),
    );
    if (!result.ok) return result.error;
    canonical.observe(observation, result.data);
    const data = restrictToDays(result.data, range.days, { buffers });
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

  // Asked by a link ("Noter", from another page): once, when the view is known.
  const createAsked = useRef(initialCreate === true);
  useEffect(() => {
    if (wide === null || !createAsked.current) return;
    createAsked.current = false;
    // Reloading the page does not ask again.
    window.history.replaceState(null, "", "/app");
    openCreateAppointment();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [wide]);

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

  const banners = (
    <>
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
                <TextAction onClick={todayFailure.retry}>Réessayer</TextAction>
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
    </>
  );

  const panels = (
    <Sheet open={shown !== null} onClose={() => setPanel(null)} title={title}>
      {shown?.kind === "appointment" ? (
        <AppointmentDetails
          key={`${shown.appointment.id}:${shown.appointment.version}`}
          appointment={shown.appointment}
          zone={zone}
          onEdit={() => openEdit(shown.appointment)}
          onUpdated={showAppointment}
          onRefresh={() => refreshAppointment(shown.appointment, false)}
        />
      ) : null}
      {shown?.kind === "createAppointment" ||
      shown?.kind === "editAppointment" ? (
        <AppointmentForm
          key={
            shown.kind === "editAppointment"
              ? `${shown.appointment.id}:${shown.appointment.version}`
              : "create"
          }
          mode={
            shown.kind === "editAppointment"
              ? { kind: "edit", appointment: shown.appointment }
              : { kind: "create", date: shown.date, time: shown.time }
          }
          services={services ?? { status: "loading" }}
          zone={zone}
          onSaved={showAppointment}
          onCancel={() =>
            setPanel(
              shown.kind === "editAppointment"
                ? { kind: "appointment", appointment: shown.appointment }
                : null,
            )
          }
          onRefresh={
            shown.kind === "editAppointment"
              ? () => refreshAppointment(shown.appointment, true)
              : undefined
          }
        />
      ) : null}
      {shown?.kind === "createBlock" || shown?.kind === "block" ? (
        <BlockForm
          key={
            shown.kind === "block"
              ? `${shown.block.id}:${shown.block.version}`
              : "create"
          }
          mode={
            shown.kind === "block"
              ? { kind: "edit", block: shown.block }
              : { kind: "create", date: shown.date, time: shown.time }
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
            shown.kind === "block" ? () => refreshBlock(shown.block) : undefined
          }
        />
      ) : null}
    </Sheet>
  );

  const viewPicker = (
    <nav
      aria-label="Vue de l’agenda"
      className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2 sm:px-6"
    >
      {(
        [
          ["day", "Jour"],
          ["week", "Semaine"],
          ["month", "Mois"],
        ] as const
      ).map(([value, label]) => (
        <Button
          key={value}
          size="md"
          variant={value === view ? "primary" : "ghost"}
          aria-pressed={value === view}
          onClick={() => {
            supersede();
            setOverrideView(value);
          }}
        >
          {label}
        </Button>
      ))}
      {formatSettings ? (
        <label className="ml-auto flex min-w-0 items-center gap-2 text-sm text-ink-soft">
          <span className="sr-only lg:not-sr-only">Format d’agenda</span>
          <select
            aria-label="Format d’agenda"
            value={format}
            disabled={savingFormat}
            onChange={(event) => {
              const next = agendaFormats.find(
                (value) => value === event.target.value,
              );
              if (next) void changeFormat(next);
            }}
            className="min-h-11 max-w-full rounded-xl border border-line bg-paper-raised px-2 text-sm font-medium text-ink"
          >
            {agendaFormats.map((value) => (
              <option key={value} value={value}>
                {agendaFormatNames[value]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {savingFormat ? (
        <span role="status" className="sr-only">
          Enregistrement du format…
        </span>
      ) : null}
      {formatError ? (
        <p role="alert" className="w-full text-sm text-danger">
          Le format n’a pas pu être enregistré. Sélectionne-le à nouveau pour
          réessayer.
        </p>
      ) : null}
    </nav>
  );

  if (format !== "classic" || view === "month" || (view === "week" && !wide)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {viewPicker}
        {banners}
        <AgendaOverview
          format={format}
          slug={formatSettings?.slug}
          nowMs={clock ? clock * 30_000 : null}
          today={today}
          onOpenBlock={(block) => setPanel({ kind: "block", block })}
          onNewBlock={() => openCreateBlock(anchor)}
          onCreateAt={openCreateAppointment}
          onDayView={(day) => {
            navigate(day);
            setOverrideView("day");
          }}
          view={view}
          range={range}
          selected={anchor}
          data={data}
          loading={loading || awaitingToday !== null}
          includeCancelled={includeCancelled}
          onIncludeCancelled={setIncludeCancelled}
          onSelect={navigate}
          onShift={(direction) =>
            navigate(shiftAnchor(view, anchor, direction))
          }
          onOpen={(appointment) =>
            setPanel({ kind: "appointment", appointment })
          }
          onToday={() => withToday(navigate)}
          onNew={() => openCreateAppointment(anchor)}
        />
        {panels}
      </div>
    );
  }

  if (designed) {
    const Presentation =
      style === "carnet"
        ? CarnetAgenda
        : style === "ecrin"
          ? EcrinAgenda
          : StudioAgenda;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {viewPicker}
        <Presentation
          view={view}
          hideViewSwitch
          wide={wide}
          onView={(next) => {
            // Her intention changed: like any navigation.
            supersede();
            setStudioView(next);
            setOverrideView(null);
          }}
          days={range.days}
          anchor={anchor}
          today={today}
          data={data}
          nowMs={clock ? clock * 30_000 : null}
          loading={loading || awaitingToday !== null}
          includeCancelled={includeCancelled}
          onIncludeCancelled={setIncludeCancelled}
          onShift={(direction) =>
            navigate(
              direction === 7 || direction === -7
                ? addDaysToLocalDate(anchor, direction)
                : shiftAnchor(view, anchor, direction),
            )
          }
          onToday={() => withToday(navigate)}
          onSelectDay={navigate}
          onNewAppointment={() => openCreateAppointment()}
          onNewBlock={() => openCreateBlock()}
          onOpenAppointment={(appointment) =>
            setPanel({ kind: "appointment", appointment })
          }
          onOpenBlock={(block) => setPanel({ kind: "block", block })}
          onCreateAt={(date, time) => openCreateAppointment(date, time)}
          banners={banners}
          panels={panels}
          onRefresh={reload}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {viewPicker}
      <header className="flex flex-col gap-3 border-b border-line bg-paper glass-surface px-4 pt-3 pb-3 sm:px-6 lg:px-8 lg:pt-6">
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
              // Never disabled: whether today is on screen is PostgreSQL's
              // to say, at the click. The hint below is display only.
              data-on-today={today !== null && range.days.includes(today)}
              className={cn(
                "h-10 px-3.5",
                today !== null &&
                  range.days.includes(today) &&
                  "text-ink-muted",
              )}
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

        {banners}

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
            <div className="pointer-events-auto flex max-w-sm animate-rise flex-col items-center gap-3 rounded-3xl border border-line bg-paper-raised/95 px-6 py-7 text-center shadow-[0_24px_60px_-34px_rgb(var(--shadow-rgb)/0.45)]">
              <p className="font-display text-[28px] leading-tight text-ink">
                {view === "week"
                  ? "Ta semaine est encore libre."
                  : "Ta journée est encore libre."}
              </p>
              <p className="text-[14.5px] text-ink-soft">
                Ajoute tes rendez-vous ici. Ceux que tes clientes réservent en
                ligne y arrivent aussi.
              </p>
              <Button
                size="md"
                icon={<PlusIcon size={17} />}
                onClick={() => openCreateAppointment()}
              >
                Ajouter un rendez-vous
              </Button>
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

      {panels}
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
