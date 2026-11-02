"use client";

import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
  type TouchEvent,
} from "react";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "@/components/ui/icons";
import {
  dayNumber,
  formatDayMonth,
  formatDuration,
  formatFullDate,
  formatWeekdayLong,
  formatWeekdayShort,
  startOfWeek,
  visibleRange,
} from "@/features/agenda/client/dates";
import { cn } from "@/lib/cn";

import { dayFlow, distinctBookings } from "../agenda/day-flow";
import type { StudioAgendaProps } from "../agenda/studio-agenda";
import { useOptionsMenu } from "../agenda/use-options-menu";
import { todayModel } from "../client/today-model";
import { EcrinDial } from "./ecrin-dial";
import { EcrinThread } from "./ecrin-thread";
import { EcrinWeek } from "./ecrin-week";

// The Écrin agenda: the same agenda (AgendaView: its reading, its today
// checked with PostgreSQL, its cards, forms and actions), its own room. On
// a computer, the week as seven tubes, or a day with its dial beside its
// thread; on a phone, the day's thread, with the days as pearls and "+"
// under the thumb. It takes the same contract as the Studio presentation.

const WAKE_AFTER_MS = 60_000;

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

export function EcrinAgenda(props: StudioAgendaProps) {
  const { view, wide, days, anchor, today, data, nowMs, loading } = props;
  const count = data ? distinctBookings(data, days) : null;
  const isOnToday = today !== null && days.includes(today);
  const heading = useRef<HTMLHeadingElement>(null);

  // Back to the tab after a while: bookings may have come meanwhile.
  const refresh = useRef(props.onRefresh);
  useEffect(() => {
    refresh.current = props.onRefresh;
  });
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onChange = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt !== null && Date.now() - hiddenAt > WAKE_AFTER_MS) {
        hiddenAt = null;
        refresh.current?.();
      } else hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const model = useMemo(
    () =>
      data && view === "day" ? todayModel(data, anchor, nowMs ?? 0) : null,
    [data, view, anchor, nowMs],
  );

  const title =
    view === "week"
      ? `${formatDayMonth(days[0]!)} – ${formatDayMonth(days[days.length - 1]!)}`
      : `${capitalize(formatWeekdayLong(anchor))} ${dayNumber(anchor)}`;
  const subtitle =
    view === "week"
      ? days[0]!.slice(0, 4) === days[days.length - 1]!.slice(0, 4)
        ? days[0]!.slice(0, 4)
        : `${days[0]!.slice(0, 4)} – ${days[days.length - 1]!.slice(0, 4)}`
      : formatFullDate(anchor).split(" ").slice(2).join(" ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-x-3 gap-y-2 px-4 pt-1 pb-2 md:flex-wrap md:gap-x-6 md:px-8 md:pb-3">
        <div className="flex min-w-0 items-center gap-3">
          {!wide && model ? (
            <EcrinDial
              compact
              model={model}
              now={anchor === today ? nowMs : null}
              className="hidden size-14 shrink-0 min-[360px]:block"
            />
          ) : null}
          <div className="min-w-0">
            <h1
              ref={heading}
              tabIndex={-1}
              className="font-engraved text-[clamp(26px,7.4vw,42px)] leading-[1.05] tracking-[0.01em] text-ink outline-none"
              aria-live="polite"
            >
              {title}
            </h1>
            <p className="text-[14px] text-ink-soft">
              {subtitle}
              {count !== null ? ` · ${count} rendez‑vous` : ""}
            </p>
          </div>
        </div>

        {wide ? (
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Affichage"
              className="ecrin-object flex rounded-full p-1"
            >
              {(["week", "day"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => props.onView(option)}
                  className={cn(
                    "h-9 cursor-pointer rounded-full px-4 text-[14px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                    view === option
                      ? "bg-accent-soft font-medium text-accent-strong"
                      : "text-ink-soft hover:text-ink",
                  )}
                >
                  {option === "week" ? "Semaine" : "Jour"}
                </button>
              ))}
            </div>
            <Round
              label={view === "week" ? "Semaine précédente" : "Jour précédent"}
              onClick={() => props.onShift(-1)}
            >
              <ChevronLeftIcon size={19} />
            </Round>
            <button
              type="button"
              onClick={props.onToday}
              data-on-today={isOnToday}
              className={cn(
                "ecrin-object ecrin-press h-11 cursor-pointer rounded-full px-4 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                isOnToday ? "text-ink-soft" : "text-ink",
              )}
            >
              Aujourd’hui
            </button>
            <Round
              label={view === "week" ? "Semaine suivante" : "Jour suivant"}
              onClick={() => props.onShift(1)}
            >
              <ChevronRightIcon size={19} />
            </Round>
            <CancelledToggle
              on={props.includeCancelled}
              onChange={props.onIncludeCancelled}
            />
            <button
              type="button"
              onClick={props.onNewBlock}
              className="h-11 cursor-pointer rounded-full px-3 text-[14px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Bloquer un créneau
            </button>
            <button
              type="button"
              onClick={props.onNewAppointment}
              className="ecrin-press flex h-11 cursor-pointer items-center gap-2 rounded-full bg-signature px-5 text-[14.5px] font-medium text-on-signature shadow-[0_12px_26px_-14px_rgb(var(--shadow-rgb)/0.7)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <PlusIcon size={18} />
              Nouveau rendez-vous
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            {isOnToday ? null : (
              <button
                type="button"
                onClick={() => {
                  // This button goes away once on today: focus stays near.
                  heading.current?.focus({ preventScroll: true });
                  props.onToday();
                }}
                data-on-today={false}
                className="ecrin-object h-11 cursor-pointer rounded-full px-3.5 text-[13.5px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Aujourd’hui
              </button>
            )}
            <Options
              includeCancelled={props.includeCancelled}
              onIncludeCancelled={props.onIncludeCancelled}
              onNewBlock={props.onNewBlock}
              fallback={heading}
            />
          </div>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div
            className="absolute inset-x-8 top-0 z-50 h-0.5 overflow-hidden rounded-full bg-sand"
            role="progressbar"
            aria-label="Chargement de l’agenda"
          >
            <span className="block h-full w-1/3 animate-progress bg-accent" />
          </div>
        ) : null}
        {props.banners}

        {view === "week" ? (
          <EcrinWeek
            days={days}
            data={data}
            today={today}
            nowMs={nowMs}
            onOpenAppointment={props.onOpenAppointment}
            onOpenBlock={props.onOpenBlock}
            onCreateAt={props.onCreateAt}
            onOpenDay={(date) => {
              props.onSelectDay(date);
              props.onView("day");
            }}
          />
        ) : (
          <Swipe
            enabled={!wide}
            onShift={props.onShift}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-[230px] md:px-8 md:pb-8"
          >
            <div
              className={cn(
                wide &&
                  "mx-auto grid max-w-[1180px] items-start gap-10 lg:grid-cols-[400px_minmax(0,1fr)]",
              )}
            >
              {wide ? (
                <div className="sticky top-1 hidden flex-col gap-4 self-start lg:flex">
                  {model ? (
                    <EcrinDial
                      model={model}
                      now={anchor === today ? nowMs : null}
                      onOpen={props.onOpenAppointment}
                    >
                      <DaySays props={props} />
                    </EcrinDial>
                  ) : null}
                  <div className="flex justify-center">
                    <DayStrip
                      anchor={anchor}
                      today={today}
                      onSelect={props.onSelectDay}
                    />
                  </div>
                </div>
              ) : null}
              <EcrinThread
                data={data}
                date={anchor}
                nowMs={nowMs}
                onOpenAppointment={props.onOpenAppointment}
                onOpenBlock={props.onOpenBlock}
                onCreateAt={props.onCreateAt}
              />
            </div>
          </Swipe>
        )}
      </div>

      {/* Phone: days and "+" under the thumb, above the navigation. */}
      {wide ? null : (
        <div className="pointer-events-none fixed inset-x-2.5 bottom-[calc(env(safe-area-inset-bottom)+80px)] z-20 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={props.onNewAppointment}
            aria-label="Nouveau rendez-vous"
            className="ecrin-press pointer-events-auto grid size-14 cursor-pointer place-items-center rounded-full bg-signature text-on-signature shadow-[0_16px_30px_-12px_rgb(var(--shadow-rgb)/0.7)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent"
          >
            <PlusIcon size={26} />
          </button>
          <div className="ecrin-object pointer-events-auto flex w-full max-w-[420px] items-center gap-0.5 self-center rounded-full px-1 py-1">
            <button
              type="button"
              aria-label="Semaine précédente"
              onClick={() => props.onShift(-7)}
              className="grid h-11 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-ink-soft focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ChevronLeftIcon size={16} />
            </button>
            <DayStrip
              anchor={anchor}
              today={today}
              onSelect={props.onSelectDay}
            />
            <button
              type="button"
              aria-label="Semaine suivante"
              onClick={() => props.onShift(7)}
              className="grid h-11 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-ink-soft focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>
        </div>
      )}

      {props.panels}
    </div>
  );
}

/** What the big dial of a day says. */
function DaySays({ props }: { props: StudioAgendaProps }) {
  const { data, anchor, nowMs, today } = props;
  const flow = useMemo(
    () => (data ? dayFlow(data, anchor, nowMs) : null),
    [data, anchor, nowMs],
  );
  if (!flow) return null;
  const visits = flow.items.flatMap((item) =>
    item.kind === "visits"
      ? item.visits.filter((visit) => visit.appointment.status !== "cancelled")
      : [],
  );
  const free = flow.freeMinutes;
  return (
    <>
      <p className="font-engraved text-[11px] tracking-[0.2em] text-ink-soft uppercase">
        {anchor === today ? "Aujourd’hui" : formatWeekdayLong(anchor)}
      </p>
      <p className="text-[46px] leading-none font-extralight text-ink tabular-nums">
        {flow.closed && visits.length === 0 ? "—" : visits.length}
      </p>
      <p className="font-engraved text-[15px] text-ink">
        {flow.closed && visits.length === 0 ? "Fermé" : `rendez‑vous`}
      </p>
      {free > 0 ? (
        <p className="text-[13.5px] text-accent">
          {formatDuration(free)} de temps libre
          {flow.freeStretches > 1 ? (
            <span className="block">en {flow.freeStretches} plages</span>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

function Round({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="ecrin-object ecrin-press grid size-11 cursor-pointer place-items-center rounded-full text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

function CancelledToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[14px] transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        on
          ? "bg-accent-soft font-medium text-accent-strong"
          : "text-ink-soft hover:text-ink",
      )}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span aria-hidden="true">{on ? "✓" : "+"}</span>
      Annulés
      <span className="sr-only"> : afficher les rendez-vous annulés</span>
    </label>
  );
}

/** Phone: blocking time and cancelled visits, in one small menu. */
function Options({
  includeCancelled,
  onIncludeCancelled,
  onNewBlock,
  fallback,
}: {
  includeCancelled: boolean;
  onIncludeCancelled: (value: boolean) => void;
  onNewBlock: () => void;
  fallback: RefObject<HTMLElement | null>;
}) {
  const { open, root, trigger, toggle, leaveFor } = useOptionsMenu(fallback);
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls="ecrin-agenda-options"
        aria-label="Options de l’agenda"
        onClick={toggle}
        className="ecrin-object grid size-11 cursor-pointer place-items-center rounded-full text-[20px] leading-none text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ⋯
      </button>
      {open ? (
        <div
          id="ecrin-agenda-options"
          className="ecrin-object ecrin-appear absolute top-12 right-0 z-50 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-[22px] p-2"
        >
          <button
            type="button"
            onClick={() => leaveFor(onNewBlock)}
            className="flex min-h-12 cursor-pointer items-center rounded-[16px] px-3 text-left text-[15px] text-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            Bloquer un créneau
          </button>
          <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[16px] px-3 text-[15px] text-ink hover:bg-sand has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-accent">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(event) => onIncludeCancelled(event.target.checked)}
              className="size-5 accent-[var(--accent)]"
            />
            Afficher les annulés
          </label>
        </div>
      ) : null}
    </div>
  );
}

/** The days of the week shown, as pearls. */
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
      role="group"
      aria-label="Jours de la semaine"
      className="grid min-w-0 flex-1 grid-cols-7"
    >
      {days.map((date) => {
        const selected = date === anchor;
        return (
          <button
            key={date}
            type="button"
            onClick={() => onSelect(date)}
            aria-pressed={selected}
            className="group flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            <span
              className={cn(
                "grid size-9 place-items-center rounded-full leading-none transition-colors",
                selected
                  ? "bg-signature text-on-signature"
                  : date === today
                    ? "text-accent"
                    : "text-ink-soft group-hover:text-ink",
              )}
            >
              <span className="flex flex-col items-center">
                <span className="text-[14.5px] tabular-nums">
                  {dayNumber(date)}
                </span>
                <span className="text-[8.5px] tracking-[0.06em] uppercase">
                  {formatWeekdayShort(date).slice(0, 2)}
                </span>
              </span>
            </span>
            <span className="sr-only">, {formatFullDate(date)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A horizontal swipe changes day (phone); vertical scrolling is left alone. */
function Swipe({
  enabled,
  onShift,
  className,
  children,
}: {
  enabled: boolean;
  onShift: StudioAgendaProps["onShift"];
  className: string;
  children: ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const from = start.current;
    const touch = event.changedTouches[0];
    start.current = null;
    if (!from || !touch) return;
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) onShift(dx < 0 ? 1 : -1);
  };
  return (
    <div
      tabIndex={0}
      className={cn(
        className,
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
      )}
      onTouchStart={enabled ? onTouchStart : undefined}
      onTouchEnd={enabled ? onTouchEnd : undefined}
    >
      {children}
    </div>
  );
}
